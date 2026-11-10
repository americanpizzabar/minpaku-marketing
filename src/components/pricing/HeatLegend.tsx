"use client";

import { heatRgb } from "./shared";

/** 競合占有率ヒートマップの凡例 */
export function HeatLegend({ compact = false }: { compact?: boolean }) {
  const gradient = `linear-gradient(to right, ${[0, 25, 50, 75, 100].map((v) => heatRgb(v)).join(", ")})`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
      <span className="flex items-center gap-1">
        競合予約率 0%
        <span className="inline-block h-2.5 w-16 rounded border border-slate-200" style={{ backgroundImage: gradient }} />
        100%
      </span>
      <span className="flex items-center gap-1">
        <span
          className="inline-block h-2.5 w-4 rounded border border-slate-200"
          style={{
            backgroundImage: "repeating-linear-gradient(135deg, rgba(100,116,139,0.35) 0 1px, transparent 1px 4px)",
          }}
        />
        データ少
      </span>
      <span>— データなし</span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
        予約済
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-2 rounded-full bg-slate-400" />
        ブロック
      </span>
      <span>⚡ 予約急増</span>
      {compact ? <span>細字 = ルールのみ</span> : <span>細字+「ルール」= 競合データ不足</span>}
    </div>
  );
}
