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
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                data.dataMode === "actual"
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-sky-100 text-sky-700"
              }`}
            >
              {data.dataMode === "actual"
                ? `実績ベース (ADR・稼働率は過去実績)｜将来分析はカレンダー取得済 ${data.calendarCount}物件`
                : "全物件カレンダーベース"}
            </span>
          </div>
          {data.lastSyncedAt && (
            <p className="text-xs text-slate-400">最終同期: {data.lastSyncedAt} (UTC)</p>
          )}
        </div>

        <KpiCards
          kpis={data.kpis}
          kpisTop20={data.kpisTop20}
          kpisLumina={data.kpisLumina}
          visibleCards={data.visibleKpiCards}
        />

        <DashboardTabs
          scatter={data.scatter}
          trend={data.trend}
          benchmark={data.benchmark}
          capacityBars={data.capacityBars}
        />

        <PropertyTable rows={data.rows} columnIds={data.visibleTableColumns} />

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Market Intelligence / データソース: AirROI API
          {data.dataSource === "demo" && " (現在はデモデータを表示中)"}
        </footer>
      </main>
    </div>
  );
}
