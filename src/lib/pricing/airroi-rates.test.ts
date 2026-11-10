/**
 * データ層: airroi.ts の refreshRatesForProperty (料金カレンダーの UPSERT + calendar_snapshots への履歴保存)。
 * 外部 API は呼ばない (globalThis.fetch をモック)。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { refreshRatesForProperty } from "../airroi";
import { toDateStr, todayJst } from "../dates";
import { ensureSchema } from "../db";
import { addDaysStr } from "./holidays";

const realFetch = globalThis.fetch;
const realKey = process.env.AIRROI_API_KEY;
const realError = console.error;
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
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.AIRROI_API_KEY;
  else process.env.AIRROI_API_KEY = realKey;
  console.error = realError;
});

async function setup(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await ensureSchema(db);
  await db.execute(
    `INSERT INTO properties (id, airroi_id, title, area, max_guests, rates_synced_at)
     VALUES ('airroi_777', '777', 'Villa', '山中湖村', 8, '2020-01-01 00:00:00')`,
  );
  return db;
}

/** today−3 〜 today+200 の料金 (3日に1日は予約不可、today+50 は外れ値の異常高額) */
function ratesPayload(today: string) {
  const rates = [];
  for (let i = -3; i <= 200; i++) {
    const date = addDaysStr(today, i);
    const available = i % 3 !== 0;
    rates.push({
      date,
      rate: i === 50 ? 9_400_000 : available ? 80000 + i * 10 : 5_000_000,
      available,
      min_nights: i % 7 === 0 ? 2 : 1,
    });
  }
  return { rates };
}

