import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveAlerts, formatJpDate, formatYen } from "./alerts";
import { DEFAULT_PRICING_CONFIG } from "./config";
import type {
  DayRecommendation,
  MarketDay,
  NightType,
  OwnStatus,
  OwnStatusSource,
  PricingAction,
  PricingConfig,
} from "./types";

const cfg: PricingConfig = DEFAULT_PRICING_CONFIG;

function market(extra: Partial<MarketDay> = {}): MarketDay {
  return {
    units: 5,
    unavailable: 1,
    expectedBooked: 1,
    effectiveUnits: 5,
    occRaw: 20,
    occAdj: 20,
    occ: 20,
    occCi: [10, 30],
    remaining: 4,
    remainingEst: 4,
    compAdr: 100000,
    priceCount: 4,
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
  statusSource?: OwnStatusSource;
  action?: PricingAction;
  changePct?: number | null;
  currentPrice?: number | null;
  recommended?: number;
  market?: Partial<MarketDay>;
}): DayRecommendation {
  const type = opts.type ?? "weekday";
  const date = opts.date ?? "2026-11-24";
  return {
    date,
    lead: opts.lead ?? 14,
    night: {
      date,
      type,
      dow: new Date(date + "T00:00:00Z").getUTCDay(),
      isHoliday: false,
      holidayName: null,
      isPreHoliday: false,
      peakPeriod: null,
      reason: type === "weekday" ? "平日" : "土曜",
      tag: "",
    },
    market: market(opts.market),
    own: {
      status: opts.status ?? "vacant",
      statusSource: opts.statusSource ?? "manual",
      currentPrice: opts.currentPrice === undefined ? 110000 : opts.currentPrice,
      currentPriceSource: "manual",
    },
    pricing: {
      basePrice: 110000,
      delta: { value: 0, reason: "" },
      alpha: { value: 0, reason: "" },
      beta: { value: 0, reason: "" },
      gamma: { value: 0, reason: "" },
      rawPrice: opts.recommended ?? 110000,
      floor: 60000,
      ceiling: 200000,
      recommended: opts.recommended ?? 110000,
      clampedBy: null,
      changePct: opts.changePct === undefined ? 0 : opts.changePct,
      action: opts.action ?? "hold",
      signal: "market",
    },
  };
}

const SAT = "2026-11-21";
const lowInv = { units: 7, unavailable: 5, remaining: 2, remainingEst: 2, occ: 70 };

describe("formatJpDate / formatYen", () => {
  it("M/D(曜)", () => {
    assert.equal(formatJpDate("2026-11-21"), "11/21(土)");
    assert.equal(formatJpDate("2027-01-03"), "1/3(日)");
  });
  it("¥ + 3桁区切り", () => {
    assert.equal(formatYen(110000), "¥110,000");
    assert.equal(formatYen(1234567.4), "¥1,234,567");
    assert.equal(formatYen(0), "¥0");
    assert.equal(formatYen(NaN), "¥0");
  });
});

describe("weekend_low_inventory", () => {
  it("週末・残り少・占有率中位以上・自社空室 → high", () => {
    const a = deriveAlerts([day({ date: SAT, type: "weekend", market: lowInv })], cfg);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "weekend_low_inventory");
    assert.equal(a[0].severity, "high");
    assert.equal(a[0].date, SAT);
    assert.match(a[0].message, /^11\/21\(土\) 週末の競合 7件中 5件が予約済・残り2室（推定）/);
  });
  it("自社が予約済なら info", () => {
    const a = deriveAlerts([day({ date: SAT, type: "weekend", status: "booked", market: lowInv })], cfg);
    assert.equal(a[0].severity, "info");
  });
  it("units=3, remaining=3 (誰も予約していない) → アラートなし", () => {
    const a = deriveAlerts(
      [day({ date: SAT, type: "weekend", market: { units: 3, unavailable: 0, remaining: 3, remainingEst: 3, occ: 60 } })],
      cfg,
    );
    assert.deepEqual(a, []);
  });
  it("ゲート条件のどれかを満たさなければ出さない", () => {
    const variants: Partial<MarketDay>[] = [
      { ...lowInv, dataQuality: "low" },
      { ...lowInv, remainingEst: 4 },
      { ...lowInv, remainingEst: null },
      { ...lowInv, occ: 49.9 },
      { ...lowInv, occ: null },
    ];
    for (const v of variants) {
      assert.deepEqual(deriveAlerts([day({ date: SAT, type: "weekend", market: v })], cfg), [], JSON.stringify(v));
    }
    // 平日は対象外
    assert.deepEqual(deriveAlerts([day({ type: "weekday", market: lowInv })], cfg), []);
  });
});

