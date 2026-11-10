"use client";

import type { ReactNode } from "react";
import type { PricingDashboard, Simulation } from "@/lib/pricing/types";
import { mdw, num1, pct, yen } from "./shared";

function KpiCard({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm ${className}`}>
      <p className="text-[11px] font-semibold text-slate-500">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function OccBar({ label, value, days, color }: { label: string; value: number | null; days: number; color: string }) {
  const w = value === null || !Number.isFinite(value) ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] text-slate-500">
        <span>{label}</span>
        <span>
          <span className="text-sm font-bold text-slate-900">{pct(value)}</span>
          <span className="ml-1 text-[10px]">{days}日</span>
        </span>
      </div>
      <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

const signedYen = (v: number) => `${v >= 0 ? "+" : "−"}${yen(Math.abs(v))}`;
const signedPct = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : "−"}${num1(Math.abs(v))}%`);

/**
 * 損益分岐の弾力性の文。推奨が値上げ寄りなら「非弾力的なら有利」、値下げ寄りなら「弾力的なら有利」になるため、
 * シナリオの結果から向きを判定する (判定できなければ契約の既定文)。
 */
function breakEvenSentence(sim: Simulation): string | null {
  const be = sim.breakEvenElasticity;
  const withUplift = sim.scenarios.filter((s) => s.upliftPct !== null && Number.isFinite(s.upliftPct));
  if (be === null || !Number.isFinite(be)) {
    if (withUplift.length === 0) return null;
    if (withUplift.every((s) => (s.upliftPct ?? 0) > 0)) return "想定した弾力性の範囲では、いずれも推奨追従が有利です";
    if (withUplift.every((s) => (s.upliftPct ?? 0) < 0)) return "想定した弾力性の範囲では、いずれも据え置きが有利です";
    return null;
  }
  const ref = withUplift.find((s) => s.upliftPct !== 0 && Math.abs(s.elasticity - be) > 1e-6);
  let inelasticFavors = true;
  if (ref) inelasticFavors = ref.elasticity > be === (ref.upliftPct ?? 0) > 0;
  const b = be.toFixed(2).replace("-", "−");
  // 一定弾力性のモデルでは損益分岐はほぼ常に −1 付近になる (値上げで客がちょうど比例して減る点)。
  // 計算結果ではなく「どちらの仮定なら有利か」の目安として示す。
  return inelasticFavors
    ? `損益分岐の弾力性は ${b}。値上げしても客が減りにくい市場（弾力性が0に近い）なら推奨追従が有利、価格に敏感な市場なら据え置きが有利です。弾力性は実測値ではないため目安としてご覧ください`
    : `損益分岐の弾力性は ${b}。価格に敏感な市場（弾力性の絶対値が大きい）なら推奨追従が有利、値上げしても客が減りにくい市場なら据え置きが有利です。弾力性は実測値ではないため目安としてご覧ください`;
}

function SimulationCard({ sim }: { sim: Simulation }) {
  if (!sim.available || !sim.central) {
    return (
      <KpiCard title="想定売上シミュレーション" className="col-span-2">
        <p className="text-xs text-slate-500">{sim.reason ?? "算出できませんでした"}</p>
      </KpiCard>
    );
  }
  const c = sim.central;
  const diff = c.recommendedRevenue - c.currentRevenue;
  const ups = sim.scenarios.map((s) => s.upliftPct).filter((v): v is number => v !== null && Number.isFinite(v));
  const lo = ups.length > 0 ? Math.min(...ups) : null;
  const hi = ups.length > 0 ? Math.max(...ups) : null;
  const sentence = breakEvenSentence(sim);
  return (
    <KpiCard title="想定売上シミュレーション（空室日・感応度 中）" className="col-span-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] text-slate-500">推奨追従</p>
          <p className="text-base font-bold text-indigo-700">{yen(c.recommendedRevenue)}</p>
          <p className="text-[10px] text-slate-400">想定 {num1(c.recommendedNights)}泊</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500">{sim.baselineLabel}</p>
          <p className="text-base font-bold text-slate-700">{yen(c.currentRevenue)}</p>
          <p className="text-[10px] text-slate-400">想定 {num1(c.currentNights)}泊</p>
        </div>
      </div>
      <p className={`mt-1 text-sm font-bold ${diff >= 0 ? "text-emerald-700" : "text-rose-600"}`}>
        差額 {signedYen(diff)}（{signedPct(c.upliftPct)}）
      </p>
      {lo !== null && hi !== null && (
        <p className="text-[11px] text-slate-600">
          感応度 低〜高: {signedPct(lo)} 〜 {signedPct(hi)}
          <span className="ml-1 text-slate-400">
            （{sim.scenarios.map((s) => `${s.label.replace("価格感応度: ", "")} ε=${s.elasticity}`).join(" / ")}）
          </span>
        </p>
      )}
      {sentence && <p className="mt-1 rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-700">{sentence}</p>}
      <p className="mt-1 text-[10px] text-slate-400">
        空室 {sim.vacantDays}日が対象。予約済 {sim.bookedDays}日の売上 {yen(sim.lockedRevenue)} は両者共通。
      </p>
      {sim.assumptions.length > 0 && (
        <details className="mt-1 text-[11px] text-slate-500">
          <summary className="cursor-pointer select-none text-indigo-600">前提</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {sim.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </details>
      )}
    </KpiCard>
  );
}

/** 4. サマリーKPIカード (スマホでも2列) */
export default function KpiSummary({
  d,
  onSelectDate,
}: {
  d: PricingDashboard;
  onSelectDate: (date: string) => void;
}) {
  const k = d.kpis;
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard title={`平均競合占有率（向こう${d.horizonDays}日）`} className="col-span-2 lg:col-span-1">
        <div className="space-y-1.5">
          <OccBar label="平日" value={k.weekdayOcc} days={k.weekdayDays} color="bg-sky-500" />
          <OccBar label="週末" value={k.weekendOcc} days={k.weekendDays} color="bg-indigo-600" />
        </div>
      </KpiCard>

      <SimulationCard sim={d.simulation} />

      <KpiCard title="要注意日（Spike Dates）" className="col-span-2 lg:col-span-1">
        {k.spikeDates.length === 0 ? (
          <p className="text-xs text-slate-400">直近7日で予約が急増した日はありません</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {k.spikeDates.map((date) => (
              <button
                key={date}
                type="button"
                onClick={() => onSelectDate(date)}
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-200"
              >
                ⚡{mdw(date)}
              </button>
            ))}
          </div>
        )}
      </KpiCard>

      <KpiCard title="平均推奨価格">
        <p className="text-xs text-slate-500">
          平日 <span className="text-sm font-bold text-slate-900">{yen(k.weekdayAvgRec)}</span>
        </p>
        <p className="text-xs text-slate-500">
          週末 <span className="text-sm font-bold text-slate-900">{yen(k.weekendAvgRec)}</span>
        </p>
      </KpiCard>

      <KpiCard title="価格アクション（空室日）">
        <p className="text-xs text-slate-500">
          値上げ余地 <span className="text-sm font-bold text-rose-600">{k.raiseDays}日</span>
        </p>
        <p className="text-xs text-slate-500">
          値下げ検討 <span className="text-sm font-bold text-blue-600">{k.lowerDays}日</span>
        </p>
        {d.status.ownPriceSource === "assumed" && (
          <p className="mt-0.5 text-[10px] text-slate-400">現在価格が未入力のため判定しません</p>
        )}
      </KpiCard>

      <KpiCard title="直近14日の実績占有率" className="col-span-2 lg:col-span-1">
        <p className="text-xs text-slate-500">
          平日 <span className="text-sm font-bold text-slate-900">{pct(k.past14WeekdayOcc)}</span>
          <span className="mx-2 text-slate-300">|</span>
          週末 <span className="text-sm font-bold text-slate-900">{pct(k.past14WeekendOcc)}</span>
        </p>
      </KpiCard>
    </div>
  );
}
