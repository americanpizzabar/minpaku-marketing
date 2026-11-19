import { ensureSchema, getDb, isDbConfigured } from "./db";
import {
  LUMINA_PROFILE,
  generateDemoLuminaMetrics,
  generateDemoMetrics,
  generateDemoProperties,
} from "./demo-data";
import { getOwnCalendarState } from "./lumina-calendar";
import {
  LUMINA_FIELD_META_KEY,
  defaultLuminaListingId,
  parseLuminaFieldMeta,
  type LuminaFieldMeta,
} from "./sync-config";
import type { DailyMetric, LuminaMetric, Property, PropertyType } from "./types";

export interface LuminaProfile {
  maxGuests: number;
  bedrooms: number;
  occupancyOverride: number | null; // %表記。設定画面の稼働率 (AirROI の予約カレンダーが無いときに使用)
  source: "api" | "manual" | "demo"; // 直近の自物件カレンダー取得の結果 (api=成功 / manual=失敗) / demo
  listingId: string | null; // 自物件のAirbnbリスティングID (リンク表示用)
  lat: number | null; // 自物件の緯度 (設定画面で指定, 地図マーカー用)
  lng: number | null;
  /** 自物件カレンダーを AirROI から最後に取得できた日時 (UTC 'YYYY-MM-DD HH:MM:SS')。未取得・デモなら null */
  ratesFetchedAt: string | null;
  /** 設定画面の基準価格 (円/泊)。未設定なら null */
  basePrice: number | null;
  /** 設定値の出所 (手入力 / AirROI) と日時 */
  fieldMeta: LuminaFieldMeta;
}

export interface Dataset {
  properties: Property[];
  metrics: DailyMetric[]; // 指定期間内のみ
  lumina: LuminaMetric[]; // 指定期間内のみ
  luminaPacing: LuminaMetric[]; // 今後60日 (自物件のPacing KPI用)
  pacingMetrics: DailyMetric[]; // 今後60日 (Pacing KPI用、フィルタ済み物件のみで別途絞り込み)
  luminaProfile: LuminaProfile;
  visibleKpiCards: string[]; // 設定画面で選択された表示カードID (空 = 全て)
  visibleTableColumns: string[]; // 競合物件一覧の表示列ID (空 = 既定列)
  dataMode: "actual" | "calendar"; // データ取得モード
  calendarCount: number; // カレンダー(daily_metrics)を保持する物件数
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
    luminaPacing: demo.lumina.filter((m) => inRange(m.targetDate, pacingStart, pacingEnd)),
    pacingMetrics: demo.metrics.filter((m) => inRange(m.targetDate, pacingStart, pacingEnd)),
    luminaProfile: {
      maxGuests: LUMINA_PROFILE.maxGuests,
      bedrooms: LUMINA_PROFILE.bedrooms,
      occupancyOverride: null,
      source: "demo",
      listingId: null,
      lat: null,
      lng: null,
      ratesFetchedAt: null,
      basePrice: null,
      fieldMeta: {},
    },
    visibleKpiCards: [],
    visibleTableColumns: [],
    dataMode: "calendar",
    calendarCount: demo.properties.length,
    dataSource: "demo",
    lastSyncedAt: null,
  };
}

