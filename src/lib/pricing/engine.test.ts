import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alphaCoef,
  betaCoef,
  deltaCoef,
  gammaCoef,
  lerp,
  measurePremiums,
  priceDay,
  resolveGuardrails,
} from "./engine";
import { DEFAULT_PRICING_CONFIG } from "./config";
import type { MarketDay, MarketListingState, NightClass, PricingConfig } from "./types";

const cfg: PricingConfig = DEFAULT_PRICING_CONFIG;

function night(type: "weekday" | "weekend", extra: Partial<NightClass> = {}): NightClass {
  return {
    date: "2026-11-24",
    type,
    dow: type === "weekday" ? 2 : 6,
    isHoliday: false,
    holidayName: null,
    isPreHoliday: false,
    peakPeriod: null,
    reason: type === "weekday" ? "平日" : "土曜",
    tag: type === "weekday" ? "" : "土",
    ...extra,
  };
}
const WD = night("weekday");
const WE = night("weekend");
const PEAK = night("weekend", { date: "2026-12-30", dow: 3, peakPeriod: "年末年始", reason: "年末年始", tag: "連休" });

function market(extra: Partial<MarketDay> = {}): MarketDay {
  return {
    units: 5,
    unavailable: 0,
    expectedBooked: 0,
    effectiveUnits: 5,
    occRaw: 0,
    occAdj: 0,
    occ: 0,
    occCi: [0, 0],
    remaining: 5,
    remainingEst: 5,
    compAdr: null,
    priceCount: 0,
    maxAgeDays: 1,
    listings: [],
    pace: null,
    paceRaw: null,
    paceExpected: null,
    paceDays: null,
    newBookings: null,
    spike: false,
    dataQuality: "ok",
    ...extra,
  };
}

function near(actual: number, expected: number, msg?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);
}

describe("lerp", () => {
  it("補間とクランプ", () => {
    near(lerp(5, 10, 0.5), 7.5);
    near(lerp(0, 10, 2), 10);
    near(lerp(0, 10, -1), 0);
  });
  it("非有限の t は 1 とみなす", () => {
    near(lerp(0, 10, NaN), 10);
    near(lerp(0, 10, Infinity), 10);
    near(lerp(0, 10, 0 / 0), 10);
  });
});

describe("alphaCoef (JSDoc の例)", () => {
  const cases: [number, number, number][] = [
    // [occ, lead, 期待値 (小数第3位で丸め)]
    [80, 20, 0.15],
    [90, 20, 0.2],
    [100, 20, 0.25],
    [50, 20, 0.05],
    [65, 20, 0.075],
    [49.9, 20, 0],
    [30, 10, 0],
    [29, 14, -0.103], // −10.333% → 小数第3位
    [0, 0, -0.2],
    [10, 15, 0],
  ];
  for (const [occ, lead, expected] of cases) {
    it(`occ ${occ} lead ${lead} → ${expected}`, () => {
      near(alphaCoef(market({ occ }), lead, WD, cfg).value, expected);
    });
  }
  it("dataQuality != ok なら 0 (有効件数を明記)", () => {
    const r = alphaCoef(market({ occ: 95, dataQuality: "low", units: 2 }), 5, WD, cfg);
    assert.equal(r.value, 0);
    assert.match(r.reason, /競合データ不足のため補正なし（有効2件）/);
  });
  it("occ null なら 0", () => {
    assert.equal(alphaCoef(market({ occ: null }), 5, WD, cfg).value, 0);
  });
  it("区分別パラメータ cfg.alpha[night.type] を使う", () => {
    const c: PricingConfig = { ...cfg, alpha: { ...cfg.alpha, weekend: { ...cfg.alpha.weekend, highOcc: 60 } } };
    near(alphaCoef(market({ occ: 60 }), 20, WE, c).value, 0.15);
    near(alphaCoef(market({ occ: 60 }), 20, WD, c).value, 0.067); // 6.667%
  });
  it("reason に占有率と係数が入る", () => {
    const r = alphaCoef(market({ occ: 86 }), 20, WD, cfg);
    assert.match(r.reason, /86%/);
    assert.match(r.reason, /\+18%/); // lerp(15, 25, 0.3) = 18
  });
});

