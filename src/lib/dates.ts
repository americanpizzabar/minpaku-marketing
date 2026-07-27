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

// 2026年の主な日本の祝日 (簡易リスト)
const JP_HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
  "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06",
  "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
  "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31",
]);

export function isHoliday(dateStr: string): boolean {
  return JP_HOLIDAYS_2026.has(dateStr) || new Date(dateStr + "T00:00:00Z").getUTCDay() === 0;
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
