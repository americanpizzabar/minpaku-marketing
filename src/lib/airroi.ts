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
    stmts.push({
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

/** 1物件の料金カレンダー (今後365日) を取得してUPSERTする */
async function refreshRatesForProperty(db: Client, p: StaleProp): Promise<number> {
  const stmts: InStatement[] = [];
  try {
    const ratesRes = await airRoiGet<FutureRatesResponse>(
      `/listings/future/rates?id=${encodeURIComponent(p.airroiId)}&currency=native`,
    );
    for (const day of ratesRes.rates ?? []) {
      if (!day.date) continue;
      const rawPrice = num(day.rate);
      const available = Boolean(day.available);
      // 予約不可日の rate はAirbnbが返すダミー価格 (数百万円等) のため採用しない。
      // 価格は「予約可能日の表示価格」のみ保存し、0 は価格情報なしを意味する。
      const price = available && rawPrice !== null && rawPrice > 0 ? rawPrice : 0;
      stmts.push({
        sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(property_id, target_date) DO UPDATE SET
                price_jpy=CASE WHEN excluded.price_jpy > 0 THEN excluded.price_jpy ELSE daily_metrics.price_jpy END,
                price_per_person=CASE WHEN excluded.price_jpy > 0 THEN excluded.price_per_person ELSE daily_metrics.price_per_person END,
                is_available=excluded.is_available, min_nights=excluded.min_nights,
                fetched_at=CURRENT_TIMESTAMP`,
        args: [
          p.id,
          String(day.date).slice(0, 10),
          price,
          price / Math.max(p.maxGuests, 1),
          available ? 1 : 0,
          num(day.min_nights) ?? 1,
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

/** 自物件 (Lumina Fuji) の料金カレンダーを lumina_fuji_metrics に取り込む */
async function refreshLuminaRates(db: Client, listingId: string): Promise<number> {
  const ratesRes = await airRoiGet<FutureRatesResponse>(
    `/listings/future/rates?id=${encodeURIComponent(listingId)}&currency=native`,
  );
  const stmts: InStatement[] = [];
  for (const day of ratesRes.rates ?? []) {
    if (!day.date) continue;
    const rawPrice = num(day.rate);
    const available = Boolean(day.available);
    const price = available && rawPrice !== null && rawPrice > 0 ? rawPrice : 0;
    stmts.push({
      sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked)
            VALUES (?, ?, ?)
            ON CONFLICT(target_date) DO UPDATE SET
              configured_price=CASE WHEN excluded.configured_price > 0 THEN excluded.configured_price ELSE lumina_fuji_metrics.configured_price END,
              is_booked=excluded.is_booked`,
      args: [String(day.date).slice(0, 10), price, available ? 0 : 1],
    });
  }
  stmts.push({
    sql: `INSERT INTO sync_state (key, value) VALUES ('lumina_rates_at', datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    args: [],
  });
  await db.batch(stmts, "write");
  return stmts.length - 1;
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
          recordsFetched += await refreshLuminaRates(db, config.luminaListingId);
          ratesCalls += 1;
          console.log(`AirROI sync: Lumina Fuji (${config.luminaListingId}) の料金を更新`);
        } catch (err) {
          console.error("AirROI sync: Lumina Fuji の料金取得に失敗:", err);
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
