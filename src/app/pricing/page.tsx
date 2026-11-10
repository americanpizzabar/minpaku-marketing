import { Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import PricingView from "@/components/pricing/PricingView";
import { getPricingDashboard } from "@/lib/pricing";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const dashboard = await getPricingDashboard();
  const generated = new Date(dashboard.generatedAt);
  const generatedLabel = Number.isNaN(generated.getTime())
    ? ""
    : generated.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Suspense>
        {/* 価格最適化は CompSet 独自の条件で分析するため、共通の検索フィルタは出さない */}
        <Sidebar dataSource={dashboard.dataSource} showFilters={false} />
      </Suspense>
      <main className="min-w-0 flex-1 space-y-4 p-4 lg:p-6">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">価格最適化</h2>
          <p className="text-xs text-slate-500">
            競合の予約状況と消化ペースから、向こう{dashboard.horizonDays}日の推奨価格を日次で算出します
            {generatedLabel && `（${generatedLabel} 算出）`}
          </p>
        </div>

        <PricingView d={dashboard} />

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Dynamic Pricing / データソース: AirROI API
          {dashboard.dataSource === "demo" && " (現在はデモデータを表示中)"}
        </footer>
      </main>
    </div>
  );
}
