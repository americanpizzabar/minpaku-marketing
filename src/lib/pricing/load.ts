/**
 * PricingInputs の組み立て (Turso DB / デモ) と、CompSet カレンダー取得対象の選定。
 * pipeline.ts / API から import される。このファイルは airroi.ts を import してはならない (循環防止)。
 * 自物件の設定は src/lib/sync-config.ts の getSyncConfig を使う。
 * 生の sync_state キーを直接読まないこと (空文字→0、環境変数フォールバック等の正規化が失われるため)。
 */
import type { Client, InValue, Row } from "@libsql/client";
import { toDateStr, todayJst } from "../dates";
import { ensureSchema, getDb } from "../db";
import { getSyncConfig } from "../sync-config";
import { selectCompSet } from "./compset";
import { DEFAULT_PRICING_CONFIG, normalizePricingConfig } from "./config";
import { getPricingConfig } from "./config-store";
import { buildDemoPricingInputs } from "./demo";
import { addDaysStr, diffDays } from "./holidays";
import { ICAL_LAST_IMPORT_KEY } from "./ical";
import type {
  CalendarRow,
  CandidateProperty,
  IcalImportStatus,
  OwnDay,
  OwnStatus,
  OwnStatusSource,
  PricingConfig,
  PricingInputs,
  SnapshotRow,
} from "./types";

const IN_CHUNK = 400;
const MAX_REFRESH_LIMIT = 50;

type LuminaInputs = PricingInputs["lumina"];

interface LoadContext {
  today: string;
  config: PricingConfig;
  lumina: LuminaInputs;
  candidates: CandidateProperty[];
}

