import { NextRequest, NextResponse } from "next/server";
import { syncAllAreas } from "@/lib/airroi";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** CRON_SECRET付きGETでも同期を実行できるようにする (リモート診断用) */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return POST();
}

/** サイドバーの「データ手動更新」ボタンから呼び出される手動同期 */
export async function POST() {
  const db = getDb();
  if (!db) {
    return NextResponse.json({
      status: "SKIPPED",
      message:
        "デモモードで動作中です。Turso DB (TURSO_DATABASE_URL) と AIRROI_API_KEY を設定すると実データを同期できます。",
    });
  }

  try {
    await ensureSchema(db);
    const result = await syncAllAreas(db, "manual_refresh");
    return NextResponse.json(result, { status: result.status === "SUCCESS" ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
