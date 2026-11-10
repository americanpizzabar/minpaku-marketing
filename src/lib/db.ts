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
  // --- ダイナミックプライシング (docs/pricing-module.md の「DBスキーマ」) ---
  `CREATE TABLE IF NOT EXISTS calendar_snapshots (
    snapshot_date TEXT NOT NULL,
    property_id TEXT NOT NULL,
    target_date TEXT NOT NULL,
    is_available INTEGER NOT NULL,
    price_jpy REAL NOT NULL,
    PRIMARY KEY (property_id, snapshot_date, target_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_target ON calendar_snapshots(target_date)`,
  `CREATE INDEX IF NOT EXISTS idx_snapshots_date ON calendar_snapshots(snapshot_date)`,
  `CREATE TABLE IF NOT EXISTS pricing_recommendations (
    generated_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    lead_days INTEGER,
    day_type TEXT,
    day_type_reason TEXT,
    comp_units INTEGER,
    comp_occ REAL,
    comp_occ_adj REAL,
    comp_occ_raw REAL,
    comp_adr REAL,
    remaining_units INTEGER,
    pace_index REAL,
    pace_raw REAL,
    new_bookings INTEGER,
    spike INTEGER,
    base_price REAL,
    delta REAL,
    alpha REAL,
    beta REAL,
    gamma REAL,
    raw_price REAL,
    floor_price REAL,
    ceiling_price REAL,
    recommended_price REAL,
    clamped_by TEXT,
    current_price REAL,
    current_price_source TEXT,
    own_status TEXT,
    change_pct REAL,
    action TEXT,
    signal TEXT,
    PRIMARY KEY (generated_date, target_date)
  )`,
  `CREATE TABLE IF NOT EXISTS pricing_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    notified_at TEXT,
    UNIQUE (generated_date, target_date, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS lumina_bookings (
    target_date TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];

/**
 * 一度きりのバックフィル: 既存の daily_metrics (各物件の最新取得時点の状態) を、その取得日 (JST) の
 * スナップショットとして calendar_snapshots に写す。直近120日に取得した分の、取得日から134日先までに限定。
 */
export const SNAPSHOT_BACKFILL_SQL = `INSERT OR IGNORE INTO calendar_snapshots (snapshot_date, property_id, target_date, is_available, price_jpy)
  SELECT date(fetched_at, '+9 hours'), property_id, target_date, is_available,
         CASE WHEN is_available THEN price_jpy ELSE 0 END
  FROM daily_metrics
  WHERE date(fetched_at, '+9 hours') >= date('now', '+9 hours', '-120 days')
    AND target_date BETWEEN date(fetched_at, '+9 hours') AND date(fetched_at, '+9 hours', '+134 days')`;

// 増分マイグレーションで properties に追加する列 (存在すればスキップ)
const PROPERTY_EXTRA_COLUMNS: [string, string][] = [
  ["area_sqm", "REAL"],
  ["cleaning_fee", "REAL"],
  ["extra_guest_fee", "REAL"],
  ["superhost", "INTEGER"],
  ["instant_book", "INTEGER"],
  ["professional_management", "INTEGER"],
  ["guest_favorite", "INTEGER"],
  ["beds", "INTEGER"],
  ["host_name", "TEXT"],
  ["cover_photo_url", "TEXT"],
  ["l90d_occupancy", "REAL"],
  ["l90d_avg_rate", "REAL"],
  ["l90d_revpar", "REAL"],
  ["l90d_revenue", "REAL"],
  ["ttm_occupancy", "REAL"],
  ["ttm_avg_rate", "REAL"],
  ["ttm_revpar", "REAL"],
  ["ttm_revenue", "REAL"],
  ["ttm_avg_length_of_stay", "REAL"],
  ["ttm_avg_min_nights", "REAL"],
  ["details_json", "TEXT"],
];

// Client ごとに1回だけスキーマ作成・マイグレーションを行う (各リクエストで呼ばれても安価にするため)
const schemaPromises = new WeakMap<Client, Promise<void>>();

/**
 * スキーマ作成と増分マイグレーション。プロセス内で Client ごとに1回だけ実行する (メモ化)。
 * 失敗した場合はメモを破棄し、次回の呼び出しで再試行する。
 */
export function ensureSchema(db: Client): Promise<void> {
  let p = schemaPromises.get(db);
  if (!p) {
    p = runSchemaMigrations(db).catch((err: unknown) => {
      schemaPromises.delete(db);
      throw err;
    });
    schemaPromises.set(db, p);
  }
  return p;
}

async function runSchemaMigrations(db: Client): Promise<void> {
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
  for (const [name, type] of PROPERTY_EXTRA_COLUMNS) {
    try {
      await db.execute(`ALTER TABLE properties ADD COLUMN ${name} ${type}`);
    } catch {
      // 列が既に存在する場合は何もしない
    }
  }
  // 一度きり: 全物件の同期時刻が同一だと更新周期後に一斉失効するため、
  // 時刻をランダムに過去へ散らして日々の更新件数 (=APIコスト) を平準化する
  const staggered = await db.execute(
    "SELECT value FROM sync_state WHERE key = 'migration:stagger-rates'",
  );
  if (staggered.rows.length === 0) {
    await db.execute(
      `UPDATE properties SET rates_synced_at = datetime('now', '-' || (ABS(RANDOM()) % 14) || ' days')
       WHERE rates_synced_at IS NOT NULL`,
    );
    await db.execute(
      "INSERT INTO sync_state (key, value) VALUES ('migration:stagger-rates', datetime('now'))",
    );
  }
  // 一度きり: 既存の料金カレンダーをスナップショット履歴の初期値として写す (成功後にフラグを立てる)
  const backfilled = await db.execute(
    "SELECT value FROM sync_state WHERE key = 'migration:snapshot-backfill'",
  );
  if (backfilled.rows.length === 0) {
    await db.execute(SNAPSHOT_BACKFILL_SQL);
    await db.execute(
      `INSERT INTO sync_state (key, value) VALUES ('migration:snapshot-backfill', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
  }
}
