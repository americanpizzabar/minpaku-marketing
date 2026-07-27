import { NextResponse } from "next/server";
import { syncAllAreas } from "@/lib/airroi";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