function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim().replace(/^["']|["']$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 有限な数値ならその値、それ以外 null */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function truthy(v: unknown): boolean {
  if (typeof v === "string") return v !== "0" && v.toLowerCase() !== "false" && v !== "";
  return Boolean(Number(v));
}

/** 自社基準価格 (エンジン設定の値が優先) */
function basePriceOf(config: PricingConfig, lumina: LuminaInputs): number {
  return config.basePriceWeekday ?? lumina.basePrice;
}

async function loadContext(db: Client): Promise<LoadContext> {
  const today = toDateStr(todayJst());
  const [config, sync, sourceRes] = await Promise.all([
    getPricingConfig(db),
    getSyncConfig(db),
    db.execute("SELECT value FROM sync_state WHERE key = 'lumina_source'"),
  ]);
  const luminaSource = strOrNull(sourceRes.rows[0]?.value);
  const lumina: LuminaInputs = {
    lat: sync.luminaLat,
    lng: sync.luminaLng,
    basePrice: Number.isFinite(sync.luminaBasePrice) ? sync.luminaBasePrice : 0,
    listingId: sync.luminaListingId || null,
    priceSource: luminaSource === "api" ? "api" : "manual",
    maxGuests: sync.luminaMaxGuests,
  };
  const candidates = await loadCandidates(
    db,
    lumina.lat,
    lumina.lng,
    config.compset.maxRadiusKm + 1,
    lumina.listingId,
  );
  return { today, config, lumina, candidates };
}

/**
 * db (省略時は getDb()) があれば DB から、無ければ buildDemoPricingInputs(todayJst, getPricingConfig 相当の既定値) で組み立てる。
 * DB の場合 (ensureSchema をプロセス内で1回だけ実行してから):
 * - today = JST の今日 (dates.ts の todayJst → toDateStr)
 * - config = getPricingConfig(db)、sync = getSyncConfig(db)
 * - lumina = { lat: sync.luminaLat, lng: sync.luminaLng, basePrice: sync.luminaBasePrice,
 *     listingId: sync.luminaListingId || null, maxGuests: sync.luminaMaxGuests,
 *     priceSource: sync_state の lumina_source が "api" なら "api"、それ以外 "manual" }
 * - candidates = loadCandidates(db, lumina.lat, lumina.lng, config.compset.maxRadiusKm + 1, lumina.listingId)
 * - calendar = daily_metrics (property_id ∈ candidates, target_date ∈ [today−14, today+horizon+7]),
 *   fetchedAt = date(fetched_at, '+9 hours')
 * - snapshots = selectCompSet(candidates, lumina, basePrice, config, today).members の id のみについて
 *   calendar_snapshots (snapshot_date >= today−120, target_date ∈ [today−24, today+horizon+7])
 *   (basePrice = config.basePriceWeekday ?? lumina.basePrice)
 * - own: date ∈ [today−14, today+horizon] ごとに
 *     apiPrice = lumina.priceSource == "api" かつ lumina_fuji_metrics.configured_price > 0 ならその値、それ以外 null
 *     status/statusSource の優先順: lumina_bookings(source=manual, status は booked/blocked/vacant) >
 *       lumina_bookings(source=ical) > (priceSource "api" かつ is_booked=1 → booked/api) > vacant/none
 * - icalConfigured = config.icalUrl != null
 * - icalLastImport = sync_state "pricing:ical_last_import" の JSON (IcalImportStatus)。無ければ null
 * - alertChannel = process.env.ALERT_WEBHOOK_URL が空でなければ "webhook"、それ以外 "none"
 * - lastNotifiedAt = SELECT MAX(notified_at) FROM pricing_alerts WHERE notified_at IS NOT NULL AND notified_at <> 'skipped'
 *   (送信中の一時値 'sending:…' は除く)
 * 大量の IN 句は 400 件ずつに分割してよい。
 */
export async function loadPricingInputs(db: Client | null = getDb()): Promise<PricingInputs> {
  if (!db) {
    return buildDemoPricingInputs(toDateStr(todayJst()), normalizePricingConfig(DEFAULT_PRICING_CONFIG));
  }
  await ensureSchema(db);

  const { today, config, lumina, candidates } = await loadContext(db);
  const H = config.horizonDays;
  const calFrom = addDaysStr(today, -14);
  const calTo = addDaysStr(today, H + 7);
  const ownFrom = addDaysStr(today, -14);
  const ownTo = addDaysStr(today, H);

  // --- calendar (daily_metrics) ---
  const calendar: CalendarRow[] = [];
  for (const ids of chunks(candidates.map((c) => c.id), IN_CHUNK)) {
    const res = await db.execute({
      sql: `SELECT property_id, target_date, price_jpy, is_available,
                   date(fetched_at, '+9 hours') AS fetched_jst
            FROM daily_metrics
            WHERE property_id IN (${ids.map(() => "?").join(",")})
              AND target_date BETWEEN ? AND ?`,
      args: [...ids, calFrom, calTo],
    });
    for (const r of res.rows) {
      const available = truthy(r.is_available);
      const price = numOrNull(r.price_jpy);
      calendar.push({
        propertyId: String(r.property_id),
        date: String(r.target_date).slice(0, 10),
        available,
        // 予約不可日の価格は常に 0 (古い取得時の価格が残っていても使わない)
        price: available && price !== null && price > 0 ? price : 0,
        fetchedAt: strOrNull(r.fetched_jst) ?? today,
      });
    }
  }

  // --- snapshots (CompSet member のみ) ---
  let snapshotIds: string[];
  try {
    const compset = selectCompSet(
      candidates,
      { lat: lumina.lat, lng: lumina.lng, listingId: lumina.listingId },
      basePriceOf(config, lumina),
      config,
      today,
    );
    snapshotIds = compset.members.map((m) => m.id);
  } catch (err) {
    // 想定外の例外時のみ全候補で代替する (画面を落とさないため)
    console.error("pricing: selectCompSet に失敗したため全候補のスナップショットを読み込みます:", err);
    snapshotIds = candidates.map((c) => c.id);
  }
  const snapshots: SnapshotRow[] = [];
  const snapFrom = addDaysStr(today, -120);
  const snapTargetFrom = addDaysStr(today, -24);
  for (const ids of chunks(snapshotIds, IN_CHUNK)) {
    const res = await db.execute({
      sql: `SELECT snapshot_date, property_id, target_date, is_available, price_jpy
            FROM calendar_snapshots
            WHERE property_id IN (${ids.map(() => "?").join(",")})
              AND snapshot_date >= ?
              AND target_date BETWEEN ? AND ?`,
      args: [...ids, snapFrom, snapTargetFrom, calTo],
    });
    for (const r of res.rows) {
      const available = truthy(r.is_available);
      const price = numOrNull(r.price_jpy);
      snapshots.push({
        snapshotDate: String(r.snapshot_date),
        propertyId: String(r.property_id),
        date: String(r.target_date),
        available,
        price: available && price !== null && price > 0 ? price : 0,
      });
    }
  }

  // --- own (自社の予約状況・現在価格) ---
  const [metricsRes, bookingsRes, icalRes, notifiedRes] = await Promise.all([
    db.execute({
      sql: `SELECT target_date, configured_price, is_booked FROM lumina_fuji_metrics
            WHERE target_date BETWEEN ? AND ?`,
      args: [ownFrom, ownTo],
    }),
    db.execute({
      sql: `SELECT target_date, status, source FROM lumina_bookings WHERE target_date BETWEEN ? AND ?`,
      args: [ownFrom, ownTo],
    }),
    db.execute({ sql: "SELECT value FROM sync_state WHERE key = ?", args: [ICAL_LAST_IMPORT_KEY] }),
    db.execute(
      `SELECT MAX(notified_at) AS m FROM pricing_alerts
       WHERE notified_at IS NOT NULL AND notified_at <> 'skipped' AND notified_at NOT LIKE 'sending:%'`,
    ),
  ]);
  const own = buildOwnDays(ownFrom, ownTo, lumina.priceSource, metricsRes.rows, bookingsRes.rows);

  return {
    today,
    dataSource: "turso",
    lumina,
    candidates,
    calendar,
    snapshots,
    own,
    config,
    icalConfigured: config.icalUrl != null,
    icalLastImport: parseIcalStatus(icalRes.rows[0]?.value),
    alertChannel: cleanEnv(process.env.ALERT_WEBHOOK_URL) ? "webhook" : "none",
    lastNotifiedAt: strOrNull(notifiedRes.rows[0]?.m),
  };
}

function parseIcalStatus(raw: unknown): IcalImportStatus | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v === null || typeof v !== "object" || typeof v.at !== "string") return null;
    const imported = Number(v.imported);
    return {
      at: v.at,
      ok: v.ok === true,
      imported: Number.isFinite(imported) ? imported : 0,
      error: typeof v.error === "string" ? v.error : null,
    };
  } catch {
    return null;
  }
}

