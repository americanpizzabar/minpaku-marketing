import { loadDataset, type LuminaProfile } from "./data";
import { newerTimestamp } from "./format";
import type { LuminaMetaField } from "./sync-config";
import { matchesDayType, rangeForTimeRange, todayJst, toDateStr, addDays } from "./dates";
import { LUMINA_PROFILE } from "./demo-data";
import {
  AREAS,
  CAPACITY_BUCKETS,
  PROPERTY_TYPES,
  TIME_RANGES,
  type BenchmarkPoint,
  type CapacityBar,
  type DailyMetric,
  type DashboardData,
  type Filters,
  type Kpis,
  type LuminaMetric,
  type LuminaSources,
  type LuminaValueSource,
  type MapPoint,
  type Property,
  type PropertyRow,
  type ScatterPoint,
  type TrendPoint,
} from "./types";

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// 集計時のセーフティネット: この市場で¥200万/泊超は実在しない (ブロック目的の異常価格)
const MAX_SANE_NIGHTLY = 2_000_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function matchesFilters(p: Property, f: Filters): boolean {
  if (f.areas.length > 0 && !f.areas.includes(p.area)) return false;
  if (f.propertyTypes.length > 0 && !f.propertyTypes.includes(p.propertyType)) return false;
  if (f.capacity !== "all") {
    const bucket = CAPACITY_BUCKETS.find((b) => b.value === f.capacity);
    if (bucket && (p.maxGuests < bucket.min || p.maxGuests > bucket.max)) return false;
  }
  if (f.bedrooms !== "all") {
    if (f.bedrooms === "3+" ? p.bedrooms < 3 : p.bedrooms !== Number(f.bedrooms)) return false;
  }
  return true;
}

function capacityBucketOf(guests: number): string {
  for (const b of CAPACITY_BUCKETS) {
    if (guests >= b.min && guests <= b.max) return b.label;
  }
  return CAPACITY_BUCKETS[CAPACITY_BUCKETS.length - 1].label;
}

interface PropertyStats {
  prices: number[];
  booked: number;
  total: number;
  minNightsCount: Map<number, number>;
}

