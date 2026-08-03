/** マーケット概況のKPIカード定義 (表示選択の設定とカード描画で共有) */

export const KPI_METRICS = [
  { id: "adr", label: "平均客室単価 (ADR)" },
  { id: "occupancy", label: "平均稼働率" },
  { id: "revpar", label: "RevPAR" },
  { id: "pacing", label: "Pacing 稼働率" },
  { id: "ppg", label: "1人当たり平均単価" },
  { id: "lumina", label: "Lumina Fuji 差異" },
  { id: "top20", label: "上位20% ADR (ハイエンド層)" },
  { id: "alos", label: "平均滞在日数 (ALOS)" },
  { id: "weekend", label: "週末プレミアム" },
  { id: "minstay", label: "最低2泊以上の物件" },
] as const;

export type KpiMetricId = (typeof KPI_METRICS)[number]["id"];
export type KpiSegmentId = "all" | "top" | "own";

/** セグメントごとに表示する指標 (top: 上位20%ADRは重複のため除外 / own: 自物件で意味のある指標のみ) */
export const KPI_SEGMENTS: {
  id: KpiSegmentId;
  label: string;
  metricIds: KpiMetricId[];
}[] = [
  {
    id: "all",
    label: "全物件",
    metricIds: ["adr", "occupancy", "revpar", "pacing", "ppg", "lumina", "top20", "alos", "weekend", "minstay"],
  },
  {
    id: "top",
    label: "上位20%",
    metricIds: ["adr", "occupancy", "revpar", "pacing", "ppg", "lumina", "alos", "weekend", "minstay"],
  },
  {
    id: "own",
    label: "Lumina Fuji",
    metricIds: ["adr", "occupancy", "revpar", "pacing", "ppg", "weekend"],
  },
];

/** 全カードのフラットな定義 (id = "<segment>:<metric>") — 設定画面の表示選択で使用 */
export const KPI_CARD_DEFS: { id: string; label: string; segment: KpiSegmentId }[] =
  KPI_SEGMENTS.flatMap((seg) =>
    seg.metricIds.map((mid) => ({
      id: `${seg.id}:${mid}`,
      label: KPI_METRICS.find((m) => m.id === mid)!.label,
      segment: seg.id,
    })),
  );
