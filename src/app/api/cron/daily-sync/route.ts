import { NextRequest, NextResponse } from "next/server";
import { runChunkedSync } from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron から毎日 18:00 UTC (JST 深夜3時) に呼び出される日次の増分同期。
 * - 物件カタログ: AIRROI_SEARCH_REFRESH_DAYS (既定30日) ごとに再検索
 * - 料金カレンダー: AIRROI_RATES_REFRESH_DAYS (既定14日) より古い物件を
 *   古い順に AIRROI_DAILY_RATES_CALLS (既定40) 件まで更新
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

  try {
    const result = await runChunkedSync("cron_daily");
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
