import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * AirROI APIレスポンスの実データ検証用の診断ルート。
 * CRON_SECRET をクエリ `key` に指定した場合のみ実行可能。
 * `id` で指定した物件の料金カレンダーを通貨指定パターン別に取得し、統計を返す。
 */
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function parseJsonSafe<T>(text: string): T {
  const quoted = text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted) as T;
}

interface RateDay {
  date?: string;
  available?: unknown;
  rate?: unknown;
  min_nights?: unknown;
  [key: string]: unknown;
}

function summarize(days: RateDay[]) {
  const rates = days
    .map((d) => Number(d.rate))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const availTrue = days.filter((d) => d.available === true || d.available === 1).length;
  const availFalse = days.filter((d) => d.available === false || d.available === 0).length;
  const availOther = days.length - availTrue - availFalse;
  const pct = (p: number) => rates[Math.min(rates.length - 1, Math.floor((p / 100) * rates.length))];
  return {
    totalDays: days.length,
    availTrue,
    availFalse,
    availOther,
    positiveRateDays: rates.length,
    zeroOrMissingRateDays: days.length - rates.length,
    rateMin: rates[0] ?? null,
    rateP25: rates.length ? pct(25) : null,
    rateMedian: rates.length ? pct(50) : null,
    rateP75: rates.length ? pct(75) : null,
    rateMax: rates[rates.length - 1] ?? null,
    rateAvg: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    availableDaysRateAvg: (() => {
      const r = days
        .filter((d) => d.available === true || d.available === 1)
        .map((d) => Number(d.rate))
        .filter((n) => Number.isFinite(n) && n > 0);
      return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
    })(),
    unavailableDaysRateAvg: (() => {
      const r = days
        .filter((d) => d.available === false || d.available === 0)
        .map((d) => Number(d.rate))
        .filter((n) => Number.isFinite(n) && n > 0);
      return r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null;
    })(),
    first5: days.slice(0, 5),
    highest3: [...days]
      .filter((d) => Number.isFinite(Number(d.rate)))
      .sort((a, b) => Number(b.rate) - Number(a.rate))
      .slice(0, 3),
  };
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

  const id = request.nextUrl.searchParams.get("id") ?? "560510509533844467";
  const base = (process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com").replace(/\/$/, "");

  const variants = [
    `/listings/future/rates?id=${id}&currency=native`,
    `/listings/future/rates?id=${id}`,
    `/listings/future/rates?id=${id}&currency=JPY`,
  ];

  const results: Record<string, unknown>[] = [];
  for (const path of variants) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { "x-api-key": apiKey, Accept: "application/json" },
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        results.push({ path, status: res.status, body: text.slice(0, 500) });
        continue;
      }
      const json = parseJsonSafe<{ rates?: RateDay[]; [key: string]: unknown }>(text);
      results.push({
        path,
        status: res.status,
        topLevelKeys: Object.keys(json),
        summary: json.rates ? summarize(json.rates) : null,
        nonRatesFields: Object.fromEntries(
          Object.entries(json)
            .filter(([k]) => k !== "rates")
            .map(([k, v]) => [k, JSON.stringify(v).slice(0, 300)]),
        ),
      });
    } catch (err) {
      results.push({ path, status: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ base, id, results });
}
