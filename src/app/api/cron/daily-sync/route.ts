import { NextRequest, NextResponse } from "next/server";
import { syncAllAreas } from "@/lib/airroi";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron から毎日 18:00 UTC (JST 深夜3時) に呼び出される日次同期。
 * vercel.json の crons 設定を参照。
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({
      status: "SKIPPED",
      message: "TURSO_DATABASE_URL が未設定のため同期をスキップしました (デモモード)",
    });
  }

  await ensureSchema(db);
  const result = await syncAllAreas(db, "cron_daily");
  return NextResponse.json(result, { status: result.status === "SUCCESS" ? 200 : 500 });
}
