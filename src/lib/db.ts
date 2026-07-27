import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL);
}

export function getDb(): Client | null {
  if (!isDbConfigured()) return null;
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
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
];

export async function ensureSchema(db: Client): Promise<void> {
  for (const sql of SCHEMA_SQL) {
    await db.execute(sql);
  }
}
