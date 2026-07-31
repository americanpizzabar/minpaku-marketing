"use client";

import { useMemo, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { MapPoint } from "@/lib/types";

const METRICS = [
  { key: "occupancyRate", label: "稼働率", isPercent: true },
  { key: "adr", label: "ADR (販売価格)", isPercent: false },
  { key: "pricePerGuest", label: "1人単価", isPercent: false },
  { key: "l90dOccupancy", label: "実稼働 (過去90日)", isPercent: true },
  { key: "l90dAvgRate", label: "実単価 (過去90日)", isPercent: false },
] as const;
type MetricKey = (typeof METRICS)[number]["key"];

const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;

function metricValue(p: MapPoint, key: MetricKey): number | null {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 0(低)→1(高) を青→黄→赤のカラースケールに変換 */
function colorFor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return `hsl(${Math.round(220 - clamped * 220)}, 78%, 48%)`;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

export default function MapPanel({ points }: { points: MapPoint[] }) {
  const [metric, setMetric] = useState<MetricKey>("occupancyRate");
  const meta = METRICS.find((m) => m.key === metric)!;

  // 色スケールの範囲: %は0-100固定、価格系は外れ値の影響を避けて10-90パーセンタイル
  const [lo, hi] = useMemo(() => {
    if (meta.isPercent) return [0, 100];
    const values = points
      .filter((p) => !p.isLumina)
      .map((p) => metricValue(p, metric))
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    if (values.length === 0) return [0, 1];
    const l = quantile(values, 0.1);
    const h = quantile(values, 0.9);
    return h > l ? [l, h] : [l, l + 1];
  }, [points, metric, meta.isPercent]);

  const format = (v: number) => (meta.isPercent ? `${v.toFixed(1)}%` : yen(v));

  const center: [number, number] = [35.47, 138.79];
  const competitors = points.filter((p) => !p.isLumina);
  const lumina = points.filter((p) => p.isLumina);
  const missing = competitors.filter((p) => metricValue(p, metric) === null).length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs font-semibold text-slate-500">色分け:</span>
        {METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              metric === m.key
                ? "bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="relative overflow-hidden rounded-lg" style={{ height: "70vh" }}>
        <MapContainer center={center} zoom={12} style={{ height: "100%", width: "100%" }}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {competitors.map((p) => {
            const v = metricValue(p, metric);
            const t = v === null ? 0 : (v - lo) / (hi - lo);
            return (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lng]}
                radius={Math.min(14, 5 + p.maxGuests * 0.7)}
                pathOptions={{
                  color: "#ffffff",
                  weight: 1,
                  fillColor: v === null ? "#94a3b8" : colorFor(t),
                  fillOpacity: v === null ? 0.4 : 0.85,
                }}
              >
                <Popup>
                  <div className="text-xs" style={{ minWidth: 180 }}>
                    <p className="mb-1 font-bold">{p.title}</p>
                    <p>
                      {p.area} / 定員{p.maxGuests}名 / 寝室{p.bedrooms}
                      {p.rating != null ? ` / ★${p.rating.toFixed(2)}` : ""}
                    </p>
                    <p className="mt-1">
                      ADR {yen(p.adr)} / 稼働率 {p.occupancyRate.toFixed(1)}%
                    </p>
                    {p.l90dAvgRate != null && (
                      <p>
                        実績90日: {yen(p.l90dAvgRate)} /{" "}
                        {p.l90dOccupancy != null ? `${p.l90dOccupancy.toFixed(1)}%` : "—"}
                      </p>
                    )}
                    {v !== null && (
                      <p className="mt-1 font-semibold">
                        {meta.label}: {format(v)}
                      </p>
                    )}
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        Airbnbで開く ↗
                      </a>
                    )}
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
          {lumina.map((p) => (
            <CircleMarker
              key={p.id}
              center={[p.lat, p.lng]}
              radius={13}
              pathOptions={{ color: "#be123c", weight: 3, fillColor: "#f43f5e", fillOpacity: 0.9 }}
            >
              <Popup>
                <div className="text-xs" style={{ minWidth: 180 }}>
                  <p className="mb-1 font-bold">★ {p.title}</p>
                  <p>
                    ADR {yen(p.adr)} / 稼働率 {p.occupancyRate.toFixed(1)}%
                  </p>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      Airbnbで開く ↗
                    </a>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        {/* 凡例 */}
        <div className="absolute right-3 bottom-3 z-[1000] rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow">
          <p className="mb-1 font-semibold text-slate-700">{meta.label}</p>
          <div
            className="h-2 w-36 rounded"
            style={{
              background: `linear-gradient(to right, ${colorFor(0)}, ${colorFor(0.5)}, ${colorFor(1)})`,
            }}
          />
          <div className="flex justify-between text-slate-500">
            <span>{format(lo)}</span>
            <span>{format(hi)}</span>
          </div>
          <p className="mt-1 flex items-center gap-1 text-slate-500">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-rose-700 bg-rose-500" />
            Lumina Fuji
          </p>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        マーカーの大きさ=定員。タップで物件詳細とAirbnbリンクを表示します。
        Airbnbの仕様上、座標は最大150m程度ぼかされている場合があります。
        {missing > 0 && ` グレーの${missing}件は選択中の指標のデータ未取得です。`}
      </p>
    </div>
  );
}
