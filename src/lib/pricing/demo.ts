/**
 * デモモード (Turso 未設定) 用の決定的な PricingInputs。
 * 本番データが無い環境でも /pricing 画面と全指標 (Pace・予約曲線・シミュレーション) が動くことを確認できるようにする。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 生成内容 (乱数は seed 固定の mulberry32。同じ today なら常に同じ結果):
 * - lumina: lat 35.42038, lng 138.90478 (山中湖), basePrice 110000, listingId "demo_lumina",
 *   priceSource "demo", maxGuests 8
 * - candidates 約30件: うち 12件は厳格条件を満たす一棟貸しヴィラ (半径7km以内, 定員6〜10, 評価4.7+, レビュー5+,
 *   adrRef 80,000〜140,000)、残りは条件外 (遠い・ホテル・個室・低評価・安価) を混ぜる。roomType は実データ同様
 *   "entire_home"/"private_room"/"hotel_room"。reservedShare 0.6〜0.95。
 *   CompSet 12件の ratesSyncedAt/lastAttemptAt: 9件 today−1、1件 today−20 (stale)、1件 null/null (none)、
 *   1件 ratesSyncedAt null かつ lastAttemptAt today−2 (failed)
 * - calendar: ratesSyncedAt があるものについて date ∈ [today−14, today+horizon+7]、fetchedAt = ratesSyncedAt
 *   (stale 物件は today−20 時点の状態)。予約確率は「週末 > 平日」「リードタイムが近いほど高い」
 *   「特定連休 (年末年始等) は高い」を反映。price は adrRef × (週末1.2, 連休1.6) × ノイズ。予約不可日の price は 0
 * - snapshots: ratesSyncedAt を持つ物件のみ、snapshotDate ≤ その物件の ratesSyncedAt の日付だけ:
 *   fresh 物件は today−8 と today−1 の2時点 (today−1 の内容は calendar と一致。today−8 は数件ずつ予約が
 *   埋まる前の状態にし、いくつかの週末で 3件以上の新規予約 = spike が出るように)、stale 物件は today−20 のみ
 * - own: date ∈ [today−14, today+horizon]、約25%を booked (週末寄り)、2日を blocked、残り vacant、
 *   statusSource "manual"、apiPrice は null (現在価格は config.ownPriceWeekday/Weekend で与える)
 * - config = 引数 config に ownPriceWeekday 110000 / ownPriceWeekend 125000 を (null なら) 入れたもの
 * - icalConfigured false、icalLastImport null、alertChannel "none"、lastNotifiedAt null、dataSource "demo"
 */
import type { PricingConfig, PricingInputs } from "./types";

export function buildDemoPricingInputs(today: string, config: PricingConfig): PricingInputs {
  void today;
  void config;
  throw new Error("not implemented");
}
