import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AirROI APIの正しいエンドポイントパスを特定するための診断ルート。
 * CRON_SECRET をクエリ `key` に指定した場合のみ実行可能。
 * 各候補パスへ1リクエストずつ送り、ステータスとレスポンス冒頭を返す。
 */
const CANDIDATES = [
  "/markets/lookup?lat=35.4167&lng=138.8667",
  "/listings/search/radius?lat=35.4167&lng=138.8667&radius=3",
  "/listings/search/radius?lat=35.4167&lng=138.8667&distance=3",
  "/listings/search-radius?lat=35.4167&lng=138.8667&radius=3",
  "/listings/radius?lat=35.4167&lng=138.8667&radius=3",
  "/search/radius?lat=35.4167&lng=138.8667&radius=3",
  "/listings/search?lat=35.4167&lng=138.8667&radius=3",
  "/listings?id=43036533&currency=native",
  "/listings/future/rates?id=43036533&currency=native",
  "/listings/future-rates?id=43036533&currency=native",
  "/listings/rates?id=43036533",
];

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = cleanEnv(process.env.AIRROI_API_KEY);
  if (!apiKey) {
    return NextResponse.json({ error: "AIRROI_API_KEY 未設定" }, { status: 500 });
  }

  const base = (process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com").replace(/\/$/, "");
  const results: { path: string; status: number; body: string }[] = [];

  for (const path of CANDIDATES) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { "x-api-key": apiKey, Accept: "application/json" },
      });
      const body = (await res.text().catch(() => "")).slice(0, 500);
      results.push({ path, status: res.status, body });
    } catch (err) {
      results.push({ path, status: 0, body: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ base, results });
}
