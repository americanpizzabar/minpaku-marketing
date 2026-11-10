"use client";

import { useState } from "react";
import type { PricingAlert } from "@/lib/pricing/types";
import { Card, mdw } from "./shared";

const SEVERITY: Record<PricingAlert["severity"], { box: string; badge: string; label: string }> = {
  high: { box: "border-rose-200 bg-rose-50", badge: "bg-rose-600 text-white", label: "重要" },
  medium: { box: "border-orange-200 bg-orange-50", badge: "bg-orange-500 text-white", label: "注意" },
  info: { box: "border-slate-200 bg-slate-50", badge: "bg-slate-400 text-white", label: "情報" },
};

/** 初期表示の件数 (多いとスマホで本文が数画面分押し下げられるため) */
const INITIAL_COUNT = 5;

/** メッセージ先頭の "M/D(曜) " は日付ボタンと重複するので表示時に外す */
function stripDatePrefix(message: string): string {
  return message.replace(/^\d{1,2}\/\d{1,2}\([日月火水木金土]\)\s*/, "");
}

/** 3. アラート (重要度順。日付タップで該当日の詳細を開く) */
export default function AlertsList({
  alerts,
  onSelectDate,
}: {
  alerts: PricingAlert[];
  onSelectDate: (date: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (alerts.length === 0) return null;

  const counts = { high: 0, medium: 0, info: 0 };
  for (const a of alerts) counts[a.severity]++;
  const shown = expanded ? alerts : alerts.slice(0, INITIAL_COUNT);
  const summary = (["high", "medium", "info"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${SEVERITY[k].label}${counts[k]}`)
    .join("・");

  return (
    <Card title={`アラート（${alerts.length}件: ${summary}）`}>
      <ul className="space-y-1.5">
        {shown.map((a, i) => {
          const s = SEVERITY[a.severity];
          return (
            <li key={`${a.date}-${a.kind}-${i}`} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${s.box}`}>
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${s.badge}`}>{s.label}</span>
              {a.kind === "own_status_unlinked" ? null : (
                <button
                  type="button"
                  onClick={() => onSelectDate(a.date)}
                  className="shrink-0 text-xs font-semibold text-indigo-700 underline decoration-dotted underline-offset-2"
                >
                  {mdw(a.date)}
                </button>
              )}
              <span className="min-w-0 break-words text-xs text-slate-700">{stripDatePrefix(a.message)}</span>
            </li>
          );
        })}
      </ul>
      {alerts.length > INITIAL_COUNT && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-slate-50"
        >
          {expanded ? "重要なものだけ表示" : `すべて表示（残り${alerts.length - INITIAL_COUNT}件）`}
        </button>
      )}
    </Card>
  );
}
