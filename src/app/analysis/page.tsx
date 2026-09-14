import { Suspense } from "react";
import AnalysisView from "@/components/AnalysisView";
import Sidebar from "@/components/Sidebar";
import { getCompetitiveAnalysis } from "@/lib/analysis";
import { parseFilters } from "@/lib/analytics";
import { loadDataset } from "@/lib/data";
import { todayJst, toDateStr } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const [analysis, ds] = await Promise.all([
    getCompetitiveAnalysis(filters),
    (async () => {
      const today = toDateStr(todayJst());
      return loadDataset(today, today, today, today);
    })(),
  ]);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Suspense>
        <Sidebar dataSource={ds.dataSource} />
      </Suspense>
      <main className="flex-1 space-y-4 p-4 lg:p-6">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">勝ちパターン分析</h2>
          <p className="text-xs text-slate-500">
            高単価×高稼働の競合を基準に、{analysis.luminaTitle} に足りない要素と追い越し方を提案します
          </p>
        </div>

        <AnalysisView a={analysis} />

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Market Intelligence / データソース: AirROI API
          {ds.dataSource === "demo" && " (現在はデモデータを表示中)"}
        </footer>
      </main>
    </div>
  );
}