describe("betaCoef (JSDoc の例)", () => {
  const surge: [number, number][] = [
    [10, 0.05],
    [20, 0.1],
    [30, 0.15],
    [50, 0.15],
  ];
  for (const [pace, expected] of surge) {
    it(`pace ${pace}, 新規2件 → ${expected}`, () => {
      near(betaCoef(market({ pace, newBookings: 2 }), 20, WD, cfg).value, expected);
    });
  }
  it("新規予約1件なら pace 30 でも 0 (reason に理由)", () => {
    const r = betaCoef(market({ pace: 30, newBookings: 1 }), 20, WD, cfg);
    assert.equal(r.value, 0);
    assert.match(r.reason, /新規予約1件/);
  });
  // 期待積み増し室数 = paceExpected/100 × units × paceDays/7 = 20/100 × 5 × 1 = 1室
  const stagnant = { pace: -2, paceExpected: 20, units: 5, paceDays: 7, newBookings: 0 };
  it("停滞 lead 0 → −5%", () => {
    near(betaCoef(market(stagnant), 0, WD, cfg).value, -0.05);
  });
  it("停滞 lead 15 → −2.5%", () => {
    near(betaCoef(market(stagnant), 15, WD, cfg).value, -0.025);
  });
  it("停滞 lead 30 → 0", () => {
    assert.equal(betaCoef(market(stagnant), 30, WD, cfg).value, 0);
  });
  it("期待積み増し 0.5室 → 0", () => {
    assert.equal(betaCoef(market({ ...stagnant, paceExpected: 10 }), 0, WD, cfg).value, 0);
  });
  it("paceDays を考慮 (3.5日なら 0.5室 → 0)", () => {
    assert.equal(betaCoef(market({ ...stagnant, paceDays: 3.5 }), 0, WD, cfg).value, 0);
  });
  it("pace null → 0 (Pace未算出)", () => {
    const r = betaCoef(market({ pace: null }), 5, WD, cfg);
    assert.equal(r.value, 0);
    assert.match(r.reason, /Pace未算出/);
  });
  it("surgeFullPt == surgePt なら surgeMax", () => {
    const c: PricingConfig = { ...cfg, beta: { ...cfg.beta, weekday: { ...cfg.beta.weekday, surgeFullPt: 10 } } };
    near(betaCoef(market({ pace: 10, newBookings: 2 }), 5, WD, c).value, 0.15);
  });
});

describe("gammaCoef (JSDoc の例)", () => {
  it("平日 vacant occ20: lead0 −25%, lead3 −15.625%, lead7 −3.125%", () => {
    near(gammaCoef(0, WD, "vacant", 20, cfg).value, -0.25);
    near(gammaCoef(3, WD, "vacant", 20, cfg).value, -0.156);
    near(gammaCoef(7, WD, "vacant", 20, cfg).value, -0.031);
  });
  it("週末 lead0 → −10%", () => {
    near(gammaCoef(0, WE, "vacant", 20, cfg).value, -0.1);
  });
  it("逼迫による縮小: occ65 → −12.5%, occ80 → 0", () => {
    near(gammaCoef(0, WD, "vacant", 65, cfg).value, -0.125);
    assert.equal(gammaCoef(0, WD, "vacant", 80, cfg).value, 0);
  });
  it("occ null は縮小なし", () => {
    near(gammaCoef(0, WD, "vacant", null, cfg).value, -0.25);
  });
  it("lead8 → 0", () => {
    assert.equal(gammaCoef(8, WD, "vacant", 20, cfg).value, 0);
  });
  it("予約済/ブロックは直前値下げなし", () => {
    assert.equal(gammaCoef(0, WD, "booked", 20, cfg).value, 0);
    assert.equal(gammaCoef(0, WD, "blocked", 20, cfg).value, 0);
  });
  it("早期: lead45 平常 occ10 → −5%、lead50 年末年始 → +5%", () => {
    near(gammaCoef(45, WD, "vacant", 10, cfg).value, -0.05);
    near(gammaCoef(50, PEAK, "vacant", 10, cfg).value, 0.05);
  });
  it("早期 auto: occ >= earlyStrongOcc なら先行高値", () => {
    near(gammaCoef(50, WD, "vacant", 40, cfg).value, 0.05);
  });
  it("早期 earlyMode discount / premium", () => {
    const d: PricingConfig = { ...cfg, gamma: { ...cfg.gamma, earlyMode: "discount" } };
    const p: PricingConfig = { ...cfg, gamma: { ...cfg.gamma, earlyMode: "premium" } };
    near(gammaCoef(50, PEAK, "vacant", 90, d).value, -0.05);
    near(gammaCoef(50, WD, "vacant", 0, p).value, 0.05);
  });
});

describe("deltaCoef", () => {
  const premium = { weekendPct: 18, peakPct: 45 };
  it("平日 0 / 週末 +18% / 特定連休 +45%", () => {
    assert.equal(deltaCoef(WD, premium).value, 0);
    near(deltaCoef(WE, premium).value, 0.18);
    near(deltaCoef(PEAK, premium).value, 0.45);
    assert.match(deltaCoef(PEAK, premium).reason, /年末年始/);
  });
});

