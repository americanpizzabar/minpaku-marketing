/**
 * 自社カレンダーの iCal (Airbnb の「カレンダーをエクスポート」URL) 取り込み。
 * 仕様 4.1 のタイムライン行1「自社ステータス（予約済 / 空室）」を AirROI 未収録でも埋めるため。
 */
import type { Client, InStatement } from "@libsql/client";
import { isUserFacingMessage } from "../errors";
import { isAllowedIcalUrl } from "./config";
import { addDaysStr } from "./holidays";
import type { IcalImportStatus } from "./types";

export interface IcalEvent {
  start: string; // "YYYY-MM-DD" (JST の日付)
  end: string; // "YYYY-MM-DD" (この日は含まない = チェックアウト日)
  summary: string;
}

export const ICAL_LAST_IMPORT_KEY = "pricing:ical_last_import";
const FETCH_TIMEOUT_MS = 15_000;
const DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i;

/** iCal の日付/日時の値 → JST の "YYYY-MM-DD" (解釈できなければ null) */
function parseIcalDate(value: string): string | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const ymd = `${y}-${mo}-${d}`;
  const base = new Date(ymd + "T00:00:00Z");
  if (Number.isNaN(base.getTime()) || base.toISOString().slice(0, 10) !== ymd) return null;
  if (hh !== undefined && z) {
    // UTC 日時 → +9時間して JST の日付
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss ?? 0));
    return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  }
  return ymd;
}

/** "NAME;PARAM=..:value" → { name, value }。パラメータ内の引用符中の ":" は区切りとみなさない */
function splitContentLine(line: string): { name: string; value: string } | null {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      const head = line.slice(0, i);
      const name = head.split(";")[0].trim().toUpperCase();
      return { name, value: line.slice(i + 1) };
    }
  }
  return null;
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();
}

/**
 * iCal テキストから VEVENT を取り出す。
 * - 行の折り返し (CRLF/LF の直後が空白/タブの行は前行に連結) を解除してから解析
 * - 日付の解釈 (DTSTART / DTEND とも):
 *     VALUE=DATE (YYYYMMDD) → そのまま
 *     末尾 Z の UTC 日時 (YYYYMMDDTHHMMSSZ) → +9時間して JST の日付
 *     TZID= 付き または タイムゾーン無しの日時 → 記載された日付部分をそのまま
 * - DTEND が無ければ start の翌日
 * - SUMMARY が無ければ ""
 */
export function parseIcalEvents(text: string): IcalEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n|\r/);
  const events: IcalEvent[] = [];
  let cur: { start: string | null; end: string | null; summary: string } | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      cur = { start: null, end: null, summary: "" };
      continue;
    }
    if (upper === "END:VEVENT") {
      if (cur && cur.start) {
        events.push({ start: cur.start, end: cur.end ?? addDaysStr(cur.start, 1), summary: cur.summary });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = splitContentLine(line);
    if (!prop) continue;
    if (prop.name === "DTSTART") cur.start = parseIcalDate(prop.value);
    else if (prop.name === "DTEND") cur.end = parseIcalDate(prop.value);
    else if (prop.name === "SUMMARY") cur.summary = unescapeText(prop.value);
  }
  return events;
}

/**
 * イベントを日別の状態にする (from 〜 to, 両端含む)。宿泊夜 = [start, end) の各日。
 * summary に "reserved" を含む (大文字小文字無視) → "booked"、それ以外 (Airbnb (Not available) 等) → "blocked"。
 * 同じ日に両方あれば "booked" を優先。
 */
export function icalEventsToStatuses(
  events: IcalEvent[],
  from: string,
  to: string,
): Map<string, "booked" | "blocked"> {
  const out = new Map<string, "booked" | "blocked">();
  if (from > to) return out;
  for (const ev of events) {
    const status = /reserved/i.test(ev.summary) ? "booked" : "blocked";
    // [start, end) と [from, to] の重なりだけを走査する
    let d = ev.start > from ? ev.start : from;
    while (d < ev.end && d <= to) {
      if (status === "booked" || out.get(d) !== "booked") out.set(d, status);
      d = addDaysStr(d, 1);
    }
  }
  return out;
}

async function recordImportStatus(db: Client, status: IcalImportStatus): Promise<void> {
  await db.execute(importStatusStmt(status));
}

