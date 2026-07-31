import { Suspense } from "react";
import SettingsPanel from "@/components/SettingsPanel";
import Sidebar from "@/components/Sidebar";
import SyncControls from "@/components/SyncControls";
import { loadDataset } from "@/lib/data";
import { todayJst, toDateStr } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // データソースのバッジ表示にのみ使用 (集計は不要なので当日1日分だけ読む)
  const today = toDateStr(todayJst());
  const ds = await loadDataset(today, today, today, today);

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Suspense>
        <Sidebar dataSource={ds.dataSource} />
      </Suspense>
      <main className="flex-1 space-y-4 p-4 lg:p-6">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900">設定</h2>
          <p className="text-xs text-slate-500">
            データ取得の設定と手動同期。API料金が発生する操作はこのページに集約されています。
          </p>
        </div>

        <SyncControls />

        <div className="max-w-xl">
          <SettingsPanel defaultOpen />
        </div>

        <footer className="pb-4 text-center text-xs text-slate-400">
          Lumina Fuji Residence Yamanakako — Market Intelligence
        </footer>
      </main>
    </div>
  );
}
