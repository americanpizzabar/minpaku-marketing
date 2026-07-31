import type { Client, InStatement } from "@libsql/client";
import type { PropertyType } from "./types";

/**
 * AirROI API クライアント (実機検証済みの仕様)
 * - ベースURL: https://api.airroi.com
 * - 認証: x-api-key ヘッダ
 * - エリア検索: POST /listings/search/radius ($0.50/コール, pageSize最大10)
 * - 日別料金/空室: GET /listings/future/rates?id=<listing_id>&currency=native ($0.10/コール)
 *
 * Pay-per-call のため、同期は増分方式:
 * - 物件カタログ (エリア検索) は SEARCH_REFRESH_DAYS ごとにのみ再取得
 * - 料金カレンダーは物件ごとに RATES_REFRESH_DAYS 経過したものだけ、
 *   1回の同期あたり DAILY_RATES_CALLS 件を上限に更新 (古い順)
 */
const BASE_URL = (process.env.AIRROI_API_BASE_URL ?? "https://api.airroi.com").replace(/\/$/, "");

const AREA_SEARCH: Record<string, { lat: number; lng: number }> = {
  山中湖村: { lat: 35.4167, lng: 138.8667 },
  富士吉田市: { lat: 35.4874, lng: 138.8077 },
  富士河口湖町: { lat: 35.4972, lng: 138.755 },
  鳴沢村: { lat: 35.4763, lng: 138.7047 },
  忍野村: { lat: 35.46, lng: 138.845 },
};

export const ALL_AREAS = Object.keys(AREA_SEARCH);

const RADIUS_MILES = Number(process.env.AIRROI_RADIUS_MILES ?? 3);
const MAX_LISTINGS_PER_AREA = Number(process.env.AIRROI_MAX_LISTINGS_PER_AREA ?? 100);
const PAGE_SIZE = 10; // 検索APIの上限

// コスト管理ノブの既定値 (環境変数 → Webアプリの設定画面 (sync_state) の順で上書き)
const DEFAULT_SEARCH_REFRESH_DAYS = Number(process.env.AIRROI_SEARCH_REFRESH_DAYS ?? 30);
const DEFAULT_RATES_REFRESH_DAYS = Number(process.env.AIRROI_RATES_REFRESH_DAYS ?? 14);
const DEFAULT_DAILY_RATES_CALLS = Number(process.env.AIRROI_DAILY_RATES_CALLS ?? 40);
const DEFAULT_LUMINA_LISTING_ID = cleanEnv(process.env.LUMINA_LISTING_ID) ?? "1628678015262671191";

export interface SyncConfig {
  autoSync: boolean; // Vercel Cron による日次自動同期の有効/無効
  searchRefreshDays: number;
  ratesRefreshDays: number;
  dailyRatesCalls: number; // 0 = 自動同期での料金取得なし
  luminaListingId: string; // 自物件 (ベンチマーク対象) のAirbnbリスティングID
  luminaBasePrice: number; // 自物件がAirROI未収録の場合に使う基準価格 (円/泊, 0=未設定)
  luminaBedrooms: number; // 自物件の寝室数 (API未収録時の表示用)
  luminaMaxGuests: number; // 自物件の定員 (API未収録時の表示用)
  luminaOccupancy: number | null; // 自物件の稼働率 (%表記, API未収録時に使用, null=未設定)
  luminaLat: number | null; // 自物件の緯度 (地図マーカー位置, null=未設定)
  luminaLng: number | null; // 自物件の経度
}

