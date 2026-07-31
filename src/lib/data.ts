import { ensureSchema, getDb, isDbConfigured } from "./db";
import {
  LUMINA_PROFILE,
  generateDemoLuminaMetrics,
  generateDemoMetrics,
  generateDemoProperties,
} from "./demo-data";
import type { DailyMetric, LuminaMetric, Property, PropertyType } from "./types";

export interface LuminaProfile {
  maxGuests: number;
  bedrooms: number;
  occupancyOverride: number | null; // %表記。API未収録時に設定画面の値を使用
  source: "api" | "manual" | "demo"; // luminaメトリクスの出所
  listingId: string | null; // 自物件のAirbnbリスティングID (リンク表示用)
  lat: number | null; // 自物件の緯度 (設定画面で指定, 地図マーカー用)
  lng: number | null;
}

export interface Dataset {
  properties: Property[];
  metrics: DailyMetric[]; // 指定期間内のみ
  lumina: LuminaMetric[]; // 指定期間内のみ
  pacingMetrics: DailyMetric[]; // 今後60日 (Pacing KPI用、フィルタ済み物件のみで別途絞り込み)
  luminaProfile: LuminaProfile;
  dataSource: "turso" | "demo";
  lastSyncedAt: string | null;
}

let demoCache: {
  properties: Property[];
  metrics: DailyMetric[];
  lumina: LuminaMetric[];
  day: string;
} | null = null;

function getDemoDataset() {
  const day = new Date().toISOString().slice(0, 10);
  if (!demoCache || demoCache.day !== day) {
    const properties = generateDemoProperties();
    demoCache = {
      properties,
      metrics: generateDemoMetrics(properties),
      lumina: generateDemoLuminaMetrics(),
      day,
    };
  }
  return demoCache;
}

/**
 * 期間内の全データを取得する。
 * Turso DBが設定されていればDBから、なければ決定的デモデータから返す。
 */
export async function loadDataset(
  start: string,
  end: string,
  pacingStart: string,
  pacingEnd: string,
): Promise<Dataset> {
  if (isDbConfigured()) {
    try {
      return await loadFromTurso(start, end, pacingStart, pacingEnd);
    } catch (err) {
      console.error("Turso読み込みに失敗したためデモデータへフォールバックします:", err);
    }
  }
  const demo = getDemoDataset();
  const inRange = (d: string, s: string, e: string) => d >= s && d <= e;
  return {
    properties: demo.properties,
    metrics: demo.metrics.filter((m) => inRange(m.targetDate, start, end)),
    lumina: demo.lumina.filter((m) => inRange(m.targetDate, start, end)),
    pacingMetrics: demo.metrics.filter((m) => inRange(m.targetDate, pacingStart, pacingEnd)),
    luminaProfile: {
      maxGuests: LUMINA_PROFILE.maxGuests,
      bedrooms: LUMINA_PROFILE.bedrooms,
      occupancyOverride: null,
      source: "demo",
      listingId: null,
      lat: null,
      lng: null,
    },
    dataSource: "demo",
    lastSyncedAt: null,
  };
}

let schemaReady: Promise<void> | null = null;

