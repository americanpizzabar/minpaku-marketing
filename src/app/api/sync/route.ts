import { NextRequest, NextResponse } from "next/server";
import { runChunkedSync } from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * CRON_SECRET付きGETで同期を実行する (リモート実行・チェーン継続用)。
 * `areas` クエリでエリアを絞れる。時間予算を超えた分は自動で引き継がれる。
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runChunkedSync(
      "manual_refresh",
      request.nextUrl.searchParams.get("areas"),
      request.nextUrl.searchParams.get("reset") === "1",
    );
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}

/** サイドバーの「データ手動更新」ボタンから呼び出される手動同期 */
export async function POST() {
  try {
    const result = await runChunkedSync("manual_refresh");
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