async function loadFromTurso(
  start: string,
  end: string,
  pacingStart: string,
  pacingEnd: string,
): Promise<Dataset> {
  const db = getDb()!;

  // 初回アクセス時にスキーマを自動作成する (migrate実行を不要にする)。
  // ensureSchema は接続ごとにメモ化し、失敗時はメモを消して次回再試行する (一時的な失敗で画面が壊れたままにならない)
  await ensureSchema(db);

  const [propsRes, metricsRes, luminaRes, luminaPacingRes, pacingRes, syncRes, luminaCfgRes, calCountRes] = await Promise.all([
    // details_json は重いため一覧取得では読まない (物件詳細APIでのみ取得)
    db.execute(
      `SELECT id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type,
              max_guests, bedrooms, bathrooms, area_sqm, rating, reviews_count, url,
              cleaning_fee, extra_guest_fee, superhost, instant_book, professional_management,
              guest_favorite, beds, host_name, cover_photo_url,
              l90d_occupancy, l90d_avg_rate, l90d_revpar, l90d_revenue,
              ttm_occupancy, ttm_avg_rate, ttm_revpar, ttm_revenue,
              ttm_avg_length_of_stay, ttm_avg_min_nights
       FROM properties`,
    ),
    db.execute({
      sql: "SELECT property_id, target_date, price_jpy, is_available, min_nights FROM daily_metrics WHERE target_date BETWEEN ? AND ?",
      args: [start, end],
    }),
    db.execute({
      sql: `SELECT ${LUMINA_COLUMNS} FROM lumina_fuji_metrics WHERE target_date BETWEEN ? AND ?`,
      args: [start, end],
    }),
    db.execute({
      sql: `SELECT ${LUMINA_COLUMNS} FROM lumina_fuji_metrics WHERE target_date BETWEEN ? AND ?`,
      args: [pacingStart, pacingEnd],
    }),
    db.execute({
      sql: "SELECT property_id, target_date, price_jpy, is_available, min_nights FROM daily_metrics WHERE target_date BETWEEN ? AND ?",
      args: [pacingStart, pacingEnd],
    }),
    db.execute(
      "SELECT created_at FROM sync_logs WHERE status = 'SUCCESS' ORDER BY created_at DESC LIMIT 1",
    ),
    db.execute(
      "SELECT key, value FROM sync_state WHERE key LIKE 'config:lumina%' OR key IN ('lumina_source') OR key = 'config:kpi_cards' OR key = 'config:table_columns' OR key = 'config:data_mode'",
    ),
    db.execute(
      "SELECT COUNT(DISTINCT property_id) AS c FROM daily_metrics",
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
  // 自社カレンダーの AirROI 取得日時は、保存されている AirROI 由来の行から求める (取得失敗で日付が消えないように)。
  // 別のリスティングで取得した行なら実データとして使わない
  const ownCalendar = await getOwnCalendarState(
    db,
    luminaCfg.get("config:lumina_listing_id")?.trim() || defaultLuminaListingId(),
  );
  const toLumina = (r: Record<string, unknown>): LuminaMetric => {
    const m = toLuminaMetric(r);
    return ownCalendar.foreignListing ? withoutAirroiProvenance(m) : m;
  };

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
      extraGuestFee: r.extra_guest_fee != null ? Number(r.extra_guest_fee) : null,
      superhost: r.superhost != null ? Boolean(Number(r.superhost)) : null,
      instantBook: r.instant_book != null ? Boolean(Number(r.instant_book)) : null,
      professionalManagement:
        r.professional_management != null ? Boolean(Number(r.professional_management)) : null,
      guestFavorite: r.guest_favorite != null ? Boolean(Number(r.guest_favorite)) : null,
      beds: r.beds != null ? Number(r.beds) : null,
      hostName: r.host_name ? String(r.host_name) : null,
      coverPhotoUrl: r.cover_photo_url ? String(r.cover_photo_url) : null,
      l90dOccupancy: r.l90d_occupancy != null ? Number(r.l90d_occupancy) : null,
      l90dAvgRate: r.l90d_avg_rate != null ? Number(r.l90d_avg_rate) : null,
      l90dRevpar: r.l90d_revpar != null ? Number(r.l90d_revpar) : null,
      l90dRevenue: r.l90d_revenue != null ? Number(r.l90d_revenue) : null,
      ttmOccupancy: r.ttm_occupancy != null ? Number(r.ttm_occupancy) : null,
      ttmAvgRate: r.ttm_avg_rate != null ? Number(r.ttm_avg_rate) : null,
      ttmRevpar: r.ttm_revpar != null ? Number(r.ttm_revpar) : null,
      ttmRevenue: r.ttm_revenue != null ? Number(r.ttm_revenue) : null,
      ttmAvgLos: r.ttm_avg_length_of_stay != null ? Number(r.ttm_avg_length_of_stay) : null,
      ttmAvgMinNights: r.ttm_avg_min_nights != null ? Number(r.ttm_avg_min_nights) : null,
    })),
    metrics: metricsRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    lumina: luminaRes.rows.map((r) => toLumina(r as Record<string, unknown>)),
    luminaPacing: luminaPacingRes.rows.map((r) => toLumina(r as Record<string, unknown>)),
    pacingMetrics: pacingRes.rows.map((r) => toMetric(r as Record<string, unknown>)),
    luminaProfile: {
      maxGuests: cfgNum("config:lumina_max_guests") ?? LUMINA_PROFILE.maxGuests,
      bedrooms: cfgNum("config:lumina_bedrooms") ?? LUMINA_PROFILE.bedrooms,
      occupancyOverride: cfgNum("config:lumina_occupancy"),
      source: luminaSource === "api" ? "api" : "manual",
      listingId: luminaCfg.get("config:lumina_listing_id") || null,
      lat: cfgNum("config:lumina_lat"),
      lng: cfgNum("config:lumina_lng"),
      // 表示に使う AirROI 由来の行の最新の取得日時 (無ければ最後に成功した取得)
      ratesFetchedAt: ownCalendar.fetchedAt,
      basePrice: (() => {
        const n = cfgNum("config:lumina_base_price") ?? Number(process.env.LUMINA_BASE_PRICE ?? 0);
        return Number.isFinite(n) && n > 0 ? n : null;
      })(),
      fieldMeta: parseLuminaFieldMeta(luminaCfg.get(LUMINA_FIELD_META_KEY)),
    },
    visibleKpiCards: (luminaCfg.get("config:kpi_cards") ?? "").split(",").filter(Boolean),
    visibleTableColumns: (luminaCfg.get("config:table_columns") ?? "").split(",").filter(Boolean),
    dataMode: luminaCfg.get("config:data_mode") === "calendar" ? "calendar" : "actual",
    calendarCount: Number(calCountRes.rows[0]?.c ?? 0),
    dataSource: "turso",
    lastSyncedAt: syncRes.rows[0] ? String(syncRes.rows[0].created_at) : null,
  };
}

