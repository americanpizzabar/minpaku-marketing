import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/lib/db";
import { getPricingConfig } from "@/lib/pricing/config-store";
import { refreshCompsetCalendars, runPricingPipeline } from "@/lib/pricing/pipeline";
import { runChunkedSync, type SyncRunResult } from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron から毎日 17:00 UTC (JST 午前2時) に呼び出される日次処理 (仕様6章のパイプライン)。
 * 1. 既存の増分同期 (自動同期オフなら SKIPPED)
 *    - 物件カタログ: AIRROI_SEARCH_REFRESH_DAYS (既定30日) ごとに再検索
 *    - 料金カレンダー: AIRROI_RATES_REFRESH_DAYS より古い物件を古い順に取得上限まで更新
 * 2. CompSet カレンダーの自動取得 (価格最適化の設定でオンのときのみ。自動同期の設定とは独立。有料)
 * 3. 推奨価格の再計算と保存・アラート記録 (API費用ゼロのため常に実行。通知は 07:00 の pricing-alerts で行う)
 * 各段の失敗は捕捉して応答に含め、HTTP ステータスは同期 (1) の結果のみで決める。
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let sync: SyncRunResult | { status: "FAILED"; error: string };
  try {
    sync = await runChunkedSync("cron_daily");
  } catch (err) {
    sync = { status: "FAILED", error: err instanceof Error ? err.message : String(err) };
  }

  const db = getDb();
  let compset: Record<string, unknown> | null = null;
  let pricing: Record<string, unknown>;
  if (!db) {
    pricing = { skipped: "demo" };
  } else {
    try {
      await ensureSchema(db);
      const cfg = await getPricingConfig(db);
      if (cfg.compsetAutoRefresh) {
        try {
          compset = await refreshCompsetCalendars(db, {
            maxCalls: cfg.compsetRefreshMax,
            staleDays: cfg.compsetRefreshDays,
          });
        } catch (err) {
          compset = { error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        compset = { skipped: "自動取得オフ" };
      }
      const r = await runPricingPipeline(db, { notify: false });
      pricing = { saved: r.saved, alerts: r.alerts, notified: r.notified };
    } catch (err) {
      pricing = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json(
    { ...sync, compset, pricing },
    { status: sync.status === "FAILED" ? 500 : 200 },
  );
}
