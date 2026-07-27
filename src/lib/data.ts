import { ensureSchema, getDb, isDbConfigured } from "./db";
import {
  generateDemoLuminaMetrics,
  generateDemoMetrics,
  generateDemoProperties,
} from "./demo-data";
import type { DailyMetric, LuminaMetric, Property, PropertyType } from "./types";

export interface Dataset {
  properties: Property[];
  metrics: DailyMetric[]; // 指定期間内のみ
  lumina: LuminaMetric[]; // 指定期間内のみ
  pacingMetrics: DailyMetric[]; // 今後60日 (Pacing KPI用、フィルタ済み物件のみで別途絞り込み)
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

  const [propsRes, metricsRes, luminaRes, pacingRes, syncRes] = await Promise.all([
    db.execute("SELECT * FROM properties"),
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
  ]);

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
      rating: r.rating !== null ? Number(r.rating) : null,
      reviewsCount: Number(r.reviews_count ?? 0),
      url: r.url ? String(r.url) : null,
    })),
    metrics: metricsRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    lumina: luminaRes.rows.map((r) => ({
      targetDate: String(r.target_date),
      configuredPrice: Number(r.configured_price),
      isBooked: Boolean(Number(r.is_booked)),
      actualRevenue: Number(r.actual_revenue ?? 0),
    })),
    pacingMetrics: pacingRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    dataSource: "turso",
    lastSyncedAt: syncRes.rows[0] ? String(syncRes.rows[0].created_at) : null,
  };
}
