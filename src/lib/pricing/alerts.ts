/**
 * アラート判定 (仕様 6章「アラート通知」+ 価格アクション)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * ルール (days は lead 0..horizon。A = cfg.alpha[night.type]):
 * - weekend_low_inventory (仕様6章「週末で競合残室が3室以下」):
 *     night.type=weekend かつ market.dataQuality == "ok" かつ market.remaining < market.units
 *     かつ market.remainingEst != null かつ remainingEst <= cfg.alerts.weekendRemainingMax
 *     かつ (market.occ ?? 0) >= A.midOcc
 *     severity: 自社が vacant なら "high"、それ以外 "info"
 *     message 例: "11/21(土) 週末の競合 7件中 5件が予約済・残り2室（推定）。強気設定の好機"
 * - weekday_spike (仕様6章「直近7日で平日稼働率が跳ねた日」):
 *     night.type=weekday かつ market.pace != null かつ pace >= cfg.alerts.weekdaySpikePt
 *     かつ (market.newBookings ?? 0) >= cfg.spike.minNewBookings → severity "high"。
 *     message に 超過 +Xpt/7日 と新規予約件数
 * - spike: market.spike かつ同日に weekday_spike を出していない → severity "medium"
 * - raise_opportunity: 自社 vacant かつ own.statusSource != "none" かつ pricing.action == "raise"
 *     かつ market.occ != null かつ occ >= A.midOcc → "medium"。message: "現在¥110,000 → 推奨¥127,000（+15%）"
 * - discount_needed: 自社 vacant かつ own.statusSource != "none" かつ pricing.action == "lower" かつ lead <= 14 → "medium"
 * - own_status_unlinked: 将来日すべての own.statusSource が "none" のとき1件だけ (date = days[0].date, "info"):
 *     "自社の予約状況が未連携のため、値上げ/値下げアラートは停止中です（iCal連携または手動入力で有効になります）"
 * (action raise/lower は現在価格が実値の日しか出ないので、仮定価格では raise/discount アラートは出ない)
 * 並び順: severity (high → medium → info)、同 severity 内は日付昇順。
 * 日付表示は formatJpDate。金額は "¥" + 3桁区切り。
 */
import type { DayRecommendation, PricingAlert, PricingConfig } from "./types";

export function deriveAlerts(days: DayRecommendation[], cfg: PricingConfig): PricingAlert[] {
  void days;
  void cfg;
  throw new Error("not implemented");
}

/** "YYYY-MM-DD" → "M/D(曜)" */
export function formatJpDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const w = "日月火水木金土"[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${w})`;
}
