/**
 * バッチ処理・データパイプライン (仕様 6章)。
 *   データ取得 (CompSet カレンダー) → 差分検知 (スナップショットで Pace) → リコメンド生成 (保存) → アラート通知
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";
import type { PricingAlert, PricingDashboard } from "./types";

/**
 * CompSet のうちカレンダーが古い物件を今すぐ取得する (有料: $0.10/件)。
 * selectCompsetRefreshTargets(db, { staleDays, limit: maxCalls }) の各 id について
 * airroi.ts の refreshRatesForProperty を呼ぶ (内部でスナップショットも保存される)。
 * staleDays 省略時は 1 (= 当日取得済みの物件は再取得しない)。
 */
export async function refreshCompsetCalendars(
  db: Client,
  opts: { maxCalls: number; staleDays?: number },
): Promise<{ refreshed: number; costUsd: number }> {
  void db;
  void opts;
  throw new Error("not implemented");
}

/**
 * 今日の推奨価格を保存し、アラートを記録・通知する。
 * 1. (config.icalUrl があれば) importIcalToDb を試行 (失敗しても続行)
 * 2. dashboard = computePricingDashboard(await loadPricingInputs())
 * 3. pricing_recommendations に generated_date = today で days を UPSERT
 * 4. pricing_alerts に alerts を INSERT OR IGNORE (UNIQUE(generated_date, target_date, kind))
 * 5. notify=true かつ未通知 (notified_at IS NULL) のアラートがあれば sendAlertWebhook し、notified_at を更新
 * 6. 120日より古い calendar_snapshots / pricing_recommendations / pricing_alerts を削除
 * 戻り値: saved = 保存した推奨行数, alerts = 今回のアラート件数, notified = 通知した件数
 */
export async function runPricingPipeline(
  db: Client,
  opts: { notify: boolean },
): Promise<{ saved: number; alerts: number; notified: number; dashboard: PricingDashboard }> {
  void db;
  void opts;
  throw new Error("not implemented");
}

/**
 * 環境変数 ALERT_WEBHOOK_URL が設定されていれば、Slack/Discord 互換の JSON
 * { text, content } (同じ本文) を POST する。未設定なら何もせず false。
 * 本文: "【Lumina Fuji 価格アラート】" + 各アラートを "・{message}" で改行連結 (最大 20 件)
 */
export async function sendAlertWebhook(alerts: PricingAlert[]): Promise<boolean> {
  void alerts;
  throw new Error("not implemented");
}
