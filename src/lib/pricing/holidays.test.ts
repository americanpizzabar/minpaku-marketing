import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysStr,
  classifyNight,
  diffDays,
  holidayName,
  isJpHoliday,
  jpHolidays,
  peakPeriodOf,
} from "./holidays";
import { DEFAULT_PEAK_PERIODS } from "./config";
import { isHoliday, matchesDayType } from "../dates";

const sortedKeys = (m: Map<string, string>) => [...m.keys()].sort();

test("jpHolidays 2026 は内閣府公表と完全一致", () => {
  const expected = [
    "01-01", "01-12", "02-11", "02-23", "03-20", "04-29", "05-03", "05-04", "05-05", "05-06",
    "07-20", "08-11", "09-21", "09-22", "09-23", "10-12", "11-03", "11-23",
  ].map((md) => `2026-${md}`);
  const h = jpHolidays(2026);
  assert.deepEqual(sortedKeys(h), expected);
  assert.equal(h.get("2026-05-06"), "振替休日");
  assert.equal(h.get("2026-09-22"), "国民の休日");
  assert.equal(h.get("2026-03-20"), "春分の日");
  assert.equal(h.get("2026-09-23"), "秋分の日");
  assert.equal(h.get("2026-10-12"), "スポーツの日");
  assert.equal(h.has("2026-12-31"), false);
});

test("jpHolidays 2027 は内閣府公表と完全一致", () => {
  const expected = [
    "01-01", "01-11", "02-11", "02-23", "03-21", "03-22", "04-29", "05-03", "05-04", "05-05",
    "07-19", "08-11", "09-20", "09-23", "10-11", "11-03", "11-23",
  ].map((md) => `2027-${md}`);
  const h = jpHolidays(2027);
  assert.deepEqual(sortedKeys(h), expected);
  assert.equal(h.get("2027-03-22"), "振替休日");
  assert.equal(h.get("2027-03-21"), "春分の日");
});

test("jpHolidays 他の年の代表例 (振替・国民の休日・春分秋分)", () => {
  // 2015: 9/21 敬老の日, 9/22 国民の休日, 9/23 秋分の日 (シルバーウィーク)
  const h2015 = jpHolidays(2015);
  assert.equal(h2015.get("2015-09-22"), "国民の休日");
  // 2025: 2/23(日) → 2/24 振替休日, 11/23(日) → 11/24 振替休日, 春分 3/20, 秋分 9/23
  const h2025 = jpHolidays(2025);
  assert.equal(h2025.get("2025-02-24"), "振替休日");
  assert.equal(h2025.get("2025-11-24"), "振替休日");
  assert.equal(h2025.get("2025-03-20"), "春分の日");
  assert.equal(h2025.get("2025-09-23"), "秋分の日");
  assert.equal(h2025.size, 19);
  // 2032: 秋分の日 9/21, 敬老の日 9/20 → 国民の休日なし。2032-03-20 春分
  const h2032 = jpHolidays(2032);
  assert.equal(h2032.get("2032-03-20"), "春分の日");
  // 2016 から山の日
  assert.equal(jpHolidays(2015).has("2015-08-11"), false);
  assert.equal(jpHolidays(2016).get("2016-08-11"), "山の日");
  // 2019 以前の天皇誕生日 12/23、2020 以降 2/23
  assert.equal(jpHolidays(2018).get("2018-12-23"), "天皇誕生日");
  assert.equal(jpHolidays(2018).get("2018-12-24"), "振替休日");
  assert.equal(jpHolidays(2020).has("2020-12-23"), false);
  // 範囲の両端も例外なく計算できる
  assert.ok(jpHolidays(2000).size >= 14);
  assert.ok(jpHolidays(2099).size >= 16);
  for (const y of [2000, 2050, 2099]) {
    for (const k of jpHolidays(y).keys()) assert.ok(k.startsWith(`${y}-`));
  }
});

test("jpHolidays の戻り値を変更してもメモ化された表は壊れない", () => {
  const h = jpHolidays(2026);
  h.delete("2026-01-01");
  assert.equal(isJpHoliday("2026-01-01"), true);
});

test("holidayName / isJpHoliday", () => {
  assert.equal(holidayName("2026-11-03"), "文化の日");
  assert.equal(holidayName("2026-11-01"), null); // 日曜は祝日扱いしない
  assert.equal(isJpHoliday("2026-11-01"), false);
  assert.equal(isJpHoliday("2027-01-11"), true);
  assert.equal(holidayName("invalid"), null);
});