/** 自社の日別状態を組み立てる (manual > ical > AirROI 実カレンダー > 未連携) */
function buildOwnDays(
  from: string,
  to: string,
  priceSource: LuminaInputs["priceSource"],
  metricsRows: Row[],
  bookingRows: Row[],
): OwnDay[] {
  const metrics = new Map<string, { price: number | null; booked: boolean }>();
  for (const r of metricsRows) {
    metrics.set(String(r.target_date).slice(0, 10), {
      price: numOrNull(r.configured_price),
      booked: truthy(r.is_booked),
    });
  }
  const manual = new Map<string, OwnStatus>();
  const ical = new Map<string, OwnStatus>();
  for (const r of bookingRows) {
    const date = String(r.target_date).slice(0, 10);
    const status = String(r.status);
    const source = String(r.source);
    if (source === "manual" && (status === "booked" || status === "blocked" || status === "vacant")) {
      manual.set(date, status);
    } else if (source === "ical" && (status === "booked" || status === "blocked")) {
      ical.set(date, status);
    }
  }
  const out: OwnDay[] = [];
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) {
    const date = addDaysStr(from, i);
    const m = priceSource === "api" ? metrics.get(date) : undefined;
    const apiPrice = m && m.price !== null && m.price > 0 ? m.price : null;
    let status: OwnStatus = "vacant";
    let statusSource: OwnStatusSource = "none";
    const manualStatus = manual.get(date);
    const icalStatus = ical.get(date);
    if (manualStatus) {
      status = manualStatus;
      statusSource = "manual";
    } else if (icalStatus) {
      status = icalStatus;
      statusSource = "ical";
    } else if (m) {
      // AirROI の実カレンダーがある日は、予約不可なら booked、予約可能なら vacant (いずれも出所 api)
      status = m.booked ? "booked" : "vacant";
      statusSource = "api";
    }
    out.push({ date, apiPrice, status, statusSource });
  }
  return out;
}

