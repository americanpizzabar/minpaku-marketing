/**
 * バッチ処理・データパイプライン (仕様 6章)。
 *   データ取得 (CompSet カレンダー) → 差分検知 (スナップショットで Pace) → リコメンド生成 (保存) → アラート通知
 */
import type { Client, InStatement, InValue } from "@libsql/client";
import { isAirRoiConfigured, refreshRatesForProperty } from "../airroi";
import { toDateStr, todayJst } from "../dates";
import { COST_PER_RATES_CALL, getSyncConfig } from "../sync-config";
import { computePricingDashboard } from "./compute";
import { getPricingConfig } from "./config-store";
import { addDaysStr } from "./holidays";
import { importIcalToDb } from "./ical";
import { loadPricingInputs, selectCompsetRefreshTargets } from "./load";
import type { DayRecommendation, PricingAlert, PricingDashboard } from "./types";

const MAX_CALLS_PER_RUN = 50;
const REFRESH_CONCURRENCY = 5;
const REFRESH_BUDGET_MS = 200_000;
const RETENTION_DAYS = 120;
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_MAX_ALERTS = 20;
const NOTIFY_KINDS = ["weekend_low_inventory", "weekday_spike"] as const;
const REFRESH_COUNTER_PREFIX = "pricing:refresh_calls:";

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 有限な数値のみ保存し、それ以外 (null/NaN/Infinity) は NULL */
function numArg(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const SEVERITY_RANK: Record<string, number> = { info: 0, medium: 1, high: 2 };

function severityRank(s: string): number {
  return SEVERITY_RANK[s] ?? 0;
}

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
  const startedAt = Date.now();
  const today = toDateStr(todayJst());
  const sync = await getSyncConfig(db);
  const dailyCap = Math.max(0, Math.floor(sync.dailyRatesCalls));
  const maxCalls = Number.isFinite(opts.maxCalls) ? Math.max(0, Math.floor(opts.maxCalls)) : 0;
  const limit = Math.min(maxCalls, dailyCap, MAX_CALLS_PER_RUN);

  // 対象候補 (上限前)。limit 超過・日次上限で取得しない件数を skipped として返すため最大件数で選ぶ
  const { ids: eligible } = await selectCompsetRefreshTargets(db, {
    ids: opts.ids,
    staleDays: opts.staleDays,
    limit: MAX_CALLS_PER_RUN,
  });
  if (eligible.length === 0) return { refreshed: 0, costUsd: 0, skipped: 0 };
  if (!isAirRoiConfigured()) {
    // キー未設定で呼ぶと全件「取得失敗」として取得試行日だけが進み、CompSet が failed 扱いになってしまう
    await db
      .execute({
        sql: `INSERT INTO sync_logs (sync_type, records_fetched, api_calls_count, status, error_message)
              VALUES ('pricing_compset', 0, 0, 'FAILED', 'AIRROI_API_KEY が設定されていません')`,
        args: [],
      })
      .catch(() => {});
    return { refreshed: 0, costUsd: 0, skipped: eligible.length };
  }

  const counterKey = `${REFRESH_COUNTER_PREFIX}${today}`;
  const counterRes = await db.execute({
    sql: "SELECT value FROM sync_state WHERE key = ?",
    args: [counterKey],
  });
  const usedRaw = Number(counterRes.rows[0]?.value ?? 0);
  const usedToday = Number.isFinite(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
  const allowance = Math.max(0, Math.min(limit, dailyCap - usedToday));
  const planned = eligible.slice(0, allowance);

  const writeCounter = (value: number) =>
    db.execute({
      sql: `INSERT INTO sync_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      args: [counterKey, String(value)],
    });

  let refreshed = 0;
  let records = 0;
  let failed = 0; // 取得できなかった件数 (refreshRatesForProperty は取得失敗を内部で握りつぶし 0 件を返す)
  let errorMessage: string | null = null;
  if (planned.length > 0) {
    // 並行実行でも上限を超えないよう、先に予定件数を計上しておく (終了後に実数へ補正)
    await writeCounter(usedToday + planned.length);
    const propRes = await db.execute({
      sql: `SELECT id, airroi_id, max_guests FROM properties WHERE id IN (${planned.map(() => "?").join(",")})`,
      args: planned,
    });
    const props = new Map(
      propRes.rows.map((r) => [
        String(r.id),
        { id: String(r.id), airroiId: String(r.airroi_id), maxGuests: Number(r.max_guests) || 1 },
      ]),
    );
    const queue = planned.map((id) => props.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined);
    try {
      for (let i = 0; i < queue.length; i += REFRESH_CONCURRENCY) {
        if (Date.now() - startedAt > REFRESH_BUDGET_MS) break;
        const batch = queue.slice(i, i + REFRESH_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((p) => refreshRatesForProperty(db, p)));
        // 取得の成否に関係なく API は呼ばれている (費用は発生) ので件数に含める
        refreshed += batch.length;
        for (const r of results) {
          if (r.status === "fulfilled") {
            records += r.value;
            if (r.value === 0) failed += 1;
          } else {
            failed += 1;
            errorMessage = r.reason instanceof Error ? r.reason.message : String(r.reason);
          }
        }
      }
    } finally {
      await writeCounter(usedToday + refreshed).catch(() => {});
    }
  }

  const skipped = eligible.length - refreshed;
  const status =
    refreshed > 0 && failed >= refreshed ? "FAILED" : skipped > 0 || failed > 0 ? "PARTIAL" : "SUCCESS";
  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed}件は取得できませんでした${errorMessage ? ` (${errorMessage})` : ""}`);
  if (skipped > 0) notes.push(`${skipped}件は上限 (1回${limit}件 / 1日${dailyCap}件) のため取得しませんでした`);
  const message = notes.length > 0 ? `CompSetカレンダー: ${notes.join("、")}` : null;
  await db
    .execute({
      sql: `INSERT INTO sync_logs (sync_type, records_fetched, api_calls_count, status, error_message)
            VALUES ('pricing_compset', ?, ?, ?, ?)`,
      args: [records, refreshed, status, message],
    })
    .catch(() => {});
  // 古い日次カウンタを掃除する
  await db
    .execute({
      sql: "DELETE FROM sync_state WHERE key LIKE 'pricing:refresh_calls:%' AND key < ?",
      args: [`${REFRESH_COUNTER_PREFIX}${addDaysStr(today, -7)}`],
    })
    .catch(() => {});

  return { refreshed, costUsd: round2(refreshed * COST_PER_RATES_CALL), skipped };
}

function recommendationStmt(today: string, d: DayRecommendation): InStatement {
  const m = d.market;
  const p = d.pricing;
  const args: InValue[] = [
    today,
    d.date,
    numArg(d.lead),
    d.night.type,
    d.night.reason,
    numArg(m.units),
    numArg(m.occ),
    numArg(m.occAdj),
    numArg(m.occRaw),
    numArg(m.compAdr),
    numArg(m.remaining),
    numArg(m.pace),
    numArg(m.paceRaw),
    numArg(m.newBookings),
    m.spike ? 1 : 0,
    numArg(p.basePrice),
    numArg(p.delta.value),
    numArg(p.alpha.value),
    numArg(p.beta.value),
    numArg(p.gamma.value),
    numArg(p.rawPrice),
    numArg(p.floor),
    numArg(p.ceiling),
    numArg(p.recommended),
    p.clampedBy,
    numArg(d.own.currentPrice),
    d.own.currentPriceSource,
    d.own.status,
    numArg(p.changePct),
    p.action,
    p.signal,
  ];
  return {
    sql: `INSERT OR REPLACE INTO pricing_recommendations (
            generated_date, target_date, lead_days, day_type, day_type_reason,
            comp_units, comp_occ, comp_occ_adj, comp_occ_raw, comp_adr, remaining_units,
            pace_index, pace_raw, new_bookings, spike,
            base_price, delta, alpha, beta, gamma,
            raw_price, floor_price, ceiling_price, recommended_price, clamped_by,
            current_price, current_price_source, own_status, change_pct, action, signal)
          VALUES (${args.map(() => "?").join(", ")})`,
    args,
  };
}

/**
 * 今日の推奨価格を保存し、アラートを記録・通知する。API 費用は発生しない (CompSet 取得は呼び出し側で)。
 * 1. (config.icalUrl があれば) importIcalToDb を試行 (失敗しても続行。結果は ical.ts が記録)
 * 2. dashboard = computePricingDashboard(await loadPricingInputs(db))。db が null (= dataSource "demo") なら保存せず返す
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
  db: Client | null,
  opts: { notify: boolean },
): Promise<{ saved: number; alerts: number; notified: number; dashboard: PricingDashboard }> {
  // 1. 自社カレンダー (iCal) の取り込み
  if (db) {
    const config = await getPricingConfig(db);
    if (config.icalUrl) {
      try {
        await importIcalToDb(db, config.icalUrl, toDateStr(todayJst()), config.horizonDays);
      } catch (err) {
        console.error("pricing: iCal 取り込みに失敗 (続行):", err);
      }
    }
  }

  // 2. 推奨価格の算出 (渡された db から読む。null ならデモ)
  const dashboard = computePricingDashboard(await loadPricingInputs(db));
  if (!db || dashboard.dataSource === "demo") {
    return { saved: 0, alerts: dashboard.alerts.length, notified: 0, dashboard };
  }
  const today = dashboard.today;

  // 3. 推奨価格の保存 (今日の分は丸ごと置き換え)
  const recStmts: InStatement[] = [
    { sql: "DELETE FROM pricing_recommendations WHERE generated_date = ?", args: [today] },
    ...dashboard.days.map((d) => recommendationStmt(today, d)),
  ];
  await db.batch(recStmts, "write");

  // 4. アラートの記録 (通知済みの行は変えない) と、解消したアラートの削除
  const alertStmts: InStatement[] = dashboard.alerts.map((a) => ({
    sql: `INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(generated_date, target_date, kind) DO UPDATE SET
            severity=excluded.severity, message=excluded.message
          WHERE pricing_alerts.notified_at IS NULL`,
    args: [today, a.date, a.kind, a.severity, a.message],
  }));
  const currentKeys = [...new Set(dashboard.alerts.map((a) => `${a.date}|${a.kind}`))];
  alertStmts.push(
    currentKeys.length > 0
      ? {
          sql: `DELETE FROM pricing_alerts
                WHERE generated_date = ? AND notified_at IS NULL
                  AND (target_date || '|' || kind) NOT IN (${currentKeys.map(() => "?").join(",")})`,
          args: [today, ...currentKeys],
        }
      : {
          sql: "DELETE FROM pricing_alerts WHERE generated_date = ? AND notified_at IS NULL",
          args: [today],
        },
  );
  await db.batch(alertStmts, "write");

  // 5. 通知
  let notified = 0;
  if (opts.notify) {
    const kinds = NOTIFY_KINDS.map(() => "?").join(",");
    const pendingRes = await db.execute({
      sql: `SELECT id, target_date, kind, severity, message FROM pricing_alerts
            WHERE generated_date = ? AND notified_at IS NULL AND target_date >= ?
              AND kind IN (${kinds})
            ORDER BY target_date, kind`,
      args: [today, today, ...NOTIFY_KINDS],
    });
    // 過去に通知済みの (target_date, kind) ごとの最大 severity
    const prevRes = await db.execute({
      sql: `SELECT target_date, kind, severity FROM pricing_alerts
            WHERE generated_date < ? AND target_date >= ?
              AND notified_at IS NOT NULL AND notified_at <> 'skipped'
              AND kind IN (${kinds})`,
      args: [today, today, ...NOTIFY_KINDS],
    });
    const prevMax = new Map<string, number>();
    for (const r of prevRes.rows) {
      const key = `${String(r.target_date)}|${String(r.kind)}`;
      prevMax.set(key, Math.max(prevMax.get(key) ?? -1, severityRank(String(r.severity))));
    }
    const targets = pendingRes.rows.filter((r) => {
      const prev = prevMax.get(`${String(r.target_date)}|${String(r.kind)}`);
      return prev === undefined || severityRank(String(r.severity)) > prev;
    });
    if (targets.length > 0) {
      const alerts: PricingAlert[] = targets.map((r) => ({
        date: String(r.target_date),
        kind: String(r.kind) as PricingAlert["kind"],
        severity: String(r.severity) as PricingAlert["severity"],
        message: String(r.message),
      }));
      const sent = await sendAlertWebhook(alerts);
      if (sent) {
        const ids = targets.map((r) => Number(r.id));
        await db.execute({
          sql: `UPDATE pricing_alerts SET notified_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => "?").join(",")})`,
          args: ids,
        });
        notified = ids.length;
      }
    }
    await db.execute({
      sql: "UPDATE pricing_alerts SET notified_at = 'skipped' WHERE generated_date < ? AND notified_at IS NULL",
      args: [today],
    });
  }

  // 6. 古いデータの削除
  const cutoff = addDaysStr(today, -RETENTION_DAYS);
  await db.batch(
    [
      { sql: "DELETE FROM calendar_snapshots WHERE snapshot_date < ?", args: [cutoff] },
      { sql: "DELETE FROM pricing_recommendations WHERE generated_date < ?", args: [cutoff] },
      { sql: "DELETE FROM pricing_alerts WHERE generated_date < ?", args: [cutoff] },
    ],
    "write",
  );

  return { saved: dashboard.days.length, alerts: dashboard.alerts.length, notified, dashboard };
}

/**
 * 環境変数 ALERT_WEBHOOK_URL が設定されていれば、Slack/Discord 互換の JSON
 * { text, content } (同じ本文) を POST する (タイムアウト 10 秒)。未設定・失敗なら false。
 * 本文: "【Lumina Fuji 価格アラート】" + 各アラートを "・{message}" で改行連結 (最大 20 件)
 */
export async function sendAlertWebhook(alerts: PricingAlert[]): Promise<boolean> {
  const url = cleanEnv(process.env.ALERT_WEBHOOK_URL);
  if (!url || alerts.length === 0) return false;
  const body = ["【Lumina Fuji 価格アラート】", ...alerts.slice(0, WEBHOOK_MAX_ALERTS).map((a) => `・${a.message}`)].join(
    "\n",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: body, content: body }),
      signal: controller.signal,
    });
    return res.ok;
  } catch (err) {
    console.error("pricing: アラート通知の送信に失敗:", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
