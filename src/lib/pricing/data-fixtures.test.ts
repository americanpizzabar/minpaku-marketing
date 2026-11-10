/**
 * データ層テスト共通の DB フィクスチャ (テストは含まない。npm test の glob に合わせて *.test.ts にしている)。
 * 本番と同じ形の行 (properties.details_json・daily_metrics.fetched_at = UTC の CURRENT_TIMESTAMP 形式 等) を
 * インメモリ DB に投入する。日付はすべて「JST の今日」基準。
 */
import { createClient, type Client, type InStatement } from "@libsql/client";
import { toDateStr, todayJst } from "../dates";
import { ensureSchema } from "../db";
import { addDaysStr } from "./holidays";

export const LUMINA_LAT = 35.42038;
export const LUMINA_LNG = 138.90478;
export const OWN_LISTING_ID = "999000";

export function jstToday(): string {
  return toDateStr(todayJst());
}

export async function freshDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await ensureSchema(db);
  return db;
}

/** 本番の syncStep が書く形の properties 行 */
export function propertyStmt(p: {
  id: string;
  lat: number | null;
  lng: number | null;
  title?: string;
  area?: string;
  maxGuests?: number;
  rating?: number | null;
  reviews?: number;
  l90?: number | null;
  ttm?: number | null;
  details?: unknown; // オブジェクトなら JSON 文字列化、文字列ならそのまま (壊れた JSON の再現用)
  ratesSyncedAt?: string | null; // SQL 式 (例: "datetime('now', '-1 days')")
}): InStatement {
  const details =
    p.details === undefined ? null : typeof p.details === "string" ? p.details : JSON.stringify(p.details);
  return {
    sql: `INSERT INTO properties (id, airroi_id, airbnb_id, title, area, latitude, longitude, property_type, max_guests,
            bedrooms, rating, reviews_count, url, l90d_avg_rate, ttm_avg_rate, details_json, rates_synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'villa', ?, 3, ?, ?, ?, ?, ?, ?, ${p.ratesSyncedAt ?? "NULL"})`,
    args: [
      p.id,
      p.id.replace(/^airroi_/, ""),
      p.id.replace(/^airroi_/, ""),
      p.title ?? `物件 ${p.id}`,
      p.area ?? "山中湖村",
      p.lat,
      p.lng,
      p.maxGuests ?? 8,
      p.rating === undefined ? 4.9 : p.rating,
      p.reviews ?? 30,
      `https://www.airbnb.com/rooms/${p.id.replace(/^airroi_/, "")}`,
      p.l90 === undefined ? 110000 : p.l90,
      p.ttm === undefined ? 100000 : p.ttm,
      details,
    ],
  };
}

export function villaDetails(roomType = "entire_home", reserved = 200, blocked = 50) {
  return {
    listing_info: { room_type: roomType, listing_type: roomType === "entire_home" ? "Entire villa" : "Room in hotel" },
    performance_metrics: { ttm_days_reserved: reserved, ttm_blocked_days: blocked },
  };
}

/** 物件 pid の daily_metrics: fetchedAgoDays 日前 (UTC の now 基準) に取得した [today+from, today+to] */
export function calendarStmts(
  pid: string,
  today: string,
  fetchedAgoDays: number,
  from: number,
  to: number,
  bookedEvery = 3,
): InStatement[] {
  const out: InStatement[] = [];
  for (let i = from; i <= to; i++) {
    const available = (i + pid.length) % bookedEvery !== 0;
    out.push({
      sql: `INSERT INTO daily_metrics (property_id, target_date, price_jpy, price_per_person, is_available, min_nights, fetched_at)
            VALUES (?, ?, ?, ?, ?, 1, datetime('now', ?))
            ON CONFLICT(property_id, target_date) DO UPDATE SET price_jpy=excluded.price_jpy,
              is_available=excluded.is_available, fetched_at=excluded.fetched_at`,
      args: [pid, addDaysStr(today, i), available ? 100000 + i * 100 : 0, available ? 12500 : 0, available ? 1 : 0, `-${fetchedAgoDays} days`],
    });
  }
  return out;
}

