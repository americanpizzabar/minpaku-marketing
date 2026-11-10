/**
 * データ層: db.ts の ensureSchema (新規 DB / 本番と同じ旧スキーマからの移行 / メモ化と失敗時の再試行)。
 * 本番 Turso には旧スキーマ (properties / daily_metrics / lumina_fuji_metrics / sync_logs / sync_state) と
 * 大量の行が既にあるため、移行が冪等でデータを失わず、バックフィルが有界であることを確認する。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { SNAPSHOT_BACKFILL_SQL, ensureSchema } from "../db";

/** 価格モジュール追加前 (ed0687d) の SCHEMA_SQL そのもの */
const OLD_SCHEMA_SQL = [
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

const OLD_EXTRA_COLUMNS = [
  "area_sqm REAL",
  "cleaning_fee REAL",
  "extra_guest_fee REAL",
  "superhost INTEGER",
  "instant_book INTEGER",
  "professional_management INTEGER",
  "guest_favorite INTEGER",
  "beds INTEGER",
  "host_name TEXT",
  "cover_photo_url TEXT",
  "l90d_occupancy REAL",
  "l90d_avg_rate REAL",
  "l90d_revpar REAL",
  "l90d_revenue REAL",
  "ttm_occupancy REAL",
  "ttm_avg_rate REAL",
  "ttm_revpar REAL",
  "ttm_revenue REAL",
  "ttm_avg_length_of_stay REAL",
  "ttm_avg_min_nights REAL",
  "details_json TEXT",
];

const NEW_TABLES = ["calendar_snapshots", "pricing_recommendations", "pricing_alerts", "lumina_bookings"];

function memDb(): Client {
  return createClient({ url: ":memory:" });
}

/**
 * 同じ DB を指す「別の Client」(WeakMap のメモ化キーが異なる = 別プロセス相当)。
 * execute を差し替えて呼び出し回数の計測や失敗の注入ができる。
 */
function aliasClient(
  db: Client,
  execute?: (orig: Client["execute"], stmt: unknown, ...rest: unknown[]) => Promise<unknown>,
): Client {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute" && execute) {
        const orig = target.execute.bind(target) as Client["execute"];
        return (stmt: unknown, ...rest: unknown[]) => execute(orig, stmt, ...rest);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Client;
}

async function tableNames(db: Client): Promise<Set<string>> {
  const res = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(res.rows.map((r) => String(r.name)));
}

async function count(db: Client, sql: string, args: (string | number)[] = []): Promise<number> {
  const res = await db.execute({ sql, args });
  return Number(res.rows[0]?.c ?? 0);
}

async function columns(db: Client, table: string): Promise<Set<string>> {
  const res = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(res.rows.map((r) => String(r.name)));
}

/** 本番と同じ形 (旧 SCHEMA_SQL + 旧増分マイグレーション済み + stagger フラグ) の DB */
async function productionShapedDb(): Promise<Client> {
  const db = memDb();
  for (const sql of OLD_SCHEMA_SQL) await db.execute(sql);
  await db.execute("ALTER TABLE properties ADD COLUMN rates_synced_at DATETIME");
  for (const col of OLD_EXTRA_COLUMNS) await db.execute(`ALTER TABLE properties ADD COLUMN ${col}`);
  await db.execute("INSERT INTO sync_state (key, value) VALUES ('migration:stagger-rates', datetime('now', '-30 days'))");
  await db.execute("INSERT INTO sync_state (key, value) VALUES ('catalog:山中湖村', datetime('now', '-3 days'))");
  await db.execute("INSERT INTO sync_state (key, value) VALUES ('config:daily_rates_calls', '25')");
  return db;
}

/** SQLite の日付計算で「JST の今日 + n 日」 */
async function jstDate(db: Client, n: number): Promise<string> {
  const res = await db.execute({ sql: "SELECT date('now', '+9 hours', ?) AS d", args: [`${n} days`] });
  return String(res.rows[0].d);
}

/**
 * 物件 3件と、取得時刻の異なる daily_metrics:
 * - airroi_1: 150日前 (UTC) に取得 → バックフィル対象外 (120日より古い)
 * - airroi_2: 10日前に取得 → 取得日 (JST) から +134日まで (それより先・取得日より前は対象外)
 * - airroi_3: 今 (CURRENT_TIMESTAMP) 取得
 */
async function seedRows(db: Client): Promise<{ dm: number }> {
  for (const [id, area] of [
    ["airroi_1", "山中湖村"],
    ["airroi_2", "山中湖村"],
    ["airroi_3", "富士河口湖町"],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO properties (id, airroi_id, title, area, latitude, longitude, property_type, max_guests,
              rating, reviews_count, rates_synced_at, details_json, l90d_avg_rate)
            VALUES (?, ?, ?, ?, 35.42, 138.9, 'villa', 8, 4.9, 30, datetime('now', '-2 days'), ?, 100000)`,
      args: [id, id.slice(7), `物件 ${id}`, area, JSON.stringify({ listing_info: { room_type: "entire_home" } })],
    });
  }
  let dm = 0;
  const insert = async (pid: string, fetchedAgo: number, fromOffset: number, toOffset: number) => {
    // fetchedAgo 日前の UTC 時刻 (CURRENT_TIMESTAMP 形式) に取得した、取得日 (JST) 基準 [from, to] の行
    for (let i = fromOffset; i <= toOffset; i++) {
      await db.execute({
        sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
              VALUES (?, date(datetime('now', ?), '+9 hours', ?), ?, ?, ?, 1, datetime('now', ?))`,
        args: [
          pid,
          `-${fetchedAgo} days`,
          `${i} days`,
          i % 3 === 0 ? 0 : 90000 + i,
          (90000 + i) / 8,
          i % 3 === 0 ? 0 : 1,
          `-${fetchedAgo} days`,
        ],
      });
      dm += 1;
    }
  };
  await insert("airroi_1", 150, 0, 200);
  await insert("airroi_2", 10, -5, 200); // 取得日より前の5日と +135日以降は対象外
  await insert("airroi_3", 0, 0, 150);
  return { dm };
}