function listing(id: string, price: number | null, available = true): MarketListingState {
  return { id, available, price };
}

describe("measurePremiums", () => {
  it("fixed はそのまま", () => {
    const c: PricingConfig = { ...cfg, weekendPremiumMode: "fixed", weekendPremiumPct: 12, peakPremiumPct: 33 };
    assert.deepEqual(measurePremiums([], c), { weekendPct: 12, peakPct: 33, source: "fixed" });
  });

  function buildDays(members: string[], wdPrice: number, wePrice: number, peakPrice: number | null) {
    const days: { night: NightClass; market: MarketDay }[] = [];
    for (let i = 0; i < 3; i++) {
      days.push({ night: WD, market: market({ listings: members.map((m) => listing(m, wdPrice)) }) });
      days.push({ night: WE, market: market({ listings: members.map((m) => listing(m, wePrice)) }) });
    }
    if (peakPrice != null) {
      for (let i = 0; i < 2; i++) {
        days.push({ night: PEAK, market: market({ listings: members.map((m) => listing(m, peakPrice)) }) });
      }
    }
    // 予約不可・価格なしは無視される
    days.push({ night: WE, market: market({ listings: members.map((m) => listing(m, null, false)) }) });
    return days;
  }

  it("同一物件内の比から auto 測定 (週末 +20%, 連休 +50%)", () => {
    const r = measurePremiums(buildDays(["a", "b", "c"], 100000, 120000, 150000), cfg);
    assert.equal(r.source, "auto");
    near(r.weekendPct, 20);
    near(r.peakPct, 50);
  });
  it("物件が3件未満なら fallback", () => {
    const r = measurePremiums(buildDays(["a", "b"], 100000, 120000, 150000), cfg);
    assert.deepEqual(r, { weekendPct: 15, peakPct: 30, source: "fallback" });
  });
  it("週末は 0〜50% にクランプ、連休は測定不能なら設定値", () => {
    const r = measurePremiums(buildDays(["a", "b", "c"], 100000, 170000, null), cfg);
    assert.equal(r.source, "auto");
    near(r.weekendPct, 50);
    near(r.peakPct, 30);
    const low = measurePremiums(buildDays(["a", "b", "c"], 100000, 90000, null), cfg);
    near(low.weekendPct, 0);
  });
});

describe("resolveGuardrails", () => {
  it("floor は区分別、市場価格が足りなければ ceiling = typeBase × 1.6", () => {
    assert.deepEqual(resolveGuardrails("weekday", 110000, 15, [], cfg), { floor: 60000, ceiling: 176000 });
    // 110000 × 1.15 × 1.6 = 202400 → 切り捨て 202000
    assert.deepEqual(resolveGuardrails("weekend", 110000, 15, [], cfg), { floor: 90000, ceiling: 202000 });
  });
  it("10件以上・3物件以上なら max(P95 × 1.25, typeBase × 1.4)", () => {
    const prices = Array.from({ length: 10 }, (_, i) => ({ memberId: ["a", "b", "c"][i % 3], price: 100000 + i * 10000 }));
    // P95 = 180000 + 0.55 × 10000 = 185500 → × 1.25 = 231875 → 231000
    assert.deepEqual(resolveGuardrails("weekday", 110000, 15, prices, cfg), { floor: 60000, ceiling: 231000 });
  });
  it("異なる物件が2件ならフォールバック", () => {
    const prices = Array.from({ length: 12 }, (_, i) => ({ memberId: ["a", "b"][i % 2], price: 300000 }));
    assert.equal(resolveGuardrails("weekday", 110000, 15, prices, cfg).ceiling, 176000);
  });
  it("price <= 0 は件数に数えない", () => {
    const prices = [
      ...Array.from({ length: 9 }, (_, i) => ({ memberId: ["a", "b", "c"][i % 3], price: 300000 })),
      { memberId: "a", price: 0 },
    ];
    assert.equal(resolveGuardrails("weekday", 110000, 15, prices, cfg).ceiling, 176000);
  });
  it("fixed かつ値ありならその値、null なら auto", () => {
    const c: PricingConfig = { ...cfg, ceilingMode: "fixed", ceilingWeekday: 150000, ceilingWeekend: null };
    assert.equal(resolveGuardrails("weekday", 110000, 15, [], c).ceiling, 150000);
    assert.equal(resolveGuardrails("weekend", 110000, 15, [], c).ceiling, 202000);
  });
  it("丸め順: floor 切り上げ、ceiling 切り捨て、ceiling >= floor", () => {
    const c: PricingConfig = { ...cfg, floorWeekday: 60500 };
    assert.equal(resolveGuardrails("weekday", 110000, 15, [], c).floor, 61000);
    // 30000 × 1.6 = 48000 < floor
    assert.deepEqual(resolveGuardrails("weekday", 30000, 15, [], cfg), { floor: 60000, ceiling: 60000 });
    assert.deepEqual(resolveGuardrails("weekday", 0, 15, [], cfg), { floor: 60000, ceiling: 60000 });
  });
});

