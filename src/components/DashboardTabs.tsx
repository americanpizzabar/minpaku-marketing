"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { formatShortDate } from "@/lib/format";
import type { BenchmarkPoint, CapacityBar, ScatterPoint, TrendPoint } from "@/lib/types";

const TABS = [
  { id: "scatter", label: "価格 × 稼働率 相関" },
  { id: "trend", label: "日別トレンド (Pacing)" },
  { id: "benchmark", label: "ベンチマーク比較" },
  { id: "capacity", label: "定員別単価分布" },
] as const;

const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;

function ScatterTab({ data }: { data: ScatterPoint[] }) {
  const competitors = data.filter((d) => !d.isLumina);
  const lumina = data.filter((d) => d.isLumina);
  return (
    <ResponsiveContainer width="100%" height={420}>
      <ScatterChart margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          type="number"
          dataKey="adr"
          name="ADR"
          tickFormatter={yen}
          tick={{ fontSize: 11 }}
          label={{ value: "平均単価 (ADR)", position: "insideBottom", offset: -4, fontSize: 12 }}
        />
        <YAxis
          type="number"
          dataKey="occupancyRate"
          name="稼働率"
          unit="%"
          domain={[0, 100]}
          tick={{ fontSize: 11 }}
          label={{ value: "稼働率 (%)", angle: -90, position: "insideLeft", fontSize: 12 }}
        />
        <ZAxis type="number" dataKey="maxGuests" range={[40, 320]} name="定員" />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value, name) =>
            name === "ADR" ? yen(Number(value)) : `${value}${name === "稼働率" ? "%" : "名"}`
          }
          labelFormatter={() => ""}
          content={({ payload }) => {
            const p = payload?.[0]?.payload as ScatterPoint | undefined;
            if (!p) return null;
            return (
              <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-md">
                <p className="mb-1 font-semibold text-slate-800">{p.title}</p>
                <p className="text-slate-500">{p.area} / 定員{p.maxGuests}名</p>
                <p className="mt-1">
                  ADR: <span className="font-semibold">{yen(p.adr)}</span> / 稼働率:{" "}
                  <span className="font-semibold">{p.occupancyRate}%</span>
                </p>
              </div>
            );
          }}
        />
        <Legend />
        <Scatter name="競合物件" data={competitors} fill="#6366f1" fillOpacity={0.55} />
        <Scatter name="Lumina Fuji" data={lumina} fill="#f43f5e" shape="star" />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

function TrendTab({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={420}>
      <LineChart data={data} margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fontSize: 11 }} />
        <YAxis
          yAxisId="price"
          tickFormatter={yen}
          tick={{ fontSize: 11 }}
          width={80}
          label={{ value: "平均価格", angle: -90, position: "insideLeft", fontSize: 12 }}
        />
        <YAxis
          yAxisId="occ"
          orientation="right"
          domain={[0, 100]}
          unit="%"
          tick={{ fontSize: 11 }}
        />
        <Tooltip
          labelFormatter={(l) => String(l)}
          formatter={(value, name) =>
            name === "稼働率" ? [`${value}%`, name] : [yen(Number(value)), name]
          }
        />
        <Legend />
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="avgPrice"
          name="競合平均価格"
          stroke="#6366f1"
          strokeWidth={2}
          dot={false}
        />
        <Line
          yAxisId="price"
          type="monotone"
          dataKey="luminaPrice"
          name="Lumina Fuji 設定価格"
          stroke="#f43f5e"
          strokeWidth={2}
          strokeDasharray="6 3"
          dot={false}
          connectNulls
        />
        <Line
          yAxisId="occ"
          type="monotone"
          dataKey="occupancyRate"
          name="稼働率"
          stroke="#10b981"
          strokeWidth={1.5}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function BenchmarkTab({ data }: { data: BenchmarkPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={420}>
      <LineChart data={data} margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={yen} tick={{ fontSize: 11 }} width={80} />
        <Tooltip
          labelFormatter={(l) => String(l)}
          formatter={(value, name) => [yen(Number(value)), name]}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="top20"
          name="上位20% (ハイエンド層)"
          stroke="#8b5cf6"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="areaAvg"
          name="エリア平均"
          stroke="#64748b"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="bottom20"
          name="下位20%"
          stroke="#cbd5e1"
          strokeWidth={2}
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="lumina"
          name="Lumina Fuji"
          stroke="#f43f5e"
          strokeWidth={2.5}
          strokeDasharray="6 3"
          dot={false}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function CapacityTab({ data }: { data: CapacityBar[] }) {
  return (
    <ResponsiveContainer width="100%" height={420}>
      <BarChart data={data} margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
        <YAxis tickFormatter={yen} tick={{ fontSize: 11 }} width={80} />
        <Tooltip
          formatter={(value, name) => [yen(Number(value)), name]}
          labelFormatter={(l, payload) => {
            const count = (payload?.[0]?.payload as CapacityBar | undefined)?.count;
            return `${l}${count != null ? ` (${count}物件)` : ""}`;
          }}
        />
        <Legend />
        <Bar dataKey="avgAdr" name="平均ADR" fill="#6366f1" radius={[4, 4, 0, 0]} />
        <Bar dataKey="avgPricePerGuest" name="1人当たり単価" fill="#a5b4fc" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function DashboardTabs({
  scatter,
  trend,
  benchmark,
  capacityBars,
}: {
  scatter: ScatterPoint[];
  trend: TrendPoint[];
  benchmark: BenchmarkPoint[];
  capacityBars: CapacityBar[];
}) {
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("scatter");

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`-mb-px rounded-t-lg px-4 py-2 text-sm font-medium transition ${
              active === tab.id
                ? "border-b-2 border-indigo-600 text-indigo-700"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active === "scatter" && <ScatterTab data={scatter} />}
      {active === "trend" && <TrendTab data={trend} />}
      {active === "benchmark" && <BenchmarkTab data={benchmark} />}
      {active === "capacity" && <CapacityTab data={capacityBars} />}
    </div>
  );
}
