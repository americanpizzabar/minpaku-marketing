import type {
  CompetitiveAnalysis,
  MetricComparison,
} from "@/lib/analysis";

function fmt(v: number | null, unit: MetricComparison["unit"]): string {
  if (v == null) return "—";
  switch (unit) {
    case "yen":
      return `¥${Math.round(v).toLocaleString("ja-JP")}`;
    case "pct":
      return `${v.toFixed(1)}%`;
    case "star":
      return `★${v.toFixed(2)}`;
    case "nights":
      return `${v}泊`;
    default:
      return `${Math.round(v * 10) / 10}`;
  }
}

const prioStyle: Record<string, string> = {
  high: "border-rose-300 bg-rose-50",
  mid: "border-amber-300 bg-amber-50",
  low: "border-slate-200 bg-slate-50",
};
const prioLabel: Record<string, string> = { high: "優先度：高", mid: "優先度：中", low: "参考" };
const prioBadge: Record<string, string> = {
  high: "bg-rose-500 text-white",
  mid: "bg-amber-500 text-white",
  low: "bg-slate-400 text-white",
};

export default function AnalysisView({ a }: { a: CompetitiveAnalysis }) {
  if (!a.available) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        {a.reason}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 勝ち組の定義 */}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
        <h3 className="text-sm font-bold text-slate-900">「勝ち組」競合の抽出条件</h3>
        <p className="mt-1 text-xs text-slate-600">
          高単価かつ高稼働（{a.criteria}）を満たす <span className="font-bold">{a.winnerCount}物件</span>
          （全{a.totalCount}物件中）を「勝ち組」として、そのスペックを {a.luminaTitle} と比較しています。
        </p>
        {!a.luminaSpecKnown && (
          <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-amber-700">
            ⚠️ 自物件のスペック（評価・レビュー数・写真枚数・保有設備）が未登録です。
            設定画面（⚙）で登録すると、評価・設備のギャップまで精密に分析できます。
          </p>
        )}
      </div>

      {/* 提言 */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-slate-900">
          {a.luminaTitle} が勝ち組を追い越すための提言
        </h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {a.recommendations.map((r, i) => (
            <div key={i} className={`rounded-lg border p-3 ${prioStyle[r.priority]}`}>
              <div className="flex items-start gap-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${prioBadge[r.priority]}`}
                >
                  {prioLabel[r.priority]}
                </span>
                <div>
                  <p className="text-sm font-bold text-slate-800">{r.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">{r.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 指標比較 */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-bold text-slate-900">スペック比較</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-2 font-semibold">指標</th>
                  <th className="py-1.5 px-2 text-right font-semibold">勝ち組平均</th>
                  <th className="py-1.5 px-2 text-right font-semibold">市場平均</th>
                  <th className="py-1.5 pl-2 text-right font-semibold">{a.luminaTitle}</th>
                </tr>
              </thead>
              <tbody>
                {a.metrics.map((mtr) => (
                  <tr key={mtr.key} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 font-medium text-slate-700">{mtr.label}</td>
                    <td className="py-1.5 px-2 text-right font-semibold text-slate-900">
                      {fmt(mtr.winner, mtr.unit)}
                    </td>
                    <td className="py-1.5 px-2 text-right text-slate-500">
                      {fmt(mtr.market, mtr.unit)}
                    </td>
                    <td
                      className={`py-1.5 pl-2 text-right font-semibold ${
                        mtr.behind ? "text-rose-600" : "text-slate-900"
                      }`}
                    >
                      {fmt(mtr.lumina, mtr.unit)}
                      {mtr.behind && <span className="ml-1 text-[10px]">▼不足</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            赤字「▼不足」= 勝ち組平均に対して自物件が劣後している指標
          </p>
        </div>

        {/* 設備ギャップ */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-bold text-slate-900">
            勝ち組の主要設備と自物件の保有状況
          </h3>
          {a.amenityGaps.length === 0 ? (
            <p className="text-xs text-slate-500">
              設備データを集計できませんでした（詳細データ未取得、またはデモモード）。設定の「物件情報を今すぐ更新」で取得されます。
            </p>
          ) : (
            <div className="space-y-1.5">
              {a.amenityGaps.map((g) => (
                <div key={g.name} className="flex items-center gap-2 text-xs">
                  <span
                    className={`w-12 shrink-0 text-right font-semibold ${
                      g.winnerPct >= 60 ? "text-rose-600" : "text-slate-600"
                    }`}
                  >
                    {g.winnerPct}%
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
                    <div
                      className={`h-full ${g.luminaHas ? "bg-emerald-400" : "bg-rose-400"}`}
                      style={{ width: `${g.winnerPct}%` }}
                    />
                  </div>
                  <span className="w-40 shrink-0 truncate text-slate-700">{g.name}</span>
                  <span
                    className={`w-16 shrink-0 text-right font-semibold ${
                      g.luminaHas ? "text-emerald-600" : "text-rose-600"
                    }`}
                  >
                    {g.luminaHas ? "保有" : "未保有"}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-400">
            数値=勝ち組の保有率／緑=自物件も保有・赤=自物件は未保有(導入検討候補)
          </p>
        </div>
      </div>

      {/* 勝ち組リスト */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-bold text-slate-900">勝ち組物件（RevPAR上位）</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="py-1.5 pr-2 font-semibold">物件名</th>
                <th className="py-1.5 px-2 font-semibold">エリア</th>
                <th className="py-1.5 px-2 text-right font-semibold">ADR</th>
                <th className="py-1.5 px-2 text-right font-semibold">稼働率</th>
                <th className="py-1.5 px-2 text-right font-semibold">RevPAR</th>
                <th className="py-1.5 px-2 text-right font-semibold">評価</th>
                <th className="py-1.5 pl-2 text-right font-semibold">定員/寝室</th>
              </tr>
            </thead>
            <tbody>
              {a.winners.map((w, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="max-w-64 truncate py-1.5 pr-2 font-medium text-slate-800">
                    {w.url ? (
                      <a href={w.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-600 hover:underline">
                        {w.title}
                      </a>
                    ) : (
                      w.title
                    )}
                  </td>
                  <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{w.area}</td>
                  <td className="py-1.5 px-2 text-right text-slate-800">¥{w.adr.toLocaleString("ja-JP")}</td>
                  <td className="py-1.5 px-2 text-right text-slate-800">{w.occ.toFixed(1)}%</td>
                  <td className="py-1.5 px-2 text-right font-semibold text-slate-900">¥{w.revpar.toLocaleString("ja-JP")}</td>
                  <td className="py-1.5 px-2 text-right text-slate-600">{w.rating != null ? `★${w.rating.toFixed(2)}` : "—"}</td>
                  <td className="py-1.5 pl-2 text-right whitespace-nowrap text-slate-600">{w.maxGuests}名/{w.bedrooms}室</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