export function snapshotStmts(pid: string, snapshotDate: string, toDate: string, bookedEvery: number): InStatement[] {
  const out: InStatement[] = [];
  for (let d = snapshotDate, i = 0; d <= toDate; d = addDaysStr(d, 1), i++) {
    const available = (i + pid.length) % bookedEvery !== 0;
    out.push({
      sql: `INSERT OR REPLACE INTO calendar_snapshots (snapshot_date, property_id, target_date, is_available, price_jpy)
            VALUES (?, ?, ?, ?, ?)`,
      args: [snapshotDate, pid, d, available ? 1 : 0, available ? 100000 : 0],
    });
  }
  return out;
}

export interface SeedResult {
  today: string;
  fresh: string[]; // 昨日取得した CompSet member
  stale: string; // 20日前に取得
  none: string; // 未取得 (試行もなし)
  failed: string; // 試行 (2日前) したが成功データなし
  hotel: string; // 範囲内だがホテル (CompSet 外)
  far: string; // バウンディングボックス外
  noLocation: string; // 緯度経度なし
  brokenJson: string; // details_json が壊れている
  own: string; // 自社 (除外される)
}

/**
 * 現実的なデータ一式:
 * - sync_state: 自社設定 (緯度経度・listing id・基準価格・定員)、lumina_source、iCal 取り込み結果
 * - properties: CompSet 条件を満たすヴィラ 12件 + 条件外/除外対象
 * - daily_metrics / calendar_snapshots / lumina_fuji_metrics / lumina_bookings / pricing_alerts
 */