/**
 * 候補物件を読み込む (自社 id = "airroi_" + ownListingId は除外)。lat/lng が非 null なら緯度経度の
 * バウンディングボックス (radiusKm 相当: 緯度1度≈111km、経度1度≈111km×cos(lat)) で事前に絞る。null なら全件。
 * roomType/listingType/reservedShare は details_json から json_extract で取得:
 *   $.listing_info.room_type, $.listing_info.listing_type,
 *   $.performance_metrics.ttm_days_reserved, $.performance_metrics.ttm_blocked_days
 *   reservedShare = reserved / (reserved + blocked) (合計 > 0 のとき)、それ以外 null
 * adrRef = l90d_avg_rate ?? ttm_avg_rate
 * ratesSyncedAt = その物件の MAX(daily_metrics.fetched_at) の JST 日付 (取得成功の最終日。無ければ null)
 * lastAttemptAt = date(properties.rates_synced_at, '+9 hours') (取得の最終試行日。失敗でも進む)
 */
export async function loadCandidates(
  db: Client,
  lat: number | null,
  lng: number | null,
  radiusKm: number,
  ownListingId: string | null,
): Promise<CandidateProperty[]> {
  const where: string[] = ["p.id LIKE 'airroi_%'"];
  const args: InValue[] = [];
  if (ownListingId) {
    where.push("p.id <> ?");
    args.push(`airroi_${ownListingId}`);
  }
  if (lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng)) {
    const r = Math.max(0, Number.isFinite(radiusKm) ? radiusKm : 0);
    const dLat = r / 111;
    const cos = Math.cos((lat * Math.PI) / 180);
    const dLng = r / (111 * Math.max(0.01, Math.abs(cos)));
    where.push("p.latitude BETWEEN ? AND ?", "p.longitude BETWEEN ? AND ?");
    args.push(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
  }
  // 壊れた details_json で json_extract が失敗しないよう json_valid で守る
  const jx = (path: string) =>
    `CASE WHEN json_valid(p.details_json) THEN json_extract(p.details_json, '${path}') END`;
  const res = await db.execute({
    sql: `SELECT p.id, p.title, p.url, p.area, p.latitude, p.longitude, p.property_type,
                 p.max_guests, p.rating, p.reviews_count, p.l90d_avg_rate, p.ttm_avg_rate,
                 ${jx("$.listing_info.room_type")} AS room_type,
                 ${jx("$.listing_info.listing_type")} AS listing_type,
                 ${jx("$.performance_metrics.ttm_days_reserved")} AS ttm_reserved,
                 ${jx("$.performance_metrics.ttm_blocked_days")} AS ttm_blocked,
                 date(p.rates_synced_at, '+9 hours') AS last_attempt,
                 (SELECT date(MAX(d.fetched_at), '+9 hours') FROM daily_metrics d
                   WHERE d.property_id = p.id) AS last_success
          FROM properties p
          WHERE ${where.join(" AND ")}
          ORDER BY p.id`,
    args,
  });
  return res.rows.map((r) => {
    const l90 = numOrNull(r.l90d_avg_rate);
    const ttm = numOrNull(r.ttm_avg_rate);
    const reserved = numOrNull(r.ttm_reserved);
    const blocked = numOrNull(r.ttm_blocked);
    const total = (reserved ?? 0) + (blocked ?? 0);
    const reservedShare =
      reserved !== null && blocked !== null && reserved >= 0 && blocked >= 0 && total > 0
        ? reserved / total
        : null;
    const maxGuests = numOrNull(r.max_guests);
    return {
      id: String(r.id),
      title: String(r.title ?? r.id),
      url: strOrNull(r.url),
      area: String(r.area ?? ""),
      lat: numOrNull(r.latitude),
      lng: numOrNull(r.longitude),
      roomType: strOrNull(r.room_type),
      listingType: strOrNull(r.listing_type),
      propertyType: String(r.property_type ?? ""),
      maxGuests: maxGuests !== null && maxGuests > 0 ? maxGuests : 0,
      rating: numOrNull(r.rating),
      reviews: Math.max(0, numOrNull(r.reviews_count) ?? 0),
      // 0 は「実績なし」なので参照ADRとして使わない
      adrRef: l90 !== null && l90 > 0 ? l90 : ttm !== null && ttm > 0 ? ttm : null,
      reservedShare,
      ratesSyncedAt: strOrNull(r.last_success),
      lastAttemptAt: strOrNull(r.last_attempt),
    };
  });
}