describe("priceDay", () => {
  const premium = { weekendPct: 15, peakPct: 30 };
  const guard = { floor: 90000, ceiling: 200000 };
  const mk = market({ occ: 90, pace: 20, newBookings: 2 });
  const base = {
    basePrice: 100000,
    night: WE,
    lead: 20,
    market: mk,
    ownStatus: "vacant" as const,
    currentPrice: 130000,
    currentPriceSource: "manual" as const,
    premium,
    guard,
    cfg,
  };
  it("P_raw = P_base × (1+δ)(1+α)(1+β)(1+γ) と丸め・乖離率・action・signal", () => {
    const r = priceDay(base);
    near(r.delta.value, 0.15);
    near(r.alpha.value, 0.2);
    near(r.beta.value, 0.1);
    assert.equal(r.gamma.value, 0);
    assert.equal(r.rawPrice, 151800);
    assert.equal(r.recommended, 152000);
    assert.equal(r.clampedBy, null);
    assert.equal(r.changePct, 16.9);
    assert.equal(r.action, "raise");
    assert.equal(r.signal, "market");
    assert.equal(r.floor, 90000);
    assert.equal(r.ceiling, 200000);
  });
  it("値下げ・据え置き", () => {
    assert.equal(priceDay({ ...base, currentPrice: 180000 }).action, "lower");
    assert.equal(priceDay({ ...base, currentPrice: 180000 }).changePct, -15.6);
    assert.equal(priceDay({ ...base, currentPrice: 150000 }).action, "hold");
  });
  it("仮定価格・null・0 は乖離率 null で hold", () => {
    for (const p of [
      { currentPrice: 130000, currentPriceSource: "assumed" as const },
      { currentPrice: null, currentPriceSource: "manual" as const },
      { currentPrice: 0, currentPriceSource: "api" as const },
    ]) {
      const r = priceDay({ ...base, ...p });
      assert.equal(r.changePct, null);
      assert.equal(r.action, "hold");
    }
  });
  it("予約済/ブロックの action", () => {
    assert.equal(priceDay({ ...base, ownStatus: "booked" }).action, "booked");
    assert.equal(priceDay({ ...base, ownStatus: "blocked" }).action, "blocked");
  });
  it("ガードレール", () => {
    const c = priceDay({ ...base, guard: { floor: 90000, ceiling: 140000 } });
    assert.equal(c.recommended, 140000);
    assert.equal(c.clampedBy, "ceiling");
    const f = priceDay({ ...base, basePrice: 0 });
    assert.equal(f.rawPrice, 0);
    assert.equal(f.recommended, 90000);
    assert.equal(f.clampedBy, "floor");
    const n = priceDay({ ...base, basePrice: NaN });
    assert.equal(n.recommended, 90000);
    assert.ok(Number.isFinite(n.rawPrice));
  });
  it("signal: dataQuality != ok → rules_only, pace null → partial", () => {
    assert.equal(priceDay({ ...base, market: market({ occ: 90, dataQuality: "low" }) }).signal, "rules_only");
    assert.equal(priceDay({ ...base, market: market({ occ: 90, pace: null }) }).signal, "partial");
  });
  it("rules_only の日は乖離が大きくても値上げ/値下げ判定をしない (本番で実価格を根拠なく下げる推奨が出た回帰)", () => {
    for (const dataQuality of ["none", "low"] as const) {
      const noMarket = market({ occ: null, dataQuality, units: dataQuality === "none" ? 0 : 1, pace: null });
      const lowered = priceDay({ ...base, market: noMarket, currentPrice: 300000 });
      assert.equal(lowered.signal, "rules_only");
      assert.ok(lowered.changePct !== null && lowered.changePct < -10, "乖離率は参考値として残す");
      assert.equal(lowered.action, "hold");
      const raised = priceDay({ ...base, market: noMarket, currentPrice: 50000 });
      assert.ok(raised.changePct !== null && raised.changePct > 10);
      assert.equal(raised.action, "hold");
    }
  });
});
