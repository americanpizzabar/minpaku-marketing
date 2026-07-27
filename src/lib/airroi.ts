import type { Client, InStatement } from "@libsql/client";
import type { PropertyType } from "./types";

/**
 * AirROI API クライアント (実機検証済みの仕様)
 * - ベースURL: https://api.airroi.com
 * - 認証: x-api-key ヘッダ
 * - エリア検索: POST /listings/search/radius
 *     body: { latitude, longitude, radius, pagination: { pageSize(最大10), offset } }
 *     res:  { pagination: { total_count, page_size, offset }, results: [{ listing_info: {...} }] }
 * - 日別料金/空室: GET /listings/future/rates?id=<listing_id>&currency=native
 *     res:  { rates: [{ date, available, rate, min_nights }] }
 */
const BASE_URL = (process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com").replace(/\/$/, "");

const AREA_SEARCH: Record<string, { lat: number; lng: number }> = {
  山中湖村: { lat: 35.4167, lng: 138.8667 },
  富士吉田市: { lat: 35.4874, lng: 138.8077 },
  富士河口湖町: { lat: 35.4972, lng: 138.755 },
  鳴沢村: { lat: 35.4763, lng: 138.7047 },
  忍野村: { lat: 35.46, lng: 138.845 },
};

const RADIUS_MILES = Number(process.env.AIRROI_RADIUS_MILES ?? 3);
// Pay-per-call コスト管理: 1エリアあたりのカレンダー取得件数上限
const MAX_LISTINGS_PER_AREA = Number(process.env.AIRROI_MAX_LISTINGS_PER_AREA ?? 25);
const PAGE_SIZE = 10; // APIの上限

export interface SyncResult {
  recordsFetched: number;
  apiCalls: number;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function apiKeyOrThrow(): string {
  const apiKey = cleanEnv(process.env.AIRROI_API_KEY);
  if (!apiKey) throw new Error("AIRROI_API_KEY が設定されていません");
  return apiKey;
}

async function airRoiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": apiKeyOrThrow(), Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (GET ${path}) ${body}`);
  }
  return res.json() as Promise<T>;
}