async function loadFromTurso(
  start: string,
  end: string,
  pacingStart: string,
  pacingEnd: string,
): Promise<Dataset> {
  const db = getDb()!;

  // 初回アクセス時にスキーマを自動作成する (migrate実行を不要にする)
  if (!schemaReady) schemaReady = ensureSchema(db);
  await schemaReady;

  const [propsRes, metricsRes, luminaRes, pacingRes, syncRes, luminaCfgRes] = await Promise.all([
    // details_json は重いため一覧取得では読まない (物件詳細APIでのみ取得)
    db.execute(
      `SELECT id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type,
              max_guests, bedrooms, bathrooms, area_sqm, rating, reviews_count, url,
              cleaning_fee, superhost, instant_book, guest_favorite, beds, host_name,
              l90d_occupancy, l90d_avg_rate, l90d_revpar,
              ttm_occupancy, ttm_avg_rate, ttm_revpar, ttm_avg_length_of_stay
       FROM properties`,
    ),
    db.execute({
      sql: "SELECT property_id, target_date, price_jpy, is_available, min_nights FROM daily_metrics WHERE target_date BETWEEN ? AND ?",
      args: [start, end],
    }),
    db.execute({
      sql: "SELECT target_date, configured_price, is_booked, actual_revenue FROM lumina_fuji_metrics WHERE target_date BETWEEN ? AND ?",
      args: [start, end],
    }),
    db.execute({
      sql: "SELECT property_id, target_date, price_jpy, is_available, min_nights FROM daily_metrics WHERE target_date BETWEEN ? AND ?",
      args: [pacingStart, pacingEnd],
    }),
    db.execute(
      "SELECT created_at FROM sync_logs WHERE status = 'SUCCESS' ORDER BY created_at DESC LIMIT 1",
    ),
    db.execute(
      "SELECT key, value FROM sync_state WHERE key LIKE 'config:lumina%' OR key = 'lumina_source'",
    ),
  ]);

  const luminaCfg = new Map(
    luminaCfgRes.rows.map((r) => [String(r.key), String(r.value ?? "")]),
  );
  const cfgNum = (key: string): number | null => {
    const v = luminaCfg.get(key);
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const luminaSource = luminaCfg.get("lumina_source");

  const toMetric = (r: Record<string, unknown>): DailyMetric => ({
    propertyId: String(r.property_id),
    targetDate: String(r.target_date),
    priceJpy: Number(r.price_jpy),
    isAvailable: Boolean(Number(r.is_available)),
    minNights: Number(r.min_nights ?? 1),
  });

  return {
    properties: propsRes.rows.map((r) => ({
      id: String(r.id),
      airroiId: String(r.airroi_id),
      airbnbId: r.airbnb_id ? String(r.airbnb_id) : null,
      title: String(r.title),
      area: String(r.area),
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
      propertyType: (r.property_type ?? "house") as PropertyType,
      maxGuests: Number(r.max_guests),
      bedrooms: Number(r.bedrooms ?? 1),
      bathrooms: r.bathrooms !== null ? Number(r.bathrooms) : null,
      areaSqm: r.area_sqm !== null && r.area_sqm !== undefined ? Number(r.area_sqm) : null,
      rating: r.rating !== null ? Number(r.rating) : null,
      reviewsCount: Number(r.reviews_count ?? 0),
      url: r.url ? String(r.url) : null,
      cleaningFee: r.cleaning_fee != null ? Number(r.cleaning_fee) : null,
      superhost: r.superhost != null ? Boolean(Number(r.superhost)) : null,
      instantBook: r.instant_book != null ? Boolean(Number(r.instant_book)) : null,
      guestFavorite: r.guest_favorite != null ? Boolean(Number(r.guest_favorite)) : null,
      beds: r.beds != null ? Number(r.beds) : null,
      hostName: r.host_name ? String(r.host_name) : null,
      l90dOccupancy: r.l90d_occupancy != null ? Number(r.l90d_occupancy) : null,
      l90dAvgRate: r.l90d_avg_rate != null ? Number(r.l90d_avg_rate) : null,
      l90dRevpar: r.l90d_revpar != null ? Number(r.l90d_revpar) : null,
      ttmOccupancy: r.ttm_occupancy != null ? Number(r.ttm_occupancy) : null,
      ttmAvgRate: r.ttm_avg_rate != null ? Number(r.ttm_avg_rate) : null,
      ttmRevpar: r.ttm_revpar != null ? Number(r.ttm_revpar) : null,
      ttmAvgLos: r.ttm_avg_length_of_stay != null ? Number(r.ttm_avg_length_of_stay) : null,
    })),
    metrics: metricsRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    lumina: luminaRes.rows.map((r) => ({
      targetDate: String(r.target_date),
      configuredPrice: Number(r.configured_price),
      isBooked: Boolean(Number(r.is_booked)),
      actualRevenue: Number(r.actual_revenue ?? 0),
    })),
    pacingMetrics: pacingRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    luminaProfile: {
      maxGuests: cfgNum("config:lumina_max_guests") ?? LUMINA_PROFILE.maxGuests,
      bedrooms: cfgNum("config:lumina_bedrooms") ?? LUMINA_PROFILE.bedrooms,
      occupancyOverride: cfgNum("config:lumina_occupancy"),
      source: luminaSource === "api" ? "api" : "manual",
      listingId: luminaCfg.get("config:lumina_listing_id") || null,
      lat: cfgNum("config:lumina_lat"),
      lng: cfgNum("config:lumina_lng"),
    },
    dataSource: "turso",
    lastSyncedAt: syncRes.rows[0] ? String(syncRes.rows[0].created_at) : null,
  };
}
