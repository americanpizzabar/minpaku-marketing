"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PropertyRow } from "@/lib/types";
import {
  COLUMN_GROUPS,
  DEFAULT_MAIN_COLUMNS,
  TABLE_COLUMN_DEFS,
  TABLE_COLUMN_IDS,
} from "@/lib/table-columns";
import PropertyTable from "./PropertyTable";

/**
 * 全物件×全項目のデータベース閲覧。全列を常時表示しつつ、
 * 「メイン一覧に表示する列」をチェックで選び、サーバー設定 (config:table_columns) に保存する。
 */
export default function DatabaseTable({
  rows,
  selectedColumns,
}: {
  rows: PropertyRow[];
  selectedColumns: string[]; // 現在メイン一覧に出している列 (空=既定)
}) {
  const router = useRouter();
  const initial = selectedColumns.length > 0 ? selectedColumns : DEFAULT_MAIN_COLUMNS;
  const [selected, setSelected] = useState<string[]>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (id: string, checked: boolean) =>
    setSelected((cur) => (checked ? [...cur, id] : cur.filter((x) => x !== id)));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // TABLE_COLUMN_IDS の順序を保って保存 (メイン一覧の列順が安定する)
      const ordered = TABLE_COLUMN_IDS.filter((id) => selected.includes(id));
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableColumns: ordered }),
      });
      const json = await res.json();
      if (json.saved) {
        setMessage("表示列を保存しました (競合物件一覧に反映されます)");
        router.refresh();
      } else {
        setMessage(json.error ?? "保存に失敗しました");
      }
    } catch {
      setMessage("保存リクエストに失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-slate-900">メイン一覧に表示する列を選択</h3>
            <p className="text-xs text-slate-500">
              チェックした列がダッシュボードの「競合物件一覧」とCSVに表示されます (全端末共通)
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelected(TABLE_COLUMN_IDS.slice())}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              全選択
            </button>
            <button
              onClick={() => setSelected(DEFAULT_MAIN_COLUMNS.slice())}
              className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              既定に戻す
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COLUMN_GROUPS.map((group) => (
            <div key={group}>
              <p className="mb-1 text-[11px] font-semibold text-slate-600">{group}</p>
              <div className="flex flex-col gap-1">
                {TABLE_COLUMN_DEFS.filter((c) => c.group === group).map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={(e) => toggle(c.id, e.target.checked)}
                      className="h-4 w-4 shrink-0 accent-indigo-600"
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        {message && <p className="mt-2 text-xs text-slate-500">{message}</p>}
      </div>

      <PropertyTable
        rows={rows}
        columnIds={TABLE_COLUMN_IDS}
        title="データベース (全項目)"
        csvName="lumina-fuji-database"
      />
    </div>
  );
}