test("peakPeriodOf (年跨ぎを含む)", () => {
  assert.equal(peakPeriodOf("2026-12-27", DEFAULT_PEAK_PERIODS), null);
  assert.equal(peakPeriodOf("2026-12-28", DEFAULT_PEAK_PERIODS), "年末年始");
  assert.equal(peakPeriodOf("2027-01-03", DEFAULT_PEAK_PERIODS), "年末年始");
  assert.equal(peakPeriodOf("2027-01-04", DEFAULT_PEAK_PERIODS), null);
  assert.equal(peakPeriodOf("2026-05-05", DEFAULT_PEAK_PERIODS), "ゴールデンウィーク");
  assert.equal(peakPeriodOf("2026-08-16", DEFAULT_PEAK_PERIODS), "お盆");
  assert.equal(peakPeriodOf("2026-08-17", DEFAULT_PEAK_PERIODS), null);
  assert.equal(peakPeriodOf("2026-08-12", []), null);
});

const cases: [string, "weekday" | "weekend", string, string][] = [
  ["2026-11-02", "weekend", "祝前日（文化の日）", "祝前"],
  ["2026-11-03", "weekday", "祝日（文化の日）・翌日平日", "祝"],
  ["2026-11-22", "weekend", "祝前日（勤労感謝の日）", "祝前"],
  ["2026-11-20", "weekend", "金曜", "金"],
  ["2026-11-21", "weekend", "土曜", "土"],
  ["2026-11-24", "weekday", "平日", ""],
  ["2026-12-27", "weekday", "平日", ""],
  ["2026-12-30", "weekend", "年末年始", "連休"],
  ["2027-01-03", "weekend", "年末年始", "連休"],
  ["2027-01-04", "weekday", "平日", ""],
  ["2027-01-10", "weekend", "祝前日（成人の日）", "祝前"],
  ["2027-03-21", "weekend", "祝前日（振替休日）", "祝前"],
];

for (const [date, type, reason, tag] of cases) {
  test(`classifyNight ${date} → ${type} ${reason}`, () => {
    const n = classifyNight(date, DEFAULT_PEAK_PERIODS);
    assert.equal(n.date, date);
    assert.equal(n.type, type);
    assert.equal(n.reason, reason);
    assert.equal(n.tag, tag);
  });
}

test("classifyNight のフラグ", () => {
  const n = classifyNight("2027-03-21", DEFAULT_PEAK_PERIODS);
  assert.equal(n.dow, 0);
  assert.equal(n.isHoliday, true);
  assert.equal(n.holidayName, "春分の日");
  assert.equal(n.isPreHoliday, true);
  assert.equal(n.peakPeriod, null);

  const p = classifyNight("2026-12-30", DEFAULT_PEAK_PERIODS);
  assert.equal(p.peakPeriod, "年末年始");
  assert.equal(p.isHoliday, false);
  assert.equal(p.holidayName, null);

  const w = classifyNight("2026-11-24", DEFAULT_PEAK_PERIODS);
  assert.equal(w.dow, 2);
  assert.equal(w.isPreHoliday, false);

  // 特定連休なしなら年末も通常の判定 (2026-12-30 は水曜 → 平日)
  const q = classifyNight("2026-12-30", []);
  assert.equal(q.type, "weekday");
  assert.equal(q.tag, "");
  // 祝日の金曜 (2026-01-02 は祝日でない金曜)
  assert.equal(classifyNight("2027-01-01", []).reason, "金曜");
  // 日曜の祝前日 2026-05-03(日・憲法記念日) → 翌日みどりの日
  assert.equal(classifyNight("2026-05-03", []).reason, "祝前日（みどりの日）");
  // 振替休日の前日 2026-05-05 → 祝前日（振替休日）
  assert.equal(classifyNight("2026-05-05", []).reason, "祝前日（振替休日）");
});

test("addDaysStr / diffDays", () => {
  assert.equal(addDaysStr("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysStr("2026-03-01", -1), "2026-02-28");
  assert.equal(diffDays("2026-11-10", "2027-01-09"), 60);
  assert.equal(diffDays("2026-11-10", "2026-11-03"), -7);
});

test("dates.isHoliday は祝日または日曜 (12/31 は対象外)", () => {
  assert.equal(isHoliday("2026-11-03"), true);
  assert.equal(isHoliday("2026-11-01"), true); // 日曜
  assert.equal(isHoliday("2026-12-31"), false); // 木曜・祝日でない
  assert.equal(isHoliday("2027-01-11"), true); // 2027年の祝日も判定できる
  assert.equal(isHoliday("2026-11-04"), false);
  assert.equal(matchesDayType("2026-11-03", "weekday"), false);
  assert.equal(matchesDayType("2026-11-04", "weekday"), true);
  assert.equal(matchesDayType("2026-11-06", "preholiday"), true);
  assert.equal(matchesDayType("2027-03-22", "holiday"), true);
});
