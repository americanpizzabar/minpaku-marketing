export const AREAS = [
  "山中湖村",
  "富士吉田市",
  "富士河口湖町",
  "鳴沢村",
  "忍野村",
] as const;
export type Area = (typeof AREAS)[number];

export const PROPERTY_TYPES = [
  { value: "villa", label: "一棟貸しヴィラ" },
  { value: "house", label: "民泊（Entire Place）" },
  { value: "hotel", label: "ホテル/旅館" },
  { value: "pension", label: "ペンション" },
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number]["value"];

export const TIME_RANGES = [
  { value: "past30", label: "過去30日（実績）" },
  { value: "past90", label: "過去90日（実績）" },
  { value: "next30", label: "今後30日（Pacing）" },
  { value: "next60", label: "今後60日（Pacing）" },
  { value: "next90", label: "今後90日（Pacing）" },
] as const;
export type TimeRange = (typeof TIME_RANGES)[number]["value"];

export const DAY_TYPES = [
  { value: "all", label: "全日" },
  { value: "weekday", label: "平日（月〜木）" },
  { value: "preholiday", label: "休前日（金・土）" },
  { value: "holiday", label: "祝日・日曜" },
] as const;
export type DayType = (typeof DAY_TYPES)[number]["value"];

export const CAPACITY_BUCKETS = [
  { value: "1-2", label: "1〜2名", min: 1, max: 2 },
  { value: "3-5", label: "3〜5名", min: 3, max: 5 },
  { value: "6-8", label: "6〜8名", min: 6, max: 8 },
  { value: "9+", label: "9名以上", min: 9, max: 99 },
] as const;

export interface Filters {
  areas: string[]; // 空配列 = 全エリア (複数選択可)
  propertyType: string; // "all" or PropertyType
  priceMin: number | null;
  priceMax: number | null;
  capacity: string; // "all" or bucket value
  bedrooms: string; // "all" | "1" | "2" | "3+"
  timeRange: TimeRange;
  dateFrom: string | null; // YYYY-MM-DD。dateTo とセットで指定するとプリセット期間より優先
  dateTo: string | null;
  dayType: DayType;
}

export const DEFAULT_FILTERS: Filters = {
  areas: [],
  propertyType: "all",
  priceMin: null,
  priceMax: null,
  capacity: "all",
  bedrooms: "all",
  timeRange: "next30",
  dateFrom: null,
  dateTo: null,
  dayType: "all",
};

export interface Property {
  id: string;
  airroiId: string;
  airbnbId: string | null;
  title: string;
  area: string;
  latitude: number | null;
  longitude: number | null;
  propertyType: PropertyType;
  maxGuests: number;
  bedrooms: number;
  bathrooms: number | null;
  areaSqm: number | null; // 部屋面積 (m²)
  rating: number | null;
  reviewsCount: number;
  url: string | null;
  // ---- カタログ検索から取得する追加属性 ----
  cleaningFee: number | null;
  superhost: boolean | null;
  instantBook: boolean | null;
  guestFavorite: boolean | null;
  beds: number | null;
  hostName: string | null;
  // 過去実績 (l90d=過去90日, ttm=過去12ヶ月)。稼働率は%表記
  l90dOccupancy: number | null;
  l90dAvgRate: number | null;
  l90dRevpar: number | null;
  ttmOccupancy: number | null;
  ttmAvgRate: number | null;
  ttmRevpar: number | null;
}

export interface DailyMetric {
  propertyId: string;
  targetDate: string; // YYYY-MM-DD
  priceJpy: number;
  isAvailable: boolean;
  minNights: number;
}

export interface LuminaMetric {
  targetDate: string;
  configuredPrice: number;
  isBooked: boolean;
  actualRevenue: number;
}

// ---- 集計結果 ----

export interface Kpis {
  adr: number;
  occupancyRate: number; // 0-1
  revpar: number;
  pacingOccupancy30: number; // 0-1
  pacingOccupancy60: number; // 0-1
  pricePerGuest: number;
  propertiesCount: number;
  luminaAdr: number | null;
  luminaOccupancy: number | null;
}

export interface ScatterPoint {
  propertyId: string;
  title: string;
  area: string;
  adr: number;
  occupancyRate: number; // 0-100 (%)
  maxGuests: number;
  url: string | null;
  // 過去90日の実績 (実績表示モード用)
  l90dOccupancy: number | null;
  l90dAvgRate: number | null;
  isLumina?: boolean;
}

export interface TrendPoint {
  date: string;
  avgPrice: number;
  occupancyRate: number; // 0-100 (%)
  luminaPrice: number | null;
}

export interface CapacityBar {
  bucket: string;
  avgAdr: number;
  avgPricePerGuest: number;
  count: number;
}

export interface BenchmarkPoint {
  date: string;
  areaAvg: number;
  top20: number;
  bottom20: number;
  lumina: number | null;
}

export interface PropertyRow {
  id: string;
  airroiId: string;
  title: string;
  area: string;
  propertyType: PropertyType;
  bedrooms: number;
  maxGuests: number;
  rating: number | null;
  reviewsCount: number;
  occupancyRate: number; // 0-100 (%)
  adr: number;
  pricePerGuest: number;
  minNights: number; // 期間内で最も多い最低泊数
  areaSqm: number | null; // 部屋面積 (m²)
  cleaningFee: number | null;
  superhost: boolean | null;
  l90dOccupancy: number | null; // 過去90日の実績稼働率 (%)
  l90dAvgRate: number | null; // 過去90日の実績平均単価
  url: string | null;
}

export interface MapPoint {
  id: string;
  title: string;
  area: string;
  lat: number;
  lng: number;
  adr: number;
  occupancyRate: number; // 0-100 (%)
  pricePerGuest: number;
  l90dOccupancy: number | null; // 0-100 (%)
  l90dAvgRate: number | null;
  maxGuests: number;
  bedrooms: number;
  rating: number | null;
  url: string | null;
  isLumina?: boolean;
}

export interface DashboardData {
  kpis: Kpis;
  scatter: ScatterPoint[];
  trend: TrendPoint[];
  capacityBars: CapacityBar[];
  benchmark: BenchmarkPoint[];
  rows: PropertyRow[];
  mapPoints: MapPoint[];
  dataSource: "turso" | "demo";
  periodLabel: string;
  lastSyncedAt: string | null;
}
