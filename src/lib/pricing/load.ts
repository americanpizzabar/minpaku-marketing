/**
 * PricingInputs の組み立て (Turso DB / デモ) と、同期処理から使う CompSet 更新対象の選定。
 * airroi.ts から import されるため、このファイルは airroi.ts を import してはならない (循環防止)。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";
import type { CandidateProperty, PricingConfig, PricingInputs } from "./types";

/**
 * DB が設定されていれば DB から、無ければ buildDemoPricingInputs で組み立てる。
 * DB の場合:
 * - today = JST の今日 (dates.ts の todayJst)
 * - config = getPricingConfig(db)
 * - lumina: sync_state の config:lumina_lat/lng/base_price/listing_id/max_guests、lumina_source
 *   (priceSource = lumina_source が "api" なら "api"、それ以外 "manual")
 * - candidates = loadCandidates(db, lumina.lat, lumina.lng, config.compset.maxRadiusKm + 1)
 * - calendar = daily_metrics (property_id ∈ candidates, target_date ∈ [today−14, today+horizon+7]),
 *   fetchedAt = date(fetched_at, '+9 hours')
 * - snapshots = calendar_snapshots (property_id ∈ candidates, snapshot_date >= today−90,
 *   target_date ∈ [today−14−10, today+horizon+7])
 * - own: date ∈ [today−14, today+horizon] ごとに
 *     currentPrice = lumina_fuji_metrics.configured_price (無い日は lumina.basePrice)
 *     status/statusSource の優先順: lumina_bookings(source=manual) > lumina_bookings(source=ical)
 *       > (lumina_source が "api" かつ lumina_fuji_metrics.is_booked=1 → booked/api) > vacant/none
 * - icalConfigured = config.icalUrl != null
 * 大量の IN 句は 500 件ずつに分割してよい。
 */
export async function loadPricingInputs(): Promise<PricingInputs> {
  throw new Error("not implemented");
}

/**
 * 候補物件を読み込む。lat/lng が非 null なら緯度経度のバウンディングボックス (radiusKm 相当) で事前に絞る
 * (緯度1度≈111km、経度1度≈111km×cos(lat))。null なら全件。
 * roomType/listingType/reservedShare は details_json から json_extract で取得:
 *   $.listing_info.room_type, $.listing_info.listing_type,
 *   $.performance_metrics.ttm_days_reserved, $.performance_metrics.ttm_blocked_days
 *   reservedShare = reserved / (reserved + blocked) (合計 > 0 のとき)、それ以外 null
 * adrRef = l90d_avg_rate ?? ttm_avg_rate、ratesSyncedAt = date(rates_synced_at, '+9 hours')
 */
export async function loadCandidates(
  db: Client,
  lat: number | null,
  lng: number | null,
  radiusKm: number,
): Promise<CandidateProperty[]> {
  void db;
  void lat;
  void lng;
  void radiusKm;
  throw new Error("not implemented");
}

/**
 * 同期 (syncStep) と「CompSet カレンダー更新」ボタンが使う、カレンダー取得対象の CompSet 物件 id。
 * - selectCompSet で CompSet を求め、members のうち ratesSyncedAt が null または
 *   today − ratesSyncedAt >= staleDays の物件 (staleDays 省略時は config.compsetRefreshDays)
 * - 取得日が古い順 (null を最優先) に並べ、limit 件 (省略時 config.compsetRefreshMax) まで返す
 * DB 未設定や自社基準価格が未設定でも例外を投げず空配列を返す。
 */
export async function selectCompsetRefreshTargets(
  db: Client,
  opts?: { staleDays?: number; limit?: number },
): Promise<{ ids: string[]; config: PricingConfig }> {
  void db;
  void opts;
  throw new Error("not implemented");
}
