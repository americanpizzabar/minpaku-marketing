"use client";

import { useMemo, useState } from "react";
import { PROPERTY_TYPES, type PropertyRow } from "@/lib/types";

type SortKey = "title" | "area" | "bedrooms" | "maxGuests" | "areaSqm" | "occupancyRate" | "adr" | "pricePerGuest" | "minNights" | "rating";

const typeLabel = (value: string) =>
  PROPERTY_TYPES.find((t) => t.value === value)?.label ?? value;

function toCsv(rows: PropertyRow[]): string {
  const header = [
    "物件名",
    "エリア",
    "施設形態",
    "寝室数",
    "定員",
    "面積(m2)",
    "稼働率(%)",
    "ADR(円)",
    "1人当たり単価(円)",
    "最低泊数",
    "評価",
    "レビュー数",
    "AirROI ID",
    "URL",
  ];
  const lines = rows.map((r) =>
    [
      `"${r.title.replace(/"/g, '""')}"`,
      r.area,
      typeLabel(r.propertyType),
      r.bedrooms,
      r.maxGuests,
      r.areaSqm ?? "",
      r.occupancyRate,
      r.adr,
      r.pricePerGuest,
      r.minNights,
      r.rating ?? "",
      r.reviewsCount,
      r.airroiId,
      r.url ?? "",
    ].join(","),
  );
  return "﻿" + [header.join(","), ...lines].join("\n");
}

export default function PropertyTable({ rows }: { rows: PropertyRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("adr");
  const [sortDesc, setSortDesc] = useState(true);
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => {
    const filtered = query
      ? rows.filter((r) => r.title.toLowerCase().includes(query.toLowerCase()))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      const cmp = typeof av === "string" ? av.localeCompare(String(bv), "ja") : Number(av) - Number(bv);
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, sortKey, sortDesc, query]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc(!sortDesc);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const downloadCsv = () => {
    const blob = new Blob([toCsv(sorted)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lumina-fuji-competitors-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const th = (label: string, key: SortKey, align = "text-right") => (
    <th
      className={`cursor-pointer px-3 py-2 text-xs font-semibold whitespace-nowrap text-slate-500 select-none hover:text-slate-800 ${align}`}
      onClick={() => handleSort(key)}
    >
      {label}
      {sortKey === key && <span className="ml-0.5">{sortDesc ? "▼" : "▲"}</span>}
    </th>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">競合物件一覧</h2>
          <p className="text-xs text-slate-500">{sorted.length}物件 (指定条件の集計値)</p>
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
              {th("物件名", "title", "text-left")}
              {th("エリア", "area", "text-left")}
              <th className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-slate-500">
                形態
              </th>
              {th("寝室", "bedrooms")}
              {th("定員", "maxGuests")}
              {th("面積", "areaSqm")}
              {th("稼働率", "occupancyRate")}
              {th("ADR", "adr")}
              {th("1人単価", "pricePerGuest")}
              {th("最低泊数", "minNights")}
              {th("評価", "rating")}
              <th className="px-3 py-2 text-right text-xs font-semibold whitespace-nowrap text-slate-500">
                AirROI ID
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="max-w-64 truncate px-3 py-2 font-medium text-slate-800">
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-indigo-600 hover:underline"
                    >
                      {r.title}
                    </a>
                  ) : (
                    r.title
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-600">{r.area}</td>
                <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                  {typeLabel(r.propertyType)}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">{r.bedrooms}</td>
                <td className="px-3 py-2 text-right text-slate-600">{r.maxGuests}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap text-slate-600">
                  {r.areaSqm != null ? `${r.areaSqm}m²` : "—"}
                </td>
                <td className="px-3 py-2 text-right font-medium text-slate-800">
                  {r.occupancyRate.toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-right font-medium text-slate-800">
                  ¥{r.adr.toLocaleString("ja-JP")}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">
                  ¥{r.pricePerGuest.toLocaleString("ja-JP")}
                </td>
                <td className="px-3 py-2 text-right text-slate-600">{r.minNights}泊</td>
                <td className="px-3 py-2 text-right text-slate-600">
                  {r.rating != null ? `★${r.rating.toFixed(2)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-xs text-slate-400">{r.airroiId}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-8 text-center text-sm text-slate-400">
                  条件に一致する物件がありません。フィルタを緩めてください。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