function importStatusStmt(status: IcalImportStatus): InStatement {
  return {
    sql: `INSERT INTO sync_state (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [ICAL_LAST_IMPORT_KEY, JSON.stringify(status)],
  };
}

const MAX_ICAL_BYTES = 2 * 1024 * 1024;
const TOO_LARGE = "iCalのサイズが大きすぎます（2MB超）";

class IcalTooLargeError extends Error {
  constructor() {
    super(TOO_LARGE);
  }
}
const MAX_REDIRECTS = 3;

/** 本文を最大 MAX_ICAL_BYTES まで読む (巨大な応答でメモリを使い切らない) */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ICAL_BYTES) {
    throw new IcalTooLargeError();
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ICAL_BYTES) {
      await reader.cancel().catch(() => {});
      throw new IcalTooLargeError();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

/**
 * iCal を取得する。リダイレクトは自動で追わず、転送先も Airbnb の iCal URL の場合だけ最大3回まで追う
 * (許可外のホストへサーバーから接続しない)。本文は 2MB まで。
 */
async function fetchIcalText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetch(current, {
          signal: controller.signal,
          redirect: "manual",
          headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1" },
        });
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        throw new Error(aborted ? "iCalの取得がタイムアウトしました（15秒）" : "iCalの取得に失敗しました（通信エラー）");
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        let next: string | null = null;
        try {
          next = location ? new URL(location, current).href : null;
        } catch {
          next = null;
        }
        if (!next || !isAllowedIcalUrl(next) || hop >= MAX_REDIRECTS) {
          throw new Error("iCalの取得に失敗しました（Airbnb 以外への転送は追いません）");
        }
        current = next;
        continue;
      }
      if (!res.ok) throw new Error(`iCalの取得に失敗しました（HTTP ${res.status}）`);
      try {
        return await readCapped(res);
      } catch (err) {
        if (err instanceof IcalTooLargeError) throw err;
        // 本文の読み込み中のタイムアウトも日本語のメッセージにする
        const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        throw new Error(aborted ? "iCalの取得がタイムアウトしました（15秒）" : "iCalの取得に失敗しました（通信エラー）");
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * url (config.ts の isAllowedIcalUrl を満たすこと) を fetch (タイムアウト 15 秒) して取り込み、lumina_bookings に保存する。
 * 安全規則 (既存データを誤って消さない):
 * - res.ok でない、または本文に "BEGIN:VCALENDAR" が無い → DB に触れず日本語の Error を投げる
 * - 範囲 [today, today + horizonDays] で状態のある日が 0 なのに、既存の source='ical' 行が範囲内に1件以上ある
 *   → DB に触れず Error("iCalが空でした。URLが変更されていないか確認してください")
 * - 範囲内の source='ical' 行の DELETE と新しい行の INSERT は1回の db.batch(stmts, "write") で行う
 *   (source='manual' の行は残す: 手動指定が優先。INSERT は manual 行のある日をスキップ)
 * - 成功・失敗とも sync_state "pricing:ical_last_import" に IcalImportStatus の JSON を保存
 *   (失敗時は at/ok=false/imported=0/error=メッセージ)
 * - 戻り値 imported = 書き込んだ日数, booked/blocked = 内訳
 */
export async function importIcalToDb(
  db: Client,
  url: string,
  today: string,
  horizonDays: number,
): Promise<{ imported: number; booked: number; blocked: number }> {
  const at = new Date().toISOString();
  try {
    if (!isAllowedIcalUrl(url)) {
      throw new Error("Airbnb のカレンダーエクスポート URL ではないため取り込めません");
    }
    const text = await fetchIcalText(url);
    if (!text.includes("BEGIN:VCALENDAR")) {
      throw new Error("iCal形式のデータではありませんでした。URLが正しいか確認してください");
    }
    const to = addDaysStr(today, Math.max(0, Math.round(horizonDays)));
    const statuses = icalEventsToStatuses(parseIcalEvents(text), today, to);

    if (statuses.size === 0) {
      const existing = await db.execute({
        sql: `SELECT COUNT(*) AS c FROM lumina_bookings
              WHERE source = 'ical' AND target_date BETWEEN ? AND ?`,
        args: [today, to],
      });
      if (Number(existing.rows[0]?.c ?? 0) > 0) {
        throw new Error("iCalが空でした。URLが変更されていないか確認してください");
      }
    }

    const manualRes = await db.execute({
      sql: `SELECT target_date FROM lumina_bookings
            WHERE source = 'manual' AND target_date BETWEEN ? AND ?`,
      args: [today, to],
    });
    const manualDates = new Set(manualRes.rows.map((r) => String(r.target_date)));

    const stmts: InStatement[] = [
      {
        sql: "DELETE FROM lumina_bookings WHERE source = 'ical' AND target_date BETWEEN ? AND ?",
        args: [today, to],
      },
    ];
    let booked = 0;
    let blocked = 0;
    for (const [date, status] of [...statuses.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (manualDates.has(date)) continue;
      stmts.push({
        // 手動指定 (manual) の行がある日は上書きしない
        sql: `INSERT INTO lumina_bookings (target_date, status, source, updated_at)
              VALUES (?, ?, 'ical', CURRENT_TIMESTAMP)
              ON CONFLICT(target_date) DO NOTHING`,
        args: [date, status],
      });
      if (status === "booked") booked += 1;
      else blocked += 1;
    }
    const imported = booked + blocked;
    stmts.push(importStatusStmt({ at, ok: true, imported, error: null }));
    await db.batch(stmts, "write");
    return { imported, booked, blocked };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      // 画面に出す記録には DB 等の内部エラー文を残さない (詳細はサーバーログ)
      if (!isUserFacingMessage(message)) console.error("iCal import failed:", err);
      await recordImportStatus(db, {
        at,
        ok: false,
        imported: 0,
        error: isUserFacingMessage(message) ? message : "内部エラー（詳細はサーバーログ）",
      });
    } catch {
      // 記録の失敗は元のエラーを優先する
    }
    throw err instanceof Error ? err : new Error(message);
  }
}