describe("refreshRatesForProperty", () => {
  it("daily_metrics を UPSERT し、[今日JST, +134日] を今日付けのスナップショットとして保存する", async () => {
    const db = await setup();
    const today = toDateStr(todayJst());
    // 既存行: 過去の同期で保存された外れ値価格 (上限超過) は掃除され、通常価格は予約不可日でも保持される
    await db.execute({
      sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, fetched_at)
            VALUES ('airroi_777', ?, 7000000, 875000, 1, '2020-01-01 00:00:00'),
                   ('airroi_777', ?, 70000, 8750, 1, '2020-01-01 00:00:00')`,
      args: [addDaysStr(today, 3), addDaysStr(today, 6)],
    });
    mockFetch(() => new Response(JSON.stringify(ratesPayload(today)), { status: 200 }));

    const records = await refreshRatesForProperty(db, { id: "airroi_777", airroiId: "777", maxGuests: 8 });

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /\/listings\/future\/rates\?id=777&currency=native$/);
    assert.equal(records, 204, "戻り値は daily_metrics の書き込み件数 (スナップショット行は含めない)");

    const dm = await db.execute("SELECT * FROM daily_metrics WHERE property_id = 'airroi_777' ORDER BY target_date");
    assert.equal(dm.rows.length, 204);
    const byDate = new Map(dm.rows.map((r) => [String(r.target_date), r]));
    const d1 = byDate.get(addDaysStr(today, 1))!;
    assert.equal(Number(d1.price_jpy), 80010);
    assert.equal(Number(d1.price_per_person), 80010 / 8);
    assert.equal(Number(d1.is_available), 1);
    assert.equal(Number(byDate.get(addDaysStr(today, 7))!.min_nights), 2);
    // 予約不可日のダミー価格は採用しない (新規行は 0)
    assert.equal(Number(byDate.get(addDaysStr(today, 9))!.price_jpy), 0);
    assert.equal(Number(byDate.get(addDaysStr(today, 9))!.is_available), 0);
    // 外れ値 (中央値の8倍超) は 0
    assert.equal(Number(byDate.get(addDaysStr(today, 50))!.price_jpy), 0);
    // 既存の外れ値価格 (7,000,000 > 上限) は予約不可の更新で 0 に掃除される
    assert.equal(Number(byDate.get(addDaysStr(today, 3))!.price_jpy), 0);
    // 既存の通常価格は予約不可になっても保持される (価格情報の保持)
    assert.equal(Number(byDate.get(addDaysStr(today, 6))!.price_jpy), 70000);
    assert.equal(Number(byDate.get(addDaysStr(today, 6))!.is_available), 0);
    // fetched_at は今に更新される
    const stale = await db.execute(
      "SELECT COUNT(*) AS c FROM daily_metrics WHERE fetched_at < datetime('now', '-1 minutes')",
    );
    assert.equal(Number(stale.rows[0].c), 0);

    const snaps = await db.execute(
      "SELECT snapshot_date, target_date, is_available, price_jpy FROM calendar_snapshots ORDER BY target_date",
    );
    assert.equal(snaps.rows.length, 135);
    assert.ok(snaps.rows.every((r) => String(r.snapshot_date) === today));
    assert.equal(String(snaps.rows[0].target_date), today);
    assert.equal(String(snaps.rows[snaps.rows.length - 1].target_date), addDaysStr(today, 134));
    const snapByDate = new Map(snaps.rows.map((r) => [String(r.target_date), r]));
    assert.equal(Number(snapByDate.get(addDaysStr(today, 1))!.price_jpy), 80010);
    assert.equal(Number(snapByDate.get(addDaysStr(today, 3))!.is_available), 0);
    assert.equal(Number(snapByDate.get(addDaysStr(today, 3))!.price_jpy), 0);
    assert.equal(Number(snapByDate.get(addDaysStr(today, 50))!.price_jpy), 0);

    const p = await db.execute("SELECT rates_synced_at FROM properties WHERE id = 'airroi_777'");
    assert.notEqual(String(p.rows[0].rates_synced_at), "2020-01-01 00:00:00");

    // 同日に再取得 → スナップショットは上書き (行数は変わらない)
    mockFetch(() => {
      const payload = ratesPayload(today);
      payload.rates = payload.rates.map((r) => (r.date === addDaysStr(today, 1) ? { ...r, available: false } : r));
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    await refreshRatesForProperty(db, { id: "airroi_777", airroiId: "777", maxGuests: 8 });
    const again = await db.execute("SELECT COUNT(*) AS c FROM calendar_snapshots");
    assert.equal(Number(again.rows[0].c), 135);
    const day1 = await db.execute({
      sql: "SELECT is_available, price_jpy FROM calendar_snapshots WHERE target_date = ?",
      args: [addDaysStr(today, 1)],
    });
    assert.equal(Number(day1.rows[0].is_available), 0);
    assert.equal(Number(day1.rows[0].price_jpy), 0);
  });

  it("取得失敗時はスナップショットも daily_metrics も書かず、rates_synced_at だけ進める", async () => {
    const db = await setup();
    mockFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));
    const records = await refreshRatesForProperty(db, { id: "airroi_777", airroiId: "777", maxGuests: 8 });
    assert.equal(records, 0);
    assert.equal(fetchCalls.length, 1);
    const snaps = await db.execute("SELECT COUNT(*) AS c FROM calendar_snapshots");
    assert.equal(Number(snaps.rows[0].c), 0);
    const dm = await db.execute("SELECT COUNT(*) AS c FROM daily_metrics");
    assert.equal(Number(dm.rows[0].c), 0);
    const p = await db.execute("SELECT rates_synced_at FROM properties WHERE id = 'airroi_777'");
    assert.notEqual(String(p.rows[0].rates_synced_at), "2020-01-01 00:00:00");
  });

  it("通信エラー (fetch が例外) でもスナップショットは書かない", async () => {
    const db = await setup();
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const records = await refreshRatesForProperty(db, { id: "airroi_777", airroiId: "777", maxGuests: 8 });
    assert.equal(records, 0);
    const snaps = await db.execute("SELECT COUNT(*) AS c FROM calendar_snapshots");
    assert.equal(Number(snaps.rows[0].c), 0);
  });
});