/** Webアプリの設定画面で保存された値 (sync_state) を環境変数既定値とマージして返す */
export async function getSyncConfig(db: Client): Promise<SyncConfig> {
  const res = await db.execute("SELECT key, value FROM sync_state WHERE key LIKE 'config:%'");
  const map = new Map(res.rows.map((r) => [String(r.key), String(r.value ?? "")]));
  const numOr = (key: string, fallback: number) => {
    const v = map.get(key);
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    autoSync: (map.get("config:auto_sync") ?? "1") !== "0",
    searchRefreshDays: numOr("config:search_refresh_days", DEFAULT_SEARCH_REFRESH_DAYS),
    ratesRefreshDays: numOr("config:rates_refresh_days", DEFAULT_RATES_REFRESH_DAYS),
    dailyRatesCalls: numOr("config:daily_rates_calls", DEFAULT_DAILY_RATES_CALLS),
    luminaListingId: map.get("config:lumina_listing_id")?.trim() || DEFAULT_LUMINA_LISTING_ID,
    luminaBasePrice: numOr("config:lumina_base_price", Number(process.env.LUMINA_BASE_PRICE ?? 0)),
    luminaBedrooms: numOr("config:lumina_bedrooms", 4),
    luminaMaxGuests: numOr("config:lumina_max_guests", 10),
    luminaOccupancy: (() => {
      const v = map.get("config:lumina_occupancy");
      if (v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
    })(),
    luminaLat: (() => {
      const n = Number(map.get("config:lumina_lat"));
      return Number.isFinite(n) && n !== 0 ? n : null;
    })(),
    luminaLng: (() => {
      const n = Number(map.get("config:lumina_lng"));
      return Number.isFinite(n) && n !== 0 ? n : null;
    })(),
  };
}

export async function saveSyncConfig(db: Client, config: Partial<SyncConfig>): Promise<void> {
  const entries: [string, string][] = [];
  if (config.autoSync !== undefined) entries.push(["config:auto_sync", config.autoSync ? "1" : "0"]);
  if (config.searchRefreshDays !== undefined)
    entries.push(["config:search_refresh_days", String(config.searchRefreshDays)]);
  if (config.ratesRefreshDays !== undefined)
    entries.push(["config:rates_refresh_days", String(config.ratesRefreshDays)]);
  if (config.dailyRatesCalls !== undefined)
    entries.push(["config:daily_rates_calls", String(config.dailyRatesCalls)]);
  if (config.luminaListingId !== undefined)
    entries.push(["config:lumina_listing_id", config.luminaListingId.trim()]);
  if (config.luminaBasePrice !== undefined)
    entries.push(["config:lumina_base_price", String(config.luminaBasePrice)]);
  if (config.luminaBedrooms !== undefined)
    entries.push(["config:lumina_bedrooms", String(config.luminaBedrooms)]);
  if (config.luminaMaxGuests !== undefined)
    entries.push(["config:lumina_max_guests", String(config.luminaMaxGuests)]);
  if (config.luminaOccupancy !== undefined)
    entries.push(["config:lumina_occupancy", config.luminaOccupancy === null ? "" : String(config.luminaOccupancy)]);
  if (config.luminaLat !== undefined)
    entries.push(["config:lumina_lat", config.luminaLat === null ? "" : String(config.luminaLat)]);
  if (config.luminaLng !== undefined)
    entries.push(["config:lumina_lng", config.luminaLng === null ? "" : String(config.luminaLng)]);
  for (const [key, value] of entries) {
    await db.execute({
      sql: `INSERT INTO sync_state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      args: [key, value],
    });
  }
}

export const COST_PER_SEARCH_CALL = 0.5; // USD
export const COST_PER_RATES_CALL = 0.1; // USD

// Vercelの関数実行制限 (300秒) に対する1実行あたりの処理時間上限
const HARD_BUDGET_MS = 200_000;
const CONCURRENCY = 10;

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

/**
 * listing_id は18〜19桁で Number.MAX_SAFE_INTEGER (約9.0e15) を超えるため、
 * 通常の JSON.parse では末尾が丸められ「存在しないID」になってしまう。
 * 16桁以上の整数リテラルを文字列に変換してからパースする。
 */
function parseJsonSafe<T>(text: string): T {
  const quoted = text.replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted) as T;
}

async function airRoiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-api-key": apiKeyOrThrow(), Accept: "application/json" },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (GET ${path}) ${text.slice(0, 300)}`);
  }
  return parseJsonSafe<T>(text);
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
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`AirROI API Error: ${res.status} ${res.statusText} (POST ${path}) ${text.slice(0, 300)}`);
  }
  return parseJsonSafe<T>(text);
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
  rates?: { date?: string; available?: unknown; rate?: unknown; min_nights?: unknown }[];
}

