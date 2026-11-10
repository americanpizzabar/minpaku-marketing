/**
 * 推奨価格追従時の想定売上シミュレーション (仕様 4.1 サマリーKPI)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 目的: 推奨に従った場合と、従わずに据え置いた場合の空室日の想定売上を、需要の価格感応度 (弾力性 ε)
 * の仮定ごとに比較する。結果の符号は ε の仮定に強く依存するため、損益分岐の ε (breakEvenElasticity) も必ず出す。
 *
 * モデル (自社が vacant の将来日 d, リードタイム L ごと):
 *   F = curves[night.type].fitted を lead → occ/100 の関数に (無ければもう一方の区分の曲線。両方空なら available=false)
 *     F(L) = lead が L に最も近い点の値、F0 = 最小 lead の点の値
 *   残り在庫の成約確率 (条件付きピックアップ): q = F(L) < 1 ? clamp((F0 − F(L)) / (1 − F(L)), 0, 0.95) : 0
 *   品質調整した参照価格: typeBase = basePrice × (1 + δ) (pricing.delta.value)
 *     ref = market.compAdr != null かつ 区分の compAdr 中央値 M_type が非 null
 *           ? typeBase × market.compAdr / M_type   (市場の日別の高低だけを反映し、自社の品質プレミアムは割高とみなさない)
 *           : typeBase
 *     M_type = horizon 内の同区分の日の compAdr の中央値
 *   弾力性 ε_d = ε × (1 − tightnessDamping × occNow)  (occNow = (market.occ ?? 0)/100。既定 tightnessDamping=0 = 一定)
 *   成約確率 p(P) = clamp(q × (P / ref)^ε_d, 0, 0.95)
 *   売上 = Σ P × p(P)、泊数 = Σ p(P)   (据え置き価格 と 推奨価格 でそれぞれ計算)
 * 据え置き価格 (baseline):
 *   - 将来の空室日の半数以上で own.currentPriceSource が "assumed" でないなら baseline "current":
 *     各日の currentPrice (assumed の日は除外して計算) / baselineLabel "現在価格"
 *   - それ以外 baseline "assumed_seasonal": 各日 typeBase を roundTo で丸めた固定シーズン料金 /
 *     baselineLabel "固定シーズン料金（基準価格×週末係数・仮定）" (仕様1章「固定シーズン料金に依存せず」の比較対象)
 * - own.status "booked" の日: lockedRevenue += currentPrice ?? typeBase (丸め)、bookedDays++ (比較対象外)
 * - "blocked" の日はスキップ
 * - 3シナリオ ε = cfg.elasticity.low/central/high。label: "価格感応度: 低" / "価格感応度: 中（標準）" / "価格感応度: 高"
 * - upliftPct = currentRevenue > 0 ? (recommendedRevenue − currentRevenue)/currentRevenue × 100 (小数1桁) : null
 * - breakEvenElasticity: tightnessDamping=0 として recommendedRevenue(ε) − currentRevenue(ε) の符号が
 *   ε ∈ [−5, −0.1] の両端で異なれば二分探索 (40回) で求めた ε (小数2桁)、異ならなければ null
 * - 金額は整数円、泊数は小数1桁に丸める
 * - assumptions (日本語, 必ず含める): 予約曲線による残り在庫の成約確率、参照価格は自社の品質プレミアムを保った市場連動価格、
 *   弾力性は実測ではなく仮定 (3シナリオの値)、損益分岐の弾力性の意味、予約済日は比較対象外、
 *   baseline が assumed_seasonal ならその旨と「設定で現在価格を入力すると実価格で比較」
 * - 計算可能な空室日が 0 日なら available=false, reason に理由 (例: "予約曲線が未算出（競合カレンダー取得後に表示）")
 */
import type { BookingCurve, DayRecommendation, PricingConfig, Simulation } from "./types";

export function simulateRevenue(
  days: DayRecommendation[],
  curves: { weekday: BookingCurve; weekend: BookingCurve },
  cfg: PricingConfig,
): Simulation {
  void days;
  void curves;
  void cfg;
  throw new Error("not implemented");
}
