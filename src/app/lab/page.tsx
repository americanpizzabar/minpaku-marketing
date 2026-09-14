import { Suspense } from "react";
import RevenueLabView from "@/components/RevenueLabView";
import Sidebar from "@/components/Sidebar";
import { parseFilters } from "@/lib/analytics";
import { loadDataset } from "@/lib/data";
import { todayJst, toDateStr } from "@/lib/dates";
import { getRevenueLab } from "@/lib/revenue-lab";

export const dynamic = "force-dynamic";

export default async function LabPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const [lab, ds] = await Promise.all([
    getRevenueLab(filters),
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
          <h2 className="text-xl font-bold tracking-tight text-slate-900">収益最適化ラボ</h2>
          <p className="text-xs text-slate-500">
            回帰分析・価格弾力性・数理最適化で、{lab.luminaTitle} の適正価格と収益機会を定量化します
          </p>
        </div>

        <RevenueLabView lab={lab} />

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Revenue Science / データソース: AirROI API
          {ds.dataSource === "demo" && " (現在はデモデータを表示中)"}
        </footer>
      </main>
    </div>
  );
}