describe("weekday_spike / spike", () => {
  it("平日の超過Pace >= 15 かつ新規2件 → high、spike は重複させない", () => {
    const a = deriveAlerts([day({ market: { pace: 25, newBookings: 3, spike: true } })], cfg);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "weekday_spike");
    assert.equal(a[0].severity, "high");
    assert.match(a[0].message, /\+25pt\/7日/);
    assert.match(a[0].message, /新規予約3件/);
  });
  it("新規1件 / pace 14.9 / pace null は出さない", () => {
    assert.deepEqual(deriveAlerts([day({ market: { pace: 25, newBookings: 1 } })], cfg), []);
    assert.deepEqual(deriveAlerts([day({ market: { pace: 14.9, newBookings: 3 } })], cfg), []);
    assert.deepEqual(deriveAlerts([day({ market: { pace: null, newBookings: 3 } })], cfg), []);
  });
  it("週末の spike → medium", () => {
    const a = deriveAlerts([day({ date: SAT, type: "weekend", market: { pace: 22, newBookings: 2, spike: true } })], cfg);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "spike");
    assert.equal(a[0].severity, "medium");
  });
});

describe("raise_opportunity / discount_needed", () => {
  it("値上げ余地 (空室・連携済・raise・占有率中位以上)", () => {
    const a = deriveAlerts(
      [day({ action: "raise", changePct: 15.5, currentPrice: 110000, recommended: 127000, market: { occ: 60 } })],
      cfg,
    );
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "raise_opportunity");
    assert.equal(a[0].severity, "medium");
    assert.match(a[0].message, /現在¥110,000 → 推奨¥127,000（\+15\.5%）/);
  });
  it("値上げ余地: 未連携・占有率不足・空室以外では出さない", () => {
    const base = { action: "raise" as const, changePct: 15, market: { occ: 60 } };
    assert.equal(deriveAlerts([day({ ...base, statusSource: "none" })], cfg).filter((x) => x.kind === "raise_opportunity").length, 0);
    assert.deepEqual(deriveAlerts([day({ ...base, market: { occ: 40 } })], cfg), []);
    assert.deepEqual(deriveAlerts([day({ ...base, market: { occ: null } })], cfg), []);
    assert.deepEqual(deriveAlerts([day({ ...base, status: "blocked" })], cfg), []);
  });
  it("値下げ検討は lead <= 14 のみ", () => {
    const a = deriveAlerts([day({ action: "lower", changePct: -12, lead: 14, recommended: 97000 })], cfg);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "discount_needed");
    assert.match(a[0].message, /（−12%）/);
    assert.deepEqual(deriveAlerts([day({ action: "lower", changePct: -12, lead: 15 })], cfg), []);
  });
});

describe("own_status_unlinked と並び順", () => {
  it("将来日すべて statusSource none → info 1件 (date = days[0].date)", () => {
    const days = [
      day({ date: "2026-11-10", statusSource: "none" }),
      day({ date: "2026-11-11", statusSource: "none" }),
    ];
    const a = deriveAlerts(days, cfg);
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "own_status_unlinked");
    assert.equal(a[0].severity, "info");
    assert.equal(a[0].date, "2026-11-10");
  });
  it("一部でも連携があれば出さない / 空入力は空", () => {
    const days = [day({ date: "2026-11-10", statusSource: "none" }), day({ date: "2026-11-11", statusSource: "ical" })];
    assert.deepEqual(deriveAlerts(days, cfg), []);
    assert.deepEqual(deriveAlerts([], cfg), []);
  });
  it("severity (high → medium → info) → 日付昇順", () => {
    const days = [
      day({ date: "2026-11-20", lead: 10, action: "lower", changePct: -15 }), // medium
      day({ date: "2026-11-21", lead: 11, type: "weekend", status: "booked", market: lowInv }), // info
      day({ date: "2026-11-24", lead: 14, market: { pace: 30, newBookings: 2 } }), // high
      day({ date: "2026-11-28", lead: 18, type: "weekend", market: lowInv }), // high
      day({ date: "2026-11-12", lead: 2, action: "lower", changePct: -20 }), // medium
    ];
    const a = deriveAlerts(days, cfg);
    assert.deepEqual(
      a.map((x) => [x.severity, x.date]),
      [
        ["high", "2026-11-24"],
        ["high", "2026-11-28"],
        ["medium", "2026-11-12"],
        ["medium", "2026-11-20"],
        ["info", "2026-11-21"],
      ],
    );
  });
});
