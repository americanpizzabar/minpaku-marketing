import { Suspense } from "react";
import DashboardTabs from "@/components/DashboardTabs";
import KpiCards from "@/components/KpiCards";
import PropertyTable from "@/components/PropertyTable";
import Sidebar from "@/components/Sidebar";
import { getDashboardData, parseFilters } from "@/lib/analytics";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const data = await getDashboardData(filters);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Suspense>
        <Sidebar dataSource={data.dataSource} />
      </Suspense>
      <main className="flex-1 space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-slate-900">
              マーケット概況
            </h2>
            <p className="text-xs text-slate-500">{data.periodLabel}</p>
          </div>
          {data.lastSyncedAt && (
            <p className="text-xs text-slate-400">最終同期: {data.lastSyncedAt} (UTC)</p>
          )}
        </div>

        <KpiCards
          kpis={data.kpis}
          kpisTop20={data.kpisTop20}
          visibleCards={data.visibleKpiCards}
        />

        <DashboardTabs
          scatter={data.scatter}
          trend={data.trend}
          benchmark={data.benchmark}
          capacityBars={data.capacityBars}
        />

        <PropertyTable rows={data.rows} />

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Market Intelligence / データソース: AirROI API
          {data.dataSource === "demo" && " (現在はデモデータを表示中)"}
        </footer>
      </main>
    </div>
  );
}
