import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRICING_CONFIG, normalizePricingConfig } from "./config";
import { alphaCoef } from "./engine";
import type { MarketDay, NightClass } from "./types";

const WD: NightClass = {
  date: "2026-11-24",
  type: "weekday",
  dow: 2,
  isHoliday: false,
  holidayName: null,
  isPreHoliday: false,
  peakPeriod: null,
  reason: "平日",
  tag: "",
};

function occDay(occ: number): MarketDay {
  return {
    units: 8,
    unavailable: 0,
    expectedBooked: 0,
    effectiveUnits: 8,
    occRaw: occ,
    occAdj: occ,
    occ,
    occCi: [occ, occ],
    remaining: 0,
    remainingEst: 0,
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
  };
}

describe("normalizePricingConfig: α の帯", () => {
  it("既定値はそのまま", () => {
    const c = normalizePricingConfig({});
    assert.deepEqual(c.alpha, DEFAULT_PRICING_CONFIG.alpha);
  });
  it("中位の上限が高位の下限を超える設定は高位側を引き上げ、占有率に対して係数が単調になる", () => {
    const c = normalizePricingConfig({ alpha: { weekday: { midMin: 30, midMax: 40 } } });
    assert.equal(c.alpha.weekday.highMin, 40);
    assert.ok(c.alpha.weekday.highMax >= c.alpha.weekday.highMin);
    // 競合が埋まって高位帯に入った瞬間に推奨が下がらない
    let prev = -Infinity;
    for (let occ = 50; occ <= 100; occ += 0.5) {
      const a = alphaCoef(occDay(occ), 20, WD, c).value;
      assert.ok(a >= prev - 1e-9, `occ ${occ}: ${a} < ${prev}`);
      prev = a;
    }
    assert.ok(prev <= c.alpha.weekday.highMax / 100 + 1e-9);
  });
});
