"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BookingCurve, PricingDashboard } from "@/lib/pricing/types";
import { Card, md, mdw, num1, yen, yenK } from "./shared";

const C_REC = "#4f46e5"; // 推奨
const C_CUR = "#0d9488"; // 現在
const C_ADR = "#d97706"; // 競合中央価格

const leadTick = (v: number) => (v === 0 ? "当日" : `${v}日前`);

function leadTicks(horizon: number): number[] {
  const base = [60, 45, 30, 14, 7, 0].filter((t) => t <= horizon);
  return horizon > 60 ? [horizon, ...base] : base;
}

interface CurveTip {
  lead?: number;
  occ?: number;
  date?: string;
  source?: string;
}

function CurveChart({
  title,
  curve,
  horizon,
  color,
}: {
  title: string;
  curve: BookingCurve;
  horizon: number;
  color: string;
}) {
  const points = curve.points.filter(
    (p) => Number.isFinite(p.lead) && Number.isFinite(p.occ) && p.lead >= 0 && p.lead <= horizon,
  );
  const fitted = curve.fitted.filter((p) => Number.isFinite(p.lead) && Number.isFinite(p.occ) && p.lead <= horizon);
  const reach = (v: number | null) => (v === null ? "未到達" : `${Math.round(v)}日前`);
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <p className="text-xs font-bold text-slate-800">{title}</p>
        <p className="text-[10px] text-slate-400">n={curve.sampleSize}</p>
      </div>
      <p className="text-[11px] text-slate-600">
        50%到達: <span className="font-semibold">{reach(curve.reach50)}</span> / 80%到達:{" "}
        <span className="font-semibold">{reach(curve.reach80)}</span>
      </p>
      {points.length === 0 && fitted.length === 0 ? (
        <p className="mt-2 rounded-lg bg-slate-50 p-4 text-center text-xs text-slate-400">
          予約曲線のデータがありません（競合カレンダー取得後に表示）
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis
              type="number"
              dataKey="lead"
              domain={[0, horizon]}
              reversed
              ticks={leadTicks(horizon)}
              tickFormatter={leadTick}
              tick={{ fontSize: 10 }}
              allowDataOverflow
            />
            <YAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 80, 100]} unit="%" width={40} tick={{ fontSize: 10 }} />
            <ReferenceLine y={50} stroke="#94a3b8" strokeDasharray="4 4" />
            <ReferenceLine y={80} stroke="#94a3b8" strokeDasharray="4 4" />
            {curve.reach50 !== null && curve.reach50 <= horizon && (
              <ReferenceLine
                x={curve.reach50}
                stroke={color}
                strokeOpacity={0.5}
                strokeDasharray="2 3"
                label={{ value: "50%", position: "insideTopLeft", fontSize: 10, fill: "#475569" }}
              />
            )}
            {curve.reach80 !== null && curve.reach80 <= horizon && (
              <ReferenceLine
                x={curve.reach80}
                stroke={color}
                strokeOpacity={0.5}
                strokeDasharray="2 3"
                label={{ value: "80%", position: "insideTopLeft", fontSize: 10, fill: "#475569" }}
              />
            )}
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as CurveTip | undefined;
                if (!p || p.lead === undefined || p.occ === undefined) return null;
                return (
                  <div className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] shadow">
                    {p.date ? (
                      <p className="font-semibold text-slate-700">
                        {mdw(p.date)}
                        <span className="ml-1 font-normal text-slate-400">
                          {p.source === "snapshot" ? "過去の取得時点" : "現在"}
                        </span>
                      </p>
                    ) : (
                      <p className="font-semibold text-slate-700">平均予約曲線</p>
                    )}
                    <p className="text-slate-600">
                      {leadTick(p.lead)}: 占有率 {num1(p.occ)}%
                    </p>
                  </div>
                );
              }}
            />
            <Scatter name="観測値" data={points} dataKey="occ" fill={color} fillOpacity={0.22} isAnimationActive={false} />
            <Line
              name="平均予約曲線"
              data={fitted}
              dataKey="occ"
              type="monotone"
              stroke={color}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

