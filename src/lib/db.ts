import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

/** 環境変数の貼り付けミス (引用符・空白・改行) を吸収する */
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function dbUrl(): string | undefined {
  const url = cleanEnv(process.env.TURSO_DATABASE_URL);
  if (!url) return undefined;
  // https://でも libsqlクライアントは処理できるが、ダッシュボードURLは弾く
  if (url.startsWith("https://app.turso.tech") || url.startsWith("https://api.turso.tech")) {
    console.error("TURSO_DATABASE_URL にダッシュボード/APIのURLが設定されています。libsql://で始まるDatabase URLを設定してください。");
    return undefined;
  }
  return url;
}

export function isDbConfigured(): boolean {
  return Boolean(dbUrl());
}

export function getDb(): Client | null {
  const url = dbUrl();
  if (!url) return null;
  if (!client) {
    client = createClient({
      url,
      authToken: cleanEnv(process.env.TURSO_AUTH_TOKEN),
    });
  }
  return client;
}

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    airroi_id TEXT UNIQUE NOT NULL,
    airbnb_id TEXT,
    title TEXT NOT NULL,
    area TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    property_type TEXT,
    max_guests INTEGER NOT NULL,
    bedrooms INTEGER,
    bathrooms REAL,
    rating REAL,
    reviews_count INTEGER,
    url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS daily_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_id TEXT NOT NULL,
    target_date DATE NOT NULL,
    price_jpy REAL NOT NULL,
    price_per_person REAL,
    is_available BOOLEAN NOT NULL,
    min_nights INTEGER DEFAULT 1,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (property_id) REFERENCES properties(id),
    UNIQUE(property_id, target_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(target_date)`,
  `CREATE TABLE IF NOT EXISTS area_monthly_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    area TEXT NOT NULL,
    year_month TEXT NOT NULL,
    property_type TEXT,
    avg_adr_jpy REAL,
    avg_occupancy_rate REAL,
    revpar_jpy REAL,
    total_properties_tracked INTEGER,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(area, year_month, property_type)
  )`,
  `CREATE TABLE IF NOT EXISTS lumina_fuji_metrics (
    target_date DATE PRIMARY KEY,
    configured_price REAL NOT NULL,
    is_booked BOOLEAN DEFAULT 0,
    actual_revenue REAL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type TEXT NOT NULL,
    records_fetched INTEGER,
    api_calls_count INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
];

export async function ensureSchema(db: Client): Promise<void> {
  for (const sql of SCHEMA_SQL) {
    await db.execute(sql);
  }
  // 増分マイグレーション: 物件別の料金カレンダー最終取得時刻 (増分同期のコスト管理に使用)
  try {
    await db.execute("ALTER TABLE properties ADD COLUMN rates_synced_at DATETIME");
    // 列を今追加できた場合のみ、既存データから初期値をバックフィルする
    await db.execute(
      `UPDATE properties SET rates_synced_at =
         (SELECT MAX(fetched_at) FROM daily_metrics WHERE property_id = properties.id)`,
    );
    await db.execute(
      `INSERT OR IGNORE INTO sync_state (key, value)
         SELECT 'catalog:' || area, datetime('now') FROM properties GROUP BY area`,
    );
  } catch {
    // 列が既に存在する場合は何もしない
  }
}
