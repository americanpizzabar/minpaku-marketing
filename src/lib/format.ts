export function formatJpy(value: number): string {
  return `¥${Math.round(value).toLocaleString("ja-JP")}`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * 日時文字列を Date に変換する。SQLite の UTC 形式 'YYYY-MM-DD HH:MM:SS' (タイムゾーン無し) は UTC として扱い、
 * ISO 8601 はそのまま解釈する。解釈できなければ null。
 */
export function parseTimestamp(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const s = ts.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 日時を日本時間の "M/D" で返す (解釈できなければ null) */
export function formatJstMonthDay(ts: string | null | undefined): string | null {
  const d = parseTimestamp(ts);
  if (!d) return null;
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

/** 2つの日時のうち新しい方 (どちらも解釈できなければ null) */
export function newerTimestamp(a: string | null, b: string | null): string | null {
  const da = parseTimestamp(a);
  const db = parseTimestamp(b);
  if (!da) return db ? b : null;
  if (!db) return a;
  return db.getTime() > da.getTime() ? b : a;
}
