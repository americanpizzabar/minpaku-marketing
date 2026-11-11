import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { simulateRevenue } from "./simulate";
import { DEFAULT_PRICING_CONFIG } from "./config";
import type {
  BookingCurve,
  DayRecommendation,
  MarketDay,
  NightType,
  OwnPriceSource,
  OwnStatus,
  PricingConfig,
} from "./types";

const cfg: PricingConfig = DEFAULT_PRICING_CONFIG;

function market(extra: Partial<MarketDay> = {}): MarketDay {
  return {
    // 既定は占有率 50% = 曲線の lead 10 の値 (F(L)) と同じ → q は曲線だけで求めた値と一致する
    units: 6,
    unavailable: 3,
    expectedBooked: 3,
    effectiveUnits: 6,
    occRaw: 50,
    occAdj: 50,
    occ: 50,
    occCi: [40, 60],
    remaining: 3,
    remainingEst: 3,
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

function day(opts: {
  date?: string;
  lead?: number;
  type?: NightType;
  status?: OwnStatus;
  currentPrice?: number | null;
  source?: OwnPriceSource;
  recommended?: number;
  basePrice?: number;
  delta?: number;
  compAdr?: number | null;
  occ?: number;
  dataQuality?: MarketDay["dataQuality"];
  signal?: DayRecommendation["pricing"]["signal"];
}): DayRecommendation {
  const type = opts.type ?? "weekday";
  const status = opts.status ?? "vacant";
  return {
    date: opts.date ?? "2026-11-20",
    lead: opts.lead ?? 10,
    night: {
      date: opts.date ?? "2026-11-20",
      type,
      dow: type === "weekday" ? 2 : 6,
      isHoliday: false,
      holidayName: null,
      isPreHoliday: false,
      peakPeriod: null,
      reason: type === "weekday" ? "平日" : "土曜",
      tag: type === "weekday" ? "" : "土",
    },
    market: market({
      compAdr: opts.compAdr ?? null,
      ...(opts.occ !== undefined ? { occ: opts.occ } : {}),
      ...(opts.dataQuality ? { dataQuality: opts.dataQuality } : {}),
    }),
    own: {
      status,
      statusSource: "manual",
      currentPrice: opts.currentPrice === undefined ? 100000 : opts.currentPrice,
      currentPriceSource: opts.source ?? "manual",
    },
    pricing: {
      basePrice: opts.basePrice ?? 100000,
      delta: { value: opts.delta ?? 0, reason: "" },
      alpha: { value: 0, reason: "" },
      beta: { value: 0, reason: "" },
      gamma: { value: 0, reason: "" },
      rawPrice: opts.recommended ?? 100000,
      floor: 60000,
      ceiling: 200000,
      recommended: opts.recommended ?? 100000,
      clampedBy: null,
      changePct: null,
      action: status === "vacant" ? "hold" : status,
      signal: opts.signal ?? "market",
    },
  };
}

function curve(type: NightType, fitted: { lead: number; occ: number }[]): BookingCurve {
  return { type, points: [], fitted, reach50: null, reach80: null, sampleSize: fitted.length };
}

// lead 10 → F = 0.5, F0 = 0.8 → 市場がこれから埋める量 0.3 / 残り在庫 (1 − 占有率 0.5) → q = 0.6
const FITTED = [
  { lead: 0, occ: 80 },
  { lead: 10, occ: 50 },
  { lead: 30, occ: 20 },
];
const curves = { weekday: curve("weekday", FITTED), weekend: curve("weekend", FITTED) };
const emptyCurves = { weekday: curve("weekday", []), weekend: curve("weekend", []) };

function assertAllFinite(v: unknown, path = "sim"): void {
  if (typeof v === "number") assert.ok(Number.isFinite(v), `${path} is ${v}`);
  else if (Array.isArray(v)) v.forEach((x, i) => assertAllFinite(x, `${path}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertAllFinite(x, `${path}.${k}`);
}

describe("simulateRevenue", () => {
  it("推奨 = 現在価格なら uplift 0、損益分岐の対象日なし", () => {
    const days = [day({ lead: 10 }), day({ lead: 30, date: "2026-12-10" }), day({ lead: 3, date: "2026-11-13" })];
    const s = simulateRevenue(days, curves, cfg);
    assert.equal(s.available, true);
    assert.equal(s.baseline, "current");
    assert.equal(s.baselineLabel, "現在価格");
    assert.equal(s.scenarios.length, 3);
    for (const sc of s.scenarios) {
      assert.equal(sc.upliftPct, 0);
      assert.equal(sc.currentRevenue, sc.recommendedRevenue);
      assert.equal(sc.currentNights, sc.recommendedNights);
    }
    assert.deepEqual(s.breakEven, { raise: null, lower: null });
    assert.equal(s.central?.key, "central");
    assertAllFinite(s);
  });

  it("条件付きピックアップ q と弾力性で売上を計算 (単日)", () => {
    // q = 0.6, ref = typeBase = 100000, P = 110000, ε = -1.5
    const s = simulateRevenue([day({ lead: 10, recommended: 110000 })], curves, cfg);
    const c = s.central!;
    assert.equal(c.elasticity, -1.5);
    assert.equal(c.currentRevenue, Math.round(100000 * 0.6));
    assert.equal(c.recommendedRevenue, Math.round(110000 * 0.6 * Math.pow(1.1, -1.5)));
    assert.equal(c.currentNights, 0.6);
    assert.equal(c.recommendedNights, Math.round(0.6 * Math.pow(1.1, -1.5) * 10) / 10);
  });

  it("参照価格は typeBase × compAdr / 区分の compAdr 中央値", () => {
    // M_weekday = median(120000, 100000) = 110000 (予約済の日も含む)
    const days = [
      day({ lead: 10, compAdr: 120000 }),
      day({ lead: 12, date: "2026-11-22", status: "booked", compAdr: 100000 }),
    ];
    const s = simulateRevenue(days, curves, cfg);
    const ref = (100000 * 120000) / 110000;
    assert.equal(s.central!.currentRevenue, Math.round(100000 * 0.6 * Math.pow(100000 / ref, -1.5)));
  });

  it("予約済の日は lockedRevenue のみ、ブロックは除外", () => {
    const days = [
      day({ lead: 10 }),
      day({ lead: 11, date: "2026-11-21", status: "booked", currentPrice: 130000 }),
      day({ lead: 12, date: "2026-11-22", status: "booked", currentPrice: null, basePrice: 100000, delta: 0.155 }),
      day({ lead: 13, date: "2026-11-23", status: "blocked" }),
    ];
    const s = simulateRevenue(days, curves, cfg);
    assert.equal(s.bookedDays, 2);
    // currentPrice が無い予約済の日は typeBase を丸めた値 (115500 → 116000)
    assert.equal(s.lockedRevenue, 130000 + 116000);
    assert.equal(s.vacantDays, 1);
    const only = simulateRevenue([day({ lead: 10 })], curves, cfg);
    assert.deepEqual(s.scenarios, only.scenarios);
  });

  it("予約曲線が無ければ available=false", () => {
    const s = simulateRevenue([day({ lead: 10 })], emptyCurves, cfg);
    assert.equal(s.available, false);
    assert.match(s.reason ?? "", /予約曲線が未算出/);
    assert.equal(s.central, null);
    assert.deepEqual(s.breakEven, { raise: null, lower: null });
    assertAllFinite(s);
  });

  it("空入力でも落ちない", () => {
    const s = simulateRevenue([], curves, cfg);
    assert.equal(s.available, false);
    assert.equal(s.vacantDays, 0);
    assertAllFinite(s);
  });

  it("片方の区分の曲線が空ならもう一方を使う", () => {
    const s = simulateRevenue(
      [day({ lead: 10, type: "weekend" })],
      { weekday: curve("weekday", FITTED), weekend: curve("weekend", []) },
      cfg,
    );
    assert.equal(s.available, true);
    assert.equal(s.central!.currentRevenue, 60000);
  });

  it("純粋な値上げ: 弾力性が大きいほど uplift は単調に小さい", () => {
    const days = [
      day({ lead: 10, recommended: 110000 }),
      day({ lead: 25, date: "2026-12-05", recommended: 120000 }),
      day({ lead: 5, date: "2026-11-15", recommended: 105000 }),
    ];
    const s = simulateRevenue(days, curves, cfg);
    const [low, central, high] = s.scenarios;
    assert.equal(low.key, "low");
    assert.equal(high.key, "high");
    assert.ok(low.upliftPct! > central.upliftPct!);
    assert.ok(central.upliftPct! > high.upliftPct!);
    assert.ok(low.upliftPct! > 0); // ε = −0.8 (非弾力的) なら値上げが有利
    assert.ok(high.upliftPct! < 0);
    assert.ok(low.recommendedRevenue > high.recommendedRevenue);
    assert.equal(s.breakEven.lower, null);
    assert.equal(s.breakEven.raise?.days, 3);
    // 細かい弾力性でも単調
    let prev = Infinity;
    for (const eps of [-0.2, -0.5, -1, -1.5, -2, -3, -4]) {
      const r = simulateRevenue(days, curves, { ...cfg, elasticity: { low: eps, central: eps, high: eps } });
      const rev = r.central!.recommendedRevenue;
      assert.ok(rev < prev, `ε=${eps}`);
      prev = rev;
    }
  });

  it("現在価格が仮定値なら assumed_seasonal (typeBase を丸めた固定料金と比較)", () => {
    const days = [
      day({ lead: 10, source: "assumed", currentPrice: 999999, recommended: 115000, delta: 0.15, type: "weekend" }),
      day({ lead: 12, date: "2026-11-22", source: "assumed", currentPrice: 999999, recommended: 115000, delta: 0.15, type: "weekend" }),
    ];
    const s = simulateRevenue(days, curves, cfg);
    assert.equal(s.baseline, "assumed_seasonal");
    assert.equal(s.baselineLabel, "固定シーズン料金（基準価格×週末係数・仮定）");
    // 固定料金 = round(100000 × 1.15 / 1000) × 1000 = 115000 = 推奨 → 差なし
    for (const sc of s.scenarios) assert.equal(sc.upliftPct, 0);
    assert.ok(s.assumptions.some((a) => a.includes("現在価格を入力すると実価格で比較")));
  });

  it("baseline current では仮定価格の日を除外する", () => {
    const days = [
      day({ lead: 10 }),
      day({ lead: 12, date: "2026-11-22" }),
      day({ lead: 14, date: "2026-11-24", source: "assumed" }),
    ];
    const s = simulateRevenue(days, curves, cfg);
    assert.equal(s.baseline, "current");
    assert.equal(s.vacantDays, 2);
  });

  it("F(L) >= 1 の日は成約確率 0", () => {
    const full = { weekday: curve("weekday", [{ lead: 0, occ: 100 }]), weekend: curve("weekend", []) };
    const s = simulateRevenue([day({ lead: 10 })], full, cfg);
    assert.equal(s.available, true);
    assert.equal(s.central!.currentRevenue, 0);
    assert.equal(s.central!.upliftPct, null);
  });

  it("基準価格 0 でも NaN を出さない", () => {
    const s = simulateRevenue([day({ lead: 10, basePrice: 0 })], curves, cfg);
    assert.equal(s.available, false);
    assertAllFinite(s);
  });

  it("損益分岐の予約数変化: 値上げ日と値下げ日を分け、価格だけで決まる", () => {
    const days = [
      day({ lead: 10, recommended: 120000 }),
      day({ lead: 12, date: "2026-11-22", recommended: 120000 }),
      day({ lead: 14, date: "2026-11-24", recommended: 80000 }),
      day({ lead: 16, date: "2026-11-26", recommended: 100000 }), // 据え置きと同じ → どちらにも入らない
    ];
    const s = simulateRevenue(days, curves, cfg);
    // 値上げ 2日: 合計 200000 → 240000 (+20%)。予約が 1 − 200000/240000 = 16.7% 減っても売上は同じ
    assert.deepEqual(s.breakEven.raise, { days: 2, avgChangePct: 20, bookingChangePct: -16.7 });
    // 値下げ 1日: 100000 → 80000 (−20%)。予約が 100000/80000 − 1 = 25% 増えれば元が取れる
    assert.deepEqual(s.breakEven.lower, { days: 1, avgChangePct: -20, bookingChangePct: 25 });
    // 弾力性の仮定を変えても損益分岐は変わらない
    const other = simulateRevenue(days, curves, { ...cfg, elasticity: { low: -0.3, central: -3, high: -6 } });
    assert.deepEqual(other.breakEven, s.breakEven);
  });

  it("成約確率はその日の競合の残り在庫で条件付ける (埋まっている日ほど高い)", () => {
    // 市場がこれから埋める量 0.3。占有率 80% の日: 0.3/0.2 → 0.95 (上限)、20% の日: 0.3/0.8 = 0.375
    const tight = simulateRevenue([day({ lead: 10, occ: 80 })], curves, cfg);
    const loose = simulateRevenue([day({ lead: 10, occ: 20 })], curves, cfg);
    assert.equal(tight.central!.currentNights, 1); // 0.95 → 小数1桁
    assert.equal(tight.central!.currentRevenue, 95000);
    assert.equal(loose.central!.currentRevenue, 37500);
    // データ不足の日は市場の占有率を使わず曲線の値 (F(L)) を使う → q = 0.6
    const low = simulateRevenue([day({ lead: 10, occ: 80, dataQuality: "low" })], curves, cfg);
    assert.equal(low.central!.currentRevenue, 60000);
  });

  it("競合が満室 (占有率100%) でも市場がまだ埋まる局面なら成約確率は上限 (0にしない)", () => {
    const s = simulateRevenue([day({ lead: 10, occ: 100 })], curves, cfg);
    assert.equal(s.central!.currentRevenue, 95000);
    assert.ok(!s.assumptions.some((a) => a.includes("曲線が平坦")));
  });

  it("曲線が平坦で成約確率 0 の日があれば前提に明記する", () => {
    const flat = { weekday: curve("weekday", [{ lead: 0, occ: 70 }, { lead: 30, occ: 70 }]), weekend: curve("weekend", []) };
    const s = simulateRevenue([day({ lead: 10 }), day({ lead: 12, date: "2026-11-22" })], flat, cfg);
    assert.ok(s.assumptions.some((a) => a.startsWith("2日は予約曲線上これ以上の予約が見込めない")));
  });

  it("推奨がルールのみの日 (競合データ不足) は比較しない。全日そうなら算出しない", () => {
    const all = simulateRevenue(
      [day({ lead: 10, recommended: 160000, signal: "rules_only" }), day({ lead: 12, date: "2026-11-22", recommended: 50000, signal: "rules_only" })],
      curves,
      cfg,
    );
    assert.equal(all.available, false);
    assert.match(all.reason ?? "", /競合データが不足しているため算出していません/);
    assert.deepEqual(all.breakEven, { raise: null, lower: null });

    const mixed = simulateRevenue(
      [day({ lead: 10, recommended: 120000 }), day({ lead: 12, date: "2026-11-22", recommended: 200000, signal: "rules_only" })],
      curves,
      cfg,
    );
    assert.equal(mixed.available, true);
    assert.equal(mixed.vacantDays, 1);
    assert.deepEqual(mixed.breakEven.raise, { days: 1, avgChangePct: 20, bookingChangePct: -16.7 });
    assert.ok(mixed.assumptions.some((a) => a.includes("ルールのみの空室 1日は比較から除外")));
  });

  it("assumptions に必須の前提を含む", () => {
    const s = simulateRevenue([day({ lead: 10 })], curves, cfg);
    const all = s.assumptions.join("\n");
    assert.match(all, /予約曲線/);
    assert.match(all, /品質プレミアム/);
    assert.match(all, /仮定/);
    assert.match(all, /損益分岐/);
    assert.match(all, /予約済/);
  });
});
