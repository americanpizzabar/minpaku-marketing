/**
 * データ層: 定期実行 (/api/cron/daily-sync, /api/cron/pricing-alerts)。TURSO_DATABASE_URL=":memory:"、fetch はモック。
 * 既存の増分同期 (AirROI 検索・料金) は自動同期オフで SKIPPED にして、価格計算の段だけを確認する。
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { Client } from "@libsql/client";
import { DEFAULT_PRICING_CONFIG } from "./config";
import { savePricingConfig } from "./config-store";
import { seedRealistic, type SeedResult } from "./data-fixtures.test";
import { addDaysStr } from "./holidays";

const saved = {
  url: process.env.TURSO_DATABASE_URL,
  secret: process.env.CRON_SECRET,
  key: process.env.AIRROI_API_KEY,
  hook: process.env.ALERT_WEBHOOK_URL,
};
const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
let urls: string[] = [];

let daily: typeof import("../../app/api/cron/daily-sync/route");
let alerts: typeof import("../../app/api/cron/pricing-alerts/route");
let db: Client;
let seed: SeedResult;

before(async () => {
  process.env.TURSO_DATABASE_URL = ":memory:";
  process.env.CRON_SECRET = "s3cret";
  process.env.AIRROI_API_KEY = "test-key";
  delete process.env.ALERT_WEBHOOK_URL;
  daily = await import("../../app/api/cron/daily-sync/route");
  alerts = await import("../../app/api/cron/pricing-alerts/route");
  const { getDb, ensureSchema } = await import("../db");
  db = getDb()!;
  await ensureSchema(db);
  seed = await seedRealistic(db);
  await db.execute("INSERT INTO sync_state (key, value) VALUES ('config:auto_sync', '0')");
});

after(() => {
  for (const [k, v] of [
    ["TURSO_DATABASE_URL", saved.url],
    ["CRON_SECRET", saved.secret],
    ["AIRROI_API_KEY", saved.key],
    ["ALERT_WEBHOOK_URL", saved.hook],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  urls = [];
  console.error = () => {};
  console.log = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("/listings/future/rates")) {
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const rates = Array.from({ length: 30 }, (_, i) => ({ date: addDaysStr(today, i), rate: 100000, available: true }));
      return new Response(JSON.stringify({ rates }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.log = realLog;
});

function req(path: string, auth?: string) {
  return new NextRequest(`http://localhost:3000${path}`, { headers: auth ? { authorization: auth } : {} });
}

describe("cron", () => {
  it("Bearer が違えば 401", async () => {
    assert.equal((await daily.GET(req("/api/cron/daily-sync"))).status, 401);
    assert.equal((await alerts.GET(req("/api/cron/pricing-alerts", "Bearer x"))).status, 401);
    assert.equal(urls.length, 0);
  });

  it("daily-sync: 自動取得オフなら API を呼ばず、推奨価格を保存する", async () => {
    const res = await daily.GET(req("/api/cron/daily-sync", "Bearer s3cret"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.status, "SKIPPED");
    assert.deepEqual(body.compset, { skipped: "自動取得オフ" });
    assert.equal(body.pricing.saved, 61);
    assert.equal(urls.length, 0);
  });

  it("daily-sync: CompSet 自動取得オンなら設定上限まで取得 (staleDays = compsetRefreshDays)", async () => {
    await savePricingConfig(db, { ...DEFAULT_PRICING_CONFIG, compsetAutoRefresh: true, compsetRefreshMax: 1 });
    const res = await daily.GET(req("/api/cron/daily-sync", "Bearer s3cret"));
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.compset.refreshed, 1);
    assert.equal(body.compset.costUsd, 0.1);
    assert.equal(urls.filter((u) => u.includes("/listings/future/rates")).length, 1);
    assert.match(urls[0], new RegExp(`id=${seed.none.slice(7)}&`));
  });

  it("pricing-alerts: 推奨価格を保存し、Webhook 未設定なら通知 0件", async () => {
    const res = await alerts.GET(req("/api/cron/pricing-alerts", "Bearer s3cret"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body.saved, 61);
    assert.equal(body.notified, 0);
  });
});

describe("cron-auth (CRON_SECRET の比較)", () => {
  const env = process.env.CRON_SECRET;
  afterEach(() => {
    if (env === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = env;
  });

  it("生の値と、空白・引用符を除いた値の両方を受け付ける", async () => {
    const { hasCronBearer, isCronAuthorized, matchesCronSecret } = await import("../cron-auth");
    process.env.CRON_SECRET = ' "s3cret" ';
    assert.equal(hasCronBearer('Bearer  "s3cret" '), true);
    assert.equal(hasCronBearer("Bearer s3cret"), true);
    assert.equal(matchesCronSecret("s3cret"), true);
    assert.equal(hasCronBearer("Bearer other"), false);
    assert.equal(isCronAuthorized("Bearer other"), false);
    assert.equal(isCronAuthorized(null), false);
  });

  it("空や引用符だけの CRON_SECRET は秘密として一致させない (Basic 認証の迂回に使えない)", async () => {
    const { hasCronBearer, isCronAuthorized, matchesCronSecret } = await import("../cron-auth");
    for (const v of ['""', "''", " ", '" "']) {
      process.env.CRON_SECRET = v;
      assert.equal(hasCronBearer(`Bearer ${v}`), false, JSON.stringify(v));
      assert.equal(hasCronBearer("Bearer "), false);
      assert.equal(matchesCronSecret(v), false);
      // cron ルートは未設定と同じ扱い (従来どおり)
      assert.equal(isCronAuthorized(null), true);
    }
    delete process.env.CRON_SECRET;
    assert.equal(hasCronBearer("Bearer undefined"), false);
    assert.equal(isCronAuthorized(null), true);
  });
});