/** エリアの物件カタログを再取得して properties をUPSERTする (料金は取得しない) */
async function refreshAreaCatalog(
  db: Client,
  area: string,
): Promise<{ searchCalls: number; listings: number }> {
  const center = AREA_SEARCH[area];
  if (!center) return { searchCalls: 0, listings: 0 };

  let searchCalls = 0;
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
    searchCalls += 1;
    totalCount = num(res.pagination?.total_count) ?? 0;
    const page = res.results ?? [];
    if (page.length === 0) break;
    collected.push(...page);
    offset += PAGE_SIZE;
  }

  const stmts: InStatement[] = [];
  for (const raw of collected.slice(0, MAX_LISTINGS_PER_AREA)) {
    const item = flatten(raw);
    const rawId = pick(item, ["listing_id", "id", "listingId"]);
    if (rawId === undefined) continue;
    const airroiId = String(rawId);
    const maxGuests =
      num(pick(item, ["person_capacity", "accommodates", "max_guests", "guests", "guest_limit", "capacity"])) ?? 1;
    // 部屋面積: m²系のフィールドを優先し、平方フィートしか無ければ換算する
    let areaSqm = num(
      pick(item, ["area_sqm", "square_meters", "sqm", "m2", "listing_size_sqm", "unit_size"]),
    );
    if (areaSqm === null) {
      const sqft = num(pick(item, ["square_feet", "sq_ft", "sqft", "listing_size"]));
      if (sqft !== null && sqft > 0) areaSqm = Math.round(sqft * 0.092903 * 10) / 10;
    }
    // 稼働率は 0-1 / 0-100 のどちらで返っても %表記 (0-100) に正規化する
    const occPct = (v: unknown): number | null => {
      const n = num(v);
      if (n === null) return null;
      return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
    };
    const bool01 = (v: unknown): number | null =>
      v === undefined || v === null ? null : v ? 1 : 0;
    stmts.push({
      sql: `INSERT INTO properties (
              id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type,
              max_guests, bedrooms, bathrooms, area_sqm, rating, reviews_count, url,
              cleaning_fee, extra_guest_fee, superhost, instant_book, professional_management,
              guest_favorite, beds, host_name, cover_photo_url,
              l90d_occupancy, l90d_avg_rate, l90d_revpar, l90d_revenue,
              ttm_occupancy, ttm_avg_rate, ttm_revpar, ttm_revenue, ttm_avg_length_of_stay,
              details_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              title=excluded.title, rating=excluded.rating, reviews_count=excluded.reviews_count,
              max_guests=excluded.max_guests, bedrooms=excluded.bedrooms,
              area_sqm=COALESCE(excluded.area_sqm, properties.area_sqm),
              cleaning_fee=excluded.cleaning_fee, extra_guest_fee=excluded.extra_guest_fee,
              superhost=excluded.superhost, instant_book=excluded.instant_book,
              professional_management=excluded.professional_management,
              guest_favorite=excluded.guest_favorite, beds=excluded.beds,
              host_name=excluded.host_name, cover_photo_url=excluded.cover_photo_url,
              l90d_occupancy=excluded.l90d_occupancy, l90d_avg_rate=excluded.l90d_avg_rate,
              l90d_revpar=excluded.l90d_revpar, l90d_revenue=excluded.l90d_revenue,
              ttm_occupancy=excluded.ttm_occupancy, ttm_avg_rate=excluded.ttm_avg_rate,
              ttm_revpar=excluded.ttm_revpar, ttm_revenue=excluded.ttm_revenue,
              ttm_avg_length_of_stay=excluded.ttm_avg_length_of_stay,
              details_json=excluded.details_json,
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
        num(pick(item, ["baths", "bathrooms", "bathroom_count"])),
        areaSqm,
        num(pick(item, ["rating_overall", "rating", "overall_rating", "review_score"])),
        num(pick(item, ["num_reviews", "reviews_count", "number_of_reviews", "review_count"])) ?? 0,
        `https://www.airbnb.com/rooms/${airroiId}`,
        num(item.cleaning_fee),
        num(item.extra_guest_fee),
        bool01(item.superhost),
        bool01(item.instant_book),
        bool01(item.professional_management),
        bool01(item.guest_favorite),
        num(item.beds),
        item.host_name != null ? String(item.host_name) : null,
        item.cover_photo_url != null ? String(item.cover_photo_url) : null,
        occPct(item.l90d_occupancy),
        num(item.l90d_avg_rate),
        num(item.l90d_revpar),
        num(item.l90d_revenue),
        occPct(item.ttm_occupancy),
        num(item.ttm_avg_rate),
        num(item.ttm_revpar),
        num(item.ttm_revenue),
        num(item.ttm_avg_length_of_stay),
        JSON.stringify(raw),
      ],
    });
  }
  stmts.push({
    sql: `INSERT INTO sync_state (key, value) VALUES (?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [`catalog:${area}`],
  });
  await db.batch(stmts, "write");
  return { searchCalls, listings: stmts.length - 1 };
}

interface StaleProp {
  id: string;
  airroiId: string;
  maxGuests: number;
}

/**
 * 予約可能日の価格から外れ値の上限を求める。
 * ホストが実質ブロック目的で設定する異常高額日 (中央値の8倍超, 例: ¥940万/泊) を
 * 除外するため。下限10万円は安価な物件の正当な繁忙期価格を守るための床。
 */
function outlierCapOf(days: { available?: unknown; rate?: unknown }[]): number {
  const positives = days
    .filter((d) => Boolean(d.available))
    .map((d) => num(d.rate))
    .filter((n): n is number => n !== null && n > 0)
    .sort((a, b) => a - b);
  if (positives.length === 0) return Number.MAX_SAFE_INTEGER;
  const median = positives[Math.floor(positives.length / 2)];
  return Math.max(median * 8, 100_000);
}

/** 1物件の料金カレンダー (今後365日) を取得してUPSERTする */
export async function refreshRatesForProperty(db: Client, p: StaleProp): Promise<number> {
  const stmts: InStatement[] = [];
  try {
    const ratesRes = await airRoiGet<FutureRatesResponse>(
      `/listings/future/rates?id=${encodeURIComponent(p.airroiId)}&currency=native`,
    );
    const days = ratesRes.rates ?? [];
    const cap = outlierCapOf(days);
    for (const day of days) {
      if (!day.date) continue;
      const rawPrice = num(day.rate);
      const available = Boolean(day.available);
      // 予約不可日の rate はAirbnbが返すダミー価格 (数百万円等) のため採用しない。
      // 予約可能日でも外れ値上限 (中央値の8倍) を超える価格はブロック目的とみなし除外。
      // 価格は 0 = 価格情報なしを意味する。
      const price =
        available && rawPrice !== null && rawPrice > 0 && rawPrice <= cap ? rawPrice : 0;
      stmts.push({
        sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(property_id, target_date) DO UPDATE SET
                price_jpy=CASE
                  WHEN excluded.price_jpy > 0 THEN excluded.price_jpy
                  WHEN daily_metrics.price_jpy > ? THEN 0
                  ELSE daily_metrics.price_jpy END,
                price_per_person=CASE
                  WHEN excluded.price_jpy > 0 THEN excluded.price_per_person
                  WHEN daily_metrics.price_jpy > ? THEN 0
                  ELSE daily_metrics.price_per_person END,
                is_available=excluded.is_available, min_nights=excluded.min_nights,
                fetched_at=CURRENT_TIMESTAMP`,
        args: [
          p.id,
          String(day.date).slice(0, 10),
          price,
          price / Math.max(p.maxGuests, 1),
          available ? 1 : 0,
          num(day.min_nights) ?? 1,
          // 過去の同期で保存済みの外れ値価格も上限超過なら掃除する
          cap,
          cap,
        ],
      });
    }
  } catch (err) {
    // 取得失敗 (掲載終了等) でも rates_synced_at は進め、次周期まで再試行しない
    console.error(`AirROI: 物件 ${p.airroiId} のカレンダー取得に失敗:`, err);
  }
  const records = stmts.length;
  stmts.push({
    sql: `UPDATE properties SET rates_synced_at=CURRENT_TIMESTAMP WHERE id=?`,
    args: [p.id],
  });
  await db.batch(stmts, "write");
  return records;
}

