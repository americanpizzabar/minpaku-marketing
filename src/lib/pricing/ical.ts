/**
 * 自社カレンダーの iCal (Airbnb の「カレンダーをエクスポート」URL) 取り込み。
 * 仕様 4.1 のタイムライン行1「自社ステータス（予約済 / 空室）」を AirROI 未収録でも埋めるため。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";

export interface IcalEvent {
  start: string; // "YYYY-MM-DD" (JST の日付)
  end: string; // "YYYY-MM-DD" (この日は含まない = チェックアウト日)
  summary: string;
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
  void db;
  void url;
  void today;
  void horizonDays;
  throw new Error("not implemented");
}
