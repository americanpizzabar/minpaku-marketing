/**
 * 自物件 (Lumina) の KPI 値の出所を画面に出す日本語の文言 (KPIカード・グラフの系列名で共有)。
 * 実データ (AirROI) か手入力か、いつの値か (日本時間の M/D) が分かるようにする。
 */
import { formatJstMonthDay } from "./format";
import type { LuminaSources, LuminaValueSource } from "./types";

function fetchedDate(src: LuminaValueSource): string {
  const d = formatJstMonthDay(src.asOf);
  return d ? `${d}取得` : "取得日不明";
}

function savedDate(src: LuminaValueSource): string {
  const d = formatJstMonthDay(src.asOf);
  return d ? `${d}保存` : "日時不明";
}

/** ADR カードの補足 */
export function adrSourceText(src: LuminaValueSource): string {
  switch (src.source) {
    case "airroi":
      return src.basis === "calendar"
        ? `AirROI実データ・料金のある${src.days}日の平均（${fetchedDate(src)}）`
        : `AirROI取得の設定値（${fetchedDate(src)}）`;
    case "manual":
      return `手入力の基準価格（AirROIの料金なし・${savedDate(src)}）`;
    case "demo":
      return `デモデータ・${src.days}日の平均`;
    default:
      return "データなし（AirROIの料金・基準価格なし）";
  }
}

/** 稼働率・Pacing カードの補足 */
export function occupancySourceText(src: LuminaValueSource): string {
  switch (src.source) {
    case "airroi":
      return src.basis === "calendar"
        ? `AirROI予約カレンダー（${fetchedDate(src)}）`
        : `AirROI取得の稼働率（${fetchedDate(src)}）`;
    case "manual":
      return `手入力の設定値（${savedDate(src)}）`;
    case "demo":
      return "デモデータ";
    default:
      return "データなし（予約カレンダー・設定値なし）";
  }
}

/** RevPAR カードの補足 (ADR・稼働率のどちらかが手入力ならその旨) */
export function revparSourceText(s: LuminaSources): string {
  const manual = [
    s.adr.source === "manual" ? "ADR" : null,
    s.occupancy.source === "manual" ? "稼働率" : null,
  ].filter((v): v is string => v !== null);
  if (manual.length > 0) return `ADR × 稼働率（${manual.join("・")}は手入力）`;
  if (s.adr.source === "airroi" && s.occupancy.source === "airroi") return "ADR × 稼働率（AirROI実データ）";
  return "ADR × 稼働率";
}

/** 1人当たり単価カードの補足 (料金・定員のどちらかが手入力ならその旨) */
export function perGuestSourceText(s: LuminaSources): string {
  const manual = [
    s.adr.source === "manual" ? "料金" : null,
    s.maxGuests.source === "manual" ? "定員" : null,
  ].filter((v): v is string => v !== null);
  return manual.length > 0 ? `1泊料金 ÷ 収容定員（${manual.join("・")}は手入力）` : "1泊料金 ÷ 収容定員";
}

/** グラフの自物件系列名に添える出所 (無ければ null) */
export function luminaSeriesNote(src: LuminaValueSource): string | null {
  switch (src.source) {
    case "airroi":
      return src.basis === "calendar" ? `AirROI実データ・${fetchedDate(src)}` : null;
    case "manual":
      return "手入力の基準価格";
    case "demo":
      return "デモ";
    default:
      return null;
  }
}
