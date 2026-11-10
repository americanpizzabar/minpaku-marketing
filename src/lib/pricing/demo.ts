/**
 * デモモード (Turso 未設定) 用の決定的な PricingInputs。
 * 本番データが無い環境でも /pricing 画面と全指標 (Pace・予約曲線・シミュレーション) が動くことを確認できるようにする。
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 生成内容 (乱数は seed 固定の mulberry32。today に依存してよいが同じ today なら常に同じ結果):
 * - lumina: lat 35.42038, lng 138.90478 (山中湖), basePrice 110000, priceSource "demo", maxGuests 8
 * - candidates 約30件: うち 12件は厳格条件を満たす一棟貸しヴィラ (半径6km以内, 定員6〜10, 評価4.7+, レビュー5+,
 *   adrRef 80,000〜140,000)、残りは条件外 (遠い・ホテル・個室・低評価・安価) を混ぜる。roomType は実データ同様
 *   "entire_home"/"private_room"/"hotel_room"。reservedShare 0.6〜0.95。ratesSyncedAt は CompSet の
 *   大半を today−1、2件を today−20 (stale)、1件を null にする
 * - calendar: candidates のうち ratesSyncedAt があるものについて date ∈ [today−14, today+horizon+7]。
 *   予約確率は「週末 > 平日」「リードタイムが近いほど高い」「年末年始・連休は高い」を反映し、
 *   price は adrRef × (週末1.25) × ノイズ。予約不可日の price は 0。fetchedAt = ratesSyncedAt
 * - snapshots: CompSet 物件について snapshotDate = today−7 と today−1 の2時点 (+ today−21)。
 *   today−1 の内容は calendar と一致させ、today−7 は「そこから数件ずつ予約が埋まる前の状態」にする
 *   (一部の週末日付で急増 = spike が出るように)
 * - own: date ∈ [today−14, today+horizon]、約25%を booked (週末寄り)、2日を blocked、
 *   currentPrice = 110000 (週末は 130000)、statusSource "manual"
 * - config = 引数 config、icalConfigured false、dataSource "demo"
 */
import type { PricingConfig, PricingInputs } from "./types";

export function buildDemoPricingInputs(today: string, config: PricingConfig): PricingInputs {
  void today;
  void config;
  throw new Error("not implemented");
}
