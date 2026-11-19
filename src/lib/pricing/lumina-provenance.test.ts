/**
 * 自物件 (Lumina) の値の出所 (AirROI の実データか手入力か・いつの値か)。
 * - db.ts: lumina_fuji_metrics の出所列の追加と一度きりのバックフィル (本番と同じ旧スキーマから)
 * - airroi.ts: refreshLuminaRates (AirROI はモック。ネットワークには出ない)
 * - analytics.ts: 実データ優先の ADR・稼働率・Pacing と出所
 * - lumina-sources.ts: 画面の文言 / sync-config.ts: 設定値の出所の記録
 * - pricing/load.ts: 基準価格の代替行を実価格・実予約として扱わない
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { refreshLuminaRates } from "../airroi";
import { luminaAdrAndOcc, luminaPacing } from "../analytics";
import { toLuminaMetric, type LuminaProfile } from "../data";
import { LUMINA_PROVENANCE_FLAG, ensureSchema } from "../db";
import { formatJstMonthDay, parseTimestamp } from "../format";
import {
  adrSourceText,
  luminaSeriesNote,
  occupancySourceText,
  perGuestSourceText,
  revparSourceText,
} from "../lumina-sources";
import {
  LUMINA_FIELD_META_KEY,
  changedLuminaFields,
  getLuminaFieldMeta,
  getSyncConfig,
  markLuminaFields,
  parseLuminaFieldMeta,
  recordManualLuminaEdits,
  saveSyncConfig,
} from "../sync-config";
import type { LuminaMetric, LuminaSources, LuminaValueSource } from "../types";
import { freshDb, jstToday, seedRealistic } from "./data-fixtures.test";
import { addDaysStr } from "./holidays";
import { loadPricingInputs } from "./load";

const realFetch = globalThis.fetch;
const realKey = process.env.AIRROI_API_KEY;
const realError = console.error;
const realLog = console.log;
let fetchCalls: string[] = [];

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  process.env.AIRROI_API_KEY = "test-key";
  fetchCalls = [];
  console.error = () => {};
  console.log = () => {};
  // 既定では外部に出さない (呼ばれたら失敗させる)
  mockFetch((url) => {
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.AIRROI_API_KEY;
  else process.env.AIRROI_API_KEY = realKey;
  console.error = realError;
  console.log = realLog;
});

async function count(db: Client, sql: string, args: (string | number)[] = []): Promise<number> {
  const r = await db.execute({ sql, args });
  return Number(r.rows[0]?.c ?? 0);
}

/* ------------------------------------------------------------------ */
/* A. スキーマとバックフィル                                             */
/* ------------------------------------------------------------------ */

