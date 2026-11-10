import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, isEntireHome, passesFilters, selectCompSet } from "./compset";
import { DEFAULT_PRICING_CONFIG } from "./config";
import type { CandidateProperty, CompSetFilterConfig, PricingConfig } from "./types";

const TODAY = "2026-11-10";
const LUMINA = { lat: 35.42, lng: 138.87, listingId: "999" };
const BASE = 110000;

function cand(id: string, over: Partial<CandidateProperty> = {}): CandidateProperty {
  return {
    id,
    title: `Villa ${id}`,
    url: null,
    area: "山中湖",
    lat: 35.42,
    lng: 138.88,
    roomType: "entire_home",
    listingType: "Entire villa",
    propertyType: "villa",
    maxGuests: 8,
    rating: 4.9,
    reviews: 20,
    adrRef: 110000,
    reservedShare: 0.8,
    ratesSyncedAt: "2026-11-08",
    lastAttemptAt: "2026-11-08",
    ...over,
  };
}

function cfg(over: Partial<PricingConfig> = {}, cs: Partial<CompSetFilterConfig> = {}): PricingConfig {
  return { ...DEFAULT_PRICING_CONFIG, ...over, compset: { ...DEFAULT_PRICING_CONFIG.compset, ...cs } };
}

const F: CompSetFilterConfig = DEFAULT_PRICING_CONFIG.compset;

test("haversineKm", () => {
  assert.equal(haversineKm(35, 139, 35, 139), 0);
  // 緯度 1 度 ≒ 111.19km (R=6371)
  assert.ok(Math.abs(haversineKm(35, 139, 36, 139) - 111.195) < 0.01);
  // 東京駅 → 新宿駅 ≒ 6.1km
  const d = haversineKm(35.6812, 139.7671, 35.6896, 139.7006);
  assert.ok(d > 5.9 && d < 6.3, String(d));
});

test("isEntireHome", () => {
  assert.deepEqual(isEntireHome(cand("a")), { entire: true, inferred: false });
  assert.deepEqual(isEntireHome(cand("a", { roomType: "private_room", listingType: "Entire villa" })), {
    entire: false,
    inferred: false,
  });
  assert.deepEqual(isEntireHome(cand("a", { roomType: null, listingType: "entire cabin" })), {
    entire: true,
    inferred: true,
  });
  assert.deepEqual(isEntireHome(cand("a", { roomType: null, listingType: "Private room in house" })), {
    entire: false,
    inferred: true,
  });
  assert.deepEqual(isEntireHome(cand("a", { roomType: null, listingType: null })), { entire: true, inferred: true });
  assert.deepEqual(isEntireHome(cand("a", { roomType: null, listingType: null, propertyType: "hotel" })), {
    entire: false,
    inferred: true,
  });
  for (const title of ["Cozy ROOM near lake", "湖畔の個室", "ドミトリー山中湖", "Lake Dorm"]) {
    assert.equal(isEntireHome(cand("a", { roomType: null, listingType: null, title })).entire, false, title);
  }
});

