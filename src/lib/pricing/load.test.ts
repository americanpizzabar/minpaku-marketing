/**
 * データ層: load.ts (DB → PricingInputs) と、その結果での computePricingDashboard の健全性。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePricingDashboard } from "./compute";
import {
  LUMINA_LAT,
  LUMINA_LNG,
  OWN_LISTING_ID,
  findNonFinite,
  freshDb,
  propertyStmt,
  seedRealistic,
  villaDetails,
} from "./data-fixtures.test";
import { addDaysStr, diffDays } from "./holidays";
import { loadCandidates, loadPricingInputs, selectCompsetRefreshTargets } from "./load";
import { savePricingConfig } from "./config-store";
import { DEFAULT_PRICING_CONFIG } from "./config";

const realWebhook = process.env.ALERT_WEBHOOK_URL;
beforeEach(() => {
  delete process.env.ALERT_WEBHOOK_URL;
});
afterEach(() => {
  if (realWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = realWebhook;
});

describe("loadCandidates", () => {
  it("details_json・参照ADR・取得日 (JST) を対応付け、自社と範囲外を除外する", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const cands = await loadCandidates(db, LUMINA_LAT, LUMINA_LNG, 8, OWN_LISTING_ID);
    const ids = new Set(cands.map((c) => c.id));
    for (const id of seed.fresh) assert.ok(ids.has(id), id);
    assert.ok(ids.has(seed.stale));
    assert.ok(ids.has(seed.none));
    assert.ok(ids.has(seed.failed));
    assert.ok(ids.has(seed.hotel));
    assert.ok(ids.has(seed.brokenJson), "details_json が壊れていても候補には残る (json_extract で失敗しない)");
    assert.ok(!ids.has(seed.own), "自社は除外");
    assert.ok(!ids.has(seed.far), "バウンディングボックス外は除外");
    assert.ok(!ids.has(seed.noLocation), "緯度経度の無い物件はボックスで除外");
    assert.ok(!ids.has("manual_1"), "airroi_ 以外の id は除外");

    const byId = new Map(cands.map((c) => [c.id, c]));
    const v0 = byId.get("airroi_100")!;
    assert.equal(v0.roomType, "entire_home");
    assert.equal(v0.listingType, "Entire villa");
    assert.equal(v0.propertyType, "villa");
    assert.equal(v0.maxGuests, 6);
    assert.equal(v0.reviews, 10);
    assert.equal(v0.adrRef, 95000);
    assert.equal(v0.url, "https://www.airbnb.com/rooms/100");
    assert.ok(Math.abs(v0.reservedShare! - 200 / 240) < 1e-9);
    assert.equal(v0.ratesSyncedAt, addDaysStr(seed.today, -1));
    assert.equal(v0.lastAttemptAt, addDaysStr(seed.today, -1));
    assert.equal(byId.get(seed.stale)!.ratesSyncedAt, addDaysStr(seed.today, -20));
    assert.equal(byId.get(seed.none)!.ratesSyncedAt, null);
    assert.equal(byId.get(seed.none)!.lastAttemptAt, null);
    assert.equal(byId.get(seed.failed)!.ratesSyncedAt, null, "試行しても成功データが無ければ null");
    assert.equal(byId.get(seed.failed)!.lastAttemptAt, addDaysStr(seed.today, -2));
    assert.equal(byId.get(seed.hotel)!.roomType, "hotel_room");
    const broken = byId.get(seed.brokenJson)!;
    assert.equal(broken.roomType, null);
    assert.equal(broken.reservedShare, null);
    assert.equal(broken.adrRef, null, "l90/ttm が 0 なら参照ADRなし");
  });

  it("緯度経度が null なら全件 (自社は除外)、ownListingId が null なら自社も含む", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const all = await loadCandidates(db, null, null, 8, OWN_LISTING_ID);
    const ids = new Set(all.map((c) => c.id));
    assert.ok(ids.has(seed.far));
    assert.ok(ids.has(seed.noLocation));
    assert.ok(!ids.has(seed.own));
    const withOwn = await loadCandidates(db, null, null, 8, null);
    assert.ok(withOwn.some((c) => c.id === seed.own));
  });

  it("ratesSyncedAt は MAX(daily_metrics.fetched_at) の JST 日付、lastAttemptAt は rates_synced_at の JST 日付", async () => {
    const db = await freshDb();
    await db.execute(
      propertyStmt({ id: "airroi_1", lat: LUMINA_LAT, lng: LUMINA_LNG, details: villaDetails(), ratesSyncedAt: "'2026-01-07 15:00:00'" }),
    );
    await db.execute(`INSERT INTO daily_metrics (property_id, target_date, price_jpy, is_available, fetched_at) VALUES
      ('airroi_1', '2026-02-01', 1, 1, '2026-01-03 10:00:00'),
      ('airroi_1', '2026-02-02', 1, 1, '2026-01-05 16:30:00')`);
    const [c] = await loadCandidates(db, LUMINA_LAT, LUMINA_LNG, 8, null);
    assert.equal(c.ratesSyncedAt, "2026-01-06", "UTC 16:30 は JST の翌日");
    assert.equal(c.lastAttemptAt, "2026-01-08", "UTC 15:00 は JST の翌日 0時");
  });

  it("経度方向のボックスは緯度で補正される (radiusKm 相当)", async () => {
    const db = await freshDb();
    // 東へ約 9km (経度 0.099°×cos(35.4°)×111km ≈ 8.96km) と 約 7km
    await db.batch(
      [
        propertyStmt({ id: "airroi_e9", lat: LUMINA_LAT, lng: LUMINA_LNG + 0.099, details: villaDetails() }),
        propertyStmt({ id: "airroi_e7", lat: LUMINA_LAT, lng: LUMINA_LNG + 0.077, details: villaDetails() }),
        propertyStmt({ id: "airroi_n9", lat: LUMINA_LAT + 0.081, lng: LUMINA_LNG, details: villaDetails() }),
      ],
      "write",
    );
    const ids = (await loadCandidates(db, LUMINA_LAT, LUMINA_LNG, 8, null)).map((c) => c.id).sort();
    assert.deepEqual(ids, ["airroi_e7"]);
  });
});

describe("loadPricingInputs (DB)", () => {
  it("calendar / snapshots / own / iCal / 通知の各項目を仕様どおりに組み立てる", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db, { luminaSource: "api" });
    process.env.ALERT_WEBHOOK_URL = "  'https://hooks.example.invalid/x'  ";
    const inputs = await loadPricingInputs(db);
    const { today } = seed;
    const H = inputs.config.horizonDays;

    assert.equal(inputs.dataSource, "turso");
    assert.equal(inputs.today, today);
    assert.deepEqual(inputs.lumina, {
      lat: LUMINA_LAT,
      lng: LUMINA_LNG,
      basePrice: 110000,
      listingId: OWN_LISTING_ID,
      priceSource: "api",
      maxGuests: 8,
    });
    assert.ok(!inputs.candidates.some((c) => c.id === seed.own));

    // calendar: 候補のみ、[today−14, today+H+7]、fetchedAt は JST 日付、予約不可日は価格 0
    const calFrom = addDaysStr(today, -14);
    const calTo = addDaysStr(today, H + 7);
    assert.ok(inputs.calendar.length > 0);
    assert.ok(inputs.calendar.every((r) => r.date >= calFrom && r.date <= calTo));
    assert.ok(inputs.calendar.every((r) => r.available || r.price === 0));
    const candIds = new Set(inputs.candidates.map((c) => c.id));
    assert.ok(inputs.calendar.every((r) => candIds.has(r.propertyId)));
    assert.ok(inputs.calendar.filter((r) => r.propertyId === "airroi_100").every((r) => r.fetchedAt === addDaysStr(today, -1)));
    assert.ok(inputs.calendar.filter((r) => r.propertyId === seed.stale).every((r) => r.fetchedAt === addDaysStr(today, -20)));

    // snapshots: CompSet member のみ (ホテルは含まない)、snapshot_date >= today−120、target ∈ [today−24, today+H+7]
    assert.ok(inputs.snapshots.length > 0);
    assert.ok(!inputs.snapshots.some((s) => s.propertyId === seed.hotel));
    assert.ok(inputs.snapshots.every((s) => s.snapshotDate >= addDaysStr(today, -120)));
    assert.ok(inputs.snapshots.every((s) => s.date >= addDaysStr(today, -24) && s.date <= calTo));
    assert.ok(inputs.snapshots.every((s) => s.available || s.price === 0));
    const snapDates = new Set(inputs.snapshots.map((s) => s.snapshotDate));
    assert.deepEqual([...snapDates].sort(), [addDaysStr(today, -20), addDaysStr(today, -8), addDaysStr(today, -1)]);

    // own: [today−14, today+H] の連続した日付
    assert.equal(inputs.own.length, H + 15);
    assert.equal(inputs.own[0].date, addDaysStr(today, -14));
    assert.equal(inputs.own[inputs.own.length - 1].date, addDaysStr(today, H));
    inputs.own.forEach((o, i) => assert.equal(diffDays(inputs.own[0].date, o.date), i));
    const own = new Map(inputs.own.map((o) => [diffDays(today, o.date), o]));
    assert.deepEqual(own.get(4), { date: addDaysStr(today, 4), apiPrice: 120004, status: "vacant", statusSource: "manual" });
    assert.deepEqual(own.get(5), { date: addDaysStr(today, 5), apiPrice: 120005, status: "booked", statusSource: "manual" });
    assert.equal(own.get(6)!.status, "blocked");
    assert.equal(own.get(6)!.statusSource, "manual");
    assert.deepEqual([own.get(7)!.status, own.get(7)!.statusSource], ["booked", "ical"]);
    assert.deepEqual([own.get(8)!.status, own.get(8)!.statusSource], ["blocked", "ical"], "iCal が API より優先");
    assert.deepEqual([own.get(9)!.status, own.get(9)!.statusSource], ["vacant", "api"], "不正な手動状態は無視");
    assert.deepEqual([own.get(10)!.status, own.get(10)!.statusSource], ["vacant", "api"]);
    assert.equal(own.get(10)!.apiPrice, null, "configured_price 0 は価格なし");
    assert.deepEqual([own.get(12)!.status, own.get(12)!.statusSource], ["booked", "api"], "API の is_booked=1");
    assert.deepEqual([own.get(-3)!.status, own.get(-3)!.statusSource], ["booked", "manual"]);
    assert.deepEqual([own.get(H)!.status, own.get(H)!.statusSource], ["vacant", "none"], "データの無い日は未連携");
    assert.equal(own.get(H)!.apiPrice, null);

    assert.equal(inputs.icalConfigured, false);
    assert.deepEqual(inputs.icalLastImport, { at: "2026-01-01T00:00:00.000Z", ok: false, imported: 0, error: "HTTP 404" });
    assert.equal(inputs.alertChannel, "webhook");
    assert.equal(inputs.lastNotifiedAt, "2026-01-02 22:00:05", "'skipped' は送信扱いにしない");

    // ダッシュボード: 61日、NaN/Infinity なし
    const dash = computePricingDashboard(inputs);
    assert.equal(dash.days.length, 61);
    assert.equal(dash.dataSource, "turso");
    assert.deepEqual(findNonFinite(dash), []);
    assert.ok(dash.compset.members.length >= 8);
    assert.ok(!dash.compset.members.some((m) => m.id === seed.hotel || m.id === seed.own));
    assert.equal(dash.past.length, 14);
  });

  it("priceSource が manual なら API の価格・予約は使わない", async () => {
    const db = await freshDb();
    await seedRealistic(db, { luminaSource: "manual" });
    const inputs = await loadPricingInputs(db);
    assert.equal(inputs.lumina.priceSource, "manual");
    assert.ok(inputs.own.every((o) => o.apiPrice === null));
    assert.ok(inputs.own.every((o) => o.statusSource === "manual" || o.statusSource === "ical" || o.statusSource === "none"));
    assert.equal(inputs.alertChannel, "none");
    assert.deepEqual(findNonFinite(computePricingDashboard(inputs)), []);
  });

  it("空の DB (新規) でも例外を投げずダッシュボードが作れる", async () => {
    const db = await freshDb();
    const inputs = await loadPricingInputs(db);
    assert.equal(inputs.dataSource, "turso");
    assert.equal(inputs.candidates.length, 0);
    assert.equal(inputs.lumina.lat, null);
    assert.equal(inputs.icalLastImport, null);
    assert.equal(inputs.lastNotifiedAt, null);
    const dash = computePricingDashboard(inputs);
    assert.equal(dash.days.length, 61);
    assert.deepEqual(findNonFinite(dash), []);
  });

  it("db が null ならデモ", async () => {
    const inputs = await loadPricingInputs(null);
    assert.equal(inputs.dataSource, "demo");
  });

  it("壊れた iCal 取り込み結果・設定 JSON は既定値に倒す", async () => {
    const db = await freshDb();
    await seedRealistic(db);
    await db.execute("UPDATE sync_state SET value = '{broken' WHERE key = 'pricing:ical_last_import'");
    await db.execute("INSERT INTO sync_state (key, value) VALUES ('config:pricing', 'not json')");
    const inputs = await loadPricingInputs(db);
    assert.equal(inputs.icalLastImport, null);
    assert.equal(inputs.config.horizonDays, DEFAULT_PRICING_CONFIG.horizonDays);
  });
});

describe("selectCompsetRefreshTargets", () => {
  it("CompSet member のうち古い/未取得のものを古い順に (失敗・今日試行済みは除外)", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const r = await selectCompsetRefreshTargets(db);
    assert.deepEqual(r.ids, [seed.none, seed.stale]);
    // staleDays 1 なら昨日取得の物件も対象 (null → 古い順)
    const r1 = await selectCompsetRefreshTargets(db, { staleDays: 1 });
    assert.equal(r1.ids[0], seed.none);
    assert.equal(r1.ids[1], seed.stale);
    assert.equal(r1.ids.length, 11, "failed 以外の member");
    assert.ok(!r1.ids.includes(seed.failed));
    assert.ok(!r1.ids.includes(seed.hotel));
    // ids との積集合・limit
    const r2 = await selectCompsetRefreshTargets(db, { staleDays: 1, ids: [seed.stale, seed.hotel, "airroi_100"], limit: 5 });
    assert.deepEqual(r2.ids, [seed.stale, "airroi_100"]);
    const r3 = await selectCompsetRefreshTargets(db, { staleDays: 1, limit: 2 });
    assert.equal(r3.ids.length, 2);
    const r0 = await selectCompsetRefreshTargets(db, { limit: 0 });
    assert.deepEqual(r0.ids, []);
    // 今日試行済みは除外
    await db.execute({ sql: "UPDATE properties SET rates_synced_at = datetime('now') WHERE id = ?", args: [seed.stale] });
    const r4 = await selectCompsetRefreshTargets(db);
    assert.deepEqual(r4.ids, [seed.none]);
  });

  it("基準価格が未設定なら空 (課金しない)", async () => {
    const db = await freshDb();
    await seedRealistic(db);
    await db.execute("UPDATE sync_state SET value = '0' WHERE key = 'config:lumina_base_price'");
    assert.deepEqual((await selectCompsetRefreshTargets(db, { staleDays: 1 })).ids, []);
    // エンジン設定の基準価格があればそれを使う
    await savePricingConfig(db, { ...DEFAULT_PRICING_CONFIG, basePriceWeekday: 110000 });
    assert.ok((await selectCompsetRefreshTargets(db, { staleDays: 1 })).ids.length > 0);
  });
});