function modeOf(counts: Map<number, number>): number {
  let best = 1;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** AirROI で観測した (またはデモの) 価格か。基準価格の代替値・価格なしの日は含まない */
export function isRealLuminaPrice(m: LuminaMetric): boolean {
  return (
    (m.priceSource === "airroi" || m.priceSource === "demo") &&
    m.configuredPrice > 0 &&
    m.configuredPrice <= MAX_SANE_NIGHTLY
  );
}

/** 予約状況が AirROI の (またはデモの) カレンダー由来か */
export function isRealLuminaStatus(m: LuminaMetric): boolean {
  return m.statusSource === "airroi" || m.statusSource === "demo";
}

/**
 * 日別カレンダーから算出した値の出所。asOf = 使った行の最も新しい日時
 * (価格は観測日時 price_observed_at、予約状況は取得日時 fetched_at)。どの行にも記録が無ければ null (取得日不明)。
 * 価格に予約状況の取得日時を使わない (予約済みの日に残した古い実価格が、新しい取得の日付に見えないように)。
 * 最終取得日時でも代用しない (その取得が返していない過去の日の値が、新しく見えないように)。
 */
function calendarSource(
  lp: LuminaProfile,
  rows: LuminaMetric[],
  kind: "price" | "status",
): LuminaValueSource {
  if (lp.source === "demo") return { source: "demo", basis: "calendar", asOf: null, days: rows.length };
  let asOf: string | null = null;
  for (const m of rows) {
    asOf = newerTimestamp(asOf, kind === "price" ? m.priceObservedAt : m.fetchedAt);
  }
  return { source: "airroi", basis: "calendar", asOf, days: rows.length };
}

/** 設定画面の値の出所 (記録が無ければ手入力・日時不明) */
function settingSource(lp: LuminaProfile, field: LuminaMetaField): LuminaValueSource {
  if (lp.source === "demo") return { source: "demo", basis: "setting", asOf: null, days: 0 };
  const meta = lp.fieldMeta[field];
  return {
    source: meta?.source === "airroi" ? "airroi" : "manual",
    basis: "setting",
    asOf: meta?.at ?? null,
    days: 0,
  };
}

const NO_SOURCE: LuminaValueSource = { source: "none", basis: null, asOf: null, days: 0 };

/**
 * 自物件の ADR・稼働率を実データ優先で求める。
 * ADR: AirROI で観測した価格 (>0) の平均 → 無ければ手入力の基準価格 → 無ければ null。
 * 稼働率: AirROI の予約カレンダー (status_source='airroi') の予約済み割合 → 無ければ設定の稼働率 → 無ければ null。
 */
export function luminaAdrAndOcc(
  lp: LuminaProfile,
  rows: LuminaMetric[],
): { adr: number | null; occ: number | null; adrSource: LuminaValueSource; occSource: LuminaValueSource } {
  const priced = rows.filter(isRealLuminaPrice);
  let adr: number | null = null;
  let adrSource = NO_SOURCE;
  if (priced.length > 0) {
    adr = avg(priced.map((m) => m.configuredPrice));
    adrSource = calendarSource(lp, priced, "price");
  } else if (lp.basePrice !== null && lp.basePrice > 0) {
    adr = lp.basePrice;
    adrSource = settingSource(lp, "luminaBasePrice");
  }
  const statusRows = rows.filter(isRealLuminaStatus);
  let occ: number | null = null;
  let occSource = NO_SOURCE;
  if (statusRows.length > 0) {
    occ = statusRows.filter((m) => m.isBooked).length / statusRows.length;
    occSource = calendarSource(lp, statusRows, "status");
  } else if (lp.occupancyOverride !== null) {
    occ = lp.occupancyOverride / 100;
    occSource = settingSource(lp, "luminaOccupancy");
  }
  return { adr, occ, adrSource, occSource };
}

/** 今後 endDate までの自物件 Pacing (AirROI の予約カレンダー優先 → 設定の稼働率 → データなし) */
export function luminaPacing(
  lp: LuminaProfile,
  pacingRows: LuminaMetric[],
  endDate: string,
): { value: number | null; source: LuminaValueSource } {
  const rows = pacingRows.filter((m) => m.targetDate <= endDate && isRealLuminaStatus(m));
  if (rows.length > 0) {
    return {
      value: rows.filter((m) => m.isBooked).length / rows.length,
      source: calendarSource(lp, rows, "status"),
    };
  }
  if (lp.occupancyOverride !== null) {
    return { value: lp.occupancyOverride / 100, source: settingSource(lp, "luminaOccupancy") };
  }
  return { value: null, source: NO_SOURCE };
}

export async function getDashboardData(filters: Filters): Promise<DashboardData> {
  // 日付範囲の直接指定があればプリセット期間より優先する
  const custom = filters.dateFrom !== null && filters.dateTo !== null;
  const preset = rangeForTimeRange(filters.timeRange);
  const start = custom
    ? (filters.dateFrom! <= filters.dateTo! ? filters.dateFrom! : filters.dateTo!)
    : preset.start;
  const end = custom
    ? (filters.dateFrom! <= filters.dateTo! ? filters.dateTo! : filters.dateFrom!)
    : preset.end;
  const today = todayJst();
  const pacingStart = toDateStr(today);
  const pacingEnd = toDateStr(addDays(today, 59));

  const ds = await loadDataset(start, end, pacingStart, pacingEnd);

  // 1. 物件属性でフィルタ
  let props = ds.properties.filter((p) => matchesFilters(p, filters));

  // 2. 曜日タイプで日次データをフィルタ
  const dayFiltered = ds.metrics.filter((m) => matchesDayType(m.targetDate, filters.dayType));
  const luminaFiltered = ds.lumina.filter((m) => matchesDayType(m.targetDate, filters.dayType));

  // 3. 物件ごとの統計を先に計算し、価格帯フィルタを適用
  const statsMap = new Map<string, PropertyStats>();
  for (const m of dayFiltered) {
    let s = statsMap.get(m.propertyId);
    if (!s) {
      s = { prices: [], booked: 0, total: 0, minNightsCount: new Map() };
      statsMap.set(m.propertyId, s);
    }
    // price_jpy=0 は価格情報なし (予約済み日はダミー価格のため保存していない)
    if (m.priceJpy > 0 && m.priceJpy <= MAX_SANE_NIGHTLY) s.prices.push(m.priceJpy);
    s.total += 1;
    if (!m.isAvailable) s.booked += 1;
    const mn = m.minNights > 0 ? m.minNights : 1;
    s.minNightsCount.set(mn, (s.minNightsCount.get(mn) ?? 0) + 1);
  }

  // 物件別の実効ADR/稼働率/最低泊数を求める。
  // actualモード: 検索実績(過去90日→12ヶ月フォールバック)を優先し、無ければカレンダー。
  // calendarモード: 従来どおりカレンダー(daily_metrics)のみ。
  const mode = ds.dataMode;
  const effOf = (
    p: Property,
  ): { adr: number; occ: number; minNights: number; basis: "calendar" | "actual" } | null => {
    const s = statsMap.get(p.id);
    const hasCal = !!(s && s.total > 0 && s.prices.length > 0);
    const calAdr = hasCal ? avg(s!.prices) : null;
    const calOcc = s && s.total > 0 ? s.booked / s.total : null;
    const calMn = s ? modeOf(s.minNightsCount) : 1;
    const aAdr = p.l90dAvgRate ?? p.ttmAvgRate;
    const aOcc = p.l90dOccupancy ?? p.ttmOccupancy; // 0-100
    const hasAct = aAdr !== null && aAdr > 0 && aOcc !== null;
    if (mode === "actual" && hasAct) {
      return {
        adr: aAdr!,
        occ: aOcc! / 100,
        minNights: Math.round(p.ttmAvgMinNights ?? calMn) || 1,
        basis: "actual",
      };
    }
    if (hasCal) {
      return { adr: calAdr!, occ: calOcc ?? 0, minNights: calMn, basis: "calendar" };
    }
    return null;
  };

  const effMap = new Map<string, { adr: number; occ: number; minNights: number; basis: "calendar" | "actual" }>();
  props = props.filter((p) => {
    const e = effOf(p);
    if (!e) return false;
    if (filters.priceMin !== null && e.adr < filters.priceMin) return false;
    if (filters.priceMax !== null && e.adr > filters.priceMax) return false;
    effMap.set(p.id, e);
    return true;
  });
  const propIds = new Set(props.map((p) => p.id));

  // ---- KPI ----
  const rows: PropertyRow[] = [];
  const scatter: ScatterPoint[] = [];
  const mapPoints: MapPoint[] = [];

  for (const p of props) {
    const e = effMap.get(p.id)!;
    const adr = e.adr;
    const occ = e.occ;
    rows.push({
      id: p.id,
      airroiId: p.airroiId,
      airbnbId: p.airbnbId,
      title: p.title,
      area: p.area,
      propertyType: p.propertyType,
      bedrooms: p.bedrooms,
      beds: p.beds,
      bathrooms: p.bathrooms,
      maxGuests: p.maxGuests,
      areaSqm: p.areaSqm,
      rating: p.rating,
      reviewsCount: p.reviewsCount,
      occupancyRate: Math.round(occ * 1000) / 10,
      adr: Math.round(adr),
      pricePerGuest: Math.round(adr / Math.max(p.maxGuests, 1)),
      minNights: e.minNights,
      dataBasis: e.basis,
      cleaningFee: p.cleaningFee,
      extraGuestFee: p.extraGuestFee,
      superhost: p.superhost,
      instantBook: p.instantBook,
      professionalManagement: p.professionalManagement,
      guestFavorite: p.guestFavorite,
      hostName: p.hostName,
      latitude: p.latitude,
      longitude: p.longitude,
      l90dOccupancy: p.l90dOccupancy,
      l90dAvgRate: p.l90dAvgRate !== null ? Math.round(p.l90dAvgRate) : null,
      l90dRevpar: p.l90dRevpar !== null ? Math.round(p.l90dRevpar) : null,
      ttmOccupancy: p.ttmOccupancy,
      ttmAvgRate: p.ttmAvgRate !== null ? Math.round(p.ttmAvgRate) : null,
      ttmRevpar: p.ttmRevpar !== null ? Math.round(p.ttmRevpar) : null,
      ttmAvgLos: p.ttmAvgLos,
      ttmAvgMinNights: p.ttmAvgMinNights,
      url: p.url,
    });
    scatter.push({
      propertyId: p.id,
      title: p.title,
      area: p.area,
      adr: Math.round(adr),
      occupancyRate: Math.round(occ * 1000) / 10,
      maxGuests: p.maxGuests,
      url: p.url,
      l90dOccupancy: p.l90dOccupancy,
      l90dAvgRate: p.l90dAvgRate !== null ? Math.round(p.l90dAvgRate) : null,
    });
    if (p.latitude !== null && p.longitude !== null) {
      mapPoints.push({
        id: p.id,
        title: p.title,
        area: p.area,
        lat: p.latitude,
        lng: p.longitude,
        adr: Math.round(adr),
        occupancyRate: Math.round(occ * 1000) / 10,
        pricePerGuest: Math.round(adr / Math.max(p.maxGuests, 1)),
        l90dOccupancy: p.l90dOccupancy,
        l90dAvgRate: p.l90dAvgRate !== null ? Math.round(p.l90dAvgRate) : null,
        maxGuests: p.maxGuests,
        bedrooms: p.bedrooms,
        rating: p.rating,
        url: p.url,
      });
    }
  }
  rows.sort((a, b) => b.adr - a.adr);

  // Lumina Fuji の散布図ポイント (実データ優先。手入力の値を使った場合は名前に明記する)
  const lp = ds.luminaProfile;
  const {
    adr: luminaAdr,
    occ: luminaOcc,
    adrSource: luminaAdrSource,
    occSource: luminaOccSource,
  } = luminaAdrAndOcc(lp, luminaFiltered);
  const luminaManualNotes = [
    luminaAdrSource.source === "manual" ? "価格は手入力の基準価格" : null,
    luminaOccSource.source === "manual" ? "稼働率は手入力" : null,
  ].filter((v): v is string => v !== null);
  const luminaTitle =
    luminaManualNotes.length > 0
      ? `${LUMINA_PROFILE.title} (${luminaManualNotes.join("・")})`
      : LUMINA_PROFILE.title;
  if (luminaAdr !== null && luminaOcc !== null) {
    scatter.push({
      propertyId: "lumina",
      title: luminaTitle,
      area: LUMINA_PROFILE.area,
      adr: Math.round(luminaAdr),
      occupancyRate: Math.round(luminaOcc * 1000) / 10,
      maxGuests: lp.maxGuests,
      url: lp.listingId ? `https://www.airbnb.jp/rooms/${lp.listingId}` : null,
      l90dOccupancy: null,
      l90dAvgRate: null,
      isLumina: true,
    });
    // 地図用の自物件マーカー (設定画面の緯度・経度を優先、未設定時は山中湖村中心を目安表示)
    const hasExactLocation = lp.lat !== null && lp.lng !== null;
    mapPoints.push({
      id: "lumina",
      title: hasExactLocation ? luminaTitle : `${luminaTitle} (位置は目安)`,
      area: LUMINA_PROFILE.area,
      lat: lp.lat ?? 35.4167,
      lng: lp.lng ?? 138.8667,
      adr: Math.round(luminaAdr),
      occupancyRate: Math.round(luminaOcc * 1000) / 10,
      pricePerGuest: Math.round(luminaAdr / Math.max(lp.maxGuests, 1)),
      l90dOccupancy: null,
      l90dAvgRate: null,
      maxGuests: lp.maxGuests,
      bedrooms: lp.bedrooms,
      rating: null,
      url: lp.listingId ? `https://www.airbnb.jp/rooms/${lp.listingId}` : null,
      isLumina: true,
    });
  }

  // Pacing KPI (今後30/60日、物件フィルタのみ適用)
  const pacing30End = toDateStr(addDays(today, 29));
  const pacingOf = (metrics: DailyMetric[], endDate: string, ids: Set<string>) => {
    const target = metrics.filter((m) => ids.has(m.propertyId) && m.targetDate <= endDate);
    if (target.length === 0) return 0;
    return target.filter((m) => !m.isAvailable).length / target.length;
  };

  /** 指定した物件サブセットで全KPIを計算する (全物件と上位20%の両方で使用) */
  const kpisFor = (subsetRows: PropertyRow[]): Kpis => {
    const ids = new Set(subsetRows.map((r) => r.id));
    const subsetProps = props.filter((p) => ids.has(p.id));
    const adrs = subsetRows.map((r) => r.adr);
    const occs = subsetRows.map((r) => r.occupancyRate / 100);
    const ppgs = subsetRows.map((r) => r.pricePerGuest);

    // サブセット内のさらにADR上位20%
    const adrOccPairs = adrs
      .map((a, i) => ({ adr: a, occ: occs[i] }))
      .sort((x, y) => y.adr - x.adr);
    const top20Count =
      adrOccPairs.length > 0 ? Math.max(1, Math.ceil(adrOccPairs.length * 0.2)) : 0;
    const top20 = adrOccPairs.slice(0, top20Count);

    // 平均滞在日数 (ALOS, AirROI過去12ヶ月実績)
    const losVals = subsetProps
      .map((p) => p.ttmAvgLos)
      .filter((v): v is number => v !== null && v > 0);

    // 最低泊数分布 (期間内の最頻値ベース)
    const minStayDist = {
      n1: subsetRows.filter((r) => r.minNights <= 1).length,
      n2: subsetRows.filter((r) => r.minNights === 2).length,
      n3plus: subsetRows.filter((r) => r.minNights >= 3).length,
    };

    // 週末プレミアム (曜日タイプフィルタとは独立に、期間内の平日 vs 休前日で比較)
    const weekdayPrices: number[] = [];
    const preholidayPrices: number[] = [];
    for (const m of ds.metrics) {
      if (!ids.has(m.propertyId)) continue;
      if (!(m.priceJpy > 0 && m.priceJpy <= MAX_SANE_NIGHTLY)) continue;
      if (matchesDayType(m.targetDate, "weekday")) weekdayPrices.push(m.priceJpy);
      else if (matchesDayType(m.targetDate, "preholiday")) preholidayPrices.push(m.priceJpy);
    }
    const weekdayAdr = Math.round(avg(weekdayPrices));
    const preholidayAdr = Math.round(avg(preholidayPrices));
    const weekendPremium =
      weekdayPrices.length > 0 && preholidayPrices.length > 0 && weekdayAdr > 0
        ? Math.round((preholidayAdr / weekdayAdr - 1) * 1000) / 10
        : null;

    return {
      adr: Math.round(avg(adrs)),
      occupancyRate: avg(occs),
      revpar: Math.round(avg(adrs.map((a, i) => a * occs[i]))),
      pacingOccupancy30: pacingOf(ds.pacingMetrics, pacing30End, ids),
      pacingOccupancy60: pacingOf(ds.pacingMetrics, pacingEnd, ids),
      pricePerGuest: Math.round(avg(ppgs)),
      propertiesCount: subsetRows.length,
      luminaAdr: luminaAdr !== null ? Math.round(luminaAdr) : null,
      luminaOccupancy: luminaOcc,
      top20Adr: Math.round(avg(top20.map((t) => t.adr))),
      top20Revpar: Math.round(avg(top20.map((t) => t.adr * t.occ))),
      top20Count,
      alos: losVals.length > 0 ? Math.round(avg(losVals) * 10) / 10 : null,
      minStay2PlusShare:
        subsetRows.length > 0 ? (minStayDist.n2 + minStayDist.n3plus) / subsetRows.length : 0,
      minStayDist,
      weekendPremium,
      weekdayAdr,
      preholidayAdr,
    };
  };

  const kpis = kpisFor(rows);
  // rows はADR降順ソート済みのため、先頭20%がハイエンド層
  const kpisTop20 = kpisFor(
    rows.slice(0, rows.length > 0 ? Math.max(1, Math.ceil(rows.length * 0.2)) : 0),
  );

  // ---- Lumina Fuji 単体のKPI (lumina_fuji_metrics + 設定値から算出) ----
  const pacingLumina30 = luminaPacing(lp, ds.luminaPacing, pacing30End);
  const pacingLumina60 = luminaPacing(lp, ds.luminaPacing, pacingEnd);
  const kpisLumina: Kpis = (() => {
    const adr = luminaAdr ?? 0;
    const occ = luminaOcc ?? 0;
    // 自物件の週末プレミアム (期間内の AirROI 実価格のみ。基準価格の代替値は一律のため使わない)
    const wk: number[] = [];
    const ph: number[] = [];
    for (const m of ds.lumina) {
      if (!isRealLuminaPrice(m)) continue;
      if (matchesDayType(m.targetDate, "weekday")) wk.push(m.configuredPrice);
      else if (matchesDayType(m.targetDate, "preholiday")) ph.push(m.configuredPrice);
    }
    const wkAdr = Math.round(avg(wk));
    const phAdr = Math.round(avg(ph));
    const premium =
      wk.length > 0 && ph.length > 0 && wkAdr > 0
        ? Math.round((phAdr / wkAdr - 1) * 1000) / 10
        : null;
    return {
      adr: Math.round(adr),
      occupancyRate: occ,
      revpar: Math.round(adr * occ),
      pacingOccupancy30: pacingLumina30.value ?? 0,
      pacingOccupancy60: pacingLumina60.value ?? 0,
      pricePerGuest: Math.round(adr / Math.max(lp.maxGuests, 1)),
      propertiesCount: 1,
      luminaAdr: luminaAdr !== null ? Math.round(luminaAdr) : null,
      luminaOccupancy: luminaOcc,
      top20Adr: 0,
      top20Revpar: 0,
      top20Count: 0,
      alos: null,
      minStay2PlusShare: 0,
      minStayDist: { n1: 0, n2: 0, n3plus: 0 },
      weekendPremium: premium,
      weekdayAdr: wkAdr,
      preholidayAdr: phAdr,
    };
  })();

  // ---- 日別トレンド ----
  const byDate = new Map<string, { prices: number[]; booked: number; total: number }>();
  for (const m of dayFiltered) {
    if (!propIds.has(m.propertyId)) continue;
    let d = byDate.get(m.targetDate);
    if (!d) {
      d = { prices: [], booked: 0, total: 0 };
      byDate.set(m.targetDate, d);
    }
    if (m.priceJpy > 0 && m.priceJpy <= MAX_SANE_NIGHTLY) d.prices.push(m.priceJpy);
    d.total += 1;
    if (!m.isAvailable) d.booked += 1;
  }
  // 自物件の日別価格: AirROI の実価格のみ。期間内に実価格が1日も無い場合だけ手入力の基準価格の水平線
  // (系列名で「手入力の基準価格」と明記する。DashboardTabs の luminaNote)
  const luminaByDate = new Map<string, number>();
  const luminaRealPriced = luminaFiltered.filter(isRealLuminaPrice);
  if (luminaRealPriced.length > 0) {
    for (const m of luminaRealPriced) luminaByDate.set(m.targetDate, m.configuredPrice);
  } else if (lp.basePrice !== null && lp.basePrice > 0) {
    for (const date of byDate.keys()) luminaByDate.set(date, lp.basePrice);
  }
  const trend: TrendPoint[] = [...byDate.entries()]
    .filter(([, d]) => d.prices.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      avgPrice: Math.round(avg(d.prices)),
      occupancyRate: d.total > 0 ? Math.round((d.booked / d.total) * 1000) / 10 : 0,
      luminaPrice: luminaByDate.get(date) ?? null,
    }));

  // ---- 定員数別 単価分布 ----
  const byBucket = new Map<string, { adrs: number[]; ppgs: number[] }>();
  for (const p of props) {
    const e = effMap.get(p.id);
    if (!e) continue; // 実効値のない物件は集計対象外 (念のため)
    const adr = e.adr;
    const bucket = capacityBucketOf(p.maxGuests);
    let b = byBucket.get(bucket);
    if (!b) {
      b = { adrs: [], ppgs: [] };
      byBucket.set(bucket, b);
    }
    b.adrs.push(adr);
    b.ppgs.push(adr / Math.max(p.maxGuests, 1));
  }
  const capacityBars: CapacityBar[] = CAPACITY_BUCKETS.filter((b) => byBucket.has(b.label)).map(
    (b) => {
      const d = byBucket.get(b.label)!;
      return {
        bucket: b.label,
        avgAdr: Math.round(avg(d.adrs)),
        avgPricePerGuest: Math.round(avg(d.ppgs)),
        count: d.adrs.length,
      };
    },
  );

  // ---- ベンチマーク比較 (日別: エリア平均 / 上位20% / 下位20% / Lumina) ----
  const benchmark: BenchmarkPoint[] = [...byDate.entries()]
    .filter(([, d]) => d.prices.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => {
      const sorted = [...d.prices].sort((x, y) => x - y);
      return {
        date,
        areaAvg: Math.round(avg(sorted)),
        top20: Math.round(percentile(sorted, 80)),
        bottom20: Math.round(percentile(sorted, 20)),
        lumina: luminaByDate.get(date) ?? null,
      };
    });

  const periodLabel = custom
    ? "指定期間"
    : (TIME_RANGES.find((t) => t.value === filters.timeRange)?.label ?? filters.timeRange);

  return {
    kpis,
    kpisTop20,
    kpisLumina,
    luminaSources: {
      adr: luminaAdrSource,
      occupancy: luminaOccSource,
      pacing: pacingLumina30.source,
      maxGuests: settingSource(lp, "luminaMaxGuests"),
    } satisfies LuminaSources,
    visibleKpiCards: ds.visibleKpiCards,
    visibleTableColumns: ds.visibleTableColumns,
    dataMode: ds.dataMode,
    calendarCount: ds.calendarCount,
    scatter,
    trend,
    capacityBars,
    benchmark,
    rows,
    mapPoints,
    dataSource: ds.dataSource,
    periodLabel: `${periodLabel}: ${start} 〜 ${end}`,
    lastSyncedAt: ds.lastSyncedAt,
  };
}

export function parseFilters(params: Record<string, string | string[] | undefined>): Filters {
  const get = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const num = (k: string) => {
    const v = get(k);
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // データソース (AirROI) は未来の料金カレンダーが主のため、デフォルトは今後30日
  const timeRange = TIME_RANGES.find((t) => t.value === get("range"))?.value ?? "next30";
  const dayType = (["all", "weekday", "preholiday", "holiday"] as const).find(
    (d) => d === get("dayType"),
  ) ?? "all";
  const date = (k: string) => {
    const v = get(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  const areas = (get("area") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((a) => (AREAS as readonly string[]).includes(a));
  const typeValues = PROPERTY_TYPES.map((t) => t.value as string);
  const propertyTypes = (get("type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((t) => typeValues.includes(t));
  return {
    areas,
    propertyTypes,
    priceMin: num("priceMin"),
    priceMax: num("priceMax"),
    capacity: get("capacity") ?? "all",
    bedrooms: get("bedrooms") ?? "all",
    timeRange,
    dateFrom: date("dateFrom"),
    dateTo: date("dateTo"),
    dayType,
  };
}
