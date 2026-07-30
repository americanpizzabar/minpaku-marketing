"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  AREAS,
  CAPACITY_BUCKETS,
  DAY_TYPES,
  PROPERTY_TYPES,
  TIME_RANGES,
} from "@/lib/types";
import SettingsPanel from "./SettingsPanel";

const selectClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none";
const labelClass = "mb-1.5 block text-xs font-semibold text-slate-500";

export default function Sidebar({ dataSource }: { dataSource: "turso" | "demo" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all" || value === "") params.delete(key);
      else params.set(key, value);
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams],
  );

  const get = (key: string, fallback = "all") => searchParams.get(key) ?? fallback;

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const json = await res.json();
      if (json.status === "SUCCESS" || json.status === "PARTIAL") {
        const cost = json.estimatedCostUsd != null ? ` / 約$${json.estimatedCostUsd}` : "";
        const extra = json.message ? ` — ${json.message}` : "";
        setSyncMessage(
          `同期${json.status === "PARTIAL" ? "継続中" : "完了"}: 料金更新${json.ratesRefreshed ?? 0}物件 (APIコール${json.apiCalls}回${cost})${extra}`,
        );
        router.refresh();
      } else {
        setSyncMessage(json.message ?? json.error ?? "同期に失敗しました");
      }
    } catch {
      setSyncMessage("同期リクエストに失敗しました");
    } finally {
      setSyncing(false);
    }
  };

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
        <nav className="mt-3 flex gap-1">
          {(
            [
              ["/", "📊 ダッシュボード"],
              ["/map", "🗺 地図"],
            ] as const
          ).map(([href, label]) => (
            <Link
              key={href}
              href={`${href}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`}
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
          {AREAS.map((a) => {
            const selected = (searchParams.get("area") ?? "").split(",").filter(Boolean);
            const checked = selected.includes(a);
            return (
              <label key={a} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...selected, a]
                      : selected.filter((s) => s !== a);
                    setParam("area", next.join(","));
                  }}
                  className="h-4 w-4 accent-indigo-600"
                />
                {a}
              </label>
            );
          })}
          <p className="text-[11px] text-slate-400">未選択 = 全エリア</p>
        </div>
      </div>

      <div>
        <label className={labelClass}>施設形態</label>
        <select
          className={selectClass}
          value={get("type")}
          onChange={(e) => setParam("type", e.target.value)}
        >
          <option value="all">すべて</option>
          {PROPERTY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass}>分析期間 (プリセット)</label>
        <select
          className={selectClass}
          value={get("range", "next30")}
          onChange={(e) => setParam("range", e.target.value)}
          disabled={Boolean(searchParams.get("dateFrom") && searchParams.get("dateTo"))}
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
            value={searchParams.get("dateFrom") ?? ""}
            onChange={(e) => setParam("dateFrom", e.target.value)}
            className={selectClass}
          />
          <input
            type="date"
            value={searchParams.get("dateTo") ?? ""}
            onChange={(e) => setParam("dateTo", e.target.value)}
            className={selectClass}
          />
          {(searchParams.get("dateFrom") || searchParams.get("dateTo")) && (
            <button
              onClick={() => {
                const params = new URLSearchParams(searchParams.toString());
                params.delete("dateFrom");
                params.delete("dateTo");
                startTransition(() => {
                  router.push(`${pathname}?${params.toString()}`);
                });
              }}
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
          value={get("dayType")}
          onChange={(e) => setParam("dayType", e.target.value)}
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
          value={get("capacity")}
          onChange={(e) => setParam("capacity", e.target.value)}
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
          value={get("bedrooms")}
          onChange={(e) => setParam("bedrooms", e.target.value)}
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
            defaultValue={searchParams.get("priceMin") ?? ""}
            onBlur={(e) => setParam("priceMin", e.target.value)}
            className={selectClass}
          />
          <span className="text-slate-400">〜</span>
          <input
            type="number"
            placeholder="上限"
            defaultValue={searchParams.get("priceMax") ?? ""}
            onBlur={(e) => setParam("priceMax", e.target.value)}
            className={selectClass}
          />
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <button
          onClick={handleSync}
          disabled={syncing}
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {syncing ? "同期中..." : "データ手動更新"}
        </button>
        {syncMessage && <p className="text-xs text-slate-500">{syncMessage}</p>}
        {isPending && <p className="text-xs text-indigo-500">再集計中...</p>}
        <SettingsPanel />
      </div>
    </aside>
  );
}
