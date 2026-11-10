/**
 * 日本の祝日 (年に依存しないアルゴリズム計算) と、宿泊夜の 平日/週末 区分 (仕様 3.1)。
 *
 * 【担当: market-analytics】
 */
import type { NightClass, PeakPeriod } from "./types";

const pad2 = (n: number): string => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

/** month 月の第 n 月曜日 (日付) */
function nthMonday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstMonday = 1 + ((8 - firstDow) % 7);
  return firstMonday + (n - 1) * 7;
}

function dowOf(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

const cache = new Map<number, Map<string, string>>();

/** 年ごとにメモ化した祝日表 (内部用。外へ渡すときはコピーする) */
function holidaysOf(year: number): Map<string, string> {
  const hit = cache.get(year);
  if (hit) return hit;

  // 国民の祝日 (法定の祝日そのもの)。2000〜2006 年等の旧制度の日付・名称も反映する
  const base = new Map<string, string>();
  const add = (m: number, d: number, name: string) => base.set(ymd(year, m, d), name);
  const y = year - 1980;

  add(1, 1, "元日");
  add(1, nthMonday(year, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  if (year >= 2020) add(2, 23, "天皇誕生日");
  add(3, Math.floor(20.8431 + 0.242194 * y - Math.floor(y / 4)), "春分の日");
  add(4, 29, year >= 2007 ? "昭和の日" : "みどりの日");
  add(5, 3, "憲法記念日");
  if (year >= 2007) add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  if (year >= 2003) add(7, nthMonday(year, 7, 3), "海の日");
  else add(7, 20, "海の日");
  if (year >= 2016) add(8, 11, "山の日");
  if (year >= 2003) add(9, nthMonday(year, 9, 3), "敬老の日");
  else add(9, 15, "敬老の日");
  add(9, Math.floor(23.2488 + 0.242194 * y - Math.floor(y / 4)), "秋分の日");
  add(10, nthMonday(year, 10, 2), year >= 2020 ? "スポーツの日" : "体育の日");
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  if (year <= 2018) add(12, 23, "天皇誕生日");
  if (year === 2019) {
    add(5, 1, "即位の日");
    add(10, 22, "即位礼正殿の儀");
  }

  const result = new Map(base);
  const inYear = (d: string) => d.startsWith(`${year}-`);

  // 国民の休日: 前日と翌日が国民の祝日で、それ自体は祝日でない日
  for (const date of base.keys()) {
    const mid = addDaysStr(date, 1);
    if (!result.has(mid) && base.has(addDaysStr(date, 2)) && inYear(mid)) {
      result.set(mid, "国民の休日");
    }
  }

  // 振替休日: 国民の祝日が日曜のとき、その後の最初の「祝日でない日」
  const sundayHolidays = [...base.keys()].filter((d) => dowOf(d) === 0).sort();
  for (const date of sundayHolidays) {
    let d = addDaysStr(date, 1);
    while (result.has(d)) d = addDaysStr(d, 1);
    if (inYear(d)) result.set(d, "振替休日");
  }

  const sorted = new Map([...result.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  cache.set(year, sorted);
  return sorted;
}

/**
 * 指定年の国民の祝日を返す (key = "YYYY-MM-DD", value = 祝日名)。
 * 対象年 2000〜2099 で正しいこと。含めるもの:
 * - 固定日: 元日1/1, 建国記念の日2/11, 天皇誕生日2/23(2020年以降), 昭和の日4/29, 憲法記念日5/3,
 *   みどりの日5/4, こどもの日5/5, 山の日8/11(2016年以降), 文化の日11/3, 勤労感謝の日11/23
 * - ハッピーマンデー: 成人の日=1月第2月曜, 海の日=7月第3月曜, 敬老の日=9月第3月曜, スポーツの日=10月第2月曜
 * - 春分の日 = floor(20.8431 + 0.242194*(Y-1980) - floor((Y-1980)/4)) 日 (3月)
 *   秋分の日 = floor(23.2488 + 0.242194*(Y-1980) - floor((Y-1980)/4)) 日 (9月)
 * - 国民の休日: 前日と翌日が祝日で、それ自体は祝日でない日 (例: 2026-09-22) → 名称 "国民の休日"
 * - 振替休日: 祝日が日曜のとき、その後の最初の「祝日でない日」→ 名称 "振替休日" (例: 2026-05-06)
 * 2020/2021 の五輪特例 (海の日・スポーツの日・山の日の移動) は対象外でよい。
 * 結果は年ごとにメモ化してよい。12/31 は祝日ではない (年末年始は peakPeriods で扱う)。
 * 正解データ (内閣府公表。テストで完全一致を確認すること):
 *   2026: 01-01,01-12,02-11,02-23,03-20,04-29,05-03,05-04,05-05,05-06(振替休日),07-20,08-11,
 *         09-21,09-22(国民の休日),09-23,10-12,11-03,11-23
 *   2027: 01-01,01-11,02-11,02-23,03-21,03-22(振替休日),04-29,05-03,05-04,05-05,07-19,08-11,
 *         09-20,09-23,10-11,11-03,11-23
 */
export function jpHolidays(year: number): Map<string, string> {
  if (!Number.isInteger(year)) return new Map();
  return new Map(holidaysOf(year));
}

/** その日が国民の祝日ならその名称、そうでなければ null (日曜は祝日扱いしない) */
export function holidayName(date: string): string | null {
  const year = Number(date.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  return holidaysOf(year).get(date.slice(0, 10)) ?? null;
}

export function isJpHoliday(date: string): boolean {
  return holidayName(date) !== null;
}

/** date が peakPeriods のいずれかに含まれればその名称 (start > end は年末→年始の跨ぎとして扱う) */
export function peakPeriodOf(date: string, peakPeriods: PeakPeriod[]): string | null {
  const md = date.slice(5, 10);
  for (const p of peakPeriods) {
    const inRange = p.start <= p.end ? md >= p.start && md <= p.end : md >= p.start || md <= p.end;
    if (inRange) return p.name;
  }
  return null;
}

/**
 * 宿泊夜 date を区分する (仕様 3.1)。
 * - weekend (週末・ハイバリュー日): 金曜 または 土曜 または 祝前日 (翌日が国民の祝日)
 *   または 特定連休 (peakPeriods) に含まれる夜
 * - weekday: 上記以外 (= 日〜木曜で祝前日でない夜)。祝日当日でも翌日が平日なら weekday。
 * reason の優先順: 特定連休名 > "祝前日（{翌日の祝日名}）" > "金曜"/"土曜" > "平日"。
 *   weekday で当日が祝日の場合は "祝日（{名称}）・翌日平日" とする。
 * tag (セルに表示する2文字以内): 特定連休 → "連休"、祝前日 → "祝前"、金曜 → "金"、土曜 → "土"、
 *   weekday かつ当日が祝日 → "祝"、それ以外 → ""。優先順は reason と同じ。
 * 例 (テストで必ず確認すること。peakPeriods は DEFAULT_PEAK_PERIODS):
 *   2026-11-02(月) weekend 祝前日（文化の日） / 2026-11-03(火・祝) weekday 祝日（文化の日）・翌日平日 /
 *   2026-11-22(日) weekend 祝前日（勤労感謝の日） / 2026-11-20(金) weekend / 2026-11-21(土) weekend /
 *   2026-11-24(火) weekday / 2026-12-27(日) weekday / 2026-12-30(水) weekend 年末年始 /
 *   2027-01-03(日) weekend 年末年始 / 2027-01-04(月) weekday / 2027-01-10(日) weekend 祝前日（成人の日） /
 *   2027-03-21(日・春分の日) weekend 祝前日（振替休日）
 */
export function classifyNight(date: string, peakPeriods: PeakPeriod[]): NightClass {
  const dow = dowOf(date);
  const name = holidayName(date);
  const nextName = holidayName(addDaysStr(date, 1));
  const peak = peakPeriodOf(date, peakPeriods);
  const isPreHoliday = nextName !== null;
  const isWeekend = peak !== null || isPreHoliday || dow === 5 || dow === 6;

  let reason: string;
  let tag: string;
  if (peak !== null) {
    reason = peak;
    tag = "連休";
  } else if (isPreHoliday) {
    reason = `祝前日（${nextName}）`;
    tag = "祝前";
  } else if (dow === 5) {
    reason = "金曜";
    tag = "金";
  } else if (dow === 6) {
    reason = "土曜";
    tag = "土";
  } else if (name !== null) {
    reason = `祝日（${name}）・翌日平日`;
    tag = "祝";
  } else {
    reason = "平日";
    tag = "";
  }

  return {
    date,
    type: isWeekend ? "weekend" : "weekday",
    dow,
    isHoliday: name !== null,
    holidayName: name,
    isPreHoliday,
    peakPeriod: peak,
    reason,
    tag,
  };
}

/** "YYYY-MM-DD" に n 日加算 (UTC 計算。タイムゾーンに依存しない) */
export function addDaysStr(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** b - a の日数 (どちらも "YYYY-MM-DD") */
export function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86_400_000,
  );
}
