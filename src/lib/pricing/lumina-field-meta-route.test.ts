/**
 * 自物件の値の出所 (画面・API 経由)。TURSO_DATABASE_URL=":memory:" で getDb() をインメモリ DB にする。
 * - /api/settings: 保存で値が変わった項目を「手入力・今」、自動取得で更新した項目を「AirROI・今」として記録し返す
 * - getDashboardData: 自物件 KPI は AirROI の実価格・予約カレンダーを優先し、出所 (luminaSources) を返す
 * AirROI はモック (想定外の呼び出しは失敗させ、呼び出し回数を確認する)。
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { Client } from "@libsql/client";
import { addDaysStr } from "./holidays";
import { jstToday } from "./data-fixtures.test";

const saved = {
  url: process.env.TURSO_DATABASE_URL,
  token: process.env.TURSO_AUTH_TOKEN,
  key: process.env.AIRROI_API_KEY,
  secret: process.env.CRON_SECRET,
};
const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
let fetchUrls: string[] = [];

type SettingsRoute = typeof import("../../app/api/settings/route");
type Analytics = typeof import("../analytics");
let settings: SettingsRoute;
let analytics: Analytics;
let db: Client;

const LISTING = "1628678015262671191";

before(async () => {
  process.env.TURSO_DATABASE_URL = ":memory:";
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.CRON_SECRET = "s3cret";
  settings = await import("../../app/api/settings/route");
  analytics = await import("../analytics");
  const { getDb, ensureSchema } = await import("../db");
  db = getDb()!;
  await ensureSchema(db);
});

after(() => {
  for (const [k, v] of [
    ["TURSO_DATABASE_URL", saved.url],
    ["TURSO_AUTH_TOKEN", saved.token],
    ["AIRROI_API_KEY", saved.key],
    ["CRON_SECRET", saved.secret],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  process.env.AIRROI_API_KEY = "test-key";
  fetchUrls = [];
  console.error = () => {};
  console.log = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    fetchUrls.push(url.href);
    if (url.pathname.endsWith("/listings") && url.searchParams.get("id") === LISTING) {
      return new Response(
        JSON.stringify({
          results: [
            {
              listing_info: { listing_name: "Lumina", photos_count: 40, superhost: true, amenities: ["Wifi", "Sauna"] },
              ratings: { rating_overall: 4.95, num_reviews: 20 },
              last_scraped: "2026-11-10",
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url.href}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.log = realLog;
});

type Meta = Record<string, { source: string; at: string; dataDate: string | null }>;

async function postSettings(body: unknown) {
  const res = await settings.POST(
    new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("/api/settings: 自物件の設定値の出所", () => {
  it("保存: 値が変わった項目だけを手入力として記録し、応答に含める (AirROI は呼ばない)", async () => {
    const before = Date.now();
    const r = await postSettings({
      luminaListingId: LISTING, // 既定値と同じ = 変更なし (取得しない)
      luminaBedrooms: 4, // 既定値と同じ
      luminaRating: 4.93,
      luminaReviews: 15,
      luminaOccupancy: 58,
    });
    assert.equal(r.status, 200);
    assert.equal(fetchUrls.length, 0);
    const meta = r.json.luminaFieldMeta as Meta;
    assert.deepEqual(Object.keys(meta).sort(), ["luminaOccupancy", "luminaRating", "luminaReviews"]);
    for (const k of Object.keys(meta)) {
      assert.equal(meta[k].source, "manual");
      assert.ok(new Date(meta[k].at).getTime() >= before - 1000);
    }

    // 同じ値で保存し直しても日時は変わらない
    const again = await postSettings({ luminaRating: 4.93, luminaReviews: 15, luminaOccupancy: 58 });
    assert.deepEqual(again.json.luminaFieldMeta, meta);

    // 空にした項目は記録を消す
    const cleared = await postSettings({ luminaOccupancy: null });
    assert.equal((cleared.json.luminaFieldMeta as Meta).luminaOccupancy, undefined);
  });

  it("自動取得: 更新した項目を AirROI (取得日時・データ時点) として記録する", async () => {
    const r = await postSettings({ action: "fetchLuminaSpecs" });
    assert.equal(r.status, 200);
    assert.equal(fetchUrls.length, 1);
    const meta = r.json.luminaFieldMeta as Meta;
    for (const k of ["luminaRating", "luminaReviews", "luminaPhotos", "luminaSuperhost", "luminaAmenities"]) {
      assert.equal(meta[k]?.source, "airroi", k);
      assert.equal(meta[k]?.dataDate, "2026-11-10", k);
    }
    // GET でも同じ記録を返す
    const get = await settings.GET(new NextRequest("http://localhost/api/settings"));
    const json = (await get.json()) as Record<string, unknown>;
    assert.deepEqual(json.luminaFieldMeta, meta);
  });

  it("CRON_SECRET 付き GET の保存も、値が変わった項目を手入力として記録する", async () => {
    const res = await settings.GET(new NextRequest("http://localhost/api/settings?key=s3cret&luminaOccupancy=61&luminaMaxGuests=10"));
    const json = (await res.json()) as Record<string, unknown>;
    const meta = json.luminaFieldMeta as Meta;
    assert.equal(meta.luminaOccupancy?.source, "manual");
    assert.equal(meta.luminaMaxGuests, undefined, "既定値と同じ定員は変更扱いにしない");
    assert.equal(meta.luminaRating?.source, "airroi", "触れていない項目の記録は残す");
    assert.equal(fetchUrls.length, 0);
  });
});

describe("getDashboardData: 自物件 KPI の実データ優先と出所", () => {
  async function seedLumina(realDays: number, totalDays: number) {
    const today = jstToday();
    await db.execute("DELETE FROM lumina_fuji_metrics");
    const stmts = [];
    for (let i = 0; i < totalDays; i++) {
      const real = i < realDays;
      stmts.push({
        sql: `INSERT INTO lumina_fuji_metrics
                (target_date, configured_price, is_booked, price_source, price_observed_at, status_source, fetched_at)
              VALUES (?, ?, ?, ?, ?, 'airroi', '2026-11-18 16:30:00')`,
        args: [
          addDaysStr(today, i),
          real ? 77000 + (i % 2) * 1000 : 110000,
          real ? 0 : 1,
          real ? "airroi" : "base",
          real ? "2026-11-18 16:30:00" : null,
        ],
      });
    }
    await db.batch(stmts, "write");
    await db.execute(
      `INSERT INTO sync_state (key, value) VALUES ('config:lumina_base_price', '110000')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
  }

  it("実価格がある日だけで ADR を出し (基準価格の代替値を混ぜない)、出所と取得日時を返す", async () => {
    await seedLumina(16, 30);
    const d = await analytics.getDashboardData(analytics.parseFilters({}));
    assert.equal(d.kpisLumina.adr, 77500);
    assert.deepEqual(d.luminaSources.adr, { source: "airroi", basis: "calendar", asOf: "2026-11-18 16:30:00", days: 16 });
    assert.equal(d.luminaSources.occupancy.source, "airroi");
    assert.equal(d.luminaSources.occupancy.days, 30);
    assert.equal(Math.round(d.kpisLumina.occupancyRate * 30), 14);
    assert.equal(d.luminaSources.pacing.source, "airroi");
    const point = d.scatter.find((p) => p.isLumina)!;
    assert.equal(point.adr, 77500);
    assert.ok(!point.title.includes("手入力"));
    assert.equal(fetchUrls.length, 0);
  });

  it("リスティングIDを変えて新しい物件の取得が 404 なら、前の物件の実データを使わず手入力 (基準価格・稼働率) に戻る", async () => {
    await seedLumina(16, 30);
    await db.batch(
      [
        {
          sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_rates_ok_at', '2026-11-18 16:30:00')
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          args: [],
        },
        {
          sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_rates_listing_id', ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          args: [LISTING],
        },
      ],
      "write",
    );
    await postSettings({ luminaListingId: LISTING, luminaOccupancy: 58 });
    const before = await analytics.getDashboardData(analytics.parseFilters({}));
    assert.equal(before.luminaSources.adr.source, "airroi");
    assert.equal(before.luminaSources.occupancy.source, "airroi");

    const NEW_ID = "777000";
    fetchUrls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      fetchUrls.push(url.href);
      assert.equal(url.searchParams.get("id"), NEW_ID, "前のリスティングは呼ばない");
      return new Response("Listing has not been added to our system", { status: 404 });
    }) as typeof fetch;
    const r = await postSettings({ luminaListingId: NEW_ID });
    assert.equal(r.status, 200);
    assert.ok(fetchUrls.some((u) => u.includes("/listings/future/rates")));

    const d = await analytics.getDashboardData(analytics.parseFilters({}));
    assert.equal(d.luminaSources.adr.source, "manual");
    assert.equal(d.kpisLumina.adr, 110000);
    assert.equal(d.luminaSources.occupancy.source, "manual");
    assert.equal(Math.round(d.kpisLumina.occupancyRate * 100), 58);
    assert.equal(d.luminaSources.pacing.source, "manual");

    const { loadPricingInputs } = await import("./load");
    const inputs = await loadPricingInputs(db);
    assert.equal(inputs.ownCalendarFetchedAt, null);
    assert.ok(inputs.own.every((o) => o.apiPrice === null && o.statusSource !== "api"));
  });

  it("期間内に実価格が無ければ手入力の基準価格 (出所 manual) で、名前にも明記する", async () => {
    await seedLumina(0, 30);
    const d = await analytics.getDashboardData(analytics.parseFilters({}));
    assert.equal(d.kpisLumina.adr, 110000);
    assert.equal(d.luminaSources.adr.source, "manual");
    assert.equal(d.luminaSources.adr.basis, "setting");
    assert.equal(d.kpisLumina.weekendPremium, null, "基準価格の一律値で週末プレミアムは出さない");
    assert.equal(d.luminaSources.occupancy.source, "airroi", "予約状況は AirROI の実データ");
    const point = d.scatter.find((p) => p.isLumina)!;
    assert.match(point.title, /価格は手入力の基準価格/);
  });
});
