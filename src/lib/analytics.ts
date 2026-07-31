import { loadDataset } from "./data";
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

  props = props.filter((p) => {
    const s = statsMap.get(p.id);
    if (!s || s.total === 0 || s.prices.length === 0) return false;
    const adr = avg(s.prices);
    if (filters.priceMin !== null && adr < filters.priceMin) return false;
    if (filters.priceMax !== null && adr > filters.priceMax) return false;
    return true;
  });
  const propIds = new Set(props.map((p) => p.id));

  // ---- KPI ----
  const adrs: number[] = [];
  const occs: number[] = [];
  const ppgs: number[] = [];
  const rows: PropertyRow[] = [];
  const scatter: ScatterPoint[] = [];
  const mapPoints: MapPoint[] = [];

  for (const p of props) {
    const s = statsMap.get(p.id)!;
    const adr = avg(s.prices);
    const occ = s.total > 0 ? s.booked / s.total : 0;
    adrs.push(adr);
    occs.push(occ);
    ppgs.push(adr / Math.max(p.maxGuests, 1));
    rows.push({
      id: p.id,
      airroiId: p.airroiId,
      title: p.title,
      area: p.area,
      propertyType: p.propertyType,
      bedrooms: p.bedrooms,
      maxGuests: p.maxGuests,
      rating: p.rating,
      reviewsCount: p.reviewsCount,
      occupancyRate: Math.round(occ * 1000) / 10,
      adr: Math.round(adr),
      pricePerGuest: Math.round(adr / Math.max(p.maxGuests, 1)),
      minNights: modeOf(s.minNightsCount),
      areaSqm: p.areaSqm,
      cleaningFee: p.cleaningFee,
      superhost: p.superhost,
      l90dOccupancy: p.l90dOccupancy,
      l90dAvgRate: p.l90dAvgRate !== null ? Math.round(p.l90dAvgRate) : null,
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

  // Lumina Fuji の散布図ポイント
  const lp = ds.luminaProfile;
  const luminaPrices = luminaFiltered.map((m) => m.configuredPrice).filter((p) => p > 0);
  const luminaAdr = luminaPrices.length > 0 ? avg(luminaPrices) : null;
  // API実データがある場合は予約状況から算出、未収録時は設定画面で入力された稼働率を使う
  const luminaOcc =
    lp.source !== "api" && lp.occupancyOverride !== null
      ? lp.occupancyOverride / 100
      : luminaFiltered.length > 0
        ? luminaFiltered.filter((m) => m.isBooked).length / luminaFiltered.length
        : null;
  if (luminaAdr !== null && luminaOcc !== null) {
    scatter.push({
      propertyId: "lumina",
      title: LUMINA_PROFILE.title,
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
      title: hasExactLocation ? LUMINA_PROFILE.title : `${LUMINA_PROFILE.title} (位置は目安)`,
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
  const pacingOf = (metrics: DailyMetric[], endDate: string) => {
    const target = metrics.filter((m) => propIds.has(m.propertyId) && m.targetDate <= endDate);
    if (target.length === 0) return 0;
    return target.filter((m) => !m.isAvailable).length / target.length;
  };

  // ---- ハイエンド層 (ADR上位20%) の ADR / RevPAR ----
  const adrOccPairs = adrs
    .map((a, i) => ({ adr: a, occ: occs[i] }))
    .sort((x, y) => y.adr - x.adr);
  const top20Count = adrOccPairs.length > 0 ? Math.max(1, Math.ceil(adrOccPairs.length * 0.2)) : 0;
  const top20 = adrOccPairs.slice(0, top20Count);

  // ---- 平均滞在日数 (ALOS, AirROI過去12ヶ月実績) ----
  const losVals = props
    .map((p) => p.ttmAvgLos)
    .filter((v): v is number => v !== null && v > 0);

  // ---- 最低泊数分布 (期間内の最頻値ベース) ----
  const minStayDist = {
    n1: rows.filter((r) => r.minNights <= 1).length,
    n2: rows.filter((r) => r.minNights === 2).length,
    n3plus: rows.filter((r) => r.minNights >= 3).length,
  };

  // ---- 週末プレミアム (曜日タイプフィルタとは独立に、期間内の平日 vs 休前日で比較) ----
  const weekdayPrices: number[] = [];
  const preholidayPrices: number[] = [];
  for (const m of ds.metrics) {
    if (!propIds.has(m.propertyId)) continue;
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

  const kpis: Kpis = {
    adr: Math.round(avg(adrs)),
    occupancyRate: avg(occs),
    revpar: Math.round(avg(adrs.map((a, i) => a * occs[i]))),
    pacingOccupancy30: pacingOf(ds.pacingMetrics, pacing30End),
    pacingOccupancy60: pacingOf(ds.pacingMetrics, pacingEnd),
    pricePerGuest: Math.round(avg(ppgs)),
    propertiesCount: props.length,
    luminaAdr: luminaAdr !== null ? Math.round(luminaAdr) : null,
    luminaOccupancy: luminaOcc,
    top20Adr: Math.round(avg(top20.map((t) => t.adr))),
    top20Revpar: Math.round(avg(top20.map((t) => t.adr * t.occ))),
    top20Count,
    alos: losVals.length > 0 ? Math.round(avg(losVals) * 10) / 10 : null,
    minStay2PlusShare:
      rows.length > 0 ? (minStayDist.n2 + minStayDist.n3plus) / rows.length : 0,
    minStayDist,
    weekendPremium,
    weekdayAdr,
    preholidayAdr,
  };

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
  const luminaByDate = new Map(luminaFiltered.map((m) => [m.targetDate, m.configuredPrice]));
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
    const s = statsMap.get(p.id)!;
    const adr = avg(s.prices);
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