/** 出所の列が無い旧形の lumina_fuji_metrics と sync_state */
async function oldShapeDb(state: Record<string, string>): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE lumina_fuji_metrics (
    target_date DATE PRIMARY KEY,
    configured_price REAL NOT NULL,
    is_booked BOOLEAN DEFAULT 0,
    actual_revenue REAL DEFAULT 0
  )`);
  await db.execute("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)");
  for (const [k, v] of Object.entries(state)) {
    await db.execute({ sql: "INSERT INTO sync_state (key, value) VALUES (?, ?)", args: [k, v] });
  }
  // 本番の事象: 料金のある日は実価格、予約済みの日は過去の取得失敗時の基準価格 ¥110,000、価格なしは 0
  const rows: [string, number, number][] = [
    ["2026-11-20", 77000, 0],
    ["2026-11-21", 110000, 1],
    ["2026-11-22", 0, 1],
    ["2026-11-23", 81000, 1],
  ];
  for (const [d, p, b] of rows) {
    await db.execute({
      sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES (?, ?, ?)",
      args: [d, p, b],
    });
  }
  return db;
}

/** 同じ DB を指す別の Client (ensureSchema のメモ化キーが異なる = 別プロセス相当)。batch の失敗を注入できる */
function alias(db: Client, failBatch: () => boolean = () => false): Client {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch" && failBatch()) return () => Promise.reject(new Error("SQLITE_BUSY"));
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Client;
}

async function metricsByDate(db: Client) {
  const r = await db.execute(
    "SELECT target_date, configured_price, is_booked, price_source, price_observed_at, status_source, fetched_at FROM lumina_fuji_metrics ORDER BY target_date",
  );
  return new Map(r.rows.map((x) => [String(x.target_date), x]));
}

describe("ensureSchema: lumina_fuji_metrics の出所の列とバックフィル", () => {
  it("前回取得が成功 (api) なら、基準価格と異なる価格を airroi、基準価格と同じ値を base にし、予約状況は AirROI 由来", async () => {
    const db = await oldShapeDb({
      lumina_source: "api",
      lumina_rates_at: "2026-11-03 01:02:03",
      "config:lumina_base_price": "110000",
    });
    await ensureSchema(db);
    const m = await metricsByDate(db);
    assert.equal(m.get("2026-11-20")!.price_source, "airroi");
    assert.equal(m.get("2026-11-21")!.price_source, "base", "予約済みの日に残った基準価格は実データにしない");
    assert.equal(m.get("2026-11-22")!.price_source, null);
    assert.equal(m.get("2026-11-23")!.price_source, "airroi");
    for (const row of m.values()) {
      assert.equal(row.status_source, "airroi");
      assert.equal(row.fetched_at, "2026-11-03 01:02:03");
    }
    // 実価格の観測日時は不明なので、遅くとも前回取得日時とする (基準価格・価格なしの行は NULL)
    assert.equal(m.get("2026-11-20")!.price_observed_at, "2026-11-03 01:02:03");
    assert.equal(m.get("2026-11-23")!.price_observed_at, "2026-11-03 01:02:03");
    assert.equal(m.get("2026-11-21")!.price_observed_at, null);
    assert.equal(m.get("2026-11-22")!.price_observed_at, null);
    // 既存の値は変えない
    assert.equal(Number(m.get("2026-11-21")!.configured_price), 110000);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = ?", [LUMINA_PROVENANCE_FLAG]), 1);
    // 最終成功日時・取得元リスティングID (今の設定) を前回取得から補う
    const st = await db.execute(
      "SELECT key, value FROM sync_state WHERE key IN ('lumina_rates_ok_at', 'lumina_rates_listing_id')",
    );
    const state = new Map(st.rows.map((x) => [String(x.key), String(x.value)]));
    assert.equal(state.get("lumina_rates_ok_at"), "2026-11-03 01:02:03");
    assert.equal(state.get("lumina_rates_listing_id"), "1628678015262671191");
  });

  it("前回取得より前の日: 基準価格の代替行 (予約なし) は予約状況の出所を付けず、稼働率は手入力の設定値に戻る", async () => {
    const db = await oldShapeDb({
      lumina_source: "api",
      lumina_rates_at: "2026-11-10 01:00:00",
      "config:lumina_base_price": "110000",
      "config:lumina_listing_id": "555",
    });
    // 本番の事象: 過去の取得失敗で書かれた基準価格の代替行が、後の取得 (11/10) の範囲外 (過去) に残っている
    await db.batch(
      [
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES ('2026-11-05', 110000, 0)", args: [] },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES ('2026-11-06', 110000, 0)", args: [] },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES ('2026-11-07', 110000, 1)", args: [] },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES ('2026-11-08', 80000, 0)", args: [] },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES ('2026-11-10', 110000, 0)", args: [] },
      ],
      "write",
    );
    await ensureSchema(db);
    const m = await metricsByDate(db);
    const pick = (d: string) => {
      const r = m.get(d)!;
      return [r.price_source, r.status_source, r.fetched_at, r.price_observed_at];
    };
    assert.deepEqual(pick("2026-11-05"), ["base", null, null, null], "代替行は出所不明");
    assert.deepEqual(pick("2026-11-06"), ["base", null, null, null]);
    assert.deepEqual(pick("2026-11-07"), ["base", "airroi", null, null], "予約済み (代替行は予約を立てない) は AirROI 由来・取得日時不明");
    assert.deepEqual(pick("2026-11-08"), ["airroi", "airroi", null, "2026-11-10 01:00:00"], "実価格の行は AirROI 由来・取得日時不明");
    assert.deepEqual(pick("2026-11-10"), ["base", "airroi", "2026-11-10 01:00:00", null], "前回取得の範囲 (その日以降)");
    assert.equal(
      (await db.execute("SELECT value FROM sync_state WHERE key = 'lumina_rates_listing_id'")).rows[0].value,
      "555",
    );

    // 過去の期間 (11/5-11/6) の稼働率は手入力の設定値 (AirROI予約カレンダーとは表示しない)
    const rows = (
      await db.execute({
        sql: "SELECT * FROM lumina_fuji_metrics WHERE target_date BETWEEN '2026-11-05' AND '2026-11-06'",
        args: [],
      })
    ).rows.map((r) => toLuminaMetric(r as Record<string, unknown>));
    const meta = { luminaOccupancy: { source: "manual" as const, at: "2026-11-01T00:00:00.000Z" } };
    const r = luminaAdrAndOcc(profile({ occupancyOverride: 55, fieldMeta: meta }), rows);
    assert.equal(r.occ, 0.55);
    assert.equal(r.occSource.source, "manual");
    assert.match(occupancySourceText(r.occSource), /^手入力の設定値/);
    // 価格も実価格が無いので手入力の基準価格
    assert.equal(r.adrSource.source, "manual");
  });

  it("バックフィル後に全日予約済みで再取得しても、残した実価格の日付は前回取得日時のまま (今日の取得に見せない)", async () => {
    const db = await oldShapeDb({
      lumina_source: "api",
      lumina_rates_at: "2026-11-03 01:02:03",
      "config:lumina_base_price": "110000",
    });
    await ensureSchema(db);
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            rates: ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"].map((date) => ({ date, rate: 0, available: false })),
          }),
          { status: 200 },
        ),
    );
    const res = await refreshLuminaRates(db, await getSyncConfig(db));
    assert.equal(res.ok, true);
    const rows = (await db.execute("SELECT * FROM lumina_fuji_metrics ORDER BY target_date")).rows.map((r) =>
      toLuminaMetric(r as Record<string, unknown>),
    );
    const r = luminaAdrAndOcc(profile({ ratesFetchedAt: res.fetchedAt }), rows);
    assert.equal(r.adrSource.source, "airroi");
    assert.equal(r.adrSource.days, 2);
    assert.equal(r.adrSource.asOf, "2026-11-03 01:02:03", "価格の日付は観測日時 (予約状況の取得日時ではない)");
    assert.equal(r.occSource.asOf, res.fetchedAt, "予約状況は今回の取得");
    assert.equal(r.occ, 1);
  });

  it("前回取得が失敗 (manual) なら価格はすべて base、予約状況の出所は付けない", async () => {
    const db = await oldShapeDb({ lumina_source: "manual", "config:lumina_base_price": "110000" });
    await ensureSchema(db);
    const m = await metricsByDate(db);
    assert.equal(m.get("2026-11-20")!.price_source, "base");
    assert.equal(m.get("2026-11-21")!.price_source, "base");
    assert.equal(m.get("2026-11-22")!.price_source, null);
    for (const row of m.values()) {
      assert.equal(row.status_source, null);
      assert.equal(row.fetched_at, null);
    }
  });

  it("フラグがあれば再実行しない (別 Client = 別プロセスでも)", async () => {
    const db = await oldShapeDb({ lumina_source: "api", "config:lumina_base_price": "110000" });
    await ensureSchema(db);
    await db.execute("UPDATE lumina_fuji_metrics SET price_source = NULL WHERE target_date = '2026-11-20'");
    await ensureSchema(alias(db));
    const m = await metricsByDate(db);
    assert.equal(m.get("2026-11-20")!.price_source, null);
  });

  it("バックフィルが失敗しても ensureSchema は例外を投げず、フラグを立てずに次回再試行する", async () => {
    const db = await oldShapeDb({ lumina_source: "api", "config:lumina_base_price": "110000" });
    await ensureSchema(alias(db, () => true));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = ?", [LUMINA_PROVENANCE_FLAG]), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM lumina_fuji_metrics WHERE price_source IS NOT NULL"), 0);
    await ensureSchema(alias(db));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = ?", [LUMINA_PROVENANCE_FLAG]), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM lumina_fuji_metrics WHERE price_source = 'airroi'"), 2);
  });
});

/* ------------------------------------------------------------------ */
/* B. refreshLuminaRates                                               */
/* ------------------------------------------------------------------ */

const LISTING = "1628678015262671191";

async function configFor(db: Client, basePrice: number) {
  await saveSyncConfig(db, { luminaListingId: LISTING, luminaBasePrice: basePrice });
  return getSyncConfig(db);
}

describe("refreshLuminaRates", () => {
  it("取得成功: 料金のある日は airroi・観測日時=今、予約済みの日は基準価格の代替値を消し、前回の実価格は残す", async () => {
    const db = await freshDb();
    const today = jstToday();
    const d = (i: number) => addDaysStr(today, i);
    // 既存: d(0) は過去の失敗時の基準価格、d(1) は前回 AirROI で観測した実価格、d(2) は基準価格
    await db.batch(
      [
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source) VALUES (?, 110000, 0, 'base')", args: [d(0)] },
        {
          sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source, price_observed_at, status_source, fetched_at)
                VALUES (?, 76000, 0, 'airroi', '2026-10-01 00:00:00', 'airroi', '2026-10-01 00:00:00')`,
          args: [d(1)],
        },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source) VALUES (?, 110000, 0, 'base')", args: [d(2)] },
      ],
      "write",
    );
    const cfg = await configFor(db, 110000);
    mockFetch((url) => {
      assert.ok(url.includes("/listings/future/rates") && url.includes(`id=${LISTING}`));
      return new Response(
        JSON.stringify({
          rates: [
            { date: d(0), rate: 0, available: false }, // 予約済み (AirROI は料金を返さない)
            { date: d(1), rate: 0, available: false }, // 予約済み (前回は掲載価格あり)
            { date: d(2), rate: 78000, available: true },
            { date: d(3), rate: 79000, available: true },
            { date: d(4), rate: 0, available: true }, // 予約可能だが料金なし
            { date: d(5), rate: 99_000_000, available: true }, // 外れ値 (ブロック目的)
          ],
        }),
        { status: 200 },
      );
    });
    const r = await refreshLuminaRates(db, cfg);
    assert.equal(fetchCalls.length, 1);
    assert.equal(r.ok, true);
    assert.equal(r.usedApi, true);
    assert.equal(r.records, 6);
    assert.equal(r.pricedDays, 2);
    assert.equal(r.bookedDays, 2);
    assert.match(r.fetchedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const m = await metricsByDate(db);
    const row = (i: number) => m.get(d(i))!;
    assert.deepEqual(
      [Number(row(0).configured_price), row(0).price_source, row(0).price_observed_at, Number(row(0).is_booked)],
      [0, null, null, 1],
      "基準価格の代替値は実価格として残さない",
    );
    assert.deepEqual(
      [Number(row(1).configured_price), row(1).price_source, row(1).price_observed_at, Number(row(1).is_booked)],
      [76000, "airroi", "2026-10-01 00:00:00", 1],
      "前回 AirROI で観測した価格は観測日時ごと残す",
    );
    assert.deepEqual([Number(row(2).configured_price), row(2).price_source, row(2).price_observed_at], [78000, "airroi", r.fetchedAt]);
    assert.deepEqual([Number(row(3).configured_price), row(3).price_source], [79000, "airroi"]);
    assert.deepEqual([Number(row(4).configured_price), row(4).price_source, Number(row(4).is_booked)], [0, null, 0]);
    assert.deepEqual([Number(row(5).configured_price), row(5).price_source], [0, null], "外れ値は価格なし");
    for (let i = 0; i <= 5; i++) {
      assert.equal(row(i).status_source, "airroi");
      assert.equal(row(i).fetched_at, r.fetchedAt);
    }
    const state = await db.execute(
      "SELECT key, value FROM sync_state WHERE key IN ('lumina_rates_ok_at', 'lumina_rates_at', 'lumina_source')",
    );
    const st = new Map(state.rows.map((x) => [String(x.key), String(x.value)]));
    assert.equal(st.get("lumina_rates_ok_at"), r.fetchedAt);
    assert.equal(st.get("lumina_rates_at"), r.fetchedAt);
    assert.equal(st.get("lumina_source"), "api");
  });

  it("取得失敗 (404): AirROI の実価格・予約状況は残し、それ以外を基準価格 (base) で埋める。最終成功日時は進めない", async () => {
    const db = await freshDb();
    const today = jstToday();
    const d = (i: number) => addDaysStr(today, i);
    await db.batch(
      [
        {
          sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source, price_observed_at, status_source, fetched_at)
                VALUES (?, 76000, 1, 'airroi', '2026-10-01 00:00:00', 'airroi', '2026-10-01 00:00:00')`,
          args: [d(1)],
        },
        {
          sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source, status_source, fetched_at)
                VALUES (?, 0, 1, NULL, 'airroi', '2026-10-01 00:00:00')`,
          args: [d(2)],
        },
        { sql: "INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source) VALUES (?, 100000, 0, 'base')", args: [d(3)] },
        { sql: "INSERT INTO sync_state (key, value) VALUES ('lumina_rates_ok_at', '2026-10-01 00:00:00')", args: [] },
      ],
      "write",
    );
    const cfg = await configFor(db, 120000);
    mockFetch(() => new Response("Listing has not been added to our system", { status: 404 }));
    const r = await refreshLuminaRates(db, cfg);
    assert.equal(fetchCalls.length, 1);
    assert.equal(r.ok, false);
    assert.equal(r.usedApi, true);
    assert.match(r.error ?? "", /404/);

    const m = await metricsByDate(db);
    const row = (i: number) => m.get(d(i))!;
    assert.deepEqual(
      [Number(row(1).configured_price), row(1).price_source, row(1).price_observed_at, Number(row(1).is_booked), row(1).status_source],
      [76000, "airroi", "2026-10-01 00:00:00", 1, "airroi"],
    );
    assert.deepEqual(
      [Number(row(2).configured_price), row(2).price_source, Number(row(2).is_booked), row(2).status_source, row(2).fetched_at],
      [120000, "base", 1, "airroi", "2026-10-01 00:00:00"],
      "予約状況には触れない",
    );
    assert.deepEqual([Number(row(3).configured_price), row(3).price_source], [120000, "base"], "旧基準価格は新しい値で上書き");
    assert.deepEqual([Number(row(0).configured_price), row(0).price_source, row(0).status_source], [120000, "base", null]);
    const okAt = await db.execute("SELECT value FROM sync_state WHERE key = 'lumina_rates_ok_at'");
    assert.equal(okAt.rows[0].value, "2026-10-01 00:00:00");
    const src = await db.execute("SELECT value FROM sync_state WHERE key = 'lumina_source'");
    assert.equal(src.rows[0].value, "manual");
  });
});

