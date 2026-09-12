import { PROPERTY_TYPES, type PropertyRow } from "./types";

const typeLabel = (value: string) =>
  PROPERTY_TYPES.find((t) => t.value === value)?.label ?? value;

const yen = (v: number | null): string =>
  v == null ? "—" : `¥${Math.round(v).toLocaleString("ja-JP")}`;
const pct = (v: number | null): string => (v == null ? "—" : `${v.toFixed(1)}%`);
const numOrDash = (v: number | null): string => (v == null ? "—" : String(v));
const boolLabel = (v: boolean | null): string => (v == null ? "—" : v ? "◯" : "—");

export type ColumnGroup = "基本" | "価格・単価" | "実績(過去90日/12ヶ月)" | "属性・ホスト" | "位置・メタ";

export interface TableColumnDef {
  id: string; // PropertyRow のフィールド名 (ソートキーにも使用)
  label: string;
  group: ColumnGroup;
  align: "left" | "right";
  sortable: boolean;
  render: (r: PropertyRow) => string; // 表示用
  csv: (r: PropertyRow) => string | number; // CSV用の生値
}

/** 競合物件一覧・データベース画面で使う全列の定義 (id は PropertyRow のキー) */
export const TABLE_COLUMN_DEFS: TableColumnDef[] = [
  // --- 基本 ---
  { id: "title", label: "物件名", group: "基本", align: "left", sortable: true, render: (r) => r.title, csv: (r) => r.title },
  { id: "area", label: "エリア", group: "基本", align: "left", sortable: true, render: (r) => r.area, csv: (r) => r.area },
  { id: "propertyType", label: "形態", group: "基本", align: "left", sortable: true, render: (r) => typeLabel(r.propertyType), csv: (r) => typeLabel(r.propertyType) },
  { id: "bedrooms", label: "寝室", group: "基本", align: "right", sortable: true, render: (r) => String(r.bedrooms), csv: (r) => r.bedrooms },
  { id: "beds", label: "ベッド", group: "基本", align: "right", sortable: true, render: (r) => numOrDash(r.beds), csv: (r) => r.beds ?? "" },
  { id: "bathrooms", label: "バス", group: "基本", align: "right", sortable: true, render: (r) => numOrDash(r.bathrooms), csv: (r) => r.bathrooms ?? "" },
  { id: "maxGuests", label: "定員", group: "基本", align: "right", sortable: true, render: (r) => String(r.maxGuests), csv: (r) => r.maxGuests },
  { id: "areaSqm", label: "面積", group: "基本", align: "right", sortable: true, render: (r) => (r.areaSqm != null ? `${r.areaSqm}m²` : "—"), csv: (r) => r.areaSqm ?? "" },
  // --- 価格・単価 (実効値: モードにより実績 or カレンダー) ---
  { id: "adr", label: "ADR", group: "価格・単価", align: "right", sortable: true, render: (r) => yen(r.adr), csv: (r) => r.adr },
  { id: "occupancyRate", label: "稼働率", group: "価格・単価", align: "right", sortable: true, render: (r) => pct(r.occupancyRate), csv: (r) => r.occupancyRate },
  { id: "pricePerGuest", label: "1人単価", group: "価格・単価", align: "right", sortable: true, render: (r) => yen(r.pricePerGuest), csv: (r) => r.pricePerGuest },
  { id: "minNights", label: "最低泊数", group: "価格・単価", align: "right", sortable: true, render: (r) => `${r.minNights}泊`, csv: (r) => r.minNights },
  { id: "cleaningFee", label: "清掃料", group: "価格・単価", align: "right", sortable: true, render: (r) => yen(r.cleaningFee), csv: (r) => r.cleaningFee ?? "" },
  { id: "extraGuestFee", label: "追加ゲスト料", group: "価格・単価", align: "right", sortable: true, render: (r) => yen(r.extraGuestFee), csv: (r) => r.extraGuestFee ?? "" },
  // --- 実績 ---
  { id: "l90dOccupancy", label: "実稼働90日", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => pct(r.l90dOccupancy), csv: (r) => r.l90dOccupancy ?? "" },
  { id: "l90dAvgRate", label: "実単価90日", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => yen(r.l90dAvgRate), csv: (r) => r.l90dAvgRate ?? "" },
  { id: "l90dRevpar", label: "RevPAR90日", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => yen(r.l90dRevpar), csv: (r) => r.l90dRevpar ?? "" },
  { id: "ttmOccupancy", label: "実稼働12ヶ月", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => pct(r.ttmOccupancy), csv: (r) => r.ttmOccupancy ?? "" },
  { id: "ttmAvgRate", label: "実単価12ヶ月", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => yen(r.ttmAvgRate), csv: (r) => r.ttmAvgRate ?? "" },
  { id: "ttmRevpar", label: "RevPAR12ヶ月", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => yen(r.ttmRevpar), csv: (r) => r.ttmRevpar ?? "" },
  { id: "ttmAvgLos", label: "平均滞在日数", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => (r.ttmAvgLos != null ? `${r.ttmAvgLos}泊` : "—"), csv: (r) => r.ttmAvgLos ?? "" },
  { id: "ttmAvgMinNights", label: "平均最低泊数", group: "実績(過去90日/12ヶ月)", align: "right", sortable: true, render: (r) => (r.ttmAvgMinNights != null ? `${r.ttmAvgMinNights}泊` : "—"), csv: (r) => r.ttmAvgMinNights ?? "" },
  // --- 属性・ホスト ---
  { id: "rating", label: "評価", group: "属性・ホスト", align: "right", sortable: true, render: (r) => (r.rating != null ? `★${r.rating.toFixed(2)}` : "—"), csv: (r) => r.rating ?? "" },
  { id: "reviewsCount", label: "レビュー数", group: "属性・ホスト", align: "right", sortable: true, render: (r) => String(r.reviewsCount), csv: (r) => r.reviewsCount },
  { id: "superhost", label: "スーパーホスト", group: "属性・ホスト", align: "right", sortable: true, render: (r) => (r.superhost ? "⭐" : "—"), csv: (r) => (r.superhost == null ? "" : r.superhost ? "1" : "0") },
  { id: "instantBook", label: "即予約", group: "属性・ホスト", align: "right", sortable: true, render: (r) => boolLabel(r.instantBook), csv: (r) => (r.instantBook == null ? "" : r.instantBook ? "1" : "0") },
  { id: "professionalManagement", label: "プロ運営", group: "属性・ホスト", align: "right", sortable: true, render: (r) => boolLabel(r.professionalManagement), csv: (r) => (r.professionalManagement == null ? "" : r.professionalManagement ? "1" : "0") },
  { id: "guestFavorite", label: "ゲスト人気", group: "属性・ホスト", align: "right", sortable: true, render: (r) => boolLabel(r.guestFavorite), csv: (r) => (r.guestFavorite == null ? "" : r.guestFavorite ? "1" : "0") },
  { id: "hostName", label: "ホスト名", group: "属性・ホスト", align: "left", sortable: true, render: (r) => r.hostName ?? "—", csv: (r) => r.hostName ?? "" },
  // --- 位置・メタ ---
  { id: "latitude", label: "緯度", group: "位置・メタ", align: "right", sortable: true, render: (r) => (r.latitude != null ? r.latitude.toFixed(5) : "—"), csv: (r) => r.latitude ?? "" },
  { id: "longitude", label: "経度", group: "位置・メタ", align: "right", sortable: true, render: (r) => (r.longitude != null ? r.longitude.toFixed(5) : "—"), csv: (r) => r.longitude ?? "" },
  { id: "airroiId", label: "AirROI ID", group: "位置・メタ", align: "right", sortable: false, render: (r) => r.airroiId, csv: (r) => r.airroiId },
  { id: "airbnbId", label: "Airbnb ID", group: "位置・メタ", align: "right", sortable: false, render: (r) => r.airbnbId ?? "—", csv: (r) => r.airbnbId ?? "" },
  { id: "url", label: "URL", group: "位置・メタ", align: "left", sortable: false, render: (r) => r.url ?? "—", csv: (r) => r.url ?? "" },
];

export const TABLE_COLUMN_IDS = TABLE_COLUMN_DEFS.map((c) => c.id);

/** メイン競合物件一覧の既定表示列 (config:table_columns が空のときに使用) */
export const DEFAULT_MAIN_COLUMNS: string[] = [
  "title",
  "area",
  "propertyType",
  "bedrooms",
  "maxGuests",
  "areaSqm",
  "occupancyRate",
  "adr",
  "pricePerGuest",
  "minNights",
  "l90dOccupancy",
  "l90dAvgRate",
  "rating",
];

/** グループ順に並んだグループ→列 のマップ (設定/ピッカー UI用) */
export const COLUMN_GROUPS: ColumnGroup[] = [
  "基本",
  "価格・単価",
  "実績(過去90日/12ヶ月)",
  "属性・ホスト",
  "位置・メタ",
];
