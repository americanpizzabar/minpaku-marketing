import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPace,
  buildBookingCurves,
  centralPrice,
  computeMarketDays,
  computePace,
  computePastDays,
  isotonicNonIncreasing,
  reservedShareFor,
  type PaceResult,
} from "./metrics";
import { DEFAULT_PRICING_CONFIG } from "./config";
import { addDaysStr, classifyNight } from "./holidays";
import type {
  BookingCurve,
  CalendarRow,
  CompSetMember,
  MarketDay,
  NightClass,
  PricingConfig,
  SnapshotRow,
} from "./types";

const TODAY = "2026-11-10"; // 火曜

function member(id: string, reservedShare: number | null = 0.8, distanceKm = 1): CompSetMember {
  return {
    id,
    title: id,
    url: null,
    area: "山中湖",
    distanceKm,
    maxGuests: 8,
    rating: 4.9,
    reviews: 20,
    adrRef: 110000,
    roomType: "entire_home",
    strict: true,
    entireHomeInferred: false,
    calendarStatus: "fresh",
    lastFetched: "2026-11-08",
    lastAttemptAt: "2026-11-08",
    reservedShare,
  };
}

function cfg(over: Partial<PricingConfig> = {}): PricingConfig {
  return { ...DEFAULT_PRICING_CONFIG, ...over };
}

function nightsOf(dates: string[]): Map<string, NightClass> {
  return new Map(dates.map((d) => [d, classifyNight(d, DEFAULT_PRICING_CONFIG.peakPeriods)]));
}

function row(propertyId: string, date: string, available: boolean, price: number, fetchedAt: string): CalendarRow {
  return { propertyId, date, available, price: available ? price : 0, fetchedAt };
}

function snap(propertyId: string, snapshotDate: string, date: string, available: boolean): SnapshotRow {
  return { propertyId, snapshotDate, date, available, price: available ? 100000 : 0 };
}

