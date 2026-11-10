/**
 * バッチ処理・データパイプライン (仕様 6章)。
 *   データ取得 (CompSet カレンダー) → 差分検知 (スナップショットで Pace) → リコメンド生成 (保存) → アラート通知
 *
 * 【担当: data-ops】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { Client } from "@libsql/client";
import type { PricingAlert, PricingDashboard } from "./types";

/**
 * CompSet カレンダーを取得する (有料: $0.10/件)。定期実行と「今すぐ取得」ボタンの両方から使う。
 * - 対象 = selectCompsetRefreshTargets(db, { ids: opts.ids, staleDays: opts.staleDays, limit })
 *   limit = min(opts.maxCalls, 設定画面の dailyRatesCalls (getSyncConfig), 50)
 * - 1日あたりの上限: sync_state "pricing:refresh_calls:{今日JST}" の累計 + 対象数 が dailyRatesCalls を超える分は取得しない
 * - 各 id について airroi.ts の refreshRatesForProperty を呼ぶ (内部でスナップショットも保存される)。
 *   5件ずつ並列、合計 200 秒を超えたら打ち切り
 * - 実行後、累計カウンタを更新し、sync_logs に (sync_type 'pricing_compset', records_fetched, api_calls_count, status) を記録
 * - 戻り値: refreshed = 実際に API を呼んだ件数、costUsd = round2(refreshed × 0.10)、
 *   skipped = 日次上限などで取得しなかった件数
 */
export async function refreshCompsetCalendars(
  db: Client,
  opts: { maxCalls: number; staleDays?: number; ids?: string[] },
): Promise<{ refreshed: number; costUsd: number; skipped: number }> {
  void db;
  void opts;
  throw new Error("not implemented");
}

/**
 * 今日の推奨価格を保存し、アラートを記録・通知する。API 費用は発生しない (CompSet 取得は呼び出し側で)。
 * 1. (config.icalUrl があれば) importIcalToDb を試行 (失敗しても続行。結果は ical.ts が記録)
 * 2. dashboard = computePricingDashboard(await loadPricingInputs())。dataSource "demo" なら保存せず返す
 * 3. pricing_recommendations に generated_date = today で days を UPSERT (列は docs/pricing-module.md のスキーマ)
 * 4. pricing_alerts: 今回の alerts を INSERT … ON CONFLICT(generated_date, target_date, kind)
 *    DO UPDATE SET severity, message (未通知の行のみ更新)。その後、generated_date = today かつ notified_at IS NULL で
 *    今回の alerts に無い (target_date, kind) の行を DELETE (条件が解消したアラートを送らない)
 * 5. notify=true のとき: 対象 = generated_date = today かつ notified_at IS NULL かつ target_date >= today かつ
 *    kind IN ('weekend_low_inventory','weekday_spike') (仕様6章の2種類のみ)。ただし同じ (target_date, kind) が
 *    過去の generated_date で通知済み (notified_at が 'skipped' 以外) で severity が上がっていないものは除外
 *    (同じ状況で毎日通知しない)。sendAlertWebhook が true なら対象に notified_at = CURRENT_TIMESTAMP。
 *    今日より前の generated_date で notified_at IS NULL の行は notified_at = 'skipped' にする (溜まった古い通知を送らない)
 * 6. 120日より古い calendar_snapshots (snapshot_date < today−120) / pricing_recommendations / pricing_alerts を削除
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
 * { text, content } (同じ本文) を POST する (タイムアウト 10 秒)。未設定・失敗なら false。
 * 本文: "【Lumina Fuji 価格アラート】" + 各アラートを "・{message}" で改行連結 (最大 20 件)
 */
export async function sendAlertWebhook(alerts: PricingAlert[]): Promise<boolean> {
  void alerts;
  throw new Error("not implemented");
}
