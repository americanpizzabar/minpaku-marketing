"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 手動同期ボタン (実行前にAPI課金の確認ダイアログを表示する) */
export default function SyncControls() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSync = async () => {
    const ok = window.confirm(
      "手動同期はAirROIのAPI利用料金が発生します。\n\n" +
        "・料金カレンダー更新: 最大 約$4 (取得上限の設定による)\n" +
        "・カタログ更新期限が切れている場合はさらに 約$25\n\n" +
        "実行しますか?",
    );
    if (!ok) return;

    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const json = await res.json();
      if (json.status === "SUCCESS" || json.status === "PARTIAL") {
        const cost = json.estimatedCostUsd != null ? ` / 約$${json.estimatedCostUsd}` : "";
        const extra = json.message ? ` — ${json.message}` : "";
        setMessage(
          `同期${json.status === "PARTIAL" ? "継続中" : "完了"}: 料金更新${json.ratesRefreshed ?? 0}物件 (APIコール${json.apiCalls}回${cost})${extra}`,
        );
        router.refresh();
      } else {
        setMessage(json.message ?? json.error ?? "同期に失敗しました");
      }
    } catch {
      setMessage("同期リクエストに失敗しました");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-bold text-slate-900">データ手動更新</h3>
      <p className="mt-1 text-xs text-slate-500">
        AirROI APIから最新データを取得します。設定した取得上限の範囲でAPI料金が発生します
        (フィルタや検索の操作では料金は一切かかりません)。
      </p>
      <button
        onClick={handleSync}
        disabled={syncing}
        className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50 sm:w-auto sm:px-6"
      >
        {syncing ? "同期中..." : "データ手動更新 (料金発生)"}
      </button>
      {message && <p className="mt-2 text-xs text-slate-500">{message}</p>}
    </div>
  );
}
