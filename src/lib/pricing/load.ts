/**
 * PricingInputs の組み立て (Turso DB / デモ) と、CompSet カレンダー取得対象の選定。
 * pipeline.ts / API から import される。このファイルは airroi.ts を import してはならない (循環防止)。
 * 自物件の設定は src/lib/sync-config.ts の getSyncConfig を使う (data-ops が airroi.ts から SyncConfig・
 * getSyncConfig・saveSyncConfig・関連定数をこの葉モジュールへ移し、airroi.ts は再エクスポートする)。
 * 生の sync_state キーを直接読まないこと (空文字→0、環境変数フォールバック等の正規化が失われるため)。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";
import type { CandidateProperty, PricingConfig, PricingInputs } from "./types";

/**
 * DB が設定されていれば DB から、無ければ buildDemoPricingInputs(todayJst, getPricingConfig 相当の既定値) で組み立てる。
 * DB の場合 (ensureSchema をプロセス内で1回だけ実行してから):
 * - today = JST の今日 (dates.ts の todayJst → toDateStr)
 * - config = getPricingConfig(db)、sync = getSyncConfig(db)
 * - lumina = { lat: sync.luminaLat, lng: sync.luminaLng, basePrice: sync.luminaBasePrice,
 *     listingId: sync.luminaListingId || null, maxGuests: sync.luminaMaxGuests,
 *     priceSource: sync_state の lumina_source が "api" なら "api"、それ以外 "manual" }
 * - candidates = loadCandidates(db, lumina.lat, lumina.lng, config.compset.maxRadiusKm + 1, lumina.listingId)
 * - calendar = daily_metrics (property_id ∈ candidates, target_date ∈ [today−14, today+horizon+7]),
 *   fetchedAt = date(fetched_at, '+9 hours')
 * - snapshots = selectCompSet(candidates, lumina, basePrice, config, today).members の id のみについて
 *   calendar_snapshots (snapshot_date >= today−120, target_date ∈ [today−24, today+horizon+7])
 *   (basePrice = config.basePriceWeekday ?? lumina.basePrice)
 * - own: date ∈ [today−14, today+horizon] ごとに
 *     apiPrice = lumina.priceSource == "api" かつ lumina_fuji_metrics.configured_price > 0 ならその値、それ以外 null
 *     status/statusSource の優先順: lumina_bookings(source=manual, status は booked/blocked/vacant) >
 *       lumina_bookings(source=ical) > (priceSource "api" かつ is_booked=1 → booked/api) > vacant/none
 * - icalConfigured = config.icalUrl != null
 * - icalLastImport = sync_state "pricing:ical_last_import" の JSON (IcalImportStatus)。無ければ null
 * - alertChannel = process.env.ALERT_WEBHOOK_URL が空でなければ "webhook"、それ以外 "none"
 * - lastNotifiedAt = SELECT MAX(notified_at) FROM pricing_alerts WHERE notified_at IS NOT NULL AND notified_at <> 'skipped'
 * 大量の IN 句は 400 件ずつに分割してよい。
 */
export async function loadPricingInputs(): Promise<PricingInputs> {
  throw new Error("not implemented");
}

/**
 * 候補物件を読み込む (自社 id = "airroi_" + ownListingId は除外)。lat/lng が非 null なら緯度経度の
 * バウンディングボックス (radiusKm 相当: 緯度1度≈111km、経度1度≈111km×cos(lat)) で事前に絞る。null なら全件。
 * roomType/listingType/reservedShare は details_json から json_extract で取得:
 *   $.listing_info.room_type, $.listing_info.listing_type,
 *   $.performance_metrics.ttm_days_reserved, $.performance_metrics.ttm_blocked_days
 *   reservedShare = reserved / (reserved + blocked) (合計 > 0 のとき)、それ以外 null
 * adrRef = l90d_avg_rate ?? ttm_avg_rate
 * ratesSyncedAt = その物件の MAX(daily_metrics.fetched_at) の JST 日付 (取得成功の最終日。無ければ null)
 * lastAttemptAt = date(properties.rates_synced_at, '+9 hours') (取得の最終試行日。失敗でも進む)
 */
export async function loadCandidates(
  db: Client,
  lat: number | null,
  lng: number | null,
  radiusKm: number,
  ownListingId: string | null,
): Promise<CandidateProperty[]> {
  void db;
  void lat;
  void lng;
  void radiusKm;
  void ownListingId;
  throw new Error("not implemented");
}

/**
 * CompSet カレンダーの取得対象 id (定期実行・「今すぐ取得」ボタン共通。表示する費用と実際の費用を一致させるため
 * compute.ts の status.refreshPlan と同じ選び方をする)。
 * - limit = opts.limit ?? config.compsetRefreshMax。limit <= 0 なら空配列
 * - selectCompSet の members のうち calendarStatus が "failed" でなく、
 *   ratesSyncedAt == null または today − ratesSyncedAt >= staleDays (staleDays 省略時は config.freshnessDays + 1)、
 *   かつ lastAttemptAt が今日でない (同日の再取得はしない) もの
 * - opts.ids が与えられたらそれとの積集合 (画面に表示した対象以外は取得しない)
 * - ratesSyncedAt の古い順 (null が先) に limit 件
 * DB 未設定・自社基準価格未設定・例外時も空配列を返す (例外を投げない)。
 */
export async function selectCompsetRefreshTargets(
  db: Client,
  opts?: { staleDays?: number; limit?: number; ids?: string[] },
): Promise<{ ids: string[]; config: PricingConfig }> {
  void db;
  void opts;
  throw new Error("not implemented");
}
