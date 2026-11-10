"use client";

import type { CompSetMember, CompSetResult } from "@/lib/pricing/types";
import { Card, md, num1, yen } from "./shared";

const CAL_STATUS: Record<CompSetMember["calendarStatus"], { label: string; cls: string }> = {
  fresh: { label: "新鮮", cls: "bg-emerald-100 text-emerald-700" },
  stale: { label: "古い", cls: "bg-amber-100 text-amber-800" },
  none: { label: "未取得", cls: "bg-slate-100 text-slate-600" },
  failed: { label: "取得失敗", cls: "bg-rose-100 text-rose-700" },
};

/** 9. CompSet 一覧 + 自社の市場内順位 */
export default function CompSetTable({ compset }: { compset: CompSetResult }) {
  const e = compset.effective;
  const position =
    compset.basePriceAboveAll !== null
      ? `自社の想定平均単価は、品質同等の周辺物件すべての参照ADR（最高 ${yen(compset.basePriceAboveAll.max)}）を上回っています`
      : compset.basePricePercentile !== null
        ? `自社の想定平均単価は、品質同等の周辺物件の参照ADR分布の ${num1(compset.basePricePercentile)}% 点です`
        : null;
  return (
    <Card
      title={`CompSet（競合セット）${compset.members.length}件`}
      right={`厳格条件 ${compset.strictCount}件 / 候補 ${compset.candidatesConsidered}件 / 新鮮 ${compset.freshCount}件`}
    >
      <p className="text-[11px] text-slate-500">
        条件: 半径 {num1(e.radiusKm)}km・{e.entireHomeOnly ? "一棟貸しのみ・" : ""}ADR ±{num1(e.adrBandPct)}%・定員 {e.guestsMin}〜
        {e.guestsMax}名・評価 {e.minRating}+・レビュー {e.minReviews}件+
      </p>
      {compset.relaxations.length > 0 && (
        <p className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
          件数が最小件数 {e.minSize} 未満のため条件を緩和: {compset.relaxations.join(" / ")}
        </p>
      )}
      {position && <p className="mt-1 rounded-lg bg-indigo-50 px-2 py-1 text-[11px] text-indigo-900">{position}</p>}

      {compset.members.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">条件に合う競合がありません</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[10px] text-slate-500">
                <th className="py-1 pr-2 font-semibold">物件</th>
                <th className="px-1 text-right font-semibold">距離</th>
                <th className="px-1 text-right font-semibold">定員</th>
                <th className="px-1 text-right font-semibold">参照ADR</th>
                <th className="px-1 text-right font-semibold">評価</th>
                <th className="px-1 text-right font-semibold">レビュー</th>
                <th className="px-1 font-semibold">カレンダー</th>
                <th className="px-1 font-semibold">条件</th>
              </tr>
            </thead>
            <tbody>
              {compset.members.map((m) => {
                const st = CAL_STATUS[m.calendarStatus];
                return (
                  <tr key={m.id} className="border-b border-slate-100 align-top">
                    <td className="max-w-[220px] py-1 pr-2">
                      {m.url ? (
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="line-clamp-2 font-medium text-indigo-700 hover:underline"
                        >
                          {m.title}
                        </a>
                      ) : (
                        <span className="line-clamp-2 font-medium text-slate-800">{m.title}</span>
                      )}
                      <span className="text-[10px] text-slate-400">
                        {m.area}
                        {m.entireHomeInferred ? "・一棟貸し（推定）" : ""}
                      </span>
                    </td>
                    <td className="px-1 text-right text-slate-700">{num1(m.distanceKm)}km</td>
                    <td className="px-1 text-right text-slate-700">{m.maxGuests}名</td>
                    <td className="px-1 text-right text-slate-700">{yen(m.adrRef)}</td>
                    <td className="px-1 text-right text-slate-700">{m.rating === null ? "—" : m.rating.toFixed(2)}</td>
                    <td className="px-1 text-right text-slate-700">{m.reviews}</td>
                    <td className="px-1">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
                      <span className="block text-[10px] text-slate-400">
                        {m.lastFetched ? `${md(m.lastFetched)} 取得` : m.lastAttemptAt ? `${md(m.lastAttemptAt)} 試行` : ""}
                      </span>
                    </td>
                    <td className="px-1">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          m.strict ? "bg-indigo-100 text-indigo-700" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {m.strict ? "厳格" : "緩和"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