interface TrendRow {
  label: string;
  date: string;
  recommended: number;
  current: number | null;
  currentAssumed: number | null;
  compAdr: number | null;
  wk: number;
}

/** 6. 平日 vs 週末 ディープダイブ + 60日の価格推移 */
export default function DeepDive({ d }: { d: PricingDashboard }) {
  const rows: TrendRow[] = d.days.map((day) => {
    const cur = day.own.currentPrice;
    const assumed = day.own.currentPriceSource === "assumed";
    return {
      label: md(day.date),
      date: day.date,
      recommended: day.pricing.recommended,
      current: cur !== null && !assumed ? cur : null,
      currentAssumed: cur !== null && assumed ? cur : null,
      compAdr: day.market.compAdr,
      wk: day.night.type === "weekend" ? 1 : 0,
    };
  });
  const hasReal = rows.some((r) => r.current !== null);
  const hasAssumed = rows.some((r) => r.currentAssumed !== null);
  const hasAdr = rows.some((r) => r.compAdr !== null);
  // 価格軸の範囲はデータから明示的に求める (週末の帯用の隠し軸と併用すると自動範囲が効かず、
  // 目盛りが出ない・線が上にはみ出すため)
  const prices = rows
    .flatMap((r) => [r.recommended, r.current, r.currentAssumed, r.compAdr])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  const pLo = prices.length ? Math.min(...prices) : 0;
  const pHi = prices.length ? Math.max(...prices) : 1;
  const pad = Math.max((pHi - pLo) * 0.08, 5000);
  const yDomain: [number, number] = [
    Math.max(0, Math.floor((pLo - pad) / 10000) * 10000),
    Math.ceil((pHi + pad) / 10000) * 10000,
  ];

  return (
    <Card
      title="平日 vs 週末 ディープダイブ"
      right={`横軸 = リードタイム（左: ${d.horizonDays}日前 → 右: 当日）`}
    >
      <p className="mb-2 text-[11px] text-slate-500">
        競合の占有率が宿泊日の何日前にどこまで埋まるか（予約曲線）。点 = 各宿泊日の観測、線 = 平均予約曲線、破線 = 50% / 80%。
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <CurveChart title="平日（日〜木）" curve={d.curves.weekday} horizon={d.horizonDays} color="#0284c7" />
        <CurveChart title="週末・ハイバリュー日（金土・祝前日・連休）" curve={d.curves.weekend} horizon={d.horizonDays} color={C_REC} />
      </div>

      <div className="mt-4">
        <p className="text-xs font-bold text-slate-800">{d.horizonDays}日の価格推移</p>
        <p className="text-[11px] text-slate-500">薄い帯 = 週末・ハイバリュー日</p>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={0}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={18} />
            <YAxis
              yAxisId="p"
              orientation="left"
              type="number"
              domain={yDomain}
              allowDataOverflow
              tickCount={5}
              tickFormatter={(v: number) => yenK(v)}
              width={48}
              tick={{ fontSize: 10 }}
            />
            <YAxis yAxisId="bg" orientation="right" hide type="number" domain={[0, 1]} />
            <Tooltip
              formatter={(v, name) => [yen(Number(v)), String(name)]}
              labelFormatter={(_l, pl) => {
                const p = pl?.[0]?.payload as TrendRow | undefined;
                return p ? `${mdw(p.date)}${p.wk ? "（週末）" : ""}` : "";
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar
              yAxisId="bg"
              dataKey="wk"
              fill="#e0e7ff"
              fillOpacity={0.6}
              legendType="none"
              tooltipType="none"
              isAnimationActive={false}
            />
            <Line
              yAxisId="p"
              name="推奨価格"
              dataKey="recommended"
              stroke={C_REC}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {hasReal && (
              <Line
                yAxisId="p"
                name="現在価格"
                dataKey="current"
                stroke={C_CUR}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {hasAssumed && (
              <Line
                yAxisId="p"
                name="現在価格（仮定）"
                dataKey="currentAssumed"
                stroke={C_CUR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeOpacity={0.6}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {hasAdr && (
              <Line
                yAxisId="p"
                name="競合中央価格"
                dataKey="compAdr"
                stroke={C_ADR}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
