import type { Client } from "@libsql/client";

/**
 * データ取得設定 (Webアプリの設定画面 → sync_state の config:* キー) の読み書き。
 * airroi.ts から切り出した葉モジュール (@libsql/client の型以外を import しない)。
 * プライシング (src/lib/pricing/load.ts) から airroi.ts を経由せずに使うため。
 * airroi.ts は既存の import を壊さないよう再エクスポートしている。
 */

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

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
  // 競合分析(勝ちパターン比較)用の自物件スペック (null/空=未設定)
  luminaRating: number | null; // 評価 (★)
  luminaReviews: number | null; // レビュー数
  luminaPhotos: number | null; // 写真枚数
  luminaSuperhost: boolean | null; // スーパーホストか
  luminaAmenities: string[]; // 保有設備 (カンマ区切りで保存)
  kpiCards: string[]; // マーケット概況の表示カードID (空 = 全て表示)
  tableColumns: string[]; // 競合物件一覧の表示列ID (空 = 既定列)
  // actual=実績ベース(検索実績中心・低コスト) / calendar=全物件カレンダー(現行・高コスト)
  dataMode: "actual" | "calendar";
  ratesSubsetSize: number; // actualモードで future/rates を取得する近似競合の件数
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
    luminaRating: (() => {
      const v = map.get("config:lumina_rating");
      if (v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    luminaReviews: (() => {
      const v = map.get("config:lumina_reviews");
      if (v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    })(),
    luminaPhotos: (() => {
      const v = map.get("config:lumina_photos");
      if (v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    })(),
    luminaSuperhost: (() => {
      const v = map.get("config:lumina_superhost");
      if (v === undefined || v === "") return null;
      return v === "1";
    })(),
    luminaAmenities: (map.get("config:lumina_amenities") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    kpiCards: (map.get("config:kpi_cards") ?? "").split(",").filter(Boolean),
    tableColumns: (map.get("config:table_columns") ?? "").split(",").filter(Boolean),
    dataMode: map.get("config:data_mode") === "calendar" ? "calendar" : "actual",
    ratesSubsetSize: numOr(
      "config:rates_subset_size",
      Number(process.env.AIRROI_RATES_SUBSET_SIZE ?? 40),
    ),
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
  if (config.luminaRating !== undefined)
    entries.push(["config:lumina_rating", config.luminaRating === null ? "" : String(config.luminaRating)]);
  if (config.luminaReviews !== undefined)
    entries.push(["config:lumina_reviews", config.luminaReviews === null ? "" : String(config.luminaReviews)]);
  if (config.luminaPhotos !== undefined)
    entries.push(["config:lumina_photos", config.luminaPhotos === null ? "" : String(config.luminaPhotos)]);
  if (config.luminaSuperhost !== undefined)
    entries.push(["config:lumina_superhost", config.luminaSuperhost === null ? "" : config.luminaSuperhost ? "1" : "0"]);
  if (config.luminaAmenities !== undefined)
    entries.push(["config:lumina_amenities", config.luminaAmenities.join(",")]);
  if (config.kpiCards !== undefined)
    entries.push(["config:kpi_cards", config.kpiCards.join(",")]);
  if (config.tableColumns !== undefined)
    entries.push(["config:table_columns", config.tableColumns.join(",")]);
  if (config.dataMode !== undefined) entries.push(["config:data_mode", config.dataMode]);
  if (config.ratesSubsetSize !== undefined)
    entries.push(["config:rates_subset_size", String(config.ratesSubsetSize)]);
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