/**
 * CompSet カレンダーの取得対象 id (定期実行・「今すぐ取得」ボタン共通。表示する費用と実際の費用を一致させるため
 * compute.ts の status.refreshPlan と同じ選び方をする)。
 * - limit = opts.limit ?? config.compsetRefreshMax。limit <= 0 なら空配列
 * - selectCompSet の members のうち calendarStatus が "failed" でなく、
 *   ratesSyncedAt == null または today − ratesSyncedAt >= staleDays (staleDays 省略時は config.freshnessDays + 1)、
 *   かつ lastAttemptAt が今日でない (同日の再取得はしない) もの
 * - opts.ids が与えられたらそれとの積集合 (画面に表示した対象以外は取得しない)
 * - ratesSyncedAt の古い順 (null が先) に limit 件
 * DB 未設定・自社基準価格未設定・例外時も空配列を返す (例外を投げない)。
 */
export async function selectCompsetRefreshTargets(
  db: Client,
  opts?: { staleDays?: number; limit?: number; ids?: string[] },
): Promise<{ ids: string[]; config: PricingConfig }> {
  let config: PricingConfig = DEFAULT_PRICING_CONFIG;
  if (!db) return { ids: [], config };
  try {
    await ensureSchema(db);
    const ctx = await loadContext(db);
    config = ctx.config;
    const limit = Math.min(MAX_REFRESH_LIMIT, Math.floor(opts?.limit ?? config.compsetRefreshMax));
    if (!Number.isFinite(limit) || limit <= 0) return { ids: [], config };
    const basePrice = basePriceOf(config, ctx.lumina);
    if (!(basePrice > 0)) return { ids: [], config };
    const staleDays = opts?.staleDays ?? config.freshnessDays + 1;
    // 例外時は catch で空配列 (全候補に広げると CompSet 外にも課金してしまうため代替しない)
    const compset = selectCompSet(
      ctx.candidates,
      { lat: ctx.lumina.lat, lng: ctx.lumina.lng, listingId: ctx.lumina.listingId },
      basePrice,
      config,
      ctx.today,
    );
    const allow = opts?.ids ? new Set(opts.ids) : null;
    const targets = compset.members.filter((m) => {
      if (m.calendarStatus === "failed") return false;
      if (allow && !allow.has(m.id)) return false;
      if (m.lastAttemptAt === ctx.today) return false;
      return m.lastFetched === null || diffDays(m.lastFetched, ctx.today) >= staleDays;
    });
    targets.sort((a, b) => {
      if (a.lastFetched === b.lastFetched) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      if (a.lastFetched === null) return -1;
      if (b.lastFetched === null) return 1;
      return a.lastFetched < b.lastFetched ? -1 : 1;
    });
    return { ids: targets.slice(0, limit).map((m) => m.id), config };
  } catch (err) {
    console.error("pricing: CompSet 取得対象の選定に失敗:", err);
    return { ids: [], config };
  }
}
