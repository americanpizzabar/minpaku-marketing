/** マーケット概況のKPIカード定義 (表示選択の設定とカード描画で共有) */
export const KPI_CARD_DEFS = [
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

export type KpiCardId = (typeof KPI_CARD_DEFS)[number]["id"];
