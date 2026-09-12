"use client";

import { useMemo, useState } from "react";
import type { PropertyRow } from "@/lib/types";
import {
  DEFAULT_MAIN_COLUMNS,
  TABLE_COLUMN_DEFS,
  type TableColumnDef,
} from "@/lib/table-columns";
import PropertyDetailModal from "./PropertyDetailModal";

function resolveColumns(columnIds?: string[]): TableColumnDef[] {
  const ids = columnIds && columnIds.length > 0 ? columnIds : DEFAULT_MAIN_COLUMNS;
  return ids
    .map((id) => TABLE_COLUMN_DEFS.find((c) => c.id === id))
    .filter((c): c is TableColumnDef => Boolean(c));
}

function toCsv(rows: PropertyRow[], columns: TableColumnDef[]): string {
  const header = columns.map((c) => c.label);
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => columns.map((c) => esc(c.csv(r))).join(","));
  return "﻿" + [header.join(","), ...lines].join("\n");
}

const basisBadge: Record<PropertyRow["dataBasis"], { label: string; cls: string }> = {
  actual: { label: "実績", cls: "bg-emerald-100 text-emerald-700" },
  calendar: { label: "予測", cls: "bg-sky-100 text-sky-700" },
};

export default function PropertyTable({
  rows,
  columnIds,
  title = "競合物件一覧",
  csvName = "lumina-fuji-competitors",
}: {
  rows: PropertyRow[];
  columnIds?: string[];
  title?: string;
  csvName?: string;
}) {
  const columns = useMemo(() => resolveColumns(columnIds), [columnIds]);
  const firstSortable = columns.find((c) => c.sortable)?.id ?? columns[0]?.id ?? "adr";
  const [sortKey, setSortKey] = useState<string>(
    columns.some((c) => c.id === "adr") ? "adr" : firstSortable,
  );
  const [sortDesc, setSortDesc] = useState(true);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<PropertyRow | null>(null);

  const sorted = useMemo(() => {
    const filtered = query
      ? rows.filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortKey] ?? 0;
      const bv = (b as unknown as Record<string, unknown>)[sortKey] ?? 0;
      const cmp =
        typeof av === "string"
          ? av.localeCompare(String(bv), "ja")
          : Number(av) - Number(bv);
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, sortKey, sortDesc, query]);

  const handleSort = (col: TableColumnDef) => {
    if (!col.sortable) return;
    if (col.id === sortKey) setSortDesc(!sortDesc);
    else {
      setSortKey(col.id);
      setSortDesc(true);
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([toCsv(sorted, columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${csvName}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <p className="text-xs text-slate-500">
            {sorted.length}物件 ({columns.length}列)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="物件名で検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={downloadCsv}
            className="rounded-lg border border-indigo-600 px-3 py-1.5 text-sm font-semibold text-indigo-600 transition hover:bg-indigo-50"
          >
            CSVダウンロード
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  onClick={() => handleSort(c)}
                  className={`px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-500 select-none ${
                    c.align === "left" ? "text-left" : "text-right"
                  } ${c.sortable ? "cursor-pointer hover:text-slate-800" : ""}`}
                >
                  {c.label}
                  {c.sortable && sortKey === c.id && (
                    <span className="ml-0.5">{sortDesc ? "▼" : "▲"}</span>
                  )}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap text-slate-500">
                詳細
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={`px-3 py-2 whitespace-nowrap ${
                      c.align === "left" ? "text-left" : "text-right"
                    } ${c.id === "title" ? "max-w-64 truncate font-medium text-slate-800" : "text-slate-600"}`}
                  >
                    {c.id === "title" ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`shrink-0 rounded-full px-1 py-px text-[9px] font-semibold ${basisBadge[r.dataBasis].cls}`}
                          title={r.dataBasis === "actual" ? "実績(過去90日/12ヶ月)ベース" : "カレンダー(予測)ベース"}
                        >
                          {basisBadge[r.dataBasis].label}
                        </span>
                        {r.url ? (
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate hover:text-indigo-600 hover:underline"
                          >
                            {r.title}
                          </a>
                        ) : (
                          <span className="truncate">{r.title}</span>
                        )}
                      </span>
                    ) : c.id === "url" && r.url ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-600 hover:underline"
                      >
                        リンク
                      </a>
                    ) : (
                      c.render(r)
                    )}
                  </td>
                ))}
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => setDetail(r)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-400 hover:text-indigo-600"
                  >
                    詳細
                  </button>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-3 py-8 text-center text-sm text-slate-400"
                >
                  条件に一致する物件がありません。フィルタを緩めてください。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {detail && (
        <PropertyDetailModal
          propertyId={detail.id}
          title={detail.title}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
