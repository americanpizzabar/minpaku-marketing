import type { Client } from "@libsql/client";
import type { PropertyType } from "./types";

/**
 * AirROI API クライアント
 * - ベースURL: https://api.airroi.com
 * - 認証: x-api-key ヘッダ
 * - エリア検索: GET /listings/search/radius (GPS中心 + マイル半径)
 * - 日別料金/空室: GET /listings/future/rates (今後365日)
 *
 * レスポンスのフィールド名はバージョンにより揺れがあるため、
 * 複数の候補キーを許容する防御的パースを行う。
 */
const BASE_URL = (process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com").replace(/\/$/, "");

// 各エリアの検索中心座標と半径 (マイル)
const AREA_SEARCH: Record<string, { lat: number; lng: number }> = {
  山中湖村: { lat: 35.4167, lng: 138.8667 },
  富士吉田市: { lat: 35.4874, lng: 138.8077 },
  富士河口湖町: { lat: 35.4972, lng: 138.755 },
  鳴沢村: { lat: 35.4763, lng: 138.7047 },
  忍野村: { lat: 35.46, lng: 138.845 },
};

const RADIUS_MILES = Number(process.env.AIRROI_RADIUS_MILES ?? 3);
// Pay-per-call コスト管理: 1エリアあたりのカレンダー取得件数上限
const MAX_LISTINGS_PER_AREA = Number(process.env.AIRROI_MAX_LISTINGS_PER_AREA ?? 40);

export interface SyncResult {
  recordsFetched: number;
  apiCalls: number;
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

async function airRoiFetch<T>(path: string): Promise<T> {
  const apiKey = cleanEnv(process.env.AIRROI_API_KEY);
  if (!apiKey) throw new Error("AIRROI_API_KEY が設定されていません");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (${path}) ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---- 防御的パースヘルパ ----

type Json = Record<string, unknown>;

function firstArray(obj: unknown, keys: string[]): Json[] {
  if (Array.isArray(obj)) return obj as Json[];
  if (typeof obj !== "object" || obj === null) return [];
  const rec = obj as Json;
  for (const k of keys) {
    const v = rec[k];
    if (Array.isArray(v)) return v as Json[];
    if (typeof v === "object" && v !== null) {
      const nested = firstArray(v, keys);
      if (nested.length > 0) return nested;
    }
  }
  return [];
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
  if (s.includes("villa")) return "villa";
  if (s.includes("hotel") || s.includes("ryokan")) return "hotel";
  if (s.includes("pension") || s.includes("bed and breakfast") || s.includes("b&b")) return "pension";
  return "house";
}

/**
 * 指定エリアの物件一覧 + 日別料金/空室を取得し、Turso DBへUPSERTする。
 */
export async function fetchAndStoreAirRoiData(db: Client, area: string): Promise<SyncResult> {
  let apiCalls = 0;
  let recordsFetched = 0;

  const center = AREA_SEARCH[area];
  if (!center) return { recordsFetched, apiCalls };

  // 1. 半径検索でエリア内の物件一覧を取得
  const searchRes = await airRoiFetch<unknown>(
    `/listings/search/radius?lat=${center.lat}&lng=${center.lng}&radius=${RADIUS_MILES}`,
  );
  apiCalls += 1;

  const listings = firstArray(searchRes, ["listings", "data", "results", "items"]);
  if (listings.length === 0) {
    console.warn(
      `AirROI: ${area} の検索結果が0件、またはレスポンス形式が想定外です。keys=`,
      typeof searchRes === "object" && searchRes !== null ? Object.keys(searchRes as Json) : typeof searchRes,
    );
  }

  for (const item of listings.slice(0, MAX_LISTINGS_PER_AREA)) {
    const rawId = pick(item, ["id", "listing_id", "airbnb_id", "listingId"]);
    if (rawId === undefined) continue;
    const airroiId = String(rawId);
    const airbnbId = pick(item, ["airbnb_id", "id", "listing_id"]);
    const maxGuests = num(pick(item, ["person_capacity", "accommodates", "max_guests", "guests", "capacity"])) ?? 1;

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
        airbnbId !== undefined ? String(airbnbId) : null,
        String(pick(item, ["title", "name", "listing_name"]) ?? `Listing ${airroiId}`),
        area,
        num(pick(item, ["latitude", "lat"])),
        num(pick(item, ["longitude", "lng", "lon"])),
        mapPropertyType(pick(item, ["property_type", "room_type", "propertyType"])),
        maxGuests,
        num(pick(item, ["bedrooms", "bedroom_count"])) ?? 1,
        num(pick(item, ["bathrooms", "bathroom_count"])),
        num(pick(item, ["rating", "review_score", "overall_rating", "star_rating"])),
        num(pick(item, ["reviews_count", "number_of_reviews", "reviews", "review_count"])) ?? 0,
        String(
          pick(item, ["url", "listing_url"]) ??
            (airbnbId !== undefined ? `https://www.airbnb.com/rooms/${airbnbId}` : ""),
        ),
      ],
    });
    recordsFetched += 1;

    // 2. 今後365日の料金・空室カレンダーを取得して増分保存
    try {
      const ratesRes = await airRoiFetch<unknown>(
        `/listings/future/rates?id=${encodeURIComponent(airroiId)}&currency=native`,
      );
      apiCalls += 1;

      const days = firstArray(ratesRes, ["rates", "calendar", "days", "data", "future_rates"]);
      for (const day of days) {
        const date = pick(day, ["date", "day", "calendar_date"]);
        const price = num(pick(day, ["rate", "price", "nightly_rate", "adr", "amount"]));
        if (!date || price === null) continue;
        const availableRaw = pick(day, ["available", "availability", "is_available", "status"]);
        const available =
          typeof availableRaw === "string"
            ? availableRaw.toLowerCase() === "available" || availableRaw === "true"
            : Boolean(availableRaw);
        await db.execute({
          sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(property_id, target_date) DO UPDATE SET
                  price_jpy=excluded.price_jpy, price_per_person=excluded.price_per_person,
                  is_available=excluded.is_available, min_nights=excluded.min_nights,
                  fetched_at=CURRENT_TIMESTAMP`,
          args: [
            `airroi_${airroiId}`,
            String(date).slice(0, 10),
            price,
            price / Math.max(maxGuests, 1),
            available ? 1 : 0,
            num(pick(day, ["min_stay", "min_nights", "minimum_stay", "minimum_nights"])) ?? 1,
          ],
        });
        recordsFetched += 1;
      }
    } catch (err) {
      // 1物件のカレンダー取得失敗で全体を止めない
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
