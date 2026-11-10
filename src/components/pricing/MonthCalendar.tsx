"use client";

import type { DayRecommendation } from "@/lib/pricing/types";
import { HeatLegend } from "./HeatLegend";
import { dowClass, heatStyle, heatTextClass, ownDotClass, parseDate, pct, yenK } from "./shared";

interface MonthGroup {
  key: string;
  label: string;
  lead: number; // 月初の曜日 (先頭の空セル数)
  days: DayRecommendation[];
}

function groupByMonth(days: DayRecommendation[]): MonthGroup[] {
  const out: MonthGroup[] = [];
  for (const day of days) {
    const p = parseDate(day.date);
    const key = `${p.y}-${p.m}`;
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: `${p.y}年${p.m}月`, lead: p.dow, days: [] };
      out.push(g);
    }
    g.days.push(day);
  }
  return out;
}

const HEAD = ["日", "月", "火", "水", "木", "金", "土"];

/** 5. スマホ用の月カレンダー (7列 × 週)。タップで日別詳細 (ボトムシート) を開く */
export default function MonthCalendar({
  days,
  selected,
  onSelect,
}: {
  days: DayRecommendation[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const months = groupByMonth(days);
  return (
    <div className="space-y-3">
      {months.map((g) => (
        <div key={g.key}>
          <p className="mb-1 text-xs font-bold text-slate-700">{g.label}</p>
          <div className="grid grid-cols-7 gap-0.5">
            {HEAD.map((h, i) => (
              <div
                key={h}
                className={`pb-0.5 text-center text-[10px] font-semibold ${
                  i === 0 ? "text-rose-600" : i === 6 ? "text-blue-600" : "text-slate-500"
                }`}
              >
                {h}
              </div>
            ))}
            {Array.from({ length: g.lead }, (_, i) => (
              <div key={`b${i}`} />
            ))}
            {g.days.map((day) => (
              <CalendarCell
                key={day.date}
                day={day}
                selected={selected === day.date}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      ))}
      <HeatLegend compact />
    </div>
  );
}

function CalendarCell({
  day,
  selected,
  onSelect,
}: {
  day: DayRecommendation;
  selected: boolean;
  onSelect: (date: string) => void;
}) {
  const { market, pricing, night, own } = day;
  const dot = ownDotClass(own.status);
  const none = market.dataQuality === "none" || market.occ === null;
  const txt = heatTextClass(market.occ);
  return (
    <button
      type="button"
      onClick={() => onSelect(day.date)}
      style={heatStyle(market)}
      aria-label={`${day.date} 推奨${pricing.recommended}円`}
      className={`flex h-[60px] min-w-0 flex-col overflow-hidden rounded-md border px-0.5 py-0.5 text-left ${
        selected ? "border-indigo-600 ring-2 ring-indigo-500" : day.lead === 0 ? "border-indigo-400" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-0.5 leading-none">
        <span className={`rounded bg-white/75 px-0.5 text-[10px] font-semibold ${dowClass(night)}`}>
          {parseDate(day.date).d}
        </span>
        {night.tag && (
          <span className="truncate rounded bg-white/75 px-0.5 text-[8px] font-bold text-indigo-700">{night.tag}</span>
        )}
      </div>
      <div
        className={`mt-auto truncate text-center text-[11px] leading-tight tracking-tight ${txt} ${
          pricing.signal === "rules_only" ? "font-normal opacity-80" : "font-bold"
        }`}
      >
        {yenK(pricing.recommended)}
      </div>
      <div className={`flex items-center justify-between gap-0.5 text-[9px] leading-none ${txt}`}>
        <span className="flex items-center gap-0.5">
          {dot ? <span className={`inline-block h-1.5 w-1.5 rounded-full ring-1 ring-white ${dot}`} /> : null}
          {market.spike && <span aria-label="予約急増">⚡</span>}
        </span>
        <span className="truncate">{none ? "—" : pct(Math.round(market.occ ?? 0))}</span>
      </div>
    </button>
  );
}
