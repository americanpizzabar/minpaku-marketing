"use client";

import type { PricingAlert } from "@/lib/pricing/types";
import { Card, mdw } from "./shared";

const SEVERITY: Record<PricingAlert["severity"], { box: string; badge: string; label: string }> = {
  high: { box: "border-rose-200 bg-rose-50", badge: "bg-rose-600 text-white", label: "重要" },
  medium: { box: "border-orange-200 bg-orange-50", badge: "bg-orange-500 text-white", label: "注意" },
  info: { box: "border-slate-200 bg-slate-50", badge: "bg-slate-400 text-white", label: "情報" },
};

/** 3. アラート (日付タップで該当日の詳細を開く) */
export default function AlertsList({
  alerts,
  onSelectDate,
}: {
  alerts: PricingAlert[];
  onSelectDate: (date: string) => void;
}) {
  if (alerts.length === 0) return null;
  return (
    <Card title={`アラート（${alerts.length}件）`}>
      <ul className="space-y-1.5">
        {alerts.map((a, i) => {
          const s = SEVERITY[a.severity];
          return (
            <li key={`${a.date}-${a.kind}-${i}`} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 ${s.box}`}>
              <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${s.badge}`}>{s.label}</span>
              <button
                type="button"
                onClick={() => onSelectDate(a.date)}
                className="shrink-0 text-xs font-semibold text-indigo-700 underline decoration-dotted underline-offset-2"
              >
                {mdw(a.date)}
              </button>
              <span className="min-w-0 break-words text-xs text-slate-700">{a.message}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
