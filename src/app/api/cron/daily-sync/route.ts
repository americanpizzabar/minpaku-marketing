import { NextRequest, NextResponse } from "next/server";
import { runChunkedSync } from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron から毎日 18:00 UTC (JST 深夜3時) に呼び出される日次同期。
 * 時間予算を超えた分は /api/sync への自己呼び出しで自動的に引き継がれる。
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