const close = (actual: number | null, expected: number, tol = 1e-9) => {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} != ${expected}`);
};

/* ------------------------------------------------------------------ */

test("reservedShareFor: クランプ・null は中央値・blockAdjust=false は 1", () => {
  const ms = [member("a", 0.8), member("b", null), member("c", 0.02), member("d", 1.5), member("e", 0.6)];
  const r = reservedShareFor(ms, cfg());
  // クランプ後の既知値 [0.05, 0.6, 0.8, 1] の中央値 = 0.7
  assert.equal(r.get("a"), 0.8);
  close(r.get("b") ?? null, 0.7);
  assert.equal(r.get("c"), 0.05);
  assert.equal(r.get("d"), 1);
  assert.equal(r.get("e"), 0.6);

  const off = reservedShareFor(ms, cfg({ blockAdjust: false }));
  assert.deepEqual([...off.values()], [1, 1, 1, 1, 1]);

  const allNull = reservedShareFor([member("a", null), member("b", null)], cfg());
  assert.deepEqual([...allNull.values()], [1, 1]);
  assert.equal(reservedShareFor([], cfg()).size, 0);
});

test("centralPrice: median / trimmed / 除外 / 空", () => {
  assert.equal(centralPrice([120000, 100000, 110000], "median"), 110000);
  assert.equal(centralPrice([100000, 120000], "median"), 110000);
  assert.equal(centralPrice([1, 2], "median"), 2); // 1.5 → 四捨五入
  assert.equal(centralPrice([0, -5, NaN, Infinity, 100], "median"), 100);
  assert.equal(centralPrice([], "median"), null);
  assert.equal(centralPrice([0, 0], "trimmed"), null);
  assert.equal(centralPrice([10, 20, 30], "trimmed"), 20); // g=1 → [20]
  assert.equal(centralPrice([1, 2, 3, 4, 100], "trimmed"), 3); // g=1 → mean(2,3,4)
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(centralPrice(twenty, "trimmed"), 11); // g=2 → mean(3..18)=10.5 → 11
  assert.equal(centralPrice([100, 300], "trimmed"), 200); // n<3 は中央値
});

/* ------------------------------------------------------------------ */

test("computeMarketDays: 3物件 r=0.8 の手計算 (単独日 = 縮小なし)", () => {
  const d = "2026-11-30"; // 月曜 lead 20
  const ms = [member("m1", 0.8, 1), member("m2", 0.8, 2), member("m3", 0.8, 3)];
  const cal = [
    row("m1", d, false, 0, "2026-11-08"),
    row("m2", d, true, 100000, "2026-11-08"),
    row("m3", d, true, 120000, "2026-11-08"),
    row("other", d, false, 0, "2026-11-08"), // member でない
  ];
  const m = computeMarketDays([d], nightsOf([d]), ms, cal, cfg(), TODAY).get(d) as MarketDay;
  assert.equal(m.units, 3);
  assert.equal(m.unavailable, 1);
  assert.equal(m.expectedBooked, 0.8);
  assert.equal(m.effectiveUnits, 2.8);
  assert.equal(m.occRaw, 33.3);
  assert.equal(m.occAdj, 28.6); // 0.8/2.8
  assert.equal(m.occ, 28.6); // 事前平均 = 自身 → 補正なし
  // a = 0.8+2·(2/7)+0.5, b = 2+2·(5/7)+0.5 → [9.29%, 55.24%]
  assert.deepEqual(m.occCi, [9.3, 55.2]);
  assert.equal(m.remaining, 2);
  assert.equal(m.remainingEst, 2);
  assert.equal(m.compAdr, 110000);
  assert.equal(m.priceCount, 2);
  assert.equal(m.maxAgeDays, 2);
  assert.deepEqual(m.listings, [
    { id: "m1", available: false, price: null },
    { id: "m2", available: true, price: 100000 },
    { id: "m3", available: true, price: 120000 },
  ]);
  assert.equal(m.dataQuality, "ok");
  assert.equal(m.pace, null);
  assert.equal(m.paceRaw, null);
  assert.equal(m.newBookings, null);
  assert.equal(m.spike, false);
});

test("computeMarketDays: 縮小推定は同区分の近い日だけを事前平均に使う", () => {
  const d1 = "2026-11-30"; // 月 lead 20
  const d2 = "2026-12-01"; // 火 lead 21
  const d3 = "2026-11-27"; // 金 lead 17 (週末: 事前平均に入らない)
  const ms = [member("m1"), member("m2"), member("m3")];
  const f = "2026-11-08";
  const cal = [
    row("m1", d1, false, 0, f),
    row("m2", d1, true, 100000, f),
    row("m3", d1, true, 120000, f),
    row("m1", d2, true, 100000, f),
    row("m2", d2, true, 100000, f),
    row("m3", d2, true, 100000, f),
    row("m1", d3, false, 0, f),
    row("m2", d3, false, 0, f),
    row("m3", d3, false, 0, f),
  ];
  const dates = [d3, d1, d2];
  const res = computeMarketDays(dates, nightsOf(dates), ms, cal, cfg(), TODAY);
  const m1 = res.get(d1) as MarketDay;
  // prior = d2 の 0/3 = 0 → occ = 0.8/(2.8+2) = 16.67%
  assert.equal(m1.occAdj, 28.6);
  assert.equal(m1.occ, 16.7);
  assert.deepEqual(m1.occCi, [1.9, 42.9]);
  // d2: prior = 0.8/2.8 → occ = 2·(2/7)/(3+2) = 11.43%
  assert.equal((res.get(d2) as MarketDay).occ, 11.4);
  // d3: 同区分の他の日なし → 補正なし
  const m3 = res.get(d3) as MarketDay;
  assert.equal(m3.occAdj, 100);
  assert.equal(m3.occ, 100);
  assert.equal(m3.remaining, 0);
  assert.equal(m3.compAdr, null);
  assert.equal(m3.priceCount, 0);

  // shrinkStrength = 0 なら occ = occAdj
  const k0 = computeMarketDays(dates, nightsOf(dates), ms, cal, cfg({ shrinkStrength: 0 }), TODAY);
  assert.equal((k0.get(d1) as MarketDay).occ, 28.6);
});

test("computeMarketDays: lead に応じた行の有効性・dataQuality・remainingEst", () => {
  const ms = ["m1", "m2", "m3", "m4", "m5"].map((id, i) => member(id, 0.8, i));
  const ages = [4, 5, 7, 10, 11];
  const dLead1 = "2026-11-11"; // 上限 max(4, 0) = 4
  const dLead12 = "2026-11-22"; // 上限 max(4, 6) = 6
  const dLead30 = "2026-12-10"; // 上限 min(10, max(4, 15)) = 10
  const dEmpty = "2026-12-20";
  const cal: CalendarRow[] = [];
  for (const d of [dLead1, dLead12, dLead30]) {
    ms.forEach((m, i) => cal.push(row(m.id, d, true, 100000 + i * 1000, addDaysStr(TODAY, -ages[i]))));
  }
  const dates = [dLead1, dLead12, dLead30, dEmpty];
  const res = computeMarketDays(dates, nightsOf(dates), ms, cal, cfg(), TODAY);
  const a = res.get(dLead1) as MarketDay;
  assert.equal(a.units, 1);
  assert.equal(a.maxAgeDays, 4);
  assert.equal(a.dataQuality, "low");
  assert.equal(a.remainingEst, 5); // round(1 × 5/1)
  const b = res.get(dLead12) as MarketDay;
  assert.equal(b.units, 2);
  assert.equal(b.maxAgeDays, 5);
  assert.equal(b.dataQuality, "low");
  assert.equal(b.remainingEst, 5); // round(2 × 5/2)
  assert.equal(b.compAdr, 100500);
  const c = res.get(dLead30) as MarketDay;
  assert.equal(c.units, 4);
  assert.equal(c.maxAgeDays, 10);
  assert.equal(c.dataQuality, "ok");
  assert.equal(c.occ, 0);
  const e = res.get(dEmpty) as MarketDay;
  assert.equal(e.units, 0);
  assert.equal(e.occRaw, null);
  assert.equal(e.occAdj, null);
  assert.equal(e.occ, null);
  assert.equal(e.occCi, null);
  assert.equal(e.remainingEst, null);
  assert.equal(e.maxAgeDays, null);
  assert.equal(e.compAdr, null);
  assert.deepEqual(e.listings, []);
  assert.equal(e.dataQuality, "none");
});

test("computeMarketDays: blockAdjust=false では occAdj = occRaw / 空入力でも NaN を出さない", () => {
  const d = "2026-11-30";
  const ms = [member("m1"), member("m2"), member("m3")];
  const cal = [row("m1", d, false, 0, TODAY), row("m2", d, true, 1, TODAY), row("m3", d, true, 1, TODAY)];
  const m = computeMarketDays([d], nightsOf([d]), ms, cal, cfg({ blockAdjust: false }), TODAY).get(d) as MarketDay;
  assert.equal(m.occRaw, 33.3);
  assert.equal(m.occAdj, 33.3);
  assert.equal(m.expectedBooked, 1);
  assert.equal(m.effectiveUnits, 3);

  const empty = computeMarketDays([d], nightsOf([d]), [], [], cfg(), TODAY).get(d) as MarketDay;
  assert.equal(empty.units, 0);
  assert.equal(empty.remainingEst, null);
  assert.equal(empty.dataQuality, "none");
  for (const v of Object.values(empty)) {
    if (typeof v === "number") assert.ok(Number.isFinite(v));
  }
});

/* ------------------------------------------------------------------ */

function curve(type: "weekday" | "weekend", fitted: { lead: number; occ: number }[]): BookingCurve {
  return { type, points: [], fitted, reach50: null, reach80: null, sampleSize: 0 };
}

test("computePace: 超過ペース = 生のペース − 予約曲線の期待値 (3物件 r=0.8)", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const dWd = "2026-11-30"; // 月 lead 20
  const dWe = "2026-11-28"; // 土
  const dFew = "2026-12-02"; // 2物件しか行がない
  const dPast = "2026-11-09"; // S より前 → 対象外
  const S = "2026-11-10";
  const C = "2026-11-03";
  const snaps: SnapshotRow[] = [];
  for (const m of ms) {
    snaps.push(snap(m.id, C, dWd, true), snap(m.id, C, dWe, true), snap(m.id, C, dPast, true));
    snaps.push(snap(m.id, S, dWd, m.id === "m3"), snap(m.id, S, dWe, m.id !== "m1"), snap(m.id, S, dPast, false));
  }
  snaps.push(snap("m1", C, dFew, true), snap("m2", C, dFew, true), snap("m1", S, dFew, false), snap("m2", S, dFew, false));
  // m1 は 11-05 にもあるが、7日に最も近い 11-03 を比較に使う
  snaps.push(snap("m1", "2026-11-05", dWd, false));
  const dates = [dWd, dWe, dFew, dPast];
  const curves = {
    weekday: curve("weekday", [
      { lead: 18, occ: 30 },
      { lead: 27, occ: 20 },
    ]),
    weekend: curve("weekend", []),
  };
  const res = computePace(dates, nightsOf(dates), ms, snaps, curves, cfg(), TODAY);

  // 平日: Σe_S = 0.8+0.8+1 = 2.6、Σ(b_S − b_C)/g = 1.6/7 → raw = 7·(1.6/7)/2.6 = 61.54pt
  // 期待: F(20)=F(18)=0.30 (最も近い lead)、F(27)=0.20 → 10pt
  const wd = res.byDate.get(dWd);
  assert.deepEqual(wd, { pace: 51.5, paceRaw: 61.5, paceExpected: 10, paceDays: 7, newBookings: 2 });
  // 週末: 曲線が空 → pace/paceExpected は null、raw = 0.8/2.8 = 28.57pt
  assert.deepEqual(res.byDate.get(dWe), {
    pace: null,
    paceRaw: 28.6,
    paceExpected: null,
    paceDays: 7,
    newBookings: 1,
  });
  const nulls = { pace: null, paceRaw: null, paceExpected: null, paceDays: null, newBookings: null };
  assert.deepEqual(res.byDate.get(dFew), nulls);
  assert.deepEqual(res.byDate.get(dPast), nulls);
  assert.equal(res.byDate.has("2026-12-25"), false);
  assert.equal(res.lastSnapshotDate, S);
  assert.equal(res.paceCompareDate, C);
  assert.equal(res.paceWindowDays, 7);
  assert.equal(res.paceAvailableFrom, null);
});

test("computePace: 間隔の異なる比較ペアは g_p で正規化 / 曲線なしなら paceAvailableFrom", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const d = "2026-11-30";
  const S = "2026-11-10";
  const snaps: SnapshotRow[] = [
    snap("m1", "2026-11-03", d, true),
    snap("m1", S, d, false),
    snap("m2", "2026-11-03", d, true),
    snap("m2", S, d, true),
    snap("m3", "2026-11-06", d, true), // g = 4
    snap("m3", S, d, false),
    snap("m3", "2026-11-01", d, true), // [S−7, S−3] の外
  ];
  const curves = { weekday: curve("weekday", []), weekend: curve("weekend", []) };
  const res = computePace([d], nightsOf([d]), ms, snaps, curves, cfg({ blockAdjust: false }), TODAY);
  // raw = 7·(1/7 + 0 + 1/4)/3 = 91.67pt
  assert.deepEqual(res.byDate.get(d), {
    pace: null,
    paceRaw: 91.7,
    paceExpected: null,
    paceDays: 6,
    newBookings: 2,
  });
  assert.equal(res.paceCompareDate, "2026-11-03"); // 2票 vs 1票
  assert.equal(res.paceWindowDays, 6);
  assert.equal(res.paceAvailableFrom, "2026-11-13"); // pace が1つも無い → 最小 S_p + 3
});

test("computePace: 比較できる過去スナップショットが無い / 古いスナップショットのみ", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const d = "2026-11-30";
  const curves = { weekday: curve("weekday", [{ lead: 0, occ: 50 }]), weekend: curve("weekend", []) };
  const onlyS = ms.map((m) => snap(m.id, "2026-11-09", d, true));
  onlyS.push(snap("m1", "2026-11-07", d, true)); // m1 の S は 11-07 ではなく 11-09
  const r1 = computePace([d], nightsOf([d]), ms, onlyS, curves, cfg(), TODAY);
  assert.equal(r1.byDate.get(d)?.pace, null);
  assert.equal(r1.lastSnapshotDate, "2026-11-09");
  assert.equal(r1.paceCompareDate, null);
  assert.equal(r1.paceWindowDays, null);
  assert.equal(r1.paceAvailableFrom, "2026-11-12");

  const old = ms.map((m) => snap(m.id, "2026-10-20", d, true));
  const r2 = computePace([d], nightsOf([d]), ms, old, curves, cfg(), TODAY);
  assert.equal(r2.lastSnapshotDate, null);
  assert.equal(r2.paceAvailableFrom, null);

  const r3 = computePace([d], nightsOf([d]), [], [], curves, cfg(), TODAY);
  assert.equal(r3.byDate.get(d)?.paceRaw, null);
  assert.equal(r3.lastSnapshotDate, null);
});

test("applyPace: 値の書き込みと spike 判定 (minPt 20, minNewBookings 2)", () => {
  const dates = ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03"];
  const market = computeMarketDays(dates, nightsOf(dates), [], [], cfg(), TODAY);
  for (const m of market.values()) m.dataQuality = "ok";
  const pace: PaceResult = {
    byDate: new Map([
      ["2026-11-30", { pace: 20, paceRaw: 25, paceExpected: 5, paceDays: 7, newBookings: 2 }],
      ["2026-12-01", { pace: 25, paceRaw: 30, paceExpected: 5, paceDays: 7, newBookings: 1 }],
      ["2026-12-02", { pace: 19.9, paceRaw: 25, paceExpected: 5.1, paceDays: 7, newBookings: 3 }],
    ]),
    lastSnapshotDate: null,
    paceCompareDate: null,
    paceWindowDays: null,
    paceAvailableFrom: null,
  };
  applyPace(market, pace, cfg());
  const a = market.get("2026-11-30") as MarketDay;
  assert.equal(a.spike, true);
  assert.equal(a.pace, 20);
  assert.equal(a.paceRaw, 25);
  assert.equal(a.paceExpected, 5);
  assert.equal(a.paceDays, 7);
  assert.equal(a.newBookings, 2);
  assert.equal(market.get("2026-12-01")?.spike, false);
  assert.equal(market.get("2026-12-02")?.spike, false);
  assert.equal(market.get("2026-12-03")?.spike, false);
  assert.equal(market.get("2026-12-03")?.pace, null);
  // 占有率が使えないデータ不足の日は、Pace が閾値を超えても要注意日にしない
  const weak = computeMarketDays(["2026-11-30"], nightsOf(["2026-11-30"]), [], [], cfg(), TODAY);
  applyPace(weak, pace, cfg());
  assert.equal(weak.get("2026-11-30")?.pace, 20);
  assert.equal(weak.get("2026-11-30")?.spike, false);
});

/* ------------------------------------------------------------------ */

const iso = (ys: number[], ws?: number[]) =>
  isotonicNonIncreasing(ys.map((y, x) => ({ x, y, w: ws ? ws[x] : 1 })));

test("isotonicNonIncreasing: 既知の PAV の例", () => {
  assert.deepEqual(isotonicNonIncreasing([]), []);
  assert.deepEqual(iso([5, 3, 1]), [
    { x: 0, y: 5 },
    { x: 1, y: 3 },
    { x: 2, y: 1 },
  ]);
  assert.deepEqual(
    iso([1, 2, 3]).map((p) => p.y),
    [2, 2, 2],
  );
  assert.deepEqual(
    iso([3, 1, 2]).map((p) => p.y),
    [3, 1.5, 1.5],
  );
  // 非減少版の古典例 [1,3,2,4,3,5] → [1,2.5,2.5,3.5,3.5,5] を反転したもの
  assert.deepEqual(
    iso([5, 3, 4, 2, 3, 1]).map((p) => p.y),
    [5, 3.5, 3.5, 2.5, 2.5, 1],
  );
  // 連鎖的な併合: [1,2,3,10] → 全体平均 4
  assert.deepEqual(
    iso([1, 2, 3, 10]).map((p) => p.y),
    [4, 4, 4, 4],
  );
  // 等しい値 (ties) はそのまま
  assert.deepEqual(
    iso([2, 2, 1, 1]).map((p) => p.y),
    [2, 2, 1, 1],
  );
});

test("isotonicNonIncreasing: 重み・同じ x のまとめ・順不同・無効点", () => {
  // (1·1 + 3·4)/4 = 3.25
  assert.deepEqual(
    iso([1, 4], [1, 3]).map((p) => p.y),
    [3.25, 3.25],
  );
  // 重み付きの違反: [10 (w1), 0 (w1), 6 (w3)] → 後ろ2つ併合 (0+18)/4 = 4.5
  assert.deepEqual(
    iso([10, 0, 6], [1, 1, 3]).map((p) => p.y),
    [10, 4.5, 4.5],
  );
  // 同じ x は重み付き平均: x=0 → (2+4)/2 = 3、x=1 は 5 (w2) → 違反 → (3·2 + 5·2)/4 = 4
  assert.deepEqual(
    isotonicNonIncreasing([
      { x: 0, y: 2, w: 1 },
      { x: 1, y: 5, w: 2 },
      { x: 0, y: 4, w: 1 },
    ]),
    [
      { x: 0, y: 4 },
      { x: 1, y: 4 },
    ],
  );
  // 順不同の入力
  assert.deepEqual(
    isotonicNonIncreasing([
      { x: 2, y: 1, w: 1 },
      { x: 0, y: 3, w: 1 },
      { x: 1, y: 2, w: 1 },
    ]),
    [
      { x: 0, y: 3 },
      { x: 1, y: 2 },
      { x: 2, y: 1 },
    ],
  );
  // w<=0・非有限は無視
  assert.deepEqual(
    isotonicNonIncreasing([
      { x: 0, y: 1, w: 0 },
      { x: 1, y: 9, w: -1 },
      { x: 2, y: NaN, w: 1 },
      { x: 3, y: 2, w: Infinity },
      { x: 4, y: 7, w: 1 },
    ]),
    [{ x: 4, y: 7 }],
  );
});

/* ------------------------------------------------------------------ */

test("buildBookingCurves: 点のまとめ・現在と最新スナップショットの重複除去・fitted・reach", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const c = cfg({ blockAdjust: false });
  const dWd = "2026-11-30"; // 月 lead 20
  const dWe = "2026-11-28"; // 土 lead 18
  const listings = (unavail: string[]) =>
    ms.map((m) => ({ id: m.id, available: !unavail.includes(m.id), price: unavail.includes(m.id) ? null : 100000 }));
  const market = computeMarketDays([dWd, dWe], nightsOf([dWd, dWe]), [], [], c, TODAY);
  (market.get(dWd) as MarketDay).listings = listings(["m1", "m2"]);
  (market.get(dWe) as MarketDay).listings = listings(["m1"]);

  const snaps: SnapshotRow[] = [];
  for (const m of ms) {
    snaps.push(snap(m.id, "2026-11-03", dWd, true)); // lead 27, 0%
    snaps.push(snap(m.id, "2026-11-10", dWd, true)); // 最新スナップショット = 現在と同じ (p,d) → 除外
    snaps.push(snap(m.id, "2026-11-01", dWe, false)); // lead 27, 100%
    snaps.push(snap(m.id, "2026-11-01", "2027-03-01", true)); // lead 120 > horizon → 除外
  }
  snaps.push(snap("x", "2026-11-03", dWd, false)); // member 以外

  const { weekday, weekend } = buildBookingCurves(ms, snaps, market, c, TODAY);

  assert.equal(weekday.type, "weekday");
  assert.deepEqual(weekday.points, [
    { lead: 21, occ: 66.7, date: dWd, source: "current" },
    { lead: 27, occ: 0, date: dWd, source: "snapshot" },
  ]);
  assert.equal(weekday.sampleSize, 2);
  // lead 20 の観測は L=18..22、lead 27 は L=25..29 に入る (すでに単調)
  assert.deepEqual(weekday.fitted, [
    { lead: 18, occ: 66.7 },
    { lead: 19, occ: 66.7 },
    { lead: 20, occ: 66.7 },
    { lead: 21, occ: 66.7 },
    { lead: 22, occ: 66.7 },
    { lead: 25, occ: 0 },
    { lead: 26, occ: 0 },
    { lead: 27, occ: 0 },
    { lead: 28, occ: 0 },
    { lead: 29, occ: 0 },
  ]);
  assert.equal(weekday.reach50, 22);
  assert.equal(weekday.reach80, null);

  // 週末: 近い lead (33.3%) より遠い lead (100%) が高い → 全体を併合して 66.7%
  assert.deepEqual(weekend.points, [
    { lead: 18, occ: 33.3, date: dWe, source: "current" },
    { lead: 27, occ: 100, date: dWe, source: "snapshot" },
  ]);
  assert.equal(weekend.fitted.length, 10);
  assert.ok(weekend.fitted.every((f) => f.occ === 66.7));
  assert.equal(weekend.reach50, 29);
  assert.equal(weekend.reach80, null);
});

test("buildBookingCurves: 観測数が minUnits 未満の組は点にしない / 空入力 / 400点への間引き", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const d = "2026-11-30";
  const market = computeMarketDays([d], nightsOf([d]), [], [], cfg(), TODAY);
  (market.get(d) as MarketDay).listings = [{ id: "m1", available: false, price: null }];
  const few = buildBookingCurves(ms, [], market, cfg(), TODAY);
  assert.deepEqual(few.weekday.points, []);
  assert.equal(few.weekday.sampleSize, 0);
  // 1物件だけの観測では市場の予約曲線にしない (本番の初期状態で 1件の予約が「週末は12日前に100%」になっていた)
  assert.deepEqual(few.weekday.fitted, []);
  assert.equal(few.weekday.reach80, null);

  (market.get(d) as MarketDay).listings = ms.map((m) => ({ id: m.id, available: false, price: null }));
  const three = buildBookingCurves(ms, [], market, cfg(), TODAY);
  assert.equal(three.weekday.fitted.length, 5); // lead 22 の ±2 日
  assert.equal(three.weekday.reach80, 22); // r=0.8 → 0.8/0.8 = 100%

  const none = buildBookingCurves([], [], new Map(), cfg(), TODAY);
  assert.deepEqual(none.weekday, {
    type: "weekday",
    points: [],
    fitted: [],
    reach50: null,
    reach80: null,
    sampleSize: 0,
  });
  assert.equal(none.weekend.type, "weekend");

  // 毎日のスナップショット 100日分 × 宿泊日 70日分 → 平日の点は 400 を超える
  const snaps: SnapshotRow[] = [];
  for (let s = 0; s < 100; s++) {
    const sd = addDaysStr("2026-08-03", s);
    for (let t = 0; t < 70; t++) {
      const td = addDaysStr("2026-09-01", t);
      if (td < sd) continue;
      for (const m of ms) snaps.push(snap(m.id, sd, td, (s + t + m.id.length) % 3 !== 0));
    }
  }
  const big = buildBookingCurves(ms, snaps, new Map(), cfg(), TODAY);
  assert.ok(big.weekday.sampleSize > 400, String(big.weekday.sampleSize));
  assert.equal(big.weekday.points.length, 400);
  for (let i = 1; i < big.weekday.points.length; i++) {
    assert.ok(big.weekday.points[i - 1].lead <= big.weekday.points[i].lead);
  }
  // fitted は単調非増加
  for (let i = 1; i < big.weekday.fitted.length; i++) {
    assert.ok(big.weekday.fitted[i - 1].occ >= big.weekday.fitted[i].occ);
  }
});

/* ------------------------------------------------------------------ */

test("computePastDays: 実績占有率・compAdr・pickup7・自社状況", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const d = "2026-11-05";
  const cal = [
    row("m1", d, false, 0, "2026-11-01"),
    row("m2", d, true, 100000, "2026-11-04"),
    row("m3", d, true, 90000, "2026-10-20"), // d − 10 より古い → 除外
    row("m3", d, true, 90000, "2026-11-06"), // d より後の取得 → 除外
  ];
  const snaps: SnapshotRow[] = [
    snap("m1", "2026-11-05", d, false),
    snap("m2", "2026-11-05", d, false),
    snap("m3", "2026-11-05", d, false),
    snap("m1", "2026-11-07", d, true), // d より後 → s1 にしない
    snap("m1", "2026-10-29", d, true),
    snap("m2", "2026-10-29", d, false),
    snap("m3", "2026-10-27", d, true), // s1−7 から2日 (同距離なら古い方)
    snap("m3", "2026-10-31", d, false), // s1−7 から2日
    snap("m3", "2026-10-25", d, false), // [s1−10, s1−4] の外
  ];
  const own = [{ date: d, apiPrice: 120000, status: "booked" as const, statusSource: "ical" as const }];
  const past = computePastDays(TODAY, ms, cal, snaps, own, cfg());
  assert.equal(past.length, 14);
  assert.equal(past[0].date, "2026-10-27");
  assert.equal(past[13].date, "2026-11-09");
  const p = past.find((x) => x.date === d);
  assert.ok(p);
  assert.equal(p.units, 2);
  assert.equal(p.occ, 44.4); // 0.8 / 1.8
  assert.equal(p.compAdr, 100000);
  // s1: 全て予約不可 → 100%。s0: b = 0.8, e = 1+0.8+1 = 2.8 → 28.57% → +71.4pt
  assert.equal(p.pickup7, 71.4);
  assert.deepEqual(p.own, { status: "booked", currentPrice: 120000 });
  assert.equal(p.night.date, d);
  assert.equal(p.night.type, "weekday"); // 木曜

  const fri = past.find((x) => x.date === "2026-11-06");
  assert.equal(fri?.night.type, "weekend");
  assert.equal(fri?.units, 0);
  assert.equal(fri?.occ, null);
  assert.equal(fri?.compAdr, null);
  assert.equal(fri?.pickup7, null);
  assert.deepEqual(fri?.own, { status: "vacant", currentPrice: null });
});

test("computePastDays: pickup7 は比較できる物件が minUnits 未満なら null / 空入力", () => {
  const ms = [member("m1"), member("m2"), member("m3")];
  const d = "2026-11-05";
  const snaps = [
    snap("m1", "2026-11-05", d, false),
    snap("m1", "2026-10-29", d, true),
    snap("m2", "2026-11-05", d, false),
    snap("m2", "2026-10-29", d, true),
    snap("m3", "2026-11-05", d, false), // s0 なし
  ];
  const past = computePastDays(TODAY, ms, [], snaps, [], cfg());
  assert.equal(past.find((x) => x.date === d)?.pickup7, null);
  const ok = computePastDays(TODAY, ms, [], snaps, [], cfg({ minUnitsForSignal: 2 }));
  assert.equal(ok.find((x) => x.date === d)?.pickup7, 100);

  const empty = computePastDays(TODAY, [], [], [], [], cfg());
  assert.equal(empty.length, 14);
  assert.ok(empty.every((x) => x.occ === null && x.compAdr === null && x.pickup7 === null && x.units === 0));
});
