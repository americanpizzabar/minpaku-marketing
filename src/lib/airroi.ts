import type { Client } from "@libsql/client";
import { AREAS } from "./types";

const BASE_URL = process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com/v1";

interface AirRoiListing {
  id: string | number;
  airbnb_id?: string;
  title: string;
  latitude?: number;
  longitude?: number;
  property_type?: string;
  max_guests?: number;
  bedrooms?: number;
  bathrooms?: number;
  rating?: number;
  reviews_count?: number;
  url?: string;
}

interface AirRoiCalendarDay {
  date: string; // YYYY-MM-DD
  price?: number;
  available?: boolean;
  min_nights?: number;
}

export interface SyncResult {
  recordsFetched: number;
  apiCalls: number;
}

async function airRoiFetch<T>(path: string): Promise<T> {
  const apiKey = process.env.AIRROI_API_KEY;
  if (!apiKey) throw new Error("AIRROI_API_KEY が設定されていません");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (${path})`);
  }
  return res.json() as Promise<T>;
}

/**
 * 指定エリアの物件一覧 + カレンダーデータを取得し、Turso DBへUPSERTする。
 * ダッシュボード閲覧時はAirROIを直接呼ばず、必ずこの同期済みデータを参照する。
 */
export async function fetchAndStoreAirRoiData(db: Client, area: string): Promise<SyncResult> {
  let apiCalls = 0;
  let recordsFetched = 0;

  // 1. エリア内の物件一覧を取得
  const data = await airRoiFetch<{ listings: AirRoiListing[] }>(
    `/listings?area=${encodeURIComponent(area)}`,
  );
  apiCalls += 1;

  for (const item of data.listings ?? []) {
    await db.execute({
      sql: `INSERT INTO properties (id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type, max_guests, bedrooms, bathrooms, rating, reviews_count, url, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title, rating=excluded.rating, reviews_count=excluded.reviews_count,
              max_guests=excluded.max_guests, bedrooms=excluded.bedrooms,
              updated_at=CURRENT_TIMESTAMP`,
      args: [
        `airroi_${item.id}`,
        String(item.id),
        item.airbnb_id ?? null,
        item.title,
        area,
        item.latitude ?? null,
        item.longitude ?? null,
        item.property_type ?? "house",
        item.max_guests ?? 1,
        item.bedrooms ?? 1,
        item.bathrooms ?? null,
        item.rating ?? null,
        item.reviews_count ?? 0,
        item.url ?? "",
      ],
    });
    recordsFetched += 1;

    // 2. 物件ごとのカレンダー (日別価格・空室) を取得して増分保存
    const cal = await airRoiFetch<{ calendar: AirRoiCalendarDay[] }>(
      `/listings/${item.id}/calendar`,
    );
    apiCalls += 1;

    for (const day of cal.calendar ?? []) {
      if (!day.date || day.price == null) continue;
      await db.execute({
        sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(property_id, target_date) DO UPDATE SET
                price_jpy=excluded.price_jpy, price_per_person=excluded.price_per_person,
                is_available=excluded.is_available, min_nights=excluded.min_nights,
                fetched_at=CURRENT_TIMESTAMP`,
        args: [
          `airroi_${item.id}`,
          day.date,
          day.price,
          day.price / Math.max(item.max_guests ?? 1, 1),
          day.available ? 1 : 0,
          day.min_nights ?? 1,
        ],
      });
      recordsFetched += 1;
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
    for (const area of AREAS) {
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
