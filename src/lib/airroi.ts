import type { Client, InStatement } from "@libsql/client";
import type { PropertyType } from "./types";
import { COST_PER_RATES_CALL, COST_PER_SEARCH_CALL, saveSyncConfig, type SyncConfig } from "./sync-config";

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

// SyncConfig・getSyncConfig・saveSyncConfig・コスト定数は葉モジュール sync-config.ts へ移動 (既存の import のため再エクスポート)
export { getSyncConfig, saveSyncConfig, COST_PER_SEARCH_CALL, COST_PER_RATES_CALL } from "./sync-config";
export type { SyncConfig } from "./sync-config";

// Vercelの関数実行制限 (300秒) に対する1実行あたりの処理時間上限
const HARD_BUDGET_MS = 200_000;
const CONCURRENCY = 10;

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** AIRROI_API_KEY が設定されているか (未設定のまま呼ぶと取得失敗扱いで取得試行日だけが進んでしまうため、呼び出し前の確認用) */
export function isAirRoiConfigured(): boolean {
  return cleanEnv(process.env.AIRROI_API_KEY) !== undefined;
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

/** エリアの物件カタログを再取得して properties をUPSERTする (料金は取得しない)。
 *  seenIds を渡すと、エリア間で重複する物件を跨いで検知し、
 *  そのページが既知IDのみ (= 他エリアと完全重複) になった時点でページ送りを打ち切る
 *  (山中湖・忍野・富士吉田など半径が重なる円で同じ物件に二重課金するのを防ぐ)。 */
async function refreshAreaCatalog(
  db: Client,
  area: string,
  seenIds?: Set<string>,
): Promise<{ searchCalls: number; listings: number }> {
  const center = AREA_SEARCH[area];
  if (!center) return { searchCalls: 0, listings: 0 };

  const idOf = (raw: Json): string | undefined => {
    const v = pick(flatten(raw), ["listing_id", "id", "listingId"]);
    return v === undefined ? undefined : String(v);
  };

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
    // エリア間重複の打ち切り: このページが既知IDのみなら以降は重複とみなし停止
    if (seenIds) {
      let newInPage = 0;
      for (const raw of page) {
        const id = idOf(raw);
        if (id === undefined) continue;
        if (!seenIds.has(id)) newInPage += 1;
        seenIds.add(id);
      }
      if (newInPage === 0) break;
    }
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
              ttm_avg_min_nights, details_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
              ttm_avg_min_nights=excluded.ttm_avg_min_nights,
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
        num(pick(item, ["ttm_avg_min_nights", "l90d_avg_min_nights"])),
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

/** "YYYY-MM-DD" に n 日加算 (UTC 計算) */
function addDaysIso(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// calendar_snapshots に保存する範囲 (取得日から何日先までか)
const SNAPSHOT_MAX_LEAD_DAYS = 134;

/**
 * 1物件の料金カレンダー (今後365日) を取得してUPSERTする。
 * 取得成功時は同じバッチで calendar_snapshots にも今日 (JST) 付けの履歴を保存する (Pace の差分検知用)。
 */
export async function refreshRatesForProperty(db: Client, p: StaleProp): Promise<number> {
  const stmts: InStatement[] = [];
  let records = 0;
  try {
    const ratesRes = await airRoiGet<FutureRatesResponse>(
      `/listings/future/rates?id=${encodeURIComponent(p.airroiId)}&currency=native`,
    );
    const days = ratesRes.rates ?? [];
    const cap = outlierCapOf(days);
    const snapshotDate = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const snapshotEnd = addDaysIso(snapshotDate, SNAPSHOT_MAX_LEAD_DAYS);
    for (const day of days) {
      if (!day.date) continue;
      const targetDate = String(day.date).slice(0, 10);
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
          targetDate,
          price,
          price / Math.max(p.maxGuests, 1),
          available ? 1 : 0,
          num(day.min_nights) ?? 1,
          // 過去の同期で保存済みの外れ値価格も上限超過なら掃除する
          cap,
          cap,
        ],
      });
      records += 1;
      if (targetDate >= snapshotDate && targetDate <= snapshotEnd) {
        // 同日に再取得したら最新の状態で上書きする
        stmts.push({
          sql: `INSERT OR REPLACE INTO calendar_snapshots (snapshot_date, property_id, target_date, is_available, price_jpy)
                VALUES (?, ?, ?, ?, ?)`,
          args: [snapshotDate, p.id, targetDate, available ? 1 : 0, price],
        });
      }
    }
  } catch (err) {
    // 取得失敗 (掲載終了等) でも rates_synced_at は進め、次周期まで再試行しない
    console.error(`AirROI: 物件 ${p.airroiId} のカレンダー取得に失敗:`, err);
  }
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

/** GET /listings?id=<id> で取得できる自物件スペック (抽出後) */
export interface LuminaSpecFetch {
  rating: number | null;
  reviews: number | null;
  photos: number | null;
  superhost: boolean | null;
  amenities: string[];
  bedrooms: number | null;
  maxGuests: number | null;
  beds: number | null;
  bathrooms: number | null;
  occupancy: number | null; // 0-100
  adr: number | null;
  title: string | null;
}

/**
 * 自物件 (Lumina) を AirROI の単一リスティング詳細エンドポイント
 * `GET /listings?id=<listing_id>` から取得してスペックを抽出する。
 * カタログ検索 (search/radius) と同じ形のリッチデータが返るため、
 * カタログ取り込みと同じ pick/flatten 抽出ロジックを再利用する。
 * リスティングIDが未設定・該当なしの場合は null を返す。
 */
export async function fetchLuminaSpecs(config: SyncConfig): Promise<LuminaSpecFetch | null> {
  const id = config.luminaListingId?.replace(/\D/g, "");
  if (!id) return null;
  const res = await airRoiGet<Json>(`/listings?id=${encodeURIComponent(id)}&currency=native`);

  // レスポンスの包み方 (results 配列 / listing / data / 本体そのもの) を吸収する
  let obj: Json | undefined;
  const arr = (res.results ?? res.listings ?? res.data) as unknown;
  if (Array.isArray(arr)) obj = arr[0] as Json | undefined;
  else if (res.listing && typeof res.listing === "object") obj = res.listing as Json;
  else if (res.data && typeof res.data === "object") obj = res.data as Json;
  else obj = res;
  if (!obj || typeof obj !== "object") return null;

  const flat = flatten(obj);
  const occPct = (v: unknown): number | null => {
    const n = num(v);
    if (n === null) return null;
    return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
  };
  const amenRaw = Array.isArray(flat.amenities) ? (flat.amenities as unknown[]) : [];
  const amenities = [...new Set(amenRaw.map((a) => String(a).trim()).filter(Boolean))];
  const titleRaw = pick(flat, ["listing_name", "title", "name"]);

  return {
    rating: num(pick(flat, ["rating_overall", "rating", "overall_rating", "review_score"])),
    reviews: num(pick(flat, ["num_reviews", "reviews_count", "number_of_reviews", "review_count"])),
    photos: num(pick(flat, ["photos_count", "num_photos", "photo_count", "number_of_photos"])),
    superhost:
      flat.superhost === undefined || flat.superhost === null ? null : Boolean(flat.superhost),
    amenities,
    bedrooms: num(pick(flat, ["bedrooms", "bedroom_count"])),
    maxGuests: num(
      pick(flat, ["person_capacity", "accommodates", "max_guests", "guests", "capacity"]),
    ),
    beds: num(flat.beds),
    bathrooms: num(pick(flat, ["baths", "bathrooms", "bathroom_count"])),
    occupancy: occPct(pick(flat, ["l90d_occupancy", "ttm_occupancy"])),
    adr: num(pick(flat, ["l90d_avg_rate", "ttm_avg_rate"])),
    title: titleRaw != null ? String(titleRaw) : null,
  };
}

/**
 * 自物件スペックを AirROI から取得し config に保存する (勝ちパターン分析・収益ラボ用)。
 * 分析用スペック (評価/レビュー/写真/スーパーホスト/設備) は取得値で上書きし、
 * 物理スペック・稼働率 (寝室/定員/稼働率) は未設定のときだけ補完 (手動入力を尊重)。
 */
export async function refreshLuminaSpecs(
  db: Client,
  config: SyncConfig,
): Promise<{ ok: boolean; fetched: LuminaSpecFetch | null; message: string; notFound?: boolean }> {
  let specs: LuminaSpecFetch | null;
  try {
    specs = await fetchLuminaSpecs(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AirROI: 自物件スペック取得に失敗:", message);
    // AirROIにこの物件が未収録 (404 / not found / not been added) の場合は
    // 手入力での登録を促す、原因が分かるメッセージを返す
    if (/\b404\b|not found|not been added|listing not found/i.test(message)) {
      return {
        ok: false,
        fetched: null,
        notFound: true,
        message: `この物件 (ID: ${config.luminaListingId}) はAirROIにまだ収録されていないため自動取得できません。IDが正しいかご確認のうえ、当面は下記の各項目を手入力で登録してください (AirROIが収録すれば自動取得も使えます)。`,
      };
    }
    return { ok: false, fetched: null, message: `取得に失敗しました: ${message.slice(0, 200)}` };
  }
  if (!specs) {
    return {
      ok: false,
      fetched: null,
      message: "リスティングIDが未設定か、AirROIに該当リスティングが見つかりませんでした。",
    };
  }

  const patch: Partial<SyncConfig> = {};
  if (specs.rating !== null) patch.luminaRating = specs.rating;
  if (specs.reviews !== null) patch.luminaReviews = specs.reviews;
  if (specs.photos !== null) patch.luminaPhotos = specs.photos;
  if (specs.superhost !== null) patch.luminaSuperhost = specs.superhost;
  if (specs.amenities.length > 0) patch.luminaAmenities = specs.amenities;
  // 物理スペック・稼働率は手動入力を優先し、未設定 (0/null) のときのみ補完
  if (specs.bedrooms !== null && !config.luminaBedrooms) patch.luminaBedrooms = specs.bedrooms;
  if (specs.maxGuests !== null && !config.luminaMaxGuests) patch.luminaMaxGuests = specs.maxGuests;
  if (
    specs.occupancy !== null &&
    (config.luminaOccupancy === null || config.luminaOccupancy === undefined)
  ) {
    patch.luminaOccupancy = specs.occupancy;
  }

  await saveSyncConfig(db, patch);

  const filled: string[] = [];
  if (patch.luminaRating !== undefined) filled.push(`評価 ${specs.rating}★`);
  if (patch.luminaReviews !== undefined) filled.push(`レビュー ${specs.reviews}件`);
  if (patch.luminaPhotos !== undefined) filled.push(`写真 ${specs.photos}枚`);
  if (patch.luminaSuperhost !== undefined)
    filled.push(`スーパーホスト ${specs.superhost ? "○" : "×"}`);
  if (patch.luminaAmenities !== undefined) filled.push(`設備 ${specs.amenities.length}件`);
  const message =
    filled.length > 0
      ? `自物件スペックを自動取得しました → ${filled.join(" / ")}`
      : "リスティング詳細は取得できましたが、スペック項目を抽出できませんでした。";
  return { ok: true, fetched: specs, message };
}

/**
 * 増分同期を1ステップ実行する。
 * - カタログが searchRefreshDays より古いエリアを再検索
 * - 自物件 (Lumina Fuji) の料金が古ければ更新
 * - 料金が ratesRefreshDays より古い物件を古い順に更新 (capRemaining 件まで)
 * 時間予算内に終わらなかった分は PARTIAL で返し、呼び出し側がチェーンで継続する。
 */
/**
 * actualモードで future/rates を取得する対象物件のID一覧を返す。
 * 自物件 (Lumina) の緯度経度が設定されていれば距離の近い順、
 * 未設定なら定員が近い順に ratesSubsetSize 件を選ぶ (自物件と比較しやすい競合)。
 */
export async function selectRatesSubsetIds(db: Client, config: SyncConfig): Promise<string[]> {
  const size = Math.max(0, Math.floor(config.ratesSubsetSize));
  if (size === 0) return [];
  let order: string;
  const args: number[] = [];
  if (config.luminaLat !== null && config.luminaLng !== null) {
    // 平面近似の二乗距離 (経度は緯度でスケール補正)
    order = `((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?) * 0.65)`;
    args.push(config.luminaLat, config.luminaLat, config.luminaLng, config.luminaLng);
  } else {
    order = `ABS(max_guests - ?)`;
    args.push(config.luminaMaxGuests);
  }
  const res = await db.execute({
    sql: `SELECT id FROM properties
          WHERE id LIKE 'airroi_%' AND latitude IS NOT NULL
          ORDER BY ${order} ASC LIMIT ?`,
    args: [...args, size],
  });
  return res.rows.map((r) => String(r.id));
}

export async function syncStep(
  db: Client,
  syncType: "cron_daily" | "manual_refresh",
  capRemaining: number | null,
  config: SyncConfig,
  opts: { skipCatalog?: boolean } = {},
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
    //    skipCatalog=true (通常の手動更新) のときはカタログ検索($0.50/回)を一切行わない。
    let staleAreas: string[] = [];
    if (!opts.skipCatalog) {
      const freshRes = await db.execute({
        sql: `SELECT key FROM sync_state WHERE key LIKE 'catalog:%' AND value >= datetime('now', ?)`,
        args: [`-${config.searchRefreshDays} days`],
      });
      const fresh = new Set(freshRes.rows.map((r) => String(r.key).slice("catalog:".length)));
      staleAreas = ALL_AREAS.filter((a) => !fresh.has(a));

      // エリア間で重複する物件を跨いで検知し、重複ページを打ち切って検索回数を削減する
      const seenIds = new Set<string>();
      for (const area of [...staleAreas]) {
        if (Date.now() - startedAt > HARD_BUDGET_MS) break;
        const r = await refreshAreaCatalog(db, area, seenIds);
        searchCalls += r.searchCalls;
        catalogRefreshed.push(area);
        staleAreas = staleAreas.filter((a) => a !== area);
        console.log(`AirROI sync: カタログ更新 ${area} (${r.listings}物件, 検索${r.searchCalls}回)`);
      }
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

      // 2.5 自物件スペックが未取得の間だけ、AirROI収録を待って自動リトライする。
      //     未収録(404)の間の無駄打ちを抑えるため、3日に1回だけ試行する。
      const specsUnset =
        config.luminaRating === null &&
        config.luminaReviews === null &&
        config.luminaPhotos === null &&
        config.luminaSuperhost === null &&
        config.luminaAmenities.length === 0;
      if (specsUnset) {
        const checkedRes = await db.execute(
          "SELECT value FROM sync_state WHERE key = 'lumina_specs_checked_at' AND value >= datetime('now', '-3 days')",
        );
        if (checkedRes.rows.length === 0) {
          try {
            const specResult = await refreshLuminaSpecs(db, config);
            ratesCalls += 1; // /listings 呼び出しのコスト計上
            console.log(
              `AirROI sync: 自物件スペック自動取得 — ${specResult.ok ? "成功" : specResult.notFound ? "AirROI未収録(待機)" : "失敗"}`,
            );
          } catch (err) {
            console.error("AirROI sync: 自物件スペック自動取得に失敗:", err);
          }
          await db.execute({
            sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_specs_checked_at', datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            args: [],
          });
        }
      }
    }

    // 3. 料金カレンダーが古い物件を古い順に更新。
    //    actualモードでは自物件に近い上位N件のみ (コスト削減)。calendarモードは全物件。
    let subsetClause = "";
    const subsetArgs: string[] = [];
    if (config.dataMode === "actual") {
      const subsetIds = await selectRatesSubsetIds(db, config);
      if (subsetIds.length === 0) {
        // 対象0件 = カレンダー取得なし。実績のみで運用
        subsetClause = " AND 0";
      } else {
        subsetClause = ` AND id IN (${subsetIds.map(() => "?").join(",")})`;
        subsetArgs.push(...subsetIds);
      }
    }
    const staleCondition =
      `id LIKE 'airroi_%' AND (rates_synced_at IS NULL OR rates_synced_at < datetime('now', ?))` +
      subsetClause;
    const staleArg = `-${config.ratesRefreshDays} days`;
    while (
      (capRemaining === null || capRemaining > 0) &&
      Date.now() - startedAt < HARD_BUDGET_MS
    ) {
      const limit = capRemaining === null ? CONCURRENCY : Math.min(CONCURRENCY, capRemaining);
      const staleRes = await db.execute({
        sql: `SELECT id, airroi_id, max_guests FROM properties WHERE ${staleCondition} ORDER BY rates_synced_at ASC LIMIT ?`,
        args: [staleArg, ...subsetArgs, limit],
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
      args: [staleArg, ...subsetArgs],
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