export async function seedRealistic(
  db: Client,
  opts: { luminaSource?: "api" | "manual"; dailyRatesCalls?: number } = {},
): Promise<SeedResult> {
  const today = jstToday();
  const stmts: InStatement[] = [];
  const state: [string, string][] = [
    ["config:lumina_lat", String(LUMINA_LAT)],
    ["config:lumina_lng", String(LUMINA_LNG)],
    ["config:lumina_listing_id", OWN_LISTING_ID],
    ["config:lumina_base_price", "110000"],
    ["config:lumina_max_guests", "8"],
    ["config:daily_rates_calls", String(opts.dailyRatesCalls ?? 40)],
    ["lumina_source", opts.luminaSource ?? "api"],
    [
      "pricing:ical_last_import",
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", ok: false, imported: 0, error: "HTTP 404" }),
    ],
  ];
  for (const [k, v] of state) {
    stmts.push({
      sql: `INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      args: [k, v],
    });
  }

  const fresh: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `airroi_${100 + i}`;
    const dLat = 0.004 * (i + 1) * (i % 2 === 0 ? 1 : -1);
    const dLng = 0.003 * (i + 1);
    let ratesSyncedAt = "datetime('now', '-1 days')";
    if (i === 9) ratesSyncedAt = "datetime('now', '-20 days')";
    if (i === 10) ratesSyncedAt = "NULL";
    if (i === 11) ratesSyncedAt = "datetime('now', '-2 days')";
    stmts.push(
      propertyStmt({
        id,
        lat: LUMINA_LAT + dLat,
        lng: LUMINA_LNG + dLng,
        title: `ヴィラ ${i}`,
        maxGuests: 6 + (i % 5),
        rating: 4.75 + (i % 3) * 0.1,
        reviews: 10 + i,
        l90: 95000 + i * 2000,
        details: villaDetails("entire_home", 200 + i, 40),
        ratesSyncedAt,
      }),
    );
    if (i < 9) {
      fresh.push(id);
      stmts.push(...calendarStmts(id, today, 1, -14, 67));
      stmts.push(...snapshotStmts(id, addDaysStr(today, -8), addDaysStr(today, 67), 4));
      stmts.push(...snapshotStmts(id, addDaysStr(today, -1), addDaysStr(today, 67), 3));
    } else if (i === 9) {
      stmts.push(...calendarStmts(id, today, 20, -14, 67));
      stmts.push(...snapshotStmts(id, addDaysStr(today, -20), addDaysStr(today, 67), 3));
    }
  }
  // 120日より古いスナップショット (読み込まれない)
  stmts.push(...snapshotStmts("airroi_100", addDaysStr(today, -130), addDaysStr(today, -100), 2));

  const hotel = "airroi_200";
  stmts.push(
    propertyStmt({ id: hotel, lat: LUMINA_LAT + 0.01, lng: LUMINA_LNG, details: villaDetails("hotel_room", 300, 10), ratesSyncedAt: "datetime('now', '-1 days')" }),
    ...calendarStmts(hotel, today, 1, -14, 67),
  );
  const far = "airroi_300";
  stmts.push(propertyStmt({ id: far, lat: LUMINA_LAT + 0.5, lng: LUMINA_LNG, details: villaDetails() }));
  const noLocation = "airroi_301";
  stmts.push(propertyStmt({ id: noLocation, lat: null, lng: null, details: villaDetails() }));
  const brokenJson = "airroi_302";
  stmts.push(propertyStmt({ id: brokenJson, lat: LUMINA_LAT - 0.01, lng: LUMINA_LNG, details: "{not json", l90: 0, ttm: 0 }));
  const own = `airroi_${OWN_LISTING_ID}`;
  stmts.push(propertyStmt({ id: own, lat: LUMINA_LAT, lng: LUMINA_LNG, details: villaDetails() }));
  // airroi_ 以外の id (旧データ等) は候補にしない
  stmts.push({
    sql: `INSERT INTO properties (id, airroi_id, title, area, latitude, longitude, max_guests) VALUES ('manual_1', 'm1', 'x', '山中湖村', ?, ?, 8)`,
    args: [LUMINA_LAT, LUMINA_LNG],
  });

  // 自社: AirROI の実カレンダー (configured_price, is_booked)
  for (let i = -14; i <= 59; i++) {
    const date = addDaysStr(today, i);
    stmts.push({
      sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked) VALUES (?, ?, ?)`,
      args: [date, i % 10 === 0 ? 0 : 120000 + i, i % 4 === 0 ? 1 : 0],
    });
  }
  // 手動・iCal の予約状況 (優先順位の確認用)
  const bookings: [number, string, string][] = [
    [4, "vacant", "manual"], // API では予約済 (4 % 4 == 0) → 手動の空室が優先
    [5, "booked", "manual"],
    [6, "blocked", "manual"],
    [7, "booked", "ical"],
    [8, "blocked", "ical"], // API では予約済 → iCal が優先
    [9, "weird", "manual"], // 不正な状態は無視 → API (is_booked=0) の vacant
    [10, "vacant", "ical"], // iCal に vacant は無い → 無視
    [-3, "booked", "manual"],
    [70, "booked", "manual"], // 範囲外
  ];
  for (const [i, status, source] of bookings) {
    stmts.push({
      sql: "INSERT INTO lumina_bookings (target_date, status, source) VALUES (?, ?, ?)",
      args: [addDaysStr(today, i), status, source],
    });
  }

  // 通知履歴
  stmts.push(
    {
      sql: `INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message, notified_at)
            VALUES (?, ?, 'weekend_low_inventory', 'high', 'm1', '2026-01-02 22:00:05')`,
      args: [addDaysStr(today, -3), addDaysStr(today, 5)],
    },
    {
      sql: `INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message, notified_at)
            VALUES (?, ?, 'weekday_spike', 'medium', 'm2', 'skipped')`,
      args: [addDaysStr(today, -2), addDaysStr(today, 6)],
    },
  );

  await db.batch(stmts, "write");
  return {
    today,
    fresh,
    stale: "airroi_109",
    none: "airroi_110",
    failed: "airroi_111",
    hotel,
    far,
    noLocation,
    brokenJson,
    own,
  };
}

/** 値を再帰的に走査して NaN / Infinity の場所を返す */
export function findNonFinite(v: unknown, path = "$", out: string[] = []): string[] {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(path);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => findNonFinite(x, `${path}[${i}]`, out));
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) findNonFinite(x, `${path}.${k}`, out);
  }
  return out;
}
