import type { Client, InStatement } from "@libsql/client";

/**
 * 自社カレンダー (lumina_fuji_metrics) の AirROI 取得状況。葉モジュール (@libsql/client の型以外を import しない)。
 * - lumina_rates_ok_at: 最後に AirROI から自社カレンダーを取得できた日時 (UTC 'YYYY-MM-DD HH:MM:SS')
 * - lumina_rates_listing_id: その取得のリスティングID。設定のIDと異なる場合、AirROI 由来の行は別の物件のデータ
 */
export const LUMINA_RATES_OK_KEY = "lumina_rates_ok_at";
export const LUMINA_RATES_LISTING_KEY = "lumina_rates_listing_id";

/** 記録されている取得元リスティングIDが今の設定と異なるか (記録が無ければ判断できないので false) */
export function isForeignListing(stored: string | null | undefined, current: string | null | undefined): boolean {
  const s = (stored ?? "").trim();
  return s !== "" && s !== (current ?? "").trim();
}

/**
 * 別のリスティングに切り替えたとき、前のリスティングの AirROI 由来の値を実データから外す文。
 * AirROI で観測した価格は 0・出所なしに、AirROI 由来の予約状況は出所なしにする (基準価格の行はそのまま)。
 * 最終成功日時と取得元リスティングIDも消す (取得失敗時は基準価格・手入力の稼働率に戻る)。
 */
export function resetOwnCalendarStatements(): InStatement[] {
  return [
    {
      sql: `UPDATE lumina_fuji_metrics SET
              configured_price = CASE WHEN price_source = 'airroi' THEN 0 ELSE configured_price END,
              price_source = CASE WHEN price_source = 'airroi' THEN NULL ELSE price_source END,
              price_observed_at = NULL,
              is_booked = CASE WHEN status_source = 'airroi' THEN 0 ELSE is_booked END,
              status_source = NULL,
              fetched_at = NULL
            WHERE price_source = 'airroi' OR status_source = 'airroi'`,
      args: [],
    },
    {
      sql: "DELETE FROM sync_state WHERE key IN (?, ?)",
      args: [LUMINA_RATES_OK_KEY, LUMINA_RATES_LISTING_KEY],
    },
  ];
}

export async function resetOwnCalendarProvenance(db: Client): Promise<void> {
  await db.batch(resetOwnCalendarStatements(), "write");
}

export interface OwnCalendarState {
  /** 表示に使う AirROI 由来の行の最新の取得日時 → 無ければ最終成功日時。別リスティングのデータなら null */
  fetchedAt: string | null;
  /** AirROI 由来の行が今の設定とは別のリスティングのもの (実データとして使わない) */
  foreignListing: boolean;
}

/**
 * 自社カレンダーの AirROI 取得日時を、実際に保存されている行から求める
 * (取得失敗や lumina_rates_at の削除で、表示中の実データの日付が消えないようにする)。
 */
export async function getOwnCalendarState(db: Client, currentListingId: string | null): Promise<OwnCalendarState> {
  const [maxRes, stateRes] = await Promise.all([
    db.execute("SELECT MAX(fetched_at) AS m FROM lumina_fuji_metrics WHERE status_source = 'airroi'"),
    db.execute({
      sql: "SELECT key, value FROM sync_state WHERE key IN (?, ?)",
      args: [LUMINA_RATES_OK_KEY, LUMINA_RATES_LISTING_KEY],
    }),
  ]);
  const state = new Map(
    stateRes.rows.map((r) => [String(r.key), r.value === null || r.value === undefined ? null : String(r.value)]),
  );
  if (isForeignListing(state.get(LUMINA_RATES_LISTING_KEY), currentListingId)) {
    return { fetchedAt: null, foreignListing: true };
  }
  const m = maxRes.rows[0]?.m;
  const fromRows = m === null || m === undefined || m === "" ? null : String(m);
  return { fetchedAt: fromRows ?? (state.get(LUMINA_RATES_OK_KEY) || null), foreignListing: false };
}
