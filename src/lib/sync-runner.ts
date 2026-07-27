import { waitUntil } from "@vercel/functions";
import { ALL_AREAS, syncAreasChunked, type ChunkedSyncResult } from "./airroi";
import { ensureSchema, getDb } from "./db";

export type SyncRunResult = ChunkedSyncResult | { status: "SKIPPED"; message: string };

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 時間予算付きの同期を1回分実行し、エリアが残っていれば
 * 自分自身 (/api/sync) を再呼び出しして続きを別インスタンスに引き継ぐ。
 * Vercelの実行時間制限 (300秒) 内で全エリアを確実に処理するための仕組み。
 */
export async function runChunkedSync(
  syncType: "cron_daily" | "manual_refresh",
  areasParam?: string | null,
  reset = false,
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

  if (reset) {
    // 取り込み仕様の変更後などに、既存データを一掃してから再同期する
    console.log("AirROI sync: reset指定のため daily_metrics と AirROI由来のpropertiesを削除します");
    await db.execute("DELETE FROM daily_metrics");
    await db.execute("DELETE FROM properties WHERE id LIKE 'airroi_%'");
  }

  const requested = (areasParam ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((a) => ALL_AREAS.includes(a));
  const areas = requested.length > 0 ? requested : ALL_AREAS;

  const result = await syncAreasChunked(db, areas, syncType);

  if (result.status === "PARTIAL" && result.remainingAreas.length > 0) {
    chainNext(result.remainingAreas);
  }

  return result;
}

/** 残りエリアの同期を新しい関数インスタンスに引き継ぐ (リクエスト送信のみ保証し応答は待たない) */
function chainNext(remainingAreas: string[]): void {
  const secret = cleanEnv(process.env.CRON_SECRET);
  const host =
    cleanEnv(process.env.VERCEL_PROJECT_PRODUCTION_URL) ?? cleanEnv(process.env.VERCEL_URL);
  if (!secret || !host) {
    console.error(
      "AirROI sync: 残りエリアの引き継ぎ不可 (CRON_SECRET / VERCEL_PROJECT_PRODUCTION_URL 未設定):",
      remainingAreas.join(","),
    );
    return;
  }

  const url = `https://${host}/api/sync?key=${encodeURIComponent(secret)}&areas=${encodeURIComponent(remainingAreas.join(","))}`;
  console.log(`AirROI sync: 残りエリアを引き継ぎ → ${remainingAreas.join(",")}`);

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
