/**
 * 推奨価格追従時の想定売上シミュレーション (仕様 4.1 サマリーKPI)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * モデル (空室の日 d, リードタイム L ごと):
 *   occNow = market.occ / 100 (縮小推定後。null の日はスキップ)
 *   予約曲線 f = curves[night.type].fitted (無ければもう一方の区分の曲線。両方空なら available=false)
 *   f(L) = fitted の中で lead が L に最も近い点の occ/100、f0 = 最小 lead の点の occ/100
 *   最終占有率 E = f(L) > 0.01 ? min(0.97, max(occNow, occNow × f0 / f(L))) : occNow   (乗法ピックアップ)
 *   空室1室あたりの成約確率 q = occNow < 1 ? clamp((E − occNow)/(1 − occNow), 0, 0.95) : 0
 *   参照価格 ref = market.compAdr ?? pricing.basePrice × (1 + δ)
 *   残余需要の弾力性 ε_d = ε × (1 − tightnessDamping × occNow)   (競合が埋まるほど代替が減り価格感応度が下がる)
 *   成約確率 p(P) = clamp(q × (P / ref)^ε_d, 0, 0.95)
 *   売上 = Σ P × p(P)、泊数 = Σ p(P)   (現在価格 と 推奨価格 でそれぞれ計算)
 * - own.status "booked" の日は lockedRevenue += currentPrice ?? 0、bookedDays++ (両シナリオ共通で比較対象外)
 * - "blocked" の日、currentPrice == null の日はスキップ
 * - ε は cfg.elasticity の low/central/high の3シナリオ。label: "価格感応度: 低" / "価格感応度: 中（標準）" / "価格感応度: 高"
 * - upliftPct = currentRevenue > 0 ? (recommendedRevenue − currentRevenue)/currentRevenue × 100 (小数1桁) : null
 * - 金額は整数円、泊数は小数1桁に丸める
 * - assumptions: 上記モデルの前提を日本語で列挙 (予約曲線による最終占有率推定、弾力性の値、残余需要の補正、
 *   予約済日は比較対象外、現在価格が基準価格の代替値である場合はその旨 — priceSourceManual=true のとき)
 * - 計算可能な空室日が 0 日なら available=false, reason に理由
 */
import type { BookingCurve, DayRecommendation, PricingConfig, Simulation } from "./types";

export function simulateRevenue(
  days: DayRecommendation[],
  curves: { weekday: BookingCurve; weekend: BookingCurve },
  cfg: PricingConfig,
  priceSourceManual: boolean,
): Simulation {
  void days;
  void curves;
  void cfg;
  void priceSourceManual;
  throw new Error("not implemented");
}
