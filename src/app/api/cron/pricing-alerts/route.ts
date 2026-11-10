import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { ensureSchema, getDb } from "@/lib/db";
import { runPricingPipeline } from "@/lib/pricing/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Vercel Cron から毎日 22:00 UTC (JST 午前7時) に呼び出されるアラート通知 (仕様6章)。
 * 推奨価格を再計算し、週末の競合残室僅少・平日の予約急騰を ALERT_WEBHOOK_URL へ通知する
 * (同じ状況は重複して送らない。未設定ならアプリ内表示のみ)。API費用は発生しない。
 */
export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getDb();
  if (!db) return NextResponse.json({ skipped: "demo" });

  try {
    await ensureSchema(db);
    const r = await runPricingPipeline(db, { notify: true });
    return NextResponse.json({ saved: r.saved, alerts: r.alerts, notified: r.notified });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
