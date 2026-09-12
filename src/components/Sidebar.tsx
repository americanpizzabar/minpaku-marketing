"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  AREAS,
  CAPACITY_BUCKETS,
  DAY_TYPES,
  PROPERTY_TYPES,
  TIME_RANGES,
} from "@/lib/types";

const selectClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none";
const labelClass = "mb-1.5 block text-xs font-semibold text-slate-500";

interface DraftFilters {
  areas: string[];
  types: string[];
  range: string;
  dateFrom: string;
  dateTo: string;
  dayType: string;
  capacity: string;
  bedrooms: string;
  priceMin: string;
  priceMax: string;
}

export default function Sidebar({ dataSource }: { dataSource: "turso" | "demo" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // フィルタはローカルの下書き状態に保持し、「検索」ボタンで初めてURLへ反映
  // (=DBクエリは検索実行時に1回だけ。AirROI APIは一切呼ばれない)
  const [draft, setDraft] = useState<DraftFilters>(() => ({
    areas: (searchParams.get("area") ?? "").split(",").filter(Boolean),
    types: (searchParams.get("type") ?? "").split(",").filter(Boolean),
    range: searchParams.get("range") ?? "next30",
    dateFrom: searchParams.get("dateFrom") ?? "",
    dateTo: searchParams.get("dateTo") ?? "",
    dayType: searchParams.get("dayType") ?? "all",
    capacity: searchParams.get("capacity") ?? "all",
    bedrooms: searchParams.get("bedrooms") ?? "all",
    priceMin: searchParams.get("priceMin") ?? "",
    priceMax: searchParams.get("priceMax") ?? "",
  }));

  const set = <K extends keyof DraftFilters>(key: K, value: DraftFilters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggle = (key: "areas" | "types", value: string, checked: boolean) =>
    setDraft((d) => ({
      ...d,
      [key]: checked ? [...d[key], value] : d[key].filter((v) => v !== value),
    }));

  const applySearch = () => {
    const params = new URLSearchParams();
    if (draft.areas.length > 0) params.set("area", draft.areas.join(","));
    if (draft.types.length > 0) params.set("type", draft.types.join(","));
    if (draft.range && draft.range !== "next30") params.set("range", draft.range);
    if (draft.dateFrom) params.set("dateFrom", draft.dateFrom);
    if (draft.dateTo) params.set("dateTo", draft.dateTo);
    if (draft.dayType !== "all") params.set("dayType", draft.dayType);
    if (draft.capacity !== "all") params.set("capacity", draft.capacity);
    if (draft.bedrooms !== "all") params.set("bedrooms", draft.bedrooms);
    if (draft.priceMin) params.set("priceMin", draft.priceMin);
    if (draft.priceMax) params.set("priceMax", draft.priceMax);
    startTransition(() => {
      router.push(`${pathname}${params.toString() ? `?${params.toString()}` : ""}`);
    });
  };

  const clearAll = () => {
    setDraft({
      areas: [],
      types: [],
      range: "next30",
      dateFrom: "",
      dateTo: "",
      dayType: "all",
      capacity: "all",
      bedrooms: "all",
      priceMin: "",
      priceMax: "",
    });
    startTransition(() => {
      router.push(pathname);
    });
  };

  const qs = searchParams.toString();

  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 border-b border-slate-200 bg-white p-5 lg:min-h-screen lg:w-72 lg:border-r lg:border-b-0">
      <div>
        <h1 className="text-lg font-bold tracking-tight text-slate-900">Lumina Fuji</h1>
        <p className="text-xs text-slate-500">競合分析・価格戦略ダッシュボード</p>
        <span
          className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
            dataSource === "turso"
              ? "bg-emerald-100 text-emerald-700"
              : "bg-amber-100 text-amber-700"
          }`}
        >
          {dataSource === "turso" ? "Turso DB 接続中" : "デモデータモード"}
        </span>
        <nav className="mt-3 flex flex-wrap gap-1">
          {(
            [
              ["/", "📊 ダッシュボード"],
              ["/map", "🗺 地図"],
              ["/database", "🗄 データ"],
              ["/settings", "⚙ 設定"],
            ] as const
          ).map(([href, label]) => (
            <Link
              key={href}
              href={`${href}${qs ? `?${qs}` : ""}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                pathname === href
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <div>
        <label className={labelClass}>エリア (複数選択可)</label>
        <div className="flex flex-col gap-1 rounded-lg border border-slate-300 bg-white p-2">
          {AREAS.map((a) => (
            <label key={a} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.areas.includes(a)}
                onChange={(e) => toggle("areas", a, e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
              {a}
            </label>
          ))}
          <p className="text-[11px] text-slate-400">未選択 = 全エリア</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>施設形態 (複数選択可)</label>
        <div className="flex flex-col gap-1 rounded-lg border border-slate-300 bg-white p-2">
          {PROPERTY_TYPES.map((t) => (
            <label key={t.value} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.types.includes(t.value)}
                onChange={(e) => toggle("types", t.value, e.target.checked)}
                className="h-4 w-4 accent-indigo-600"
              />
              {t.label}
            </label>
          ))}
          <p className="text-[11px] text-slate-400">未選択 = 全形態</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>分析期間 (プリセット)</label>
        <select
          className={selectClass}
          value={draft.range}
          onChange={(e) => set("range", e.target.value)}
          disabled={Boolean(draft.dateFrom && draft.dateTo)}
        >
          {TIME_RANGES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>日付範囲を直接指定 (プリセットより優先)</label>
        <div className="flex flex-col gap-1.5">
          <input
            type="date"
            value={draft.dateFrom}
            onChange={(e) => set("dateFrom", e.target.value)}
            className={selectClass}
          />
          <input
            type="date"
            value={draft.dateTo}
            onChange={(e) => set("dateTo", e.target.value)}
            className={selectClass}
          />
          {(draft.dateFrom || draft.dateTo) && (
            <button
              onClick={() => setDraft((d) => ({ ...d, dateFrom: "", dateTo: "" }))}
              className="self-start text-xs font-medium text-indigo-600 hover:underline"
            >
              日付指定をクリア
            </button>
          )}
        </div>
      </div>

      <div>
        <label className={labelClass}>曜日タイプ</label>
        <select
          className={selectClass}
          value={draft.dayType}
          onChange={(e) => set("dayType", e.target.value)}
        >
          {DAY_TYPES.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>収容人数</label>
        <select
          className={selectClass}
          value={draft.capacity}
          onChange={(e) => set("capacity", e.target.value)}
        >
          <option value="all">すべて</option>
          {CAPACITY_BUCKETS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>ベッドルーム数</label>
        <select
          className={selectClass}
          value={draft.bedrooms}
          onChange={(e) => set("bedrooms", e.target.value)}
        >
          <option value="all">すべて</option>
          <option value="1">1室</option>
          <option value="2">2室</option>
          <option value="3+">3室以上</option>
        </select>
      </div>

      <div>
        <label className={labelClass}>ADR価格帯 (円/泊)</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            placeholder="下限"
            value={draft.priceMin}
            onChange={(e) => set("priceMin", e.target.value)}
            className={selectClass}
          />
          <span className="text-slate-400">〜</span>
          <input
            type="number"
            placeholder="上限"
            value={draft.priceMax}
            onChange={(e) => set("priceMax", e.target.value)}
            className={selectClass}
          />
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <button
          onClick={applySearch}
          disabled={isPending}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {isPending ? "再集計中..." : "🔍 この条件で検索"}
        </button>
        <button
          onClick={clearAll}
          disabled={isPending}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
        >
          条件をクリア
        </button>
        <p className="text-[11px] text-slate-400">
          検索は保存済みデータの集計のみで、API料金はかかりません。データ更新は「⚙ 設定」から。
        </p>
      </div>
    </aside>
  );
}