export interface SyncStepResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  catalogRefreshed: string[];
  catalogRemaining: string[];
  ratesRefreshed: number;
  ratesRemaining: number;
  searchCalls: number;
  ratesCalls: number;
  apiCalls: number;
  estimatedCostUsd: number;
  recordsFetched: number;
  capRemaining: number | null; // null = 上限なし (reset/force時)
  message?: string;
  error?: string;
}

/**
 * 自物件 (Lumina Fuji) の料金カレンダーを lumina_fuji_metrics に取り込む。
 * AirROI未収録 (404) の場合は、設定された基準価格で今後365日を埋める
 * (実データが取れるようになれば自動的に上書きされる)。
 */
export async function refreshLuminaRates(
  db: Client,
  config: SyncConfig,
): Promise<{ records: number; usedApi: boolean }> {
  const stmts: InStatement[] = [];
  let usedApi = false;
  let source = "api";

  try {
    const ratesRes = await airRoiGet<FutureRatesResponse>(
      `/listings/future/rates?id=${encodeURIComponent(config.luminaListingId)}&currency=native`,
    );
    usedApi = true;
    const luminaCap = outlierCapOf(ratesRes.rates ?? []);
    for (const day of ratesRes.rates ?? []) {
      if (!day.date) continue;
      const rawPrice = num(day.rate);
      const available = Boolean(day.available);
      const price =
        available && rawPrice !== null && rawPrice > 0 && rawPrice <= luminaCap ? rawPrice : 0;
      stmts.push({
        sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked)
              VALUES (?, ?, ?)
              ON CONFLICT(target_date) DO UPDATE SET
                configured_price=CASE WHEN excluded.configured_price > 0 THEN excluded.configured_price ELSE lumina_fuji_metrics.configured_price END,
                is_booked=excluded.is_booked`,
        args: [String(day.date).slice(0, 10), price, available ? 0 : 1],
      });
    }
  } catch (err) {
    usedApi = true; // 404でもコールは消費されている
    source = "manual";
    console.error(`AirROI: Lumina Fuji (${config.luminaListingId}) の料金取得に失敗:`, err);
    if (config.luminaBasePrice > 0) {
      // フォールバック: 基準価格で今後365日を埋める。
      // 前回がAPI実データの場合のみ既存価格を保持し、旧基準価格は新しい値で上書きする。
      const prevSourceRes = await db.execute(
        "SELECT value FROM sync_state WHERE key = 'lumina_source'",
      );
      const prevWasApi = prevSourceRes.rows[0] && String(prevSourceRes.rows[0].value) === "api";
      console.log(`AirROI: 基準価格 ¥${config.luminaBasePrice} でベンチマークを生成します`);
      const today = new Date();
      for (let i = 0; i < 365; i++) {
        const d = new Date(today.getTime() + i * 86400_000);
        stmts.push({
          sql: prevWasApi
            ? `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked)
               VALUES (?, ?, 0)
               ON CONFLICT(target_date) DO UPDATE SET
                 configured_price=CASE WHEN lumina_fuji_metrics.configured_price > 0 THEN lumina_fuji_metrics.configured_price ELSE excluded.configured_price END`
            : `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked)
               VALUES (?, ?, 0)
               ON CONFLICT(target_date) DO UPDATE SET
                 configured_price=excluded.configured_price`,
          args: [d.toISOString().slice(0, 10), config.luminaBasePrice],
        });
      }
    }
  }

  stmts.push({
    sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_rates_at', datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [],
  });
  // データの出所 (api=実データ / manual=基準価格フォールバック) を分析側へ伝える
  stmts.push({
    sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_source', ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [source],
  });
  await db.batch(stmts, "write");
  return { records: stmts.length - 2, usedApi };
}

/**
 * 増分同期を1ステップ実行する。
 * - カタログが searchRefreshDays より古いエリアを再検索
 * - 自物件 (Lumina Fuji) の料金が古ければ更新
 * - 料金が ratesRefreshDays より古い物件を古い順に更新 (capRemaining 件まで)
 * 時間予算内に終わらなかった分は PARTIAL で返し、呼び出し側がチェーンで継続する。
 */
export async function syncStep(
  db: Client,
  syncType: "cron_daily" | "manual_refresh",
  capRemaining: number | null,
  config: SyncConfig,
): Promise<SyncStepResult> {
  const startedAt = Date.now();
  const catalogRefreshed: string[] = [];
  let searchCalls = 0;
  let ratesCalls = 0;
  let ratesRefreshed = 0;
  let recordsFetched = 0;

  const finalize = async (
    status: SyncStepResult["status"],
    catalogRemaining: string[],
    ratesRemaining: number,
    message?: string,
    error?: string,
  ): Promise<SyncStepResult> => {
    const estimatedCostUsd =
      Math.round((searchCalls * COST_PER_SEARCH_CALL + ratesCalls * COST_PER_RATES_CALL) * 100) / 100;
    await db
      .execute({
        sql: `INSERT INTO sync_logs (sync_type, records_fetched, api_calls_count, status, error_message) VALUES (?, ?, ?, ?, ?)`,
        args: [
          syncType,
          recordsFetched,
          searchCalls + ratesCalls,
          status,
          error ?? message ?? null,
        ],
      })
      .catch(() => {});
    console.log(
      `AirROI sync: status=${status} catalog=${catalogRefreshed.join("/") || "-"} rates=${ratesRefreshed}件 残り${ratesRemaining}物件 コスト$${estimatedCostUsd}`,
    );
    return {
      status,
      catalogRefreshed,
      catalogRemaining,
      ratesRefreshed,
      ratesRemaining,
      searchCalls,
      ratesCalls,
      apiCalls: searchCalls + ratesCalls,
      estimatedCostUsd,
      recordsFetched,
      capRemaining,
      message,
      error,
    };
  };

  try {
    // 1. カタログ更新が必要なエリア (sync_state の catalog:<area> が古い/未登録)
    const freshRes = await db.execute({
      sql: `SELECT key FROM sync_state WHERE key LIKE 'catalog:%' AND value >= datetime('now', ?)`,
      args: [`-${config.searchRefreshDays} days`],
    });
    const fresh = new Set(freshRes.rows.map((r) => String(r.key).slice("catalog:".length)));
    let staleAreas = ALL_AREAS.filter((a) => !fresh.has(a));

    for (const area of [...staleAreas]) {
      if (Date.now() - startedAt > HARD_BUDGET_MS) break;
      const r = await refreshAreaCatalog(db, area);
      searchCalls += r.searchCalls;
      catalogRefreshed.push(area);
      staleAreas = staleAreas.filter((a) => a !== area);
      console.log(`AirROI sync: カタログ更新 ${area} (${r.listings}物件, 検索${r.searchCalls}回)`);
    }

    // 2. 自物件 (Lumina Fuji) のベンチマーク用料金 — 競合と同じ周期で更新
    if (config.luminaListingId) {
      const luminaFresh = await db.execute({
        sql: `SELECT 1 FROM sync_state WHERE key = 'lumina_rates_at' AND value >= datetime('now', ?)`,
        args: [`-${config.ratesRefreshDays} days`],
      });
      if (luminaFresh.rows.length === 0) {
        try {
          const r = await refreshLuminaRates(db, config);
          recordsFetched += r.records;
          if (r.usedApi) ratesCalls += 1;
          console.log(`AirROI sync: Lumina Fuji (${config.luminaListingId}) の料金を更新`);
        } catch (err) {
          console.error("AirROI sync: Lumina Fuji の料金更新に失敗:", err);
        }
      }
    }

    // 3. 料金カレンダーが古い物件を古い順に更新
    const staleCondition = `id LIKE 'airroi_%' AND (rates_synced_at IS NULL OR rates_synced_at < datetime('now', ?))`;
    const staleArg = `-${config.ratesRefreshDays} days`;
    while (
      (capRemaining === null || capRemaining > 0) &&
      Date.now() - startedAt < HARD_BUDGET_MS
    ) {
      const limit = capRemaining === null ? CONCURRENCY : Math.min(CONCURRENCY, capRemaining);
      const staleRes = await db.execute({
        sql: `SELECT id, airroi_id, max_guests FROM properties WHERE ${staleCondition} ORDER BY rates_synced_at ASC LIMIT ?`,
        args: [staleArg, limit],
      });
      if (staleRes.rows.length === 0) break;
      const results = await Promise.all(
        staleRes.rows.map((r) =>
          refreshRatesForProperty(db, {
            id: String(r.id),
            airroiId: String(r.airroi_id),
            maxGuests: Number(r.max_guests) || 1,
          }),
        ),
      );
      ratesCalls += staleRes.rows.length;
      ratesRefreshed += staleRes.rows.length;
      recordsFetched += results.reduce((a, b) => a + b, 0);
      if (capRemaining !== null) capRemaining -= staleRes.rows.length;
    }

    // 4. 残作業を数えて状態を決める
    const remainRes = await db.execute({
      sql: `SELECT COUNT(*) AS c FROM properties WHERE ${staleCondition}`,
      args: [staleArg],
    });
    const ratesRemaining = Number(remainRes.rows[0]?.c ?? 0);
    const capExhausted = capRemaining !== null && capRemaining <= 0;
    const workRemains = staleAreas.length > 0 || ratesRemaining > 0;

    if (workRemains && !capExhausted) {
      return finalize("PARTIAL", staleAreas, ratesRemaining, "残り作業をチェーンで継続します");
    }
    const message =
      capExhausted && ratesRemaining > 0
        ? `1回の同期の呼び出し上限 (${config.dailyRatesCalls}件) に達しました。残り${ratesRemaining}物件は次回の同期で更新されます`
        : undefined;
    return finalize("SUCCESS", staleAreas, ratesRemaining, message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finalize("FAILED", [], -1, undefined, message);
  }
}