async function airRoiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKeyOrThrow(),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (POST ${path}) ${errBody}`);
  }
  return res.json() as Promise<T>;
}

type Json = Record<string, unknown>;

/** result要素の listing_info 等のネストを1階層フラット化して属性を拾いやすくする */
function flatten(item: Json): Json {
  const out: Json = { ...item };
  for (const v of Object.values(item)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(out, v as Json);
    }
  }
  return out;
}

function pick(obj: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapPropertyType(raw: unknown): PropertyType {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("villa") || s.includes("cabin") || s.includes("chalet") || s.includes("cottage"))
    return "villa";
  if (s.includes("hotel") || s.includes("ryokan") || s.includes("aparthotel")) return "hotel";
  if (s.includes("bed and breakfast") || s.includes("b&b") || s.includes("guesthouse"))
    return "pension";
  return "house";
}

interface RadiusSearchResponse {
  pagination?: { total_count?: number; page_size?: number; offset?: number };
  results?: Json[];
}

interface FutureRatesResponse {
  rates?: { date?: string; available?: boolean; rate?: number; min_nights?: number }[];
}

export async function fetchAndStoreAirRoiData(db: Client, area: string): Promise<SyncResult> {
  let apiCalls = 0;
  let recordsFetched = 0;

  const center = AREA_SEARCH[area];
  if (!center) return { recordsFetched, apiCalls };

  // 1. 半径検索 (pageSize上限10のためページングで収集)
  const collected: Json[] = [];
  let offset = 0;
  let totalCount = Infinity;
  while (collected.length < MAX_LISTINGS_PER_AREA && offset < totalCount) {
    const res = await airRoiPost<RadiusSearchResponse>("/listings/search/radius", {
      latitude: center.lat,
      longitude: center.lng,
      radius: RADIUS_MILES,
      pagination: { pageSize: PAGE_SIZE, offset },
    });
    apiCalls += 1;
    totalCount = num(res.pagination?.total_count) ?? 0;
    const page = res.results ?? [];
    if (page.length === 0) break;
    collected.push(...page);
    offset += PAGE_SIZE;
  }

  for (const raw of collected.slice(0, MAX_LISTINGS_PER_AREA)) {
    const item = flatten(raw);
    const rawId = pick(item, ["listing_id", "id", "listingId"]);
    if (rawId === undefined) continue;
    const airroiId = String(rawId);
    const maxGuests =
      num(pick(item, ["person_capacity", "accommodates", "max_guests", "guests", "guest_limit", "capacity"])) ?? 1;

    await db.execute({
      sql: `INSERT INTO properties (id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type, max_guests, bedrooms, bathrooms, rating, reviews_count, url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title, rating=excluded.rating, reviews_count=excluded.reviews_count,
              max_guests=excluded.max_guests, bedrooms=excluded.bedrooms,
              updated_at=CURRENT_TIMESTAMP`,
      args: [
        `airroi_${airroiId}`,
        airroiId,
        airroiId,
        String(pick(item, ["listing_name", "title", "name"]) ?? `Listing ${airroiId}`),
        area,
        num(pick(item, ["latitude", "lat"])),
        num(pick(item, ["longitude", "lng", "lon"])),
        mapPropertyType(pick(item, ["listing_type", "property_type", "room_type"])),
        maxGuests,
        num(pick(item, ["bedrooms", "bedroom_count"])) ?? 1,
        num(pick(item, ["bathrooms", "bathroom_count"])),
        num(pick(item, ["rating", "overall_rating", "review_score", "guest_satisfaction"])),
        num(pick(item, ["reviews_count", "number_of_reviews", "visible_review_count", "review_count"])) ?? 0,
        `https://www.airbnb.com/rooms/${airroiId}`,
      ],
    });
    recordsFetched += 1;

    // 2. 今後365日の料金・空室カレンダーを取得しバッチでUPSERT
    try {
      const ratesRes = await airRoiGet<FutureRatesResponse>(
        `/listings/future/rates?id=${encodeURIComponent(airroiId)}&currency=native`,
      );
      apiCalls += 1;

      const stmts: InStatement[] = [];
      for (const day of ratesRes.rates ?? []) {
        const price = num(day.rate);
        if (!day.date || price === null || price <= 0) continue; // rate=0 は価格未設定日
        stmts.push({
          sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(property_id, target_date) DO UPDATE SET
                  price_jpy=excluded.price_jpy, price_per_person=excluded.price_per_person,
                  is_available=excluded.is_available, min_nights=excluded.min_nights,
                  fetched_at=CURRENT_TIMESTAMP`,
          args: [
            `airroi_${airroiId}`,
            String(day.date).slice(0, 10),
            price,
            price / Math.max(maxGuests, 1),
            day.available ? 1 : 0,
            num(day.min_nights) ?? 1,
          ],
        });
      }
      if (stmts.length > 0) {
        await db.batch(stmts, "write");
        recordsFetched += stmts.length;
      }
    } catch (err) {
      // 1物件のカレンダー取得失敗で同期全体を止めない
      console.error(`AirROI: 物件 ${airroiId} のカレンダー取得に失敗:`, err);
    }
  }

  return { recordsFetched, apiCalls };
}

/** 全対象エリアを同期し、sync_logs に結果を記録する */
export async function syncAllAreas(
  db: Client,
  syncType: "cron_daily" | "manual_refresh",
): Promise<{ recordsFetched: number; apiCalls: number; status: string; error?: string }> {
  let totalRecords = 0;
  let totalCalls = 0;
  try {
    for (const area of Object.keys(AREA_SEARCH)) {
      const result = await fetchAndStoreAirRoiData(db, area);
      totalRecords += result.recordsFetched;
      totalCalls += result.apiCalls;
    }
    await db.execute({
      sql: `INSERT INTO sync_logs (sync_type, records_fetched, api_calls_count, status) VALUES (?, ?, ?, 'SUCCESS')`,
      args: [syncType, totalRecords, totalCalls],
    });
    return { recordsFetched: totalRecords, apiCalls: totalCalls, status: "SUCCESS" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute({
      sql: `INSERT INTO sync_logs (sync_type, records_fetched, api_calls_count, status, error_message) VALUES (?, ?, ?, 'FAILED', ?)`,
      args: [syncType, totalRecords, totalCalls, message],
    });
    return { recordsFetched: totalRecords, apiCalls: totalCalls, status: "FAILED", error: message };
  }
}
