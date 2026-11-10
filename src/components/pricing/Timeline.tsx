"use client";

import type { CSSProperties, ReactNode } from "react";
import type { DayRecommendation } from "@/lib/pricing/types";
import { HeatLegend } from "./HeatLegend";
import {
  OWN_STATUS_LABEL,
  changeClass,
  changeLabel,
  dowClass,
  heatStyle,
  heatTextClass,
  md,
  ownChipClass,
  pct,
  signedPt,
  weekdayChar,
  yenK,
} from "./shared";

const COL = "w-14 shrink-0"; // 列幅 56px
const LABEL = "sticky left-0 z-10 w-24 shrink-0 border-r border-slate-200 bg-white px-2 text-[10px] font-semibold text-slate-500";

function Row({
  label,
  sub,
  days,
  selected,
  onSelect,
  cell,
  className = "h-7",
}: {
  label: string;
  sub?: string;
  days: DayRecommendation[];
  selected: string | null;
  onSelect: (date: string) => void;
  cell: (d: DayRecommendation) => { node: ReactNode; style?: CSSProperties; className?: string };
  className?: string;
}) {
  return (
    <div className={`flex w-max border-b border-slate-100 ${className}`}>
      <div className={`${LABEL} flex flex-col justify-center leading-tight`}>
        <span>{label}</span>
        {sub && <span className="text-[9px] font-normal text-slate-400">{sub}</span>}
      </div>
      {days.map((d) => {
        const c = cell(d);
        const isSel = selected === d.date;
        return (
          <button
            key={d.date}
            type="button"
            onClick={() => onSelect(d.date)}
            style={c.style}
            className={`${COL} flex flex-col items-center justify-center border-r border-slate-100 text-[11px] leading-tight ${
              isSel ? "outline-2 -outline-offset-2 outline-indigo-500" : ""
            } ${d.night.dow === 1 ? "border-l border-l-slate-300" : ""} ${c.className ?? ""}`}
          >
            {c.node}
          </button>
        );
      })}
    </div>
  );
}

/** 5. md 以上: 横スクロールのタイムライン (行ラベル sticky) */
export default function Timeline({
  days,
  selected,
  onSelect,
}: {
  days: DayRecommendation[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const common = { days, selected, onSelect };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        {/* ヘッダ: M/D + 曜 + tag */}
        <div className="flex w-max border-b border-slate-200 bg-slate-50">
          <div className={`${LABEL} flex items-center bg-slate-50`}>日付</div>
          {days.map((d) => (
            <button
              key={d.date}
              type="button"
              onClick={() => onSelect(d.date)}
              className={`${COL} flex h-11 flex-col items-center justify-center border-r border-slate-100 leading-tight ${
                selected === d.date ? "bg-indigo-100" : d.night.type === "weekend" ? "bg-indigo-50/60" : ""
              } ${d.night.dow === 1 ? "border-l border-l-slate-300" : ""}`}
            >
              <span className={`text-[11px] font-semibold ${dowClass(d.night)}`}>{md(d.date)}</span>
              <span className={`text-[10px] ${dowClass(d.night)}`}>{weekdayChar(d.night.dow)}</span>
              <span className="h-3 text-[9px] font-bold text-indigo-700">{d.night.tag}</span>
            </button>
          ))}
        </div>

        {/* 行1 自社 */}
        <Row
          {...common}
          label="自社 状況"
          cell={(d) => ({
            node: (
              <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${ownChipClass(d.own.status)}`}>
                {OWN_STATUS_LABEL[d.own.status]}
              </span>
            ),
          })}
        />
        <Row
          {...common}
          label="現在価格"
          cell={(d) => ({
            node:
              d.own.currentPrice === null ? (
                <span className="text-slate-300">—</span>
              ) : d.own.currentPriceSource === "assumed" ? (
                <span className="text-slate-400">
                  {yenK(d.own.currentPrice)}
                  <span className="ml-0.5 text-[9px]">仮</span>
                </span>
              ) : (
                <span className="text-slate-700">{yenK(d.own.currentPrice)}</span>
              ),
          })}
        />
        <Row
          {...common}
          label="推奨価格"
          className="h-9"
          cell={(d) => ({
            node:
              d.pricing.signal === "rules_only" ? (
                <>
                  <span className="font-normal text-slate-600">{yenK(d.pricing.recommended)}</span>
                  <span className="text-[9px] text-slate-400">ルール</span>
                </>
              ) : (
                <span className={`font-bold text-indigo-700 ${d.pricing.signal === "partial" ? "opacity-80" : ""}`}>
                  {yenK(d.pricing.recommended)}
                </span>
              ),
          })}
        />
        <Row
          {...common}
          label="乖離率"
          cell={(d) => ({
            node: <span className={`text-[10px] font-semibold ${changeClass(d.pricing.changePct)}`}>{changeLabel(d.pricing.changePct, 0)}</span>,
          })}
        />

        {/* 行2 区分 */}
        <Row
          {...common}
          label="区分"
          cell={(d) => ({
            node: (
              <span
                className={`rounded px-1 text-[10px] font-semibold ${
                  d.night.type === "weekend" ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600"
                }`}
              >
                {d.night.type === "weekend" ? "週末" : "平日"}
                {d.night.tag ? `・${d.night.tag}` : ""}
              </span>
            ),
          })}
        />

        {/* 行3 競合予約率 */}
        <Row
          {...common}
          label="競合予約率"
          className="h-8"
          cell={(d) => {
            const none = d.market.dataQuality === "none" || d.market.occ === null;
            return {
              style: heatStyle(d.market),
              node: (
                <span className={`font-semibold ${none ? "text-slate-300" : heatTextClass(d.market.occ)}`}>
                  {none ? "—" : pct(Math.round(d.market.occ ?? 0))}
                </span>
              ),
            };
          }}
        />

        {/* 行4 競合残室 & 中央価格 */}
        <Row
          {...common}
          label="競合残室"
          sub="& 中央価格"
          className="h-10"
          cell={(d) =>
            d.market.units === 0
              ? { node: <span className="text-slate-300">—</span> }
              : {
                  node: (
                    <>
                      <span className="text-[10px] text-slate-600">
                        空{d.market.remaining}/{d.market.units}
                      </span>
                      <span className="text-[10px] font-semibold text-slate-800">{yenK(d.market.compAdr)}</span>
                    </>
                  ),
                }
          }
        />

        {/* 補助行 Pace */}
        <Row
          {...common}
          label="Pace"
          sub="超過pt/7日"
          cell={(d) => ({
            node: (
              <span
                className={`text-[10px] ${
                  d.market.pace === null
                    ? "text-slate-300"
                    : d.market.pace > 0
                      ? "font-semibold text-rose-600"
                      : "text-slate-500"
                }`}
              >
                {d.market.spike && "⚡"}
                {signedPt(d.market.pace)}
              </span>
            ),
          })}
        />
      </div>
      <HeatLegend />
    </div>
  );
}
