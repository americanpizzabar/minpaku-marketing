"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface SettingsState {
  autoSync: boolean;
  ratesRefreshDays: number;
  searchRefreshDays: number;
  dailyRatesCalls: number;
  luminaListingId: string;
  luminaBasePrice: number;
  luminaBedrooms: number;
  luminaMaxGuests: number;
  luminaOccupancy: number | ""; // "" = 未設定
}

function toFormState(config: Record<string, unknown>): SettingsState {
  return {
    autoSync: Boolean(config.autoSync),
    ratesRefreshDays: Number(config.ratesRefreshDays),
    searchRefreshDays: Number(config.searchRefreshDays),
    dailyRatesCalls: Number(config.dailyRatesCalls),
    luminaListingId: String(config.luminaListingId ?? ""),
    luminaBasePrice: Number(config.luminaBasePrice ?? 0),
    luminaBedrooms: Number(config.luminaBedrooms ?? 4),
    luminaMaxGuests: Number(config.luminaMaxGuests ?? 10),
    luminaOccupancy:
      config.luminaOccupancy === null || config.luminaOccupancy === undefined
        ? ""
        : Number(config.luminaOccupancy),
  };
}

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none";
const labelClass = "mb-1 block text-xs font-semibold text-slate-500";

/** データ取得 (自動/手動・更新周期・コスト上限・自物件ID) の設定パネル */
export default function SettingsPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [tracked, setTracked] = useState<number | null>(null);
  const [monthlyCost, setMonthlyCost] = useState<number | null>(null);
  const [form, setForm] = useState<SettingsState | null>(null);

  useEffect(() => {
    if (!open || form) return;
    setLoading(true);
    fetch("/api/settings")
      .then((r) => r.json())
      .then((json) => {
        if (!json.configured) {
          setConfigured(false);
          return;
        }
        setForm(toFormState(json.config));
        setTracked(json.trackedProperties);
        setMonthlyCost(json.estimatedMonthlyCostUsd);
      })
      .catch(() => setMessage("設定の読み込みに失敗しました"))
      .finally(() => setLoading(false));
  }, [open, form]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          luminaOccupancy: form.luminaOccupancy === "" ? null : form.luminaOccupancy,
        }),
      });
      const json = await res.json();
      if (json.saved) {
        setForm(toFormState(json.config));
        setMonthlyCost(json.estimatedMonthlyCostUsd);
        setMessage("設定を保存し、グラフに反映しました");
        // サーバーコンポーネントを再取得してKPI・グラフを即時更新する
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
    <div className="rounded-lg border border-slate-200">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-semibold text-slate-700"
      >
        <span>⚙ データ取得設定</span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-slate-200 p-3">
          {loading && <p className="text-xs text-slate-500">読み込み中...</p>}
          {!configured && (
            <p className="text-xs text-amber-600">
              デモモードのため設定は利用できません (Turso DB未設定)
            </p>
          )}
          {form && (
            <>
              <label className="flex items-center justify-between gap-2 text-sm text-slate-700">
                <span>自動同期 (毎日 深夜3時)</span>
                <input
                  type="checkbox"
                  checked={form.autoSync}
                  onChange={(e) => setForm({ ...form, autoSync: e.target.checked })}
                  className="h-4 w-4 accent-indigo-600"
                />
              </label>

              <div>
                <label className={labelClass}>料金カレンダーの更新周期</label>
                <select
                  className={inputClass}
                  value={String(form.ratesRefreshDays)}
                  onChange={(e) => setForm({ ...form, ratesRefreshDays: Number(e.target.value) })}
                >
                  <option value="7">7日ごと (高頻度・高コスト)</option>
                  <option value="14">14日ごと (標準)</option>
                  <option value="30">30日ごと (低コスト)</option>
                </select>
              </div>

              <div>
                <label className={labelClass}>1回の同期で取得する物件数の上限</label>
                <select
                  className={inputClass}
                  value={String(form.dailyRatesCalls)}
                  onChange={(e) => setForm({ ...form, dailyRatesCalls: Number(e.target.value) })}
                >
                  <option value="20">20件 (約$2)</option>
                  <option value="40">40件 (約$4)</option>
                  <option value="80">80件 (約$8)</option>
                </select>
              </div>

              <div>
                <label className={labelClass}>物件カタログ (エリア検索) の更新周期</label>
                <select
                  className={inputClass}
                  value={String(form.searchRefreshDays)}
                  onChange={(e) => setForm({ ...form, searchRefreshDays: Number(e.target.value) })}
                >
                  <option value="30">30日ごと (標準)</option>
                  <option value="60">60日ごと</option>
                  <option value="90">90日ごと</option>
                </select>
              </div>

              <div>
                <label className={labelClass}>自物件 (Lumina Fuji) のAirbnbリスティングID</label>
                <input
                  type="text"
                  className={inputClass}
                  value={form.luminaListingId}
                  onChange={(e) => setForm({ ...form, luminaListingId: e.target.value })}
                  placeholder="例: 1628678015262671191"
                />
              </div>

              <div className="rounded-lg bg-slate-50 p-2.5">
                <p className="mb-2 text-[11px] font-semibold text-slate-500">
                  自物件情報 (AirROI未収録の間はこの値でベンチマークを表示)
                </p>
                <div className="flex flex-col gap-2.5">
                  <div>
                    <label className={labelClass}>基準価格 (円/泊)</label>
                    <input
                      type="number"
                      className={inputClass}
                      value={form.luminaBasePrice || ""}
                      onChange={(e) =>
                        setForm({ ...form, luminaBasePrice: Number(e.target.value) || 0 })
                      }
                      placeholder="例: 78000"
                    />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className={labelClass}>寝室数</label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        className={inputClass}
                        value={form.luminaBedrooms || ""}
                        onChange={(e) =>
                          setForm({ ...form, luminaBedrooms: Number(e.target.value) || 1 })
                        }
                      />
                    </div>
                    <div className="flex-1">
                      <label className={labelClass}>定員 (人)</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        className={inputClass}
                        value={form.luminaMaxGuests || ""}
                        onChange={(e) =>
                          setForm({ ...form, luminaMaxGuests: Number(e.target.value) || 1 })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>稼働率 (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className={inputClass}
                      value={form.luminaOccupancy}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          luminaOccupancy: e.target.value === "" ? "" : Number(e.target.value),
                        })
                      }
                      placeholder="例: 65 (空欄=未設定)"
                    />
                  </div>
                </div>
              </div>

              <p className="text-xs text-slate-500">
                追跡中: {tracked ?? "-"}物件
                {monthlyCost !== null && (
                  <>
                    {" "}
                    / 推定月額コスト: <span className="font-semibold">${monthlyCost}</span>
                    {!form.autoSync && " (自動同期オフ)"}
                  </>
                )}
              </p>

              <button
                onClick={save}
                disabled={saving}
                className="w-full rounded-lg bg-slate-800 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-900 disabled:opacity-50"
              >
                {saving ? "保存中..." : "設定を保存"}
              </button>
            </>
          )}
          {message && <p className="text-xs text-slate-500">{message}</p>}
        </div>
      )}
    </div>
  );
}