describe("ensureSchema: 新規 DB", () => {
  it("全テーブル・列・フラグを作成し、2回目の呼び出しも成功する", async () => {
    const db = memDb();
    await ensureSchema(db);
    await ensureSchema(db);
    const tables = await tableNames(db);
    for (const t of [
      "properties",
      "daily_metrics",
      "area_monthly_summaries",
      "lumina_fuji_metrics",
      "sync_logs",
      "sync_state",
      ...NEW_TABLES,
    ]) {
      assert.ok(tables.has(t), `テーブル ${t} がありません`);
    }
    const cols = await columns(db, "properties");
    assert.ok(cols.has("rates_synced_at"));
    assert.ok(cols.has("details_json"));
    assert.ok(cols.has("l90d_avg_rate"));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:snapshot-backfill'"), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:stagger-rates'"), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots"), 0);
  });

  it("別の Client (メモ無し) で再実行しても冪等", async () => {
    const db = memDb();
    await ensureSchema(db);
    await ensureSchema(aliasClient(db));
    await ensureSchema(aliasClient(db));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key LIKE 'migration:%'"), 2);
  });
});

describe("ensureSchema: 本番と同じ旧スキーマからの移行", () => {
  it("データを失わず新テーブルを作り、バックフィルは直近120日の取得分の [取得日, +134日] だけ", async () => {
    const db = await productionShapedDb();
    const { dm } = await seedRows(db);
    const before = await db.execute("SELECT * FROM daily_metrics ORDER BY id");
    const propsBefore = await db.execute("SELECT id, rates_synced_at, details_json FROM properties ORDER BY id");

    await ensureSchema(db);
    await ensureSchema(db); // 同一 Client: メモ化

    const tables = await tableNames(db);
    for (const t of NEW_TABLES) assert.ok(tables.has(t), `テーブル ${t} がありません`);

    // 既存データは変わらない
    const after = await db.execute("SELECT * FROM daily_metrics ORDER BY id");
    assert.equal(after.rows.length, dm);
    assert.deepEqual(after.rows, before.rows);
    const propsAfter = await db.execute("SELECT id, rates_synced_at, details_json FROM properties ORDER BY id");
    assert.deepEqual(propsAfter.rows, propsBefore.rows, "stagger 済みの rates_synced_at を再び散らしてはならない");
    assert.equal(
      await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'config:daily_rates_calls' AND value = '25'"),
      1,
    );

    // バックフィル: airroi_1 (150日前) は無し、airroi_2 は 135日分 (取得日〜+134)、airroi_3 は 0〜150 のうち 135日分
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots WHERE property_id = 'airroi_1'"), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots WHERE property_id = 'airroi_2'"), 135);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots WHERE property_id = 'airroi_3'"), 135);

    const fetched2 = await jstDate(db, -10);
    const today = await jstDate(db, 0);
    const r2 = await db.execute(
      "SELECT MIN(snapshot_date) AS s0, MAX(snapshot_date) AS s1, MIN(target_date) AS t0, MAX(target_date) AS t1 FROM calendar_snapshots WHERE property_id = 'airroi_2'",
    );
    // fetched_at は UTC の「10日前の今」→ JST の日付は 10日前 (JST) と一致
    const s2 = await db.execute(
      "SELECT date(datetime('now', '-10 days'), '+9 hours') AS d",
    );
    assert.equal(String(r2.rows[0].s0), String(s2.rows[0].d));
    assert.equal(String(r2.rows[0].s1), String(s2.rows[0].d));
    assert.equal(String(r2.rows[0].s0), fetched2);
    assert.equal(String(r2.rows[0].t0), fetched2);
    assert.equal(
      String(r2.rows[0].t1),
      String((await db.execute({ sql: "SELECT date(?, '+134 days') AS d", args: [fetched2] })).rows[0].d),
    );
    const r3 = await db.execute(
      "SELECT MIN(snapshot_date) AS s0, MAX(snapshot_date) AS s1, MIN(target_date) AS t0 FROM calendar_snapshots WHERE property_id = 'airroi_3'",
    );
    assert.equal(String(r3.rows[0].s0), today);
    assert.equal(String(r3.rows[0].s1), today);
    assert.equal(String(r3.rows[0].t0), today);

    // 予約不可日の価格は 0、予約可能日は daily_metrics の価格
    assert.equal(
      await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots WHERE is_available = 0 AND price_jpy <> 0"),
      0,
    );
    assert.equal(
      await count(
        db,
        `SELECT COUNT(*) AS c FROM calendar_snapshots s JOIN daily_metrics d
           ON d.property_id = s.property_id AND d.target_date = s.target_date
         WHERE s.is_available = 1 AND s.price_jpy <> d.price_jpy`,
      ),
      0,
    );

    // フラグは成功後に1件
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:snapshot-backfill'"), 1);
  });

  it("別 Client (= 別プロセス) で再実行してもバックフィルを繰り返さず、行も増えない", async () => {
    const db = await productionShapedDb();
    await seedRows(db);
    await ensureSchema(db);
    const n1 = await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots");
    // スナップショットを1行消しても、フラグがあるので再バックフィルされない
    await db.execute("DELETE FROM calendar_snapshots WHERE property_id = 'airroi_2' AND rowid IN (SELECT rowid FROM calendar_snapshots WHERE property_id = 'airroi_2' LIMIT 1)");
    await ensureSchema(aliasClient(db));
    await ensureSchema(aliasClient(db));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots"), n1 - 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:snapshot-backfill'"), 1);
  });

  it("旧 SCHEMA_SQL だけの DB (増分マイグレーション前) からも移行できる", async () => {
    const db = memDb();
    for (const sql of OLD_SCHEMA_SQL) await db.execute(sql);
    await db.execute(
      `INSERT INTO properties (id, airroi_id, title, area, max_guests) VALUES ('airroi_9', '9', 't', '山中湖村', 6)`,
    );
    await db.execute(
      `INSERT INTO daily_metrics (property_id, target_date, price_jpy, is_available, fetched_at)
       VALUES ('airroi_9', date('now', '+9 hours', '+3 days'), 50000, 1, datetime('now', '-1 hours'))`,
    );
    await ensureSchema(db);
    const cols = await columns(db, "properties");
    assert.ok(cols.has("rates_synced_at"));
    assert.ok(cols.has("details_json"));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots"), 1);
  });

  it("SNAPSHOT_BACKFILL_SQL は INSERT OR IGNORE (既存のスナップショットを上書きしない)", async () => {
    const db = await productionShapedDb();
    await seedRows(db);
    await ensureSchema(db);
    const today = await jstDate(db, 0);
    await db.execute({
      sql: "UPDATE calendar_snapshots SET price_jpy = 1 WHERE property_id = 'airroi_3' AND target_date = ? AND snapshot_date = ?",
      args: [await jstDate(db, 1), today],
    });
    await db.execute(SNAPSHOT_BACKFILL_SQL);
    assert.equal(
      await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots WHERE price_jpy = 1"),
      1,
    );
  });
});