describe("refreshLuminaRates: 失敗の種類と課金・別リスティング", () => {
  async function seededReal(db: Client) {
    const today = jstToday();
    await db.batch(
      [
        {
          sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, price_source, price_observed_at, status_source, fetched_at)
                VALUES (?, 76000, 1, 'airroi', '2026-10-01 00:00:00', 'airroi', '2026-10-01 00:00:00')`,
          args: [addDaysStr(today, 1)],
        },
        { sql: "INSERT INTO sync_state (key, value) VALUES ('lumina_rates_ok_at', '2026-10-01 00:00:00')", args: [] },
        { sql: "INSERT INTO sync_state (key, value) VALUES ('lumina_source', 'api')", args: [] },
      ],
      "write",
    );
    return today;
  }

  it("200 だが料金が1日も無い (空のカレンダー): 失敗扱い・課金あり。最終成功日時は進めず、試行日時は進める", async () => {
    const db = await freshDb();
    const today = await seededReal(db);
    const cfg = await configFor(db, 110000);
    mockFetch(() => new Response(JSON.stringify({ rates: [] }), { status: 200 }));
    const r = await refreshLuminaRates(db, cfg);
    assert.equal(fetchCalls.length, 1);
    assert.equal(r.ok, false);
    assert.equal(r.usedApi, true, "応答を受け取ったので課金対象");
    assert.equal(r.failure, "empty");
    assert.equal(r.pricedDays, 0);
    const st = new Map(
      (await db.execute("SELECT key, value FROM sync_state WHERE key LIKE 'lumina_rates%'")).rows.map((x) => [String(x.key), String(x.value)]),
    );
    assert.equal(st.get("lumina_rates_ok_at"), "2026-10-01 00:00:00");
    assert.equal(st.get("lumina_rates_at"), r.fetchedAt, "同じ周期に再度課金しないよう試行日時は進める");
    assert.equal(st.get("lumina_rates_listing_id"), undefined);
    const m = await metricsByDate(db);
    const kept = m.get(addDaysStr(today, 1))!;
    assert.deepEqual([Number(kept.configured_price), kept.price_source, kept.status_source, kept.fetched_at], [76000, "airroi", "airroi", "2026-10-01 00:00:00"]);
    // 取得日時は保存されている実データの日付のまま
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, "2026-10-01 00:00:00");
  });

  it("通信エラー (応答なし) は課金なし扱い、読めない応答は課金あり", async () => {
    const db = await freshDb();
    const cfg = await configFor(db, 0);
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const net = await refreshLuminaRates(db, cfg);
    assert.deepEqual([net.ok, net.usedApi, net.failure], [false, false, "network"]);
    mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const parse = await refreshLuminaRates(db, cfg);
    assert.deepEqual([parse.ok, parse.usedApi, parse.failure], [false, true, "parse"]);
    mockFetch(() => new Response("rate limited", { status: 429 }));
    const http = await refreshLuminaRates(db, cfg);
    assert.deepEqual([http.ok, http.usedApi, http.failure, http.httpStatus], [false, true, "http", 429]);
  });

  it("成功時に取得元リスティングIDを記録し、別のリスティングIDで取得が失敗したら前の物件の実データを使わない", async () => {
    const db = await freshDb();
    const today = jstToday();
    const cfg = await configFor(db, 110000);
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            rates: [
              { date: addDaysStr(today, 1), rate: 70000, available: true },
              { date: addDaysStr(today, 2), rate: 0, available: false },
            ],
          }),
          { status: 200 },
        ),
    );
    assert.equal((await refreshLuminaRates(db, cfg)).ok, true);
    assert.equal(
      (await db.execute("SELECT value FROM sync_state WHERE key = 'lumina_rates_listing_id'")).rows[0].value,
      LISTING,
    );
    assert.ok((await loadPricingInputs(db)).ownCalendarFetchedAt !== null);

    // 環境変数等で別のリスティングに変わった (設定画面を経由しない) → 読み込みでも前の物件の行は実データにしない
    await saveSyncConfig(db, { luminaListingId: "777000" });
    const foreign = await loadPricingInputs(db);
    assert.equal(foreign.ownCalendarFetchedAt, null);
    assert.ok(foreign.own.every((o) => o.apiPrice === null && o.statusSource !== "api"));

    // 新しいリスティングの取得が 404 → 前の物件の実価格・予約状況は消し、基準価格で埋める
    mockFetch(() => new Response("Listing has not been added to our system", { status: 404 }));
    const r = await refreshLuminaRates(db, await getSyncConfig(db));
    assert.equal(r.ok, false);
    const m = await metricsByDate(db);
    for (const d of [addDaysStr(today, 1), addDaysStr(today, 2)]) {
      const row = m.get(d)!;
      assert.deepEqual([Number(row.configured_price), row.price_source, row.status_source, row.fetched_at], [110000, "base", null, null], d);
    }
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key IN ('lumina_rates_ok_at', 'lumina_rates_listing_id')"), 0);
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, null);
  });
});

/* ------------------------------------------------------------------ */
/* D. 実データ優先の KPI と出所                                         */
/* ------------------------------------------------------------------ */

function profile(over: Partial<LuminaProfile> = {}): LuminaProfile {
  return {
    maxGuests: 10,
    bedrooms: 4,
    occupancyOverride: null,
    source: "api",
    listingId: LISTING,
    lat: null,
    lng: null,
    ratesFetchedAt: "2026-11-19 03:00:00",
    basePrice: 110000,
    fieldMeta: {},
    ...over,
  };
}

function metric(date: string, price: number, over: Partial<LuminaMetric> = {}): LuminaMetric {
  return {
    targetDate: date,
    configuredPrice: price,
    isBooked: false,
    actualRevenue: 0,
    priceSource: price > 0 ? "airroi" : null,
    priceObservedAt: price > 0 ? "2026-11-19 03:00:00" : null,
    statusSource: "airroi",
    fetchedAt: "2026-11-19 03:00:00",
    ...over,
  };
}

describe("analytics: 自物件の ADR・稼働率 (実データ優先)", () => {
  it("本番の事象: 実価格16日 (平均¥77,442) + 基準価格の代替14日 → ADR は実価格だけの平均 (旧算出は ¥92,636)", () => {
    const rows: LuminaMetric[] = [];
    // 合計 1,239,072 (= 77,442 × 16) になる16日の実価格
    const prices = [70000, 72000, 74000, 76000, 78000, 80000, 82000, 84000, 70000, 72000, 74000, 76000, 78000, 80000, 82000, 91072];
    prices.forEach((p, i) => rows.push(metric(`2026-11-${String(i + 1).padStart(2, "0")}`, p)));
    for (let i = 0; i < 14; i++) {
      rows.push(metric(`2026-12-${String(i + 1).padStart(2, "0")}`, 110000, { priceSource: "base", priceObservedAt: null, isBooked: true }));
    }
    const old = Math.round(rows.reduce((a, m) => a + m.configuredPrice, 0) / rows.length);
    assert.equal(old, 92636);
    const r = luminaAdrAndOcc(profile(), rows);
    assert.equal(Math.round(r.adr!), 77442);
    assert.deepEqual(r.adrSource, { source: "airroi", basis: "calendar", asOf: "2026-11-19 03:00:00", days: 16 });
    assert.equal(r.occ, 14 / 30);
    assert.deepEqual(r.occSource, { source: "airroi", basis: "calendar", asOf: "2026-11-19 03:00:00", days: 30 });
  });

  it("asOf は使った行の最も新しい観測日時 (残した古い実価格だけなら古い日時)", () => {
    const r = luminaAdrAndOcc(profile(), [
      metric("2026-11-20", 70000, { priceObservedAt: "2026-10-01 00:00:00" }),
      metric("2026-11-21", 0),
    ]);
    assert.equal(r.adrSource.asOf, "2026-10-01 00:00:00");
    assert.equal(r.adrSource.days, 1);
  });

  it("実価格が無ければ手入力の基準価格 (出所 manual・保存日時)、それも無ければ null", () => {
    const meta = { luminaBasePrice: { source: "manual" as const, at: "2026-11-18T05:00:00.000Z" } };
    const rows = [metric("2026-11-20", 110000, { priceSource: "base", priceObservedAt: null })];
    const r = luminaAdrAndOcc(profile({ fieldMeta: meta }), rows);
    assert.equal(r.adr, 110000);
    assert.deepEqual(r.adrSource, { source: "manual", basis: "setting", asOf: "2026-11-18T05:00:00.000Z", days: 0 });
    const none = luminaAdrAndOcc(profile({ basePrice: null }), rows);
    assert.equal(none.adr, null);
    assert.equal(none.adrSource.source, "none");
  });

  it("予約状況の出所が無い行は使わず、設定の稼働率 → それも無ければ null", () => {
    const rows = [metric("2026-11-20", 0, { statusSource: null, fetchedAt: null, isBooked: true })];
    const withOverride = luminaAdrAndOcc(profile({ occupancyOverride: 62, fieldMeta: { luminaOccupancy: { source: "airroi", at: "2026-11-01T00:00:00.000Z" } } }), rows);
    assert.equal(withOverride.occ, 0.62);
    assert.deepEqual(withOverride.occSource, { source: "airroi", basis: "setting", asOf: "2026-11-01T00:00:00.000Z", days: 0 });
    const noMeta = luminaAdrAndOcc(profile({ occupancyOverride: 50 }), rows);
    assert.deepEqual(noMeta.occSource, { source: "manual", basis: "setting", asOf: null, days: 0 });
    const none = luminaAdrAndOcc(profile(), rows);
    assert.equal(none.occ, null);
    assert.equal(none.occSource.source, "none");
  });

  it("直近の取得が失敗 (source manual) でも、過去に AirROI で取得した行は実データとして使う", () => {
    const r = luminaAdrAndOcc(profile({ source: "manual", occupancyOverride: 90 }), [
      metric("2026-11-20", 70000, { isBooked: true }),
      metric("2026-11-21", 72000),
    ]);
    assert.equal(r.adr, 71000);
    assert.equal(r.occ, 0.5);
    assert.equal(r.occSource.source, "airroi");
  });

  it("Pacing: 期間内の AirROI 予約カレンダー → 設定の稼働率 → データなし", () => {
    const rows = [
      metric("2026-11-20", 70000, { isBooked: true }),
      metric("2026-11-21", 0, { isBooked: true }),
      metric("2026-11-22", 72000),
      metric("2026-12-30", 72000),
    ];
    const p = luminaPacing(profile(), rows, "2026-11-30");
    assert.equal(p.value, 2 / 3);
    assert.equal(p.source.days, 3);
    const fallback = luminaPacing(profile({ occupancyOverride: 40 }), rows.map((m) => ({ ...m, statusSource: null })), "2026-11-30");
    assert.equal(fallback.value, 0.4);
    assert.equal(fallback.source.source, "manual");
    const none = luminaPacing(profile(), [], "2026-11-30");
    assert.equal(none.value, null);
    assert.equal(none.source.source, "none");
  });

  it("デモデータは実データではなくデモとして出所を返す", () => {
    const rows = [metric("2026-11-20", 70000, { priceSource: "demo", statusSource: "demo", priceObservedAt: null, fetchedAt: null })];
    const r = luminaAdrAndOcc(profile({ source: "demo", ratesFetchedAt: null, basePrice: null }), rows);
    assert.equal(r.adr, 70000);
    assert.equal(r.adrSource.source, "demo");
    assert.equal(r.occSource.source, "demo");
  });
});

/* ------------------------------------------------------------------ */
/* F. 画面の文言                                                       */
/* ------------------------------------------------------------------ */

describe("lumina-sources: 出所の文言 (日本時間の M/D)", () => {
  const airroi: LuminaValueSource = { source: "airroi", basis: "calendar", asOf: "2026-11-18 16:30:00", days: 16 };
  const manual: LuminaValueSource = { source: "manual", basis: "setting", asOf: "2026-11-02T03:00:00.000Z", days: 0 };
  const manualUnknown: LuminaValueSource = { source: "manual", basis: "setting", asOf: null, days: 0 };
  const none: LuminaValueSource = { source: "none", basis: null, asOf: null, days: 0 };

  it("UTC の日時を日本時間の日付で表示する (16:30 UTC = 翌日 1:30 JST)", () => {
    assert.equal(formatJstMonthDay("2026-11-18 16:30:00"), "11/19");
    assert.equal(formatJstMonthDay("2026-11-02T03:00:00.000Z"), "11/2");
    assert.equal(formatJstMonthDay(null), null);
    assert.equal(formatJstMonthDay("garbage"), null);
    assert.equal(parseTimestamp("2026-11-18 16:30:00")!.toISOString(), "2026-11-18T16:30:00.000Z");
  });

  it("ADR・稼働率・RevPAR・1人当たり", () => {
    assert.equal(adrSourceText(airroi), "AirROI実データ・料金のある16日の平均（11/19取得）");
    assert.equal(adrSourceText(manual), "手入力の基準価格（AirROIの料金なし・11/2保存）");
    assert.equal(adrSourceText(none), "データなし（AirROIの料金・基準価格なし）");
    assert.equal(occupancySourceText(airroi), "AirROI予約カレンダー（11/19取得）");
    assert.equal(occupancySourceText(manual), "手入力の設定値（11/2保存）");
    assert.equal(occupancySourceText(manualUnknown), "手入力の設定値（日時不明）");
    const all: LuminaSources = { adr: airroi, occupancy: airroi, pacing: airroi, maxGuests: { ...manualUnknown } };
    assert.equal(revparSourceText(all), "ADR × 稼働率（AirROI実データ）");
    assert.equal(revparSourceText({ ...all, occupancy: manual }), "ADR × 稼働率（稼働率は手入力）");
    assert.equal(perGuestSourceText(all), "1泊料金 ÷ 収容定員（定員は手入力）");
    assert.equal(perGuestSourceText({ ...all, adr: manual }), "1泊料金 ÷ 収容定員（料金・定員は手入力）");
    assert.equal(luminaSeriesNote(airroi), "AirROI実データ・11/19取得");
    assert.equal(luminaSeriesNote(manual), "手入力の基準価格");
    assert.equal(luminaSeriesNote(none), null);
  });
});

/* ------------------------------------------------------------------ */
/* E. 設定値の出所の記録                                                */
/* ------------------------------------------------------------------ */

describe("sync-config: 自物件の設定値の出所", () => {
  it("壊れた JSON・未知の項目・不正な値は捨てる", () => {
    assert.deepEqual(parseLuminaFieldMeta("{broken"), {});
    assert.deepEqual(parseLuminaFieldMeta(null), {});
    assert.deepEqual(
      parseLuminaFieldMeta(
        JSON.stringify({
          luminaRating: { source: "manual", at: "2026-11-19T00:00:00.000Z" },
          luminaReviews: { source: "other", at: "2026-11-19T00:00:00.000Z" },
          luminaPhotos: { source: "airroi", at: "not a date" },
          bogus: { source: "manual", at: "2026-11-19T00:00:00.000Z" },
        }),
      ),
      { luminaRating: { source: "manual", at: "2026-11-19T00:00:00.000Z", dataDate: null } },
    );
  });

  it("値が実際に変わった項目だけを手入力として記録し、空にした項目は記録を消す", async () => {
    const db = await freshDb();
    await saveSyncConfig(db, { luminaRating: 4.9, luminaReviews: 10, luminaAmenities: ["Wifi", "Sauna"] });
    await markLuminaFields(db, ["luminaReviews"], { source: "airroi", at: "2026-11-01T00:00:00.000Z", dataDate: "2026-10-30" });
    const prev = await getSyncConfig(db);
    await saveSyncConfig(db, { luminaRating: 4.93, luminaReviews: null, luminaAmenities: ["Wifi", "Sauna"], luminaPhotos: 30 });
    const next = await getSyncConfig(db);
    assert.deepEqual(changedLuminaFields(prev, next).sort(), ["luminaPhotos", "luminaRating", "luminaReviews"]);
    await recordManualLuminaEdits(db, prev, next, new Date("2026-11-19T02:00:00.000Z"));
    const meta = await getLuminaFieldMeta(db);
    assert.deepEqual(meta, {
      luminaRating: { source: "manual", at: "2026-11-19T02:00:00.000Z", dataDate: null },
      luminaPhotos: { source: "manual", at: "2026-11-19T02:00:00.000Z", dataDate: null },
    });
    // getSyncConfig は出所のキーがあっても壊れない
    assert.equal((await getSyncConfig(db)).luminaRating, 4.93);
    const raw = await db.execute({ sql: "SELECT value FROM sync_state WHERE key = ?", args: [LUMINA_FIELD_META_KEY] });
    assert.equal(raw.rows.length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* pricing/load.ts                                                     */
/* ------------------------------------------------------------------ */

describe("loadPricingInputs: 自社カレンダーの出所", () => {
  it("基準価格の代替行・出所の無い予約状況は使わず、AirROI の行は直近の取得が失敗していても使う", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db, { luminaSource: "api" });
    const today = seed.today;
    // 直近の取得は失敗 (manual) だが、AirROI で取得済みの行は残っている
    await db.execute("UPDATE sync_state SET value = 'manual' WHERE key = 'lumina_source'");
    await db.batch(
      [
        { sql: "UPDATE lumina_fuji_metrics SET price_source = 'base', configured_price = 110000 WHERE target_date = ?", args: [addDaysStr(today, 11)] },
        { sql: "UPDATE lumina_fuji_metrics SET status_source = NULL, is_booked = 1 WHERE target_date = ?", args: [addDaysStr(today, 13)] },
      ],
      "write",
    );
    const inputs = await loadPricingInputs(db);
    const own = new Map(inputs.own.map((o) => [o.date, o]));
    assert.equal(own.get(addDaysStr(today, 11))!.apiPrice, null, "基準価格の代替値は実価格ではない");
    assert.equal(own.get(addDaysStr(today, 12))!.apiPrice, 120012);
    assert.deepEqual([own.get(addDaysStr(today, 12))!.status, own.get(addDaysStr(today, 12))!.statusSource], ["booked", "api"]);
    assert.deepEqual([own.get(addDaysStr(today, 13))!.status, own.get(addDaysStr(today, 13))!.statusSource], ["vacant", "none"]);
    assert.equal(inputs.ownCalendarFetchedAt, "2026-01-01 00:00:00");
  });

  it("取得日時は保存されている AirROI の行から求める (直近の取得失敗・試行日時の削除でも消えない)", async () => {
    const db = await freshDb();
    await seedRealistic(db, { luminaSource: "api" });
    await db.execute("DELETE FROM sync_state WHERE key IN ('lumina_rates_ok_at', 'lumina_rates_at')");
    await db.execute("UPDATE sync_state SET value = 'manual' WHERE key = 'lumina_source'");
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, "2026-01-01 00:00:00");
    // AirROI の行が無ければ最終成功日時
    await db.execute("UPDATE lumina_fuji_metrics SET status_source = NULL");
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, null);
    await db.execute("INSERT INTO sync_state (key, value) VALUES ('lumina_rates_ok_at', '2026-02-01 00:00:00')");
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, "2026-02-01 00:00:00");
  });

  it("旧スキーマから移行後、取得が失敗しても取得日時は失敗前の日付のまま (未取得と表示しない)", async () => {
    const db = await oldShapeDb({
      lumina_source: "api",
      lumina_rates_at: "2026-11-03 01:02:03",
      "config:lumina_base_price": "110000",
    });
    await ensureSchema(db);
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, "2026-11-03 01:02:03");
    mockFetch(() => new Response("upstream error", { status: 503 }));
    const r = await refreshLuminaRates(db, await getSyncConfig(db));
    assert.equal(r.ok, false);
    assert.equal(
      (await db.execute("SELECT value FROM sync_state WHERE key = 'lumina_source'")).rows[0].value,
      "manual",
    );
    assert.equal((await loadPricingInputs(db)).ownCalendarFetchedAt, "2026-11-03 01:02:03");
  });
});
