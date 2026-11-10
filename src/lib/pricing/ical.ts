/**
 * 自社カレンダーの iCal (Airbnb の「カレンダーをエクスポート」URL) 取り込み。
 * 仕様 4.1 のタイムライン行1「自社ステータス（予約済 / 空室）」を AirROI 未収録でも埋めるため。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";

export interface IcalEvent {
  start: string; // "YYYY-MM-DD" (DTSTART の日付部分)
  end: string; // "YYYY-MM-DD" (DTEND の日付部分。この日は含まない = チェックアウト日)
  summary: string;
}

/**
 * iCal テキストから VEVENT を取り出す。
 * - 行の折り返し (CRLF/LF の直後が空白/タブの行は前行に連結) を解除してから解析
 * - DTSTART;VALUE=DATE:20261110 / DTSTART:20261110T150000Z / DTSTART;TZID=Asia/Tokyo:20261110T150000 の
 *   いずれも日付部分 (YYYYMMDD) を採用
 * - DTEND が無ければ start の翌日
 * - SUMMARY が無ければ ""
 */
export function parseIcalEvents(text: string): IcalEvent[] {
  void text;
  throw new Error("not implemented");
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
  void events;
  void from;
  void to;
  throw new Error("not implemented");
}

/**
 * url を fetch (タイムアウト 15 秒, https のみ) して取り込み、lumina_bookings に保存する。
 * - 範囲 [today, today + horizonDays] の source='ical' の既存行を削除してから、状態のある日を INSERT
 *   (source='manual' の行は上書きしない: INSERT OR IGNORE 相当で manual を優先)
 * - 戻り値 imported = 書き込んだ日数, booked/blocked = 内訳
 * - 失敗時は Error を投げる (メッセージは日本語)
 */
export async function importIcalToDb(
  db: Client,
  url: string,
  today: string,
  horizonDays: number,
): Promise<{ imported: number; booked: number; blocked: number }> {
  void db;
  void url;
  void today;
  void horizonDays;
  throw new Error("not implemented");
}
