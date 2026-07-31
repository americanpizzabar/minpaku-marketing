import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 国土地理院の住所検索APIを使ったジオコーダ (無料・APIキー不要)。
 * 自物件の住所から緯度・経度を求めるための管理用エンドポイント。
 * CRON_SECRET をクエリ `key` に指定した場合のみ実行可能。
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.nextUrl.searchParams.get("key") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get("q");
  if (!q) {
    return NextResponse.json({ error: "q (住所) を指定してください" }, { status: 400 });
  }

  // provider=osm: Nominatim (OpenStreetMap) — 施設名・POI検索が可能
  if (request.nextUrl.searchParams.get("provider") === "osm") {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=5&accept-language=ja`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "minpaku-marketing-dashboard/1.0 (admin contact via site)",
          },
        },
      );
      if (!res.ok) {
        return NextResponse.json({ error: `Nominatim Error: ${res.status}` }, { status: 502 });
      }
      const json = (await res.json()) as {
        display_name?: string;
        lat?: string;
        lon?: string;
        type?: string;
      }[];
      return NextResponse.json({
        query: q,
        provider: "osm",
        results: json.map((r) => ({
          title: r.display_name ?? "",
          type: r.type ?? "",
          lat: r.lat ? Number(r.lat) : null,
          lng: r.lon ? Number(r.lon) : null,
        })),
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  try {
    const res = await fetch(
      `https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) {
      return NextResponse.json({ error: `GSI API Error: ${res.status}` }, { status: 502 });
    }
    const json = (await res.json()) as {
      geometry?: { coordinates?: [number, number] };
      properties?: { title?: string };
    }[];
    return NextResponse.json({
      query: q,
      results: json.slice(0, 5).map((r) => ({
        title: r.properties?.title ?? "",
        lng: r.geometry?.coordinates?.[0] ?? null,
        lat: r.geometry?.coordinates?.[1] ?? null,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
