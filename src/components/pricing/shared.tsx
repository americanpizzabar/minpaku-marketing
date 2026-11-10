"use client";

import type { CSSProperties, ReactNode } from "react";
import type {
  DayRecommendation,
  MarketDay,
  NightClass,
  OwnPriceSource,
  OwnStatus,
  OwnStatusSource,
  PricingAction,
  PricingApiRequest,
  PricingApiResponse,
} from "@/lib/pricing/types";

/* ------------------------------------------------------------------ */
/* 数値・日付の表示                                                     */
/* ------------------------------------------------------------------ */

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** ¥110,000 */
export function yen(v: number | null | undefined): string {
  return isNum(v) ? `¥${Math.round(v).toLocaleString("ja-JP")}` : "—";
}

/** 狭いセル用 ¥110k */
export function yenK(v: number | null | undefined): string {
  return isNum(v) ? `¥${Math.round(v / 1000)}k` : "—";
}

/** 小数1桁まで (末尾の .0 は省略) */
export function num1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** 45.3% (null は —) */
export function pct(v: number | null | undefined): string {
  return isNum(v) ? `${num1(v)}%` : "—";
}

/** 係数 (小数) を符号付き % に: 0.15 → +15%, -0.1 → −10% */
export function coefPct(v: number): string {
  if (!isNum(v)) return "—";
  const p = v * 100;
  if (Math.abs(p) < 0.05) return "±0%";
  return `${p > 0 ? "+" : "−"}${num1(Math.abs(p))}%`;
}

/** 乖離率: +15%↑ / −8%↓ (digits = 小数桁数) */
export function changeLabel(v: number | null | undefined, digits: 0 | 1 = 1): string {
  if (!isNum(v)) return "—";
  const a = digits === 0 ? String(Math.round(Math.abs(v))) : num1(Math.abs(v));
  if (a === "0") return "0%";
  return v > 0 ? `+${a}%↑` : `−${a}%↓`;
}

export function changeClass(v: number | null | undefined): string {
  if (!isNum(v) || Math.round(Math.abs(v) * 10) === 0) return "text-slate-400";
  return v > 0 ? "text-rose-600" : "text-blue-600";
}

/** 符号付きの pt (+12 / −3) */
export function signedPt(v: number | null | undefined): string {
  if (!isNum(v)) return "—";
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : "0";
}

export function usd(v: number | null | undefined): string {
  return isNum(v) ? `$${v.toFixed(2)}` : "$—";
}

const WEEK = "日月火水木金土";

/** "YYYY-MM-DD" → { m, d, dow } (UTC で解釈してタイムゾーンに依存しない) */
export function parseDate(date: string): { y: number; m: number; d: number; dow: number } {
  const t = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return { y: 0, m: 0, d: 0, dow: 0 };
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** "M/D" */
export function md(date: string): string {
  const p = parseDate(date);
  return `${p.m}/${p.d}`;
}

/** "M/D(曜)" */
export function mdw(date: string): string {
  const p = parseDate(date);
  return `${p.m}/${p.d}(${WEEK[p.dow]})`;
}

export function weekdayChar(dow: number): string {
  return WEEK[dow] ?? "";
}

/** 土=青, 日・祝=赤 */
export function dowClass(night: Pick<NightClass, "dow" | "isHoliday">): string {
  if (night.isHoliday || night.dow === 0) return "text-rose-600";
  if (night.dow === 6) return "text-blue-600";
  return "text-slate-600";
}

/* ------------------------------------------------------------------ */
/* 競合占有率のヒートマップ色 (白→黄→橙→赤)                            */
/* ------------------------------------------------------------------ */

const HEAT_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [35, [254, 240, 138]], // yellow-200
  [65, [251, 146, 60]], // orange-400
  [100, [220, 38, 38]], // red-600
];

