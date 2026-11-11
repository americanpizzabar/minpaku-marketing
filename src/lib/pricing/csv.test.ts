import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toDetailCsv, toPriceCsv, toPriceRanges } from "./csv";
import type { DayRecommendation, MarketDay, NightType, OwnStatus, PricingDashboard } from "./types";

function market(extra: Partial<MarketDay> = {}): MarketDay {
  return {
    units: 5,
    unavailable: 2,
    expectedBooked: 1.8,
    effectiveUnits: 4.8,
    occRaw: 40,
    occAdj: 37.5,
    occ: 38.2,
    occCi: [25, 50],
    remaining: 3,
    remainingEst: 3,
    compAdr: 98000,
    priceCount: 3,
    maxAgeDays: 1,
    listings: [],
    pace: 4.5,
    paceRaw: 10,
    paceExpected: 5.5,
    paceDays: 7,
    newBookings: 1,
    spike: false,
    dataQuality: "ok",
    ...extra,
  };
}

function day(
  date: string,
  lead: number,
  opts: {
    status?: OwnStatus;
    recommended?: number;
    type?: NightType;
    reason?: string;
    currentPrice?: number | null;
    clampedBy?: "floor" | "ceiling" | null;
    market?: Partial<MarketDay>;
    signal?: DayRecommendation["pricing"]["signal"];
  } = {},
): DayRecommendation {
  const type = opts.type ?? "weekday";
  const status = opts.status ?? "vacant";
  return {
    date,
    lead,
    night: {
      date,
      type,
      dow: new Date(date + "T00:00:00Z").getUTCDay(),
      isHoliday: false,
      holidayName: null,
      isPreHoliday: false,
      peakPeriod: null,
      reason: opts.reason ?? (type === "weekday" ? "平日" : "土曜"),
      tag: "",
    },
    market: market(opts.market),
    own: {
      status,
      statusSource: "manual",
      currentPrice: opts.currentPrice === undefined ? 110000 : opts.currentPrice,
      currentPriceSource: "manual",
    },
    pricing: {
      basePrice: 110000,
      delta: { value: type === "weekend" ? 0.15 : 0, reason: "" },
      alpha: { value: 0.075, reason: "" },
      beta: { value: -0.025, reason: "" },
      gamma: { value: -0.156, reason: "" },
      rawPrice: 123456,
      floor: 60000,
      ceiling: 200000,
      recommended: opts.recommended ?? 110000,
      clampedBy: opts.clampedBy ?? null,
      changePct: 12.3,
      action: status === "vacant" ? "raise" : status,
      signal: opts.signal ?? "partial",
    },
  };
}

// toDetailCsv / toPriceCsv / toPriceRanges は days だけを使う
function dash(days: DayRecommendation[]): PricingDashboard {
  return { days } as unknown as PricingDashboard;
}

describe("toDetailCsv", () => {
  const csv = toDetailCsv(
    dash([
      day("2026-11-13", 3, { type: "weekend", reason: "金曜" }),
      day("2026-11-14", 4, { type: "weekend", reason: 'テスト,"引用"\n改行', currentPrice: null, clampedBy: "floor" }),
      day("2026-11-15", 5, { status: "booked", market: { occ: null, compAdr: null, pace: null } }),
    ]),
  );
  it("BOM 付き、CRLF 改行", () => {
    assert.ok(csv.startsWith("﻿"));
    assert.ok(csv.endsWith("\r\n"));
    assert.equal(csv.replace(/\r\n/g, "").includes("\r"), false);
  });
  const lines = csv.slice(1).split("\r\n");
  it("ヘッダ 26 列", () => {
    const header = lines[0].split(",");
    assert.equal(header.length, 26);
    assert.equal(header[0], "日付");
    assert.equal(header[9], "乖離率(推奨までの変更率%)");
    assert.equal(header[17], "Pace超過(pt/7日)");
    assert.equal(header[25], "ガードレール");
  });
  it("値の書式 (係数は % 小数1桁、ラベルは日本語)", () => {
    const cells = lines[1].split(",");
    assert.equal(cells.length, 26);
    assert.deepEqual(cells.slice(0, 12), [
      "2026-11-13",
      "金",
      "週末",
      "金曜",
      "3",
      "空室",
      "110000",
      "入力値",
      "110000",
      "12.3",
      "値上げ",
      "一部連動",
    ]);
    assert.deepEqual(cells.slice(12, 18), ["38.2", "40", "5", "3", "98000", "4.5"]);
    assert.deepEqual(cells.slice(18, 22), ["15.0", "7.5", "-2.5", "-15.6"]);
    assert.deepEqual(cells.slice(22), ["123456", "60000", "200000", ""]);
  });
  it("カンマ・引用符・改行を含む値はダブルクォートでエスケープ、null は空欄", () => {
    assert.ok(csv.includes(',"テスト,""引用""\n改行",'));
    assert.ok(csv.includes(",空室,,入力値,"));
    assert.ok(csv.includes("下限適用"));
  });
  it("予約済の行と null の指標", () => {
    const last = lines[lines.length - 2].split(",");
    assert.equal(last[0], "2026-11-15");
    assert.equal(last[5], "予約済");
    assert.equal(last[10], "予約済");
    assert.equal(last[12], "");
    assert.equal(last[16], "");
    assert.equal(last[17], "");
  });
});