const LUMINA_COLUMNS =
  "target_date, configured_price, is_booked, actual_revenue, price_source, price_observed_at, status_source, fetched_at";

/** 別のリスティングで取得した行: AirROI の価格・予約状況を実データとして使わない (基準価格の行はそのまま) */
export function withoutAirroiProvenance(m: LuminaMetric): LuminaMetric {
  const realPrice = m.priceSource === "airroi";
  return {
    ...m,
    configuredPrice: realPrice ? 0 : m.configuredPrice,
    priceSource: realPrice ? null : m.priceSource,
    priceObservedAt: null,
    isBooked: m.statusSource === "airroi" ? false : m.isBooked,
    statusSource: null,
    fetchedAt: null,
  };
}

/** lumina_fuji_metrics の行 → LuminaMetric (出所の列が想定外の値なら「不明」として扱う) */
export function toLuminaMetric(r: Record<string, unknown>): LuminaMetric {
  const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  const priceSource = str(r.price_source);
  return {
    targetDate: String(r.target_date),
    configuredPrice: Number(r.configured_price) || 0,
    isBooked: Boolean(Number(r.is_booked)),
    actualRevenue: Number(r.actual_revenue ?? 0),
    priceSource: priceSource === "airroi" || priceSource === "base" ? priceSource : null,
    priceObservedAt: str(r.price_observed_at),
    statusSource: str(r.status_source) === "airroi" ? "airroi" : null,
    fetchedAt: str(r.fetched_at),
  };
}