export function heatRgb(occ: number): string {
  const v = Math.min(100, Math.max(0, occ));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [p1, c1] = HEAT_STOPS[i];
    const [p0, c0] = HEAT_STOPS[i - 1];
    if (v <= p1) {
      const t = p1 === p0 ? 0 : (v - p0) / (p1 - p0);
      const c = c0.map((x, k) => Math.round(x + (c1[k] - x) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(220, 38, 38)";
}

const HATCH = "repeating-linear-gradient(135deg, rgba(100,116,139,0.28) 0 1px, transparent 1px 5px)";

/** セル背景 (low = 斜線を重ねる / none = 薄灰) */
export function heatStyle(market: Pick<MarketDay, "occ" | "dataQuality">): CSSProperties {
  if (market.dataQuality === "none" || !isNum(market.occ)) return { backgroundColor: "#f8fafc" };
  const bg = heatRgb(market.occ);
  if (market.dataQuality === "low") return { backgroundColor: bg, backgroundImage: HATCH };
  return { backgroundColor: bg };
}

/** 濃い背景では白文字 */
export function heatTextClass(occ: number | null | undefined): string {
  return isNum(occ) && occ >= 80 ? "text-white" : "text-slate-800";
}

/* ------------------------------------------------------------------ */
/* ラベル                                                              */
/* ------------------------------------------------------------------ */

export const OWN_STATUS_LABEL: Record<OwnStatus, string> = {
  booked: "予約済",
  blocked: "ブロック",
  vacant: "空室",
};

export const OWN_STATUS_SOURCE_LABEL: Record<OwnStatusSource | "mixed", string> = {
  manual: "手動",
  ical: "iCal",
  api: "AirROI",
  none: "未連携",
  mixed: "混在",
};

export const OWN_PRICE_SOURCE_LABEL: Record<OwnPriceSource, string> = {
  api: "実価格",
  manual: "入力値",
  assumed: "仮定",
};

export const ACTION_LABEL: Record<PricingAction, string> = {
  raise: "値上げ",
  lower: "値下げ",
  hold: "据え置き",
  booked: "予約済",
  blocked: "ブロック",
};

export const SIGNAL_LABEL: Record<DayRecommendation["pricing"]["signal"], string> = {
  market: "競合連動",
  partial: "一部連動（Pace未算出）",
  rules_only: "ルールのみ（競合データ不足）",
};

/** 自社状況の点 / チップの色 */
export function ownChipClass(status: OwnStatus): string {
  if (status === "booked") return "bg-emerald-500 text-white";
  if (status === "blocked") return "bg-slate-400 text-white";
  return "border border-slate-300 bg-white text-slate-600";
}

export function ownDotClass(status: OwnStatus): string | null {
  if (status === "booked") return "bg-emerald-500";
  if (status === "blocked") return "bg-slate-400";
  return null;
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

export interface PricingActions {
  /** POST /api/pricing。デモモードでは呼ばずに null を返す */
  run: (req: PricingApiRequest) => Promise<PricingApiResponse | null>;
  /** 実行中の action 名 */
  busy: string | null;
  /** デモモード (POST 系ボタンをすべて無効化) */
  disabled: boolean;
}

export async function postPricing(req: PricingApiRequest): Promise<PricingApiResponse> {
  try {
    const res = await fetch("/api/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (json && typeof json === "object" && typeof (json as PricingApiResponse).message === "string") {
      const r = json as PricingApiResponse;
      return { ...r, ok: Boolean(r.ok) && res.ok };
    }
    return { ok: false, message: `リクエストに失敗しました（HTTP ${res.status}）` };
  } catch {
    return { ok: false, message: "通信に失敗しました。ネットワーク接続を確認してください" };
  }
}

/** 有料の CompSet 取得の確認文 (表示した件数・費用 = 実際に送る ids) */
export function refreshConfirmText(count: number, costUsd: number): string {
  const jpy = Math.round(costUsd * 150).toLocaleString("ja-JP");
  return `${count}件 × $0.10 = 約${usd(costUsd)}（約¥${jpy}）を AirROI に支払います。実行しますか？`;
}

/* ------------------------------------------------------------------ */
/* 小さな UI 部品                                                       */
/* ------------------------------------------------------------------ */

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          {title && <h3 className="text-sm font-bold text-slate-900">{title}</h3>}
          {right && <div className="text-xs text-slate-500">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export const buttonPrimary =
  "rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50";
export const buttonSecondary =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
