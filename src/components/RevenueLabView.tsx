"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RevenueLab } from "@/lib/revenue-lab";

const yen = (v: number) => `¥${Math.round(v).toLocaleString("ja-JP")}`;
const yenK = (v: number) => `¥${Math.round(v / 1000)}k`;

export default function RevenueLabView({ lab }: { lab: RevenueLab }) {
  if (!lab.available) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        {lab.reason}
      </div>
    );
  }

  const featBars = lab.featureEffects.slice(0, 14);

  return (
    <div className="space-y-4">
      {/* 収益機会 & 判定 */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-emerald-300 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-emerald-700">価格最適化による増収余地/年</p>
          <p className="mt-1 text-3xl font-bold tracking-tight text-emerald-700">
            {lab.annualPricingOpportunity && lab.annualPricingOpportunity > 0
              ? `+${yen(lab.annualPricingOpportunity)}`
              : "適正圏内"}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            1室あたり・最良価格帯のRevPAR中央値と現行の差 ×365日
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:col-span-2">
          <p className="text-xs font-semibold text-slate-500">価格ポジション判定</p>
          <p className="mt-1 text-sm font-medium leading-relaxed text-slate-800">{lab.pricingVerdict}</p>
          <p className="mt-2 text-[11px] text-slate-500">
            現行RevPAR {lab.currentLuminaRevpar ? yen(lab.currentLuminaRevpar) : "—"} ／ 最良価格帯のRevPAR中央値{" "}
            {lab.bestBandRevpar ? yen(lab.bestBandRevpar) : "—"}
          </p>
        </div>
      </div>

      {/* 実証的 適正価格帯 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">適正価格帯の実証分析（RevPAR最大の価格帯）</h3>
          <p className="text-xs text-slate-500">{lab.compBasis} {lab.comparableCount}物件を価格5分位で評価</p>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          近接する競合を価格帯に分け、各帯のRevPAR中央値を比較。緑=最もRevPARが高い価格帯（＝狙うべき価格）、青枠=自物件の現行価格帯。
        </p>
        {lab.priceBands.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={lab.priceBands} margin={{ top: 10, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="rp" tickFormatter={yenK} tick={{ fontSize: 11 }} width={54}
                label={{ value: "RevPAR中央値", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <YAxis yAxisId="oc" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v, name) =>
                  name === "稼働率中央値" ? [`${v}%`, name] : [yen(Number(v)), name]
                }
                labelFormatter={(l, pl) => {
                  const p = pl?.[0]?.payload as { count?: number } | undefined;
                  return `価格帯 ${l}${p?.count != null ? ` (${p.count}物件)` : ""}`;
                }}
              />
              <Bar yAxisId="rp" dataKey="medRevpar" name="RevPAR中央値" radius={[4, 4, 0, 0]}>
                {lab.priceBands.map((b, i) => (
                  <Cell
                    key={i}
                    fill={b.isBest ? "#10b981" : "#c7d2fe"}
                    stroke={b.isCurrent ? "#4f46e5" : undefined}
                    strokeWidth={b.isCurrent ? 3 : 0}
                  />
                ))}
              </Bar>
              <Line yAxisId="oc" type="monotone" dataKey="medOcc" name="稼働率中央値" stroke="#f59e0b" strokeWidth={1.5} dot={{ r: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-500">価格帯分析に十分な近接競合がありませんでした。</p>
        )}
        {lab.bestBandLo && lab.bestBandHi && (
          <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-slate-700">
            💡 実データ上、RevPARが最大になるのは <span className="font-bold">¥{lab.bestBandLo.toLocaleString("ja-JP")}〜¥{lab.bestBandHi.toLocaleString("ja-JP")}</span> の価格帯
            （RevPAR中央値 {lab.bestBandRevpar ? yen(lab.bestBandRevpar) : "—"}）。
          </p>
        )}
      </div>

      {/* ヘドニック回帰: 機能の価格効果 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">価格ドライバー分析（ヘドニック回帰・対数価格モデル）</h3>
          <p className="text-xs text-slate-500">
            説明力 R² <span className="font-bold text-slate-800">{lab.r2}</span> ／ {lab.sampleSize}物件で学習
          </p>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          各要素がADRを何%押し上げ/押し下げるかを多重回帰で推定（他条件を一定とした純粋効果）。コモディティ設備は除外し差別化設備のみ対象。
        </p>
        <ResponsiveContainer width="100%" height={Math.max(240, featBars.length * 30)}>
          <BarChart data={featBars} layout="vertical" margin={{ top: 4, right: 70, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" unit="%" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(v, _n, o) => [
                `${Number(v) >= 0 ? "+" : ""}${v}% (${yen(Number(o?.payload?.yenAtMedian ?? 0))}相当)`,
                "ADR効果",
              ]}
            />
            <Bar dataKey="pctEffect" name="ADR効果" radius={[0, 4, 4, 0]}>
              {featBars.map((f, i) => (
                <Cell
                  key={i}
                  fill={
                    f.kind === "amenity"
                      ? f.pctEffect >= 0 ? "#0ea5e9" : "#cbd5e1"
                      : f.kind === "area"
                        ? "#a78bfa"
                        : f.pctEffect >= 0 ? "#6366f1" : "#f43f5e"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-[11px] text-slate-500">モデルが示す適正ADR</p>
            <p className="text-lg font-bold text-slate-900">{lab.predictedLuminaAdr ? yen(lab.predictedLuminaAdr) : "—"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-[11px] text-slate-500">現行ADR</p>
            <p className="text-lg font-bold text-slate-900">{lab.currentLuminaAdr ? yen(lab.currentLuminaAdr) : "—"}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-[11px] text-slate-500">乖離</p>
            <p className="text-lg font-bold text-slate-900">
              {lab.priceGapPct === null ? "—" : `${lab.priceGapPct >= 0 ? "+" : ""}${lab.priceGapPct}%`}
            </p>
          </div>
        </div>
        {lab.r2 < 0.5 && (
          <p className="mt-2 text-[11px] text-amber-600">
            ※ R²が低め＝価格は立地・眺望・内装デザイン等の数値化できない要素に強く依存します。適正ADRはあくまで平均的傾向の目安としてご覧ください。
          </p>
        )}
      </div>

      {/* 差別化設備ギャップ */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-bold text-slate-900">差別化設備：上位パフォーマーの保有率と自物件</h3>
        <p className="mb-2 text-xs text-slate-500">
          RevPAR上位25%の物件がどの差別化設備を持つか。橙=自物件が未保有で上位勢の保有率が高い＝導入検討の優先候補。
        </p>
        {lab.valueDriverGaps.length === 0 ? (
          <p className="text-xs text-slate-500">差別化設備データを集計できませんでした（詳細未取得/デモモード）。</p>
        ) : (
          <div className="space-y-1.5">
            {lab.valueDriverGaps.map((g) => (
              <div key={g.name} className="flex items-center gap-2 text-xs">
                <span className={`w-10 shrink-0 text-right font-semibold ${g.topPct >= 50 ? "text-emerald-600" : "text-slate-600"}`}>
                  {g.topPct}%
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded bg-slate-100">
                  <div className={`h-full ${g.luminaHas ? "bg-emerald-400" : "bg-orange-400"}`} style={{ width: `${g.topPct}%` }} />
                </div>
                <span className="w-44 shrink-0 truncate text-slate-700">{g.name}</span>
                <span className="w-24 shrink-0 text-right text-slate-500" title="保有/非保有の平均RevPAR差">
                  {g.upliftRevpar >= 0 ? "+" : ""}{yen(g.upliftRevpar)}
                </span>
                <span className={`w-14 shrink-0 text-right font-semibold ${g.luminaHas ? "text-emerald-600" : "text-orange-600"}`}>
                  {g.luminaHas ? "保有" : "未保有"}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-slate-400">
          左=上位勢の保有率／右端の金額=保有/非保有のRevPAR差（相関。導入効果は費用対効果と併せて判断）。
        </p>
      </div>

      {/* 手法 */}
      <details className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
        <summary className="cursor-pointer font-semibold text-slate-700">分析手法と限界について</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>ヘドニック価格回帰</b>: log(ADR) をスペック・差別化設備・エリアで説明する多重回帰(Ridge)。各要素の「他条件一定での価格効果(%)」を分離。R²は説明力。</li>
          <li><b>適正価格帯</b>: 異質な物件を横断した価格-稼働の回帰は需要曲線を識別できない(交絡)ため、<b>近接競合を価格帯に分けRevPAR中央値を比較する経験分布</b>で最良価格帯を特定しています。</li>
          <li><b>差別化設備</b>: コモディティ(Wi-Fi等)を除外し、収益に効きうる設備のみ対象。数値は相関であり、導入の因果効果を保証しません。</li>
          <li>設定画面で自物件のスペック(評価・レビュー・写真・設備・稼働率)を登録すると精度が上がります。</li>
        </ul>
      </details>
    </div>
  );
}
