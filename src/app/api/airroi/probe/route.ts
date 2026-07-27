import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AirROI APIの正しいエンドポイントパスを特定するための診断ルート。
 * CRON_SECRET をクエリ `key` に指定した場合のみ実行可能。
 * 各候補パスへ1リクエストずつ送り、ステータスとレスポンス冒頭を返す。
 */
const CANDIDATES: { method: "GET" | "POST"; path: string; body?: unknown }[] = [
  {
    method: "POST",
    path: `/listings/search/radius`,
    body: { latitude: 35.4167, longitude: 138.8667, radius: 3 },
  },
  {
    method: "POST",
    path: `/listings/search/radius`,
    body: { latitude: 35.4167, longitude: 138.8667, radius: 3, page_size: 100, offset: 0 },
  },
  {
    method: "POST",
    path: `/listings/search/radius`,
    body: {
      latitude: 35.4167,
      longitude: 138.8667,
      radius: 3,
      pagination: { page_size: 100, offset: 0 },
    },
  },
  { method: "GET", path: `/listings/future/rates?id=3607285&currency=native` },
  { method: "GET", path: `/listings?id=3607285&currency=native` },
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
  const results: { method: string; path: string; status: number; body: string }[] = [];

  for (const c of CANDIDATES) {
    try {
      const res = await fetch(`${base}${c.path}`, {
        method: c.method,
        headers: {
          "x-api-key": apiKey,
          Accept: "application/json",
          ...(c.body ? { "Content-Type": "application/json" } : {}),
        },
        body: c.body ? JSON.stringify(c.body) : undefined,
      });
      const body = (await res.text().catch(() => "")).slice(0, 2500);
      results.push({ method: c.method, path: c.path, status: res.status, body });
    } catch (err) {
      results.push({
        method: c.method,
        path: c.path,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ base, results });
}
