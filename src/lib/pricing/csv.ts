/**
 * 推奨価格のエクスポート (仕様 4.1「推奨価格を一括適用 (CSV / OTA連携用フォーマット)」)。
 * 純関数 (クライアントコンポーネントからも import して Blob ダウンロード・画面表示に使う)。
 * 注意: Airbnb には価格の CSV 一括取込機能が無い。CSV は表計算・チャネルマネージャ取込用、
 * toPriceRanges は Airbnb のカレンダーで「期間を選んで価格を入力」する手作業を最小にするための一覧。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import { formatJpDate, formatYen } from "./alerts";
import { addDaysStr } from "./holidays";
import type { DayPricing, OwnPriceSource, OwnStatus, PricingDashboard } from "./types";

type Cell = string | number | null | undefined;

const DETAIL_HEADER = [
  "日付",
  "曜日",
  "区分",
  "区分理由",
  "リードタイム",
  "自社状況",
  "現在価格",
  "現在価格の出所",
  "推奨価格",
  "乖離率(推奨までの変更率%)",
  "アクション",
  "算出根拠",
  "競合占有率(%)",
  "補正前占有率(%)",
  "競合有効室数",
  "競合残室数",
  "競合中央価格",
  "Pace超過(pt/7日)",
  "δ曜日(%)",
  "α占有率(%)",
  "β Pace(%)",
  "γリードタイム(%)",
  "算出価格(丸め前)",
  "下限",
  "上限",
  "ガードレール",
];

const STATUS_LABEL: Record<OwnStatus, string> = { booked: "予約済", blocked: "ブロック", vacant: "空室" };
const PRICE_SOURCE_LABEL: Record<OwnPriceSource, string> = { api: "実価格", manual: "入力値", assumed: "仮定" };
const ACTION_LABEL: Record<DayPricing["action"], string> = {
  raise: "値上げ",
  lower: "値下げ",
  hold: "据え置き",
  booked: "予約済",
  blocked: "ブロック",
};
const SIGNAL_LABEL: Record<DayPricing["signal"], string> = {
  market: "競合連動",
  partial: "一部連動",
  rules_only: "ルールのみ",
};

function escapeCell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** 係数 (小数) → % 表記 (小数1桁) */
function coefPct(v: number): string {
  if (!Number.isFinite(v)) return "";
  const r = Math.round(v * 1000) / 10;
  return (r === 0 ? 0 : r).toFixed(1);
}

function vacantFutureDays(d: PricingDashboard) {
  return d.days
    .filter((x) => x.own.status === "vacant" && x.lead >= 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 分析用の詳細CSV (UTF-8 BOM 付き, 改行 \r\n, 値にカンマ/改行/引用符があればダブルクォートでエスケープ)。
 * ヘッダ: 日付,曜日,区分,区分理由,リードタイム,自社状況,現在価格,現在価格の出所,推奨価格,乖離率(推奨までの変更率%),
 *        アクション,算出根拠,競合占有率(%),補正前占有率(%),競合有効室数,競合残室数,競合中央価格,Pace超過(pt/7日),
 *        δ曜日(%),α占有率(%),β Pace(%),γリードタイム(%),算出価格(丸め前),下限,上限,ガードレール
 * 係数は % 表記 (0.15 → 15.0)。null は空欄。算出根拠 = signal を日本語 (競合連動/一部連動/ルールのみ)。
 */
export function toDetailCsv(d: PricingDashboard): string {
  const rows: Cell[][] = [DETAIL_HEADER];
  for (const x of d.days) {
    const p = x.pricing;
    const m = x.market;
    rows.push([
      x.date,
      "日月火水木金土"[x.night.dow] ?? "",
      x.night.type === "weekend" ? "週末" : "平日",
      x.night.reason,
      x.lead,
      STATUS_LABEL[x.own.status],
      x.own.currentPrice,
      PRICE_SOURCE_LABEL[x.own.currentPriceSource],
      p.recommended,
      p.changePct,
      ACTION_LABEL[p.action],
      SIGNAL_LABEL[p.signal],
      m.occ,
      m.occRaw,
      m.units,
      m.remaining,
      m.compAdr,
      m.pace,
      coefPct(p.delta.value),
      coefPct(p.alpha.value),
      coefPct(p.beta.value),
      coefPct(p.gamma.value),
      p.rawPrice,
      p.floor,
      p.ceiling,
      p.clampedBy === "floor" ? "下限適用" : p.clampedBy === "ceiling" ? "上限適用" : "",
    ]);
  }
  return "﻿" + rows.map((r) => r.map(escapeCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * 汎用の価格CSV (チャネルマネージャ等への取込用。UTF-8, BOM なし, 改行 \n)。
 * ヘッダ: date,price,currency,day_type,min_nights
 * 行: 自社が vacant の将来日のみ、price = 推奨価格 (整数), currency = JPY, day_type = weekday/weekend, min_nights = 空欄
 */
export function toPriceCsv(d: PricingDashboard): string {
  const lines = ["date,price,currency,day_type,min_nights"];
  for (const x of vacantFutureDays(d)) {
    const price = Number.isFinite(x.pricing.recommended) ? Math.round(x.pricing.recommended) : 0;
    lines.push(`${x.date},${price},JPY,${x.night.type},`);
  }
  return lines.join("\n") + "\n";
}

/**
 * 自社が vacant の将来日を日付順に並べ、連続する日 (翌日が vacant かつ同じ推奨価格) を1区間にまとめる。
 * 戻り値の label 例: "11/14(金)〜11/15(土) ¥127,000（2泊）"、単日は "11/18(水) ¥98,000"
 */
export function toPriceRanges(
  d: PricingDashboard,
): { from: string; to: string; price: number; nights: number; label: string }[] {
  const ranges: { from: string; to: string; price: number; nights: number }[] = [];
  for (const x of vacantFutureDays(d)) {
    const price = Number.isFinite(x.pricing.recommended) ? Math.round(x.pricing.recommended) : 0;
    const last = ranges[ranges.length - 1];
    if (last && last.price === price && addDaysStr(last.to, 1) === x.date) {
      last.to = x.date;
      last.nights++;
    } else {
      ranges.push({ from: x.date, to: x.date, price, nights: 1 });
    }
  }
  return ranges.map((r) => ({
    ...r,
    label:
      r.nights === 1
        ? `${formatJpDate(r.from)} ${formatYen(r.price)}`
        : `${formatJpDate(r.from)}〜${formatJpDate(r.to)} ${formatYen(r.price)}（${r.nights}泊）`,
  }));
}
