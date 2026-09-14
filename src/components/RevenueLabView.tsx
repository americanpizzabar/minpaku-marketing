"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
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

  const annualTotal =
    (lab.annualPricingOpportunity ?? 0) + (lab.annualAmenityOpportunity ?? 0);

  // 機能価値: 円寄与の大きい順 (絶対値)
  const featBars = [...lab.featureValues]
    .filter((f) => Math.abs(f.coefYen) >= 300)
    .sort((a, b) => Math.abs(b.coefYen) - Math.abs(a.coefYen))
    .slice(0, 14)
    .map((f) => ({ ...f }));

  return (
    <div className="space-y-4">
      {/* 収益機会ヘッドライン */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-emerald-300 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-sm md:col-span-1">
          <p className="text-xs font-semibold text-emerald-700">推定 年間収益機会 (合計)</p>
          <p className="mt-1 text-3xl font-bold tracking-tight text-emerald-700">
            {annualTotal > 0 ? `+${yen(annualTotal)}` : "—"}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">1室あたり・価格最適化＋設備導入の合算(保守的推計)</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">価格最適化による増収/年</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">
            {lab.annualPricingOpportunity ? `+${yen(lab.annualPricingOpportunity)}` : "—"}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            現行RevPAR {lab.currentRevpar ? yen(lab.currentRevpar) : "—"} → 最適 {lab.optimalRevpar ? yen(lab.optimalRevpar) : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold text-slate-500">設備導入による増収余地/年</p>
          <p className="mt-1 text-2xl font-bold text-slate-900">
            {lab.annualAmenityOpportunity ? `+${yen(lab.annualAmenityOpportunity)}` : "—"}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">未保有の高貢献設備トップ3 (効果50%で保守計上)</p>
        </div>
      </div>

      {/* 価格弾力性 & 最適価格 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">価格弾力性と RevPAR最大化価格</h3>
          <p className="text-xs text-slate-500">
            価格弾力性 <span className="font-bold text-slate-800">{lab.elasticity ?? "—"}</span>
            {lab.elasticity !== null && Math.abs(lab.elasticity) > 1 ? "（弾力的：値下げで需要が大きく反応）" : lab.elasticity !== null ? "（非弾力的：値上げ耐性あり）" : ""}
            {" ／ 比較群 "}{lab.comparableCount}物件
          </p>
        </div>
        {lab.elasticityCurve.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={lab.elasticityCurve} margin={{ top: 10, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="price" tickFormatter={yenK} tick={{ fontSize: 11 }} />
              <YAxis yAxisId="rp" tickFormatter={yenK} tick={{ fontSize: 11 }} width={54}
                label={{ value: "RevPAR", angle: -90, position: "insideLeft", fontSize: 11 }} />
              <YAxis yAxisId="oc" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v, name) => (name === "稼働率" ? [`${v}%`, name] : [yen(Number(v)), name])}
                labelFormatter={(l) => `価格 ${yen(Number(l))}`}
              />
              <Line yAxisId="rp" type="monotone" dataKey="revpar" name="RevPAR" stroke="#4f46e5" strokeWidth={2.5} dot={false} />
              <Line yAxisId="oc" type="monotone" dataKey="occ" name="稼働率" stroke="#10b981" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
              {lab.optimalPrice && (
                <ReferenceLine yAxisId="rp" x={lab.optimalPrice} stroke="#4f46e5" strokeDasharray="4 2"
                  label={{ value: `最適 ${yenK(lab.optimalPrice)}`, fontSize: 10, fill: "#4f46e5", position: "top" }} />
              )}
              {lab.currentLuminaAdr && (
                <ReferenceLine yAxisId="rp" x={lab.currentLuminaAdr} stroke="#f43f5e" strokeDasharray="4 2"
                  label={{ value: `現行 ${yenK(lab.currentLuminaAdr)}`, fontSize: 10, fill: "#f43f5e", position: "top" }} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-500">比較群が不足しているため弾力性を推定できませんでした。</p>
        )}
        {lab.optimalPrice && lab.currentLuminaAdr && (
          <p className="mt-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-slate-700">
            💡 需要曲線から、RevPARが最大になる価格は <span className="font-bold">{yen(lab.optimalPrice)}</span>。
            現行 {yen(lab.currentLuminaAdr)} との差は{" "}
            <span className="font-bold">{lab.optimalPrice >= lab.currentLuminaAdr ? "+" : ""}{yen(lab.optimalPrice - lab.currentLuminaAdr)}</span>
            {lab.optimalPrice >= lab.currentLuminaAdr ? "（値上げ余地）" : "（現行がやや高め）"}。
          </p>
        )}
      </div>

      {/* ヘドニック回帰: 機能の金額価値 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">機能の金額価値（ヘドニック価格回帰）</h3>
          <p className="text-xs text-slate-500">
            適合度 R² <span className="font-bold text-slate-800">{lab.r2}</span> ／ {lab.sampleSize}物件で学習
          </p>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          スペック・設備がADRに与える純粋な寄与額を多重回帰で推定。プラス＝価格を押し上げる要素。
        </p>
        <ResponsiveContainer width="100%" height={Math.max(240, featBars.length * 30)}>
          <BarChart data={featBars} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" tickFormatter={yenK} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="label" width={130} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v) => [yen(Number(v)), "ADR寄与"]} />
            <ReferenceLine x={0} stroke="#94a3b8" />
            <Bar dataKey="coefYen" name="ADR寄与" radius={[0, 4, 4, 0]}>
              {featBars.map((f, i) => (
                <Cell
                  key={i}
                  fill={
                    f.kind === "amenity"
                      ? f.coefYen >= 0
                        ? "#0ea5e9"
                        : "#cbd5e1"
                      : f.coefYen >= 0
                        ? "#6366f1"
                        : "#f43f5e"
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
          <div className={`rounded-lg p-3 ${lab.priceGap && lab.priceGap > 0 ? "bg-emerald-50" : "bg-rose-50"}`}>
            <p className="text-[11px] text-slate-500">乖離（適正−現行）</p>
            <p className={`text-lg font-bold ${lab.priceGap && lab.priceGap > 0 ? "text-emerald-700" : "text-rose-700"}`}>
              {lab.priceGap === null ? "—" : `${lab.priceGap >= 0 ? "+" : ""}${yen(lab.priceGap)}`}
            </p>
          </div>
        </div>
      </div>

      {/* アメニティの収益貢献 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-1 text-sm font-bold text-slate-900">設備の収益貢献（RevPAR差分）</h3>
        <p className="mb-2 text-xs text-slate-500">
          その設備を「持つ物件」と「持たない物件」の平均RevPAR差。赤枠=自物件が未保有＝導入で伸ばせる可能性。
        </p>
        <ResponsiveContainer width="100%" height={Math.max(220, lab.amenityUplift.length * 30)}>
          <BarChart data={lab.amenityUplift} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" tickFormatter={yenK} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, _n, o) => [yen(Number(v)), `RevPAR差 (保有率${o?.payload?.adoption}%)`]} />
            <ReferenceLine x={0} stroke="#94a3b8" />
            <Bar dataKey="upliftRevpar" name="RevPAR差" radius={[0, 4, 4, 0]}>
              {lab.amenityUplift.map((a, i) => (
                <Cell key={i} fill={a.luminaHas ? "#10b981" : a.upliftRevpar >= 0 ? "#f97316" : "#cbd5e1"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-1 text-[11px] text-slate-400">緑=自物件も保有／橙=未保有(伸びしろ)。相関であり因果を保証するものではありません。</p>
      </div>

      {/* 手法の説明 */}
      <details className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
        <summary className="cursor-pointer font-semibold text-slate-700">分析手法について</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>ヘドニック価格回帰</b>: ADRをスペック・設備・エリアで説明する多重回帰(Ridge正則化)。各要素の「純粋な金額価値」を分離します。R²は説明力(1に近いほど高精度)。</li>
          <li><b>価格弾力性</b>: 比較群の価格と稼働率から需要曲線を推定。RevPAR=価格×稼働率を最大化する価格を数理最適化で算出します。</li>
          <li><b>設備の収益貢献</b>: 保有群/非保有群のRevPAR平均差。相関分析のため、実際の導入判断は費用対効果と併せてご検討ください。</li>
          <li>実績値(過去90日/12ヶ月)が取得済みの場合はそれを、未取得なら表示期間のカレンダー値を用います。設定画面で自物件スペックを登録すると精度が上がります。</li>
        </ul>
      </details>
    </div>
  );
}
