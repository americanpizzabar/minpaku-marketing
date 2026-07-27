import { waitUntil } from "@vercel/functions";
import { DAILY_RATES_CALLS, syncStep, type SyncStepResult } from "./airroi";
import { ensureSchema, getDb } from "./db";

export type SyncRunResult = SyncStepResult | { status: "SKIPPED"; message: string };

export interface SyncRunOptions {
  /** データを全消去してから全件再取得する (呼び出し上限なし。コスト大のため明示指定時のみ) */
  reset?: boolean;
  /** データは保持しつつ全物件を「要更新」扱いにする (呼び出し上限なし) */
  force?: boolean;
  /** このチェーンで残っている料金取得の上限 (チェーン継続用。undefined=既定値) */
  cap?: number | null;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 増分同期を1ステップ実行し、作業が残っていれば自分自身 (/api/sync) を
 * 再呼び出しして続きを別の関数インスタンスに引き継ぐ。
 */
export async function runChunkedSync(
  syncType: "cron_daily" | "manual_refresh",
  opts: SyncRunOptions = {},
): Promise<SyncRunResult> {
  const db = getDb();
  if (!db) {
    return {
      status: "SKIPPED",
      message:
        "デモモードで動作中です。Turso DB (TURSO_DATABASE_URL) と AIRROI_API_KEY を設定すると実データを同期できます。",
    };
  }

  await ensureSchema(db);

  if (opts.reset) {
    console.log("AirROI sync: reset指定のため全データを削除して再取得します");
    await db.execute("DELETE FROM daily_metrics");
    await db.execute("DELETE FROM properties WHERE id LIKE 'airroi_%'");
    await db.execute("DELETE FROM sync_state WHERE key LIKE 'catalog:%'");
  } else if (opts.force) {
    console.log("AirROI sync: force指定のため全物件を要更新扱いにします");
    await db.execute("UPDATE properties SET rates_synced_at = NULL");
    await db.execute("DELETE FROM sync_state WHERE key LIKE 'catalog:%'");
  }

  // reset/force は全件処理のため上限なし。通常はチェーン全体で DAILY_RATES_CALLS 件まで。
  const cap =
    opts.reset || opts.force ? null : opts.cap === undefined ? DAILY_RATES_CALLS : opts.cap;

  const result = await syncStep(db, syncType, cap);

  if (result.status === "PARTIAL") {
    chainNext(result.capRemaining);
  }

  return result;
}

/** 残作業の処理を新しい関数インスタンスに引き継ぐ (リクエスト送信のみ保証し応答は待たない) */
function chainNext(capRemaining: number | null): void {
  const secret = cleanEnv(process.env.CRON_SECRET);
  const host =
    cleanEnv(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? cleanEnv(process.env.VERCEL_URL);
  if (!secret || !host) {
    console.error(
      "AirROI sync: チェーン継続不可 (CRON_SECRET / VERCEL_PROJECT_PRODUCTION_URL 未設定)",
    );
    return;
  }

  const url = `https://${host}/api/sync?key=${encodeURIComponent(secret)}&cap=${capRemaining === null ? "none" : capRemaining}`;
  console.log(`AirROI sync: 残作業を引き継ぎ (cap=${capRemaining ?? "無制限"})`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  waitUntil(
    fetch(url, { signal: controller.signal })
      .catch(() => {
        // 送信後の応答待ちタイムアウトは想定内 (子は自身の実行時間枠で処理を続ける)
      })
      .finally(() => clearTimeout(timer)),
  );
}
