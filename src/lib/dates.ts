import { isJpHoliday } from "./pricing/holidays";
import type { DayType, TimeRange } from "./types";

export function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

export function todayJst(): Date {
  // JST (UTC+9) の「今日」をUTC日付として扱う
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()));
}

export function rangeForTimeRange(range: TimeRange): { start: string; end: string; isFuture: boolean } {
  const today = todayJst();
  switch (range) {
    case "past30":
      return { start: toDateStr(addDays(today, -30)), end: toDateStr(addDays(today, -1)), isFuture: false };
    case "past90":
      return { start: toDateStr(addDays(today, -90)), end: toDateStr(addDays(today, -1)), isFuture: false };
    case "next30":
      return { start: toDateStr(today), end: toDateStr(addDays(today, 29)), isFuture: true };
    case "next60":
      return { start: toDateStr(today), end: toDateStr(addDays(today, 59)), isFuture: true };
    case "next90":
      return { start: toDateStr(today), end: toDateStr(addDays(today, 89)), isFuture: true };
  }
}

/** 国民の祝日 (振替休日・国民の休日を含む。年に依存しない計算) または日曜 */
export function isHoliday(dateStr: string): boolean {
  return isJpHoliday(dateStr) || new Date(dateStr + "T00:00:00Z").getUTCDay() === 0;
}

export function matchesDayType(dateStr: string, dayType: DayType): boolean {
  if (dayType === "all") return true;
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=Sun
  switch (dayType) {
    case "weekday":
      return dow >= 1 && dow <= 4 && !isHoliday(dateStr);
    case "preholiday":
      return dow === 5 || dow === 6;
    case "holiday":
      return isHoliday(dateStr);
  }
}