describe("toPriceCsv", () => {
  it("空室の将来日のみ、BOM なし、LF", () => {
    const csv = toPriceCsv(
      dash([
        day("2026-11-14", 4, { type: "weekend", recommended: 127000 }),
        day("2026-11-15", 5, { status: "booked" }),
        day("2026-11-16", 6, { status: "blocked" }),
        day("2026-11-17", 7, { recommended: 98000.4 }),
      ]),
    );
    assert.equal(
      csv,
      "date,price,currency,day_type,min_nights\n2026-11-14,127000,JPY,weekend,\n2026-11-17,98000,JPY,weekday,\n",
    );
  });
  it("空なら header のみ", () => {
    assert.equal(toPriceCsv(dash([])), "date,price,currency,day_type,min_nights\n");
  });
  it("競合データ不足でルールのみの推奨の日は取込用ファイルに入れない", () => {
    const csv = toPriceCsv(
      dash([
        day("2026-11-14", 4, { recommended: 127000, signal: "rules_only" }),
        day("2026-11-17", 7, { recommended: 98000, signal: "market" }),
      ]),
    );
    assert.equal(csv, "date,price,currency,day_type,min_nights\n2026-11-17,98000,JPY,weekday,\n");
  });
});

describe("toPriceRanges", () => {
  it("連続する同一価格の空室日をまとめる", () => {
    const r = toPriceRanges(
      dash([
        day("2026-11-14", 4, { recommended: 127000 }), // 順不同でも日付順に並べる
        day("2026-11-13", 3, { recommended: 127000 }),
        day("2026-11-15", 5, { recommended: 110000 }),
        day("2026-11-16", 6, { status: "booked", recommended: 110000 }),
        day("2026-11-17", 7, { recommended: 110000 }),
        day("2026-11-18", 8, { recommended: 98000 }),
        day("2026-11-20", 10, { recommended: 98000 }), // 11/19 が無いので別区間
      ]),
    );
    assert.deepEqual(
      r.map((x) => [x.from, x.to, x.price, x.nights]),
      [
        ["2026-11-13", "2026-11-14", 127000, 2],
        ["2026-11-15", "2026-11-15", 110000, 1],
        ["2026-11-17", "2026-11-17", 110000, 1],
        ["2026-11-18", "2026-11-18", 98000, 1],
        ["2026-11-20", "2026-11-20", 98000, 1],
      ],
    );
    assert.equal(r[0].label, "11/13(金)〜11/14(土) ¥127,000（2泊）");
    assert.equal(r[3].label, "11/18(水) ¥98,000");
  });
  it("ルールのみの日は参考区間として分け、根拠の違う日とはまとめない", () => {
    const r = toPriceRanges(
      dash([
        day("2026-11-13", 3, { recommended: 110000, signal: "market" }),
        day("2026-11-14", 4, { recommended: 110000, signal: "rules_only" }),
        day("2026-11-15", 5, { recommended: 110000, signal: "rules_only" }),
      ]),
    );
    assert.deepEqual(
      r.map((x) => [x.from, x.to, x.nights, x.rulesOnly]),
      [
        ["2026-11-13", "2026-11-13", 1, false],
        ["2026-11-14", "2026-11-15", 2, true],
      ],
    );
  });
  it("空入力は空配列", () => {
    assert.deepEqual(toPriceRanges(dash([])), []);
  });
});
