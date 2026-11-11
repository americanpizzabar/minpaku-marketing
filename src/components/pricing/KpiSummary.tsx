"use client";

import type { ReactNode } from "react";
import type { BreakEvenGroup, PricingDashboard, Simulation } from "@/lib/pricing/types";
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

function BreakEvenLine({ kind, g }: { kind: "raise" | "lower"; g: BreakEvenGroup }) {
  const raise = kind === "raise";
  return (
    <p className="text-[11px] leading-snug text-slate-700">
      <span className={`font-bold ${raise ? "text-rose-600" : "text-blue-600"}`}>
        {raise ? "値上げ" : "値下げ"} {g.days}日
      </span>
      <span className="text-slate-500">（平均 {signedPct(g.avgChangePct)}）</span>:{" "}
      {raise ? (
        <>
          予約が <span className="font-bold">{num1(Math.abs(g.bookingChangePct))}%</span> 減っても売上は同等以上
        </>
      ) : (
        <>
          予約が <span className="font-bold">{num1(g.bookingChangePct)}%</span> 以上増えれば売上増
        </>
      )}
    </p>
  );
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
  const { raise, lower } = sim.breakEven;
  return (
    <KpiCard title={`想定売上シミュレーション（空室 ${sim.vacantDays}日・${sim.baselineLabel}と比較）`} className="col-span-2">
      <p className="text-[10px] font-semibold text-slate-500">損益分岐（価格だけで決まる目安）</p>
      {raise || lower ? (
        <div className="mt-0.5 space-y-0.5">
          {raise && <BreakEvenLine kind="raise" g={raise} />}
          {lower && <BreakEvenLine kind="lower" g={lower} />}
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">推奨価格は{sim.baselineLabel}と同じです</p>
      )}

      <p className="mt-2 text-[10px] font-semibold text-slate-500">需要の価格感応度を仮定した試算</p>
      <div className="mt-0.5 grid grid-cols-3 gap-1">
        {sim.scenarios.map((s) => {
          const up = s.upliftPct;
          return (
            <div key={s.key} className={`rounded-lg px-1.5 py-1 ${s.key === "central" ? "bg-slate-100" : "bg-slate-50"}`}>
              <p className="text-[10px] text-slate-500">
                {s.label.replace("価格感応度: ", "").replace("（標準）", "")}
                <span className="ml-0.5 text-slate-400">ε{s.elasticity}</span>
              </p>
              <p
                className={`text-sm font-bold ${up === null ? "text-slate-400" : up >= 0 ? "text-emerald-700" : "text-rose-600"}`}
              >
                {signedPct(up)}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-slate-600">
        中: 推奨追従 <span className="font-semibold text-indigo-700">{yen(c.recommendedRevenue)}</span>（想定{num1(c.recommendedNights)}泊）
        vs {yen(c.currentRevenue)}（{num1(c.currentNights)}泊）= <span className={diff >= 0 ? "text-emerald-700" : "text-rose-600"}>{signedYen(diff)}</span>
      </p>
      <p className="mt-0.5 text-[10px] text-slate-400">
        弾力性は実測値ではない仮定のため、試算の符号は仮定次第です。予約済 {sim.bookedDays}日の売上 {yen(sim.lockedRevenue)} は両者共通。
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
        {!d.status.paceAvailable ? (
          <p className="text-xs text-slate-400">
            Pace（予約の消化ペース）が未算出のため判定できません
            {!d.status.compsetAutoRefresh
              ? "（競合の自動取得がオフのため）"
              : d.status.paceAvailableFrom
                ? `（${mdw(d.status.paceAvailableFrom)}以降の自動取得で算出）`
                : ""}
          </p>
        ) : k.spikeDates.length === 0 ? (
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
