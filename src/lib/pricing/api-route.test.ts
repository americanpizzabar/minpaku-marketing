/**
 * データ層: /api/pricing の route (GET / POST)。TURSO_DATABASE_URL=":memory:" で getDb() をインメモリ DB にする。
 * 外部 API は globalThis.fetch のモックで代替する。
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { Client } from "@libsql/client";
import { seedRealistic, type SeedResult } from "./data-fixtures.test";
import { addDaysStr } from "./holidays";

const saved = {
  url: process.env.TURSO_DATABASE_URL,
  token: process.env.TURSO_AUTH_TOKEN,
  secret: process.env.CRON_SECRET,
  key: process.env.AIRROI_API_KEY,
};
const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
let fetchUrls: string[] = [];

type RouteModule = typeof import("../../app/api/pricing/route");
let route: RouteModule;
let db: Client;
let seed: SeedResult;

before(async () => {
  process.env.TURSO_DATABASE_URL = ":memory:";
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.CRON_SECRET = "s3cret";
  process.env.AIRROI_API_KEY = "test-key";
  route = await import("../../app/api/pricing/route");
  const { getDb, ensureSchema } = await import("../db");
  db = getDb()!;
  await ensureSchema(db);
  seed = await seedRealistic(db);
});

after(() => {
  for (const [k, v] of [
    ["TURSO_DATABASE_URL", saved.url],
    ["TURSO_AUTH_TOKEN", saved.token],
    ["CRON_SECRET", saved.secret],
    ["AIRROI_API_KEY", saved.key],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  fetchUrls = [];
  console.error = () => {};
  console.log = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchUrls.push(url);
    if (url.includes("/listings/future/rates")) {
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const rates = Array.from({ length: 60 }, (_, i) => ({ date: addDaysStr(today, i), rate: 100000, available: i % 2 === 0 }));
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

function post(body: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }): NextRequest {
  return new NextRequest("http://localhost:3000/api/pricing", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(body: unknown, headers?: Record<string, string>) {
  const res = await route.POST(post(body, headers));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/pricing: 認可", () => {
  it("同一オリジンの証明も Bearer も無ければ 403", async () => {
    const r = await call({ action: "persist" }, {});
    assert.equal(r.status, 403);
    assert.equal(r.json.ok, false);
    assert.equal((await call({ action: "persist" }, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await call({ action: "persist" }, { authorization: "Bearer wrong" })).status, 403);
    assert.equal(
      (await call({ action: "persist" }, { origin: "https://evil.example", host: "localhost:3000" })).status,
      403,
    );
  });

  it("Sec-Fetch-Site same-origin / Origin=Host / CRON_SECRET の Bearer なら受け付ける", async () => {
    assert.equal((await call({ action: "nope" })).status, 400, "認可は通り、不明な操作で 400");
    assert.equal((await call({ action: "nope" }, { origin: "http://localhost:3000", host: "localhost:3000" })).status, 400);
    assert.equal((await call({ action: "nope" }, { authorization: "Bearer s3cret" })).status, 400);
  });

  it("不正な JSON は 400", async () => {
    assert.equal((await call("{bad")).status, 400);
    assert.equal((await call([1, 2])).status, 400);
  });

  it("DB 未設定 (デモ) なら 400", async () => {
    const url = process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_DATABASE_URL;
    try {
      const r = await call({ action: "persist" });
      assert.equal(r.status, 400);
      assert.match(String(r.json.message), /デモモード/);
    } finally {
      process.env.TURSO_DATABASE_URL = url;
    }
  });
});

describe("POST /api/pricing: 操作", () => {
  it("saveConfig: Airbnb 以外の iCal URL は拒否、正しい URL は保存してマスクして返す", async () => {
    const bad = await call({ action: "saveConfig", config: { icalUrl: "https://evil.example/calendar/ical/1.ics" } });
    assert.equal(bad.status, 400);
    const bad2 = await call({ action: "saveConfig", config: { icalUrl: "http://www.airbnb.com/calendar/ical/1.ics" } });
    assert.equal(bad2.status, 400);
    const stored0 = await db.execute("SELECT value FROM sync_state WHERE key = 'config:pricing'");
    assert.equal(stored0.rows.length, 0, "拒否時は保存しない");

    const ok = await call({
      action: "saveConfig",
      config: { icalUrl: "https://www.airbnb.jp/calendar/ical/123.ics?s=secret", horizonDays: 45 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    const cfg = ok.json.config as Record<string, unknown>;
    assert.equal(cfg.horizonDays, 45);
    assert.notEqual(cfg.icalUrl, "https://www.airbnb.jp/calendar/ical/123.ics?s=secret", "URL はマスクして返す");
    const stored = JSON.parse(String((await db.execute("SELECT value FROM sync_state WHERE key = 'config:pricing'")).rows[0].value));
    assert.equal(stored.icalUrl, "https://www.airbnb.jp/calendar/ical/123.ics?s=secret");
    // "(設定済み)" は既存値を保持
    const keep = await call({ action: "saveConfig", config: { icalUrl: "(設定済み)", horizonDays: 60 } });
    assert.equal(keep.status, 200);
    const stored2 = JSON.parse(String((await db.execute("SELECT value FROM sync_state WHERE key = 'config:pricing'")).rows[0].value));
    assert.equal(stored2.icalUrl, "https://www.airbnb.jp/calendar/ical/123.ics?s=secret");
    assert.equal(stored2.horizonDays, 60);
    // "" で削除
    await call({ action: "saveConfig", config: { icalUrl: "" } });
    const stored3 = JSON.parse(String((await db.execute("SELECT value FROM sync_state WHERE key = 'config:pricing'")).rows[0].value));
    assert.equal(stored3.icalUrl, null);
  });

  it("setOwnStatus: 範囲 [today−14, today+horizon] のみ、手動として保存 (iCal 行も上書き)", async () => {
    const today = seed.today;
    for (const bad of [addDaysStr(today, -15), addDaysStr(today, 61), "2026-02-30", "x"]) {
      const r = await call({ action: "setOwnStatus", date: bad, status: "booked" });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await call({ action: "setOwnStatus", date: today, status: "maybe" })).status, 400);
    for (const [d, status] of [
      [addDaysStr(today, -14), "booked"],
      [addDaysStr(today, 60), "vacant"],
      [addDaysStr(today, 7), "vacant"], // フィクスチャでは iCal の booked
    ] as const) {
      const r = await call({ action: "setOwnStatus", date: d, status });
      assert.equal(r.status, 200, d);
      const row = await db.execute({ sql: "SELECT status, source FROM lumina_bookings WHERE target_date = ?", args: [d] });
      assert.deepEqual([row.rows[0].status, row.rows[0].source], [status, "manual"]);
    }
  });

  it("clearOwnStatus: 手動指定のみ削除し、iCal の行は残す", async () => {
    const today = seed.today;
    const d = addDaysStr(today, 5); // フィクスチャの manual booked
    const r = await call({ action: "clearOwnStatus", date: d });
    assert.equal(r.status, 200);
    assert.match(String(r.json.message), /解除/);
    const rows = await db.execute({ sql: "SELECT COUNT(*) AS c FROM lumina_bookings WHERE target_date = ?", args: [d] });
    assert.equal(Number(rows.rows[0].c), 0);
    const again = await call({ action: "clearOwnStatus", date: d });
    assert.match(String(again.json.message), /手動指定はありません/);
    const ical = addDaysStr(today, 8); // iCal の blocked
    await call({ action: "clearOwnStatus", date: ical });
    const icalRow = await db.execute({ sql: "SELECT source FROM lumina_bookings WHERE target_date = ?", args: [ical] });
    assert.equal(icalRow.rows[0].source, "ical");
    assert.equal((await call({ action: "clearOwnStatus", date: "bad" })).status, 400);
  });

  it("refreshCompset: ids の中で取得対象のものだけ取得し、実件数・実費用を返す", async () => {
    const empty = await call({ action: "refreshCompset", ids: [] });
    assert.equal(empty.status, 400);
    assert.equal(fetchUrls.length, 0);

    const r = await call({ action: "refreshCompset", ids: [seed.stale, seed.none, seed.hotel, seed.far, 42] });
    assert.equal(r.status, 200);
    assert.equal(r.json.refreshed, 2);
    assert.equal(r.json.costUsd, 0.2);
    assert.equal(fetchUrls.filter((u) => u.includes("/listings/future/rates")).length, 2);
    assert.match(String(r.json.message), /2件を取得しました（約\$0\.20）/);

    // 同じ ids でもう一度 → 今日取得済みなので 0件・$0
    fetchUrls = [];
    const again = await call({ action: "refreshCompset", ids: [seed.stale, seed.none] });
    assert.equal(again.json.refreshed, 0);
    assert.equal(again.json.costUsd, 0);
    assert.equal(fetchUrls.length, 0);
  });

  it("persist: 推奨価格とアラートを保存する", async () => {
    const r = await call({ action: "persist" });
    assert.equal(r.status, 200);
    assert.equal(r.json.saved, 61);
    const n = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM pricing_recommendations WHERE generated_date = ?",
      args: [seed.today],
    });
    assert.equal(Number(n.rows[0].c), 61);
  });

  it("importIcal: 未設定なら 400", async () => {
    const r = await call({ action: "importIcal" });
    assert.equal(r.status, 400);
  });
});

describe("GET /api/pricing", () => {
  it("DB のダッシュボードを返す", async () => {
    const res = await route.GET();
    assert.equal(res.status, 200);
    const d = (await res.json()) as Record<string, unknown>;
    assert.equal(d.dataSource, "turso");
    assert.equal((d.days as unknown[]).length, 61);
  });
});
