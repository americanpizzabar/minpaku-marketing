/**
 * アラート判定 (仕様 6章「アラート通知」+ 価格アクション)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * ルール (days は lead 0..horizon):
 * - weekend_low_inventory: night.type=weekend かつ market.units >= 1 かつ
 *     market.remaining <= cfg.alerts.weekendRemainingMax
 *     severity: 自社が vacant なら "high"、それ以外 "info"
 *     message 例: "11/21(土) 週末の競合残室が残り2室（全7室中）。強気設定の好機"
 * - weekday_spike: night.type=weekday かつ market.pace != null かつ pace >= cfg.alerts.weekdaySpikePt
 *     severity "high"。message に +Xpt/7日 と新規予約件数
 * - spike: market.spike かつ同日に weekday_spike を出していない → severity "medium"
 * - raise_opportunity: 自社 vacant かつ pricing.action == "raise" かつ market.occ != null かつ occ >= cfg.alpha.midOcc
 *     → "medium"。message に 現在価格・推奨価格・乖離率
 * - discount_needed: 自社 vacant かつ pricing.action == "lower" かつ lead <= 14 → "medium"
 * 並び順: severity (high → medium → info)、同 severity 内は日付昇順。
 * 日付表示は "M/D(曜)" (曜は 日月火水木金土)。
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