describe("ensureSchema: メモ化と失敗時の扱い", () => {
  it("同じ Client への並行呼び出しは1回だけ実行される", async () => {
    const db = memDb();
    let calls = 0;
    const counting = aliasClient(db, (orig, stmt, ...rest) => {
      calls += 1;
      return (orig as (...a: unknown[]) => Promise<unknown>)(stmt, ...rest);
    });
    await Promise.all([ensureSchema(counting), ensureSchema(counting), ensureSchema(counting)]);
    const first = calls;
    assert.ok(first > 0);
    await ensureSchema(counting);
    assert.equal(calls, first, "2回目以降は DB に触れない");
  });

  it("失敗した呼び出しはメモに残らず、次回の呼び出しで再試行される", async () => {
    const db = memDb();
    let failNext = true;
    const flaky = aliasClient(db, (orig, stmt, ...rest) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("一時的な接続エラー"));
      }
      return (orig as (...a: unknown[]) => Promise<unknown>)(stmt, ...rest);
    });
    await assert.rejects(ensureSchema(flaky), /一時的な接続エラー/);
    await ensureSchema(flaky);
    const tables = await tableNames(db);
    for (const t of NEW_TABLES) assert.ok(tables.has(t));
  });

  it("バックフィルが失敗してもスキーマは使え (画面を落とさない)、フラグは立たず次回再試行される", async () => {
    const db = await productionShapedDb();
    await seedRows(db);
    let failBackfill = true;
    const flaky = aliasClient(db, (orig, stmt, ...rest) => {
      if (failBackfill && stmt === SNAPSHOT_BACKFILL_SQL) return Promise.reject(new Error("SQLITE_BUSY"));
      return (orig as (...a: unknown[]) => Promise<unknown>)(stmt, ...rest);
    });
    const origError = console.error;
    console.error = () => {};
    try {
      await ensureSchema(flaky); // 例外を投げない
    } finally {
      console.error = origError;
    }
    const tables = await tableNames(db);
    for (const t of NEW_TABLES) assert.ok(tables.has(t));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:snapshot-backfill'"), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots"), 0);

    // 次回 (別 Client = 新しいプロセス) で再試行して成功する
    failBackfill = false;
    await ensureSchema(aliasClient(db));
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM sync_state WHERE key = 'migration:snapshot-backfill'"), 1);
    assert.equal(await count(db, "SELECT COUNT(*) AS c FROM calendar_snapshots"), 270);
  });
});
