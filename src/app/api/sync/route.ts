import { NextRequest, NextResponse } from "next/server";
import { runChunkedSync } from "@/lib/sync-runner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * CRON_SECRET付きGETで増分同期を実行する (リモート実行・チェーン継続用)。
 * - `reset=1`: 全データ削除→全件再取得 (上限なし、コスト大)
 * - `force=1`: データ保持のまま全物件を再取得 (上限なし、コスト大)
 * - `cap=<n|none>`: チェーン継続用の残り呼び出し上限
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const capParam = params.get("cap");
  const cap =
    capParam === null ? undefined : capParam === "none" ? null : Math.max(0, Number(capParam) || 0);

  try {
    const result = await runChunkedSync("manual_refresh", {
      reset: params.get("reset") === "1",
      force: params.get("force") === "1",
      catalogOnly: params.get("catalog") === "1",
      cap,
    });
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}

/** サイドバーの「データ手動更新」ボタンから呼び出される手動同期 (既定の呼び出し上限つき)。
 *  `?catalog=1` で物件カタログ (実績・料金設定等) のみ即時再取得する。 */
export async function POST(request: NextRequest) {
  try {
    const result = await runChunkedSync("manual_refresh", {
      catalogOnly: request.nextUrl.searchParams.get("catalog") === "1",
    });
    return NextResponse.json(result, { status: result.status === "FAILED" ? 500 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: "FAILED", error: message }, { status: 500 });
  }
}