test("passesFilters の各条件と null の扱い", () => {
  const c = cand("a");
  assert.equal(passesFilters(c, 3, F, BASE), true);
  assert.equal(passesFilters(c, null, F, BASE), true); // 距離条件なし
  assert.equal(passesFilters(c, NaN, F, BASE), false); // 候補の座標なし
  assert.equal(passesFilters(c, 7, F, BASE), true); // 境界を含む
  assert.equal(passesFilters(c, 7.01, F, BASE), false);
  // 価格帯 ±30% = 77,000〜143,000 (境界を含む)
  assert.equal(passesFilters(cand("a", { adrRef: 77000 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { adrRef: 143000 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { adrRef: 76999 }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { adrRef: 143001 }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { adrRef: null }), 1, F, BASE), false);
  // 定員
  assert.equal(passesFilters(cand("a", { maxGuests: 6 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { maxGuests: 10 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { maxGuests: 5 }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { maxGuests: 11 }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { maxGuests: 0 }), 1, { ...F, guestsMin: 0 }, BASE), false);
  // 評価・レビュー
  assert.equal(passesFilters(cand("a", { rating: 4.7 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { rating: 4.69 }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { rating: null }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { reviews: 5 }), 1, F, BASE), true);
  assert.equal(passesFilters(cand("a", { reviews: 4 }), 1, F, BASE), false);
  // 一棟貸し
  assert.equal(passesFilters(cand("a", { roomType: "private_room" }), 1, F, BASE), false);
  assert.equal(passesFilters(cand("a", { roomType: "private_room" }), 1, { ...F, entireHomeOnly: false }, BASE), true);
});

/** 本番のファネル形状: 厳格 5件、±40% で 10件、±50% で 15件 */
function productionFunnel(): CandidateProperty[] {
  const strict = [90000, 100000, 110000, 125000, 140000];
  const band40 = [70000, 66000, 150000, 154000, 72000];
  const band50 = [60000, 56000, 160000, 165000, 58000];
  const out: CandidateProperty[] = [];
  [...strict, ...band40, ...band50].forEach((adr, i) => {
    out.push(cand(`airroi_${i + 1}`, { adrRef: adr, lng: 138.87 + 0.005 * (15 - i) }));
  });
  // 条件外 (定員・評価・ホテル・遠方)
  out.push(cand("airroi_x1", { maxGuests: 4 }));
  out.push(cand("airroi_x2", { rating: 4.5 }));
  out.push(cand("airroi_x3", { roomType: "hotel_room" }));
  out.push(cand("airroi_x4", { lat: 35.6 }));
  return out;
}

test("本番ファネル: 厳格5件 → ±40% で10件になりラダーはステップ a で止まる", () => {
  const r = selectCompSet(productionFunnel(), LUMINA, BASE, cfg(), TODAY);
  assert.equal(r.strictCount, 5);
  assert.equal(r.members.length, 10);
  assert.deepEqual(r.relaxations, ["ADR帯 ±30% → ±40%"]);
  assert.equal(r.effective.adrBandPct, 40);
  assert.equal(r.effective.guestsMin, 6);
  assert.equal(r.effective.minRating, 4.7);
  assert.equal(r.members.filter((m) => m.strict).length, 5);
  assert.equal(r.candidatesConsidered, 19);
  // 距離昇順
  for (let i = 1; i < r.members.length; i++) {
    assert.ok(r.members[i - 1].distanceKm <= r.members[i].distanceKm);
  }
});

test("minSize=0 なら緩和しない / minSize を満たしていれば緩和しない", () => {
  const r0 = selectCompSet(productionFunnel(), LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.equal(r0.members.length, 5);
  assert.deepEqual(r0.relaxations, []);
  const r5 = selectCompSet(productionFunnel(), LUMINA, BASE, cfg({}, { minSize: 5 }), TODAY);
  assert.equal(r5.members.length, 5);
  assert.deepEqual(r5.relaxations, []);
  const r12 = selectCompSet(productionFunnel(), LUMINA, BASE, cfg({}, { minSize: 12 }), TODAY);
  assert.equal(r12.members.length, 15);
  assert.deepEqual(r12.relaxations, ["ADR帯 ±30% → ±40%", "ADR帯 ±40% → ±50%"]);
});

test("緩和ラダー a〜e を順に累積適用し、使い切っても不足ならその時点の結果", () => {
  const cands = [
    cand("airroi_1"),
    cand("airroi_g", { maxGuests: 12 }), // c で入る
    cand("airroi_r", { rating: 4.6, reviews: 3 }), // d で入る
    cand("airroi_far", { lat: 35.42 + 9 / 111.195 }), // 9km: e (半径 7→10) で入る
  ];
  const r = selectCompSet(cands, LUMINA, BASE, cfg({}, { maxRadiusKm: 10, minSize: 8 }), TODAY);
  assert.deepEqual(r.relaxations, [
    "ADR帯 ±30% → ±40%",
    "ADR帯 ±40% → ±50%",
    "定員 6〜10名 → 5〜12名",
    "評価 4.7以上 → 4.6以上、レビュー 5件以上 → 3件以上",
    "半径 7km → 10km",
  ]);
  assert.equal(r.members.length, 4);
  assert.equal(r.strictCount, 1);
  assert.deepEqual(r.effective, {
    radiusKm: 10,
    maxRadiusKm: 10,
    entireHomeOnly: true,
    adrBandPct: 50,
    guestsMin: 5,
    guestsMax: 12,
    minRating: 4.6,
    minReviews: 3,
    minSize: 8,
  });
  assert.equal(r.members[r.members.length - 1].id, "airroi_far");
});

test("ラダーは件数を満たした時点で止まる (ステップ c)", () => {
  const cands = [cand("airroi_1"), cand("airroi_2"), cand("airroi_g", { maxGuests: 12 })];
  const r = selectCompSet(cands, LUMINA, BASE, cfg({}, { minSize: 3 }), TODAY);
  assert.deepEqual(r.relaxations, ["ADR帯 ±30% → ±40%", "ADR帯 ±40% → ±50%", "定員 6〜10名 → 5〜12名"]);
  assert.equal(r.members.length, 3);
  assert.equal(r.members.find((m) => m.id === "airroi_g")?.strict, false);
});

test("半径が maxRadiusKm と同じならステップ e は適用しない", () => {
  const r = selectCompSet([cand("airroi_1")], LUMINA, BASE, cfg({}, { minSize: 8 }), TODAY);
  assert.equal(r.relaxations.length, 4);
  assert.ok(!r.relaxations.some((s) => s.startsWith("半径")));
});

test("自社の除外 / 基準価格未設定 / 緯度経度未設定", () => {
  const cands = [cand("airroi_999"), cand("airroi_1"), cand("airroi_2", { lat: null, lng: null })];
  const r = selectCompSet(cands, LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.deepEqual(
    r.members.map((m) => m.id),
    ["airroi_1"],
  ); // 自社と座標なしは除外
  assert.equal(r.candidatesConsidered, 2);

  const z = selectCompSet(cands, LUMINA, 0, cfg(), TODAY);
  assert.deepEqual(z.members, []);
  assert.deepEqual(z.relaxations, ["自社基準価格が未設定"]);
  assert.equal(z.basePricePercentile, null);

  const noLoc = selectCompSet(cands, { lat: null, lng: null, listingId: null }, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.deepEqual(noLoc.relaxations, ["自社の緯度経度が未設定のため距離条件なし"]);
  assert.equal(noLoc.members.length, 3); // 自社 ID 不明なので除外されない、座標なしも距離条件なしで通る
  assert.ok(noLoc.members.every((m) => m.distanceKm === 0));
});

test("calendarStatus (failed の30日再試行窓を含む) と needsRefreshIds の順序", () => {
  const c = cfg({ freshnessDays: 10, compsetRefreshDays: 3 }, { minSize: 0 });
  const cands = [
    cand("airroi_none", { ratesSyncedAt: null, lastAttemptAt: null }),
    cand("airroi_fresh", { ratesSyncedAt: "2026-11-05", lastAttemptAt: "2026-11-05" }),
    cand("airroi_fresh10", { ratesSyncedAt: "2026-10-31", lastAttemptAt: "2026-10-31" }),
    cand("airroi_stale11", { ratesSyncedAt: "2026-10-30", lastAttemptAt: "2026-10-30" }),
    cand("airroi_stale_old", { ratesSyncedAt: "2026-08-01", lastAttemptAt: null }),
    cand("airroi_failed_null", { ratesSyncedAt: null, lastAttemptAt: "2026-11-01" }),
    cand("airroi_retry", { ratesSyncedAt: null, lastAttemptAt: "2026-10-10" }), // 31日前 → 再試行対象
    cand("airroi_failed_gap", { ratesSyncedAt: "2026-10-01", lastAttemptAt: "2026-11-08" }),
    cand("airroi_gap5", { ratesSyncedAt: "2026-11-03", lastAttemptAt: "2026-11-08" }), // 差5 < 6
    cand("airroi_gap6", { ratesSyncedAt: "2026-11-02", lastAttemptAt: "2026-11-08" }), // 差6 >= 6
  ];
  const r = selectCompSet(cands, LUMINA, BASE, c, TODAY);
  const st = Object.fromEntries(r.members.map((m) => [m.id, m.calendarStatus]));
  assert.deepEqual(st, {
    airroi_none: "none",
    airroi_fresh: "fresh",
    airroi_fresh10: "fresh",
    airroi_stale11: "stale",
    airroi_stale_old: "stale",
    airroi_failed_null: "failed",
    airroi_retry: "none",
    airroi_failed_gap: "failed",
    airroi_gap5: "fresh",
    airroi_gap6: "failed",
  });
  assert.equal(r.freshCount, 3);
  const m = r.members.find((x) => x.id === "airroi_fresh");
  assert.equal(m?.lastFetched, "2026-11-05");
  assert.equal(m?.lastAttemptAt, "2026-11-05");
  // 未取得が先、その後 取得日の古い順。failed は含めない
  assert.deepEqual(r.needsRefreshIds.slice(0, 2).sort(), ["airroi_none", "airroi_retry"]);
  assert.deepEqual(r.needsRefreshIds.slice(2), ["airroi_stale_old", "airroi_stale11"]);
});

test("basePricePercentile: 中位順位 (想定平均単価 x = base × (1 + 15%×2/7))", () => {
  // x = 110000 × 1.0428571… = 114714.29。ADR帯外 (200000) も分布に入る。定員外は除外
  const cands = [
    cand("airroi_1", { adrRef: 100000 }),
    cand("airroi_2", { adrRef: 110000 }),
    cand("airroi_3", { adrRef: 120000 }),
    cand("airroi_4", { adrRef: 200000 }),
    cand("airroi_5", { adrRef: 50000, maxGuests: 2 }),
    cand("airroi_6", { adrRef: null }),
  ];
  const r = selectCompSet(cands, LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.equal(r.basePricePercentile, 50); // 2/4
  assert.equal(r.basePriceAboveAll, null);
});

test("basePricePercentile: 同値は 0.5 で数える / n<3 は null / 全件上回り", () => {
  const eq = [
    cand("airroi_1", { adrRef: 100000 }),
    cand("airroi_2", { adrRef: 110000 }),
    cand("airroi_3", { adrRef: 120000 }),
  ];
  const r = selectCompSet(eq, LUMINA, BASE, cfg({ weekendPremiumPct: 0 }, { minSize: 0 }), TODAY);
  assert.equal(r.basePricePercentile, 50); // (1 + 0.5) / 3
  assert.equal(r.basePriceAboveAll, null);

  const two = selectCompSet(eq.slice(0, 2), LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.equal(two.basePricePercentile, null);
  assert.equal(two.basePriceAboveAll, null);

  const low = [
    cand("airroi_1", { adrRef: 90000 }),
    cand("airroi_2", { adrRef: 96148 }),
    cand("airroi_3", { adrRef: 80000 }),
  ];
  const a = selectCompSet(low, LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY);
  assert.equal(a.basePricePercentile, 100);
  assert.deepEqual(a.basePriceAboveAll, { max: 96148 });

  // 1/3 = 33.3%
  const third = [
    cand("airroi_1", { adrRef: 100000 }),
    cand("airroi_2", { adrRef: 120000 }),
    cand("airroi_3", { adrRef: 130000 }),
  ];
  assert.equal(selectCompSet(third, LUMINA, BASE, cfg({}, { minSize: 0 }), TODAY).basePricePercentile, 33.3);
});
