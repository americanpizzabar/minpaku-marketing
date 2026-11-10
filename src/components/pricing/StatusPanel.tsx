"use client";

import { type ReactNode, useState } from "react";
import type { PricingDashboard } from "@/lib/pricing/types";
import {
  OWN_PRICE_SOURCE_LABEL,
  OWN_STATUS_SOURCE_LABEL,
  type PricingActions,
  buttonPrimary,
  buttonSecondary,
  md,
  refreshConfirmText,
  usd,
} from "./shared";

/** 有料の CompSet カレンダー取得ボタン。確認ダイアログの件数・費用 = 送信する ids */
function RefreshButton({
  d,
  api,
  onResult,
  className = buttonPrimary,
}: {
  d: PricingDashboard;
  api: PricingActions;
  onResult: (text: string) => void;
  className?: string;
}) {
  const plan = d.status.refreshPlan;
  if (plan.count <= 0 || plan.ids.length === 0 || api.disabled) return null;
  const busy = api.busy === "refreshCompset";
  const handle = async () => {
    if (!window.confirm(refreshConfirmText(plan.count, plan.costUsd))) return;
    const res = await api.run({ action: "refreshCompset", ids: plan.ids });
    if (!res) return;
    const actual =
      res.refreshed !== undefined || res.costUsd !== undefined
        ? `（実取得 ${res.refreshed ?? 0}件・実費用 ${usd(res.costUsd ?? 0)}）`
        : "";
    onResult(`${res.message}${actual}`);
  };
  return (
    <button type="button" onClick={handle} disabled={api.busy !== null} className={className}>
      {busy ? "取得中…" : `競合カレンダーを取得（${plan.count}件・約${usd(plan.costUsd)}）`}
    </button>
  );
}

/** 1. 状態バナー (status.mode 別) */
export function StatusBanner({ d, api }: { d: PricingDashboard; api: PricingActions }) {
  const [result, setResult] = useState<string | null>(null);
  const { status } = d;
  if (status.mode === "demo") {
    return (
      <div className="rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 text-xs text-slate-700">
        デモデータを表示中（実際の予約・競合データではありません）。データの更新・設定の保存などの操作は無効です。
      </div>
    );
  }
  if (status.mode === "no_market_data") {
    const plan = status.refreshPlan;
    const members = d.compset.members.length;
    const min = d.config.minUnitsForSignal;
    if (members < min) {
      // CompSet が小さすぎる場合はカレンダーを取得しても競合連動にならない (有料の取得を勧めない)
      return (
        <div className="rounded-xl border border-amber-400 bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-900">
          CompSet が{members}件で、競合連動に必要な{min}件に足りないため、現在の推奨は『曜日・直前ルールのみ』です。
          下の「エンジン設定」で CompSet の条件（半径・価格帯など）を広げてください。
        </div>
      );
    }
    return (
      <div className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 px-3 py-3 text-xs text-amber-900">
        <p className="leading-relaxed">
          競合データ未取得のため、現在の推奨は『曜日・直前ルールのみ』です。
          {plan.count > 0
            ? `競合カレンダーを取得（${plan.count}件・約${usd(plan.costUsd)}）すると競合連動になります。`
            : "取得対象の競合がありません（CompSet 条件を設定で見直してください）。"}
        </p>
        <RefreshButton d={d} api={api} onResult={setResult} />
        {result && <p className="rounded-lg bg-white px-2 py-1.5 text-slate-700">{result}</p>}
      </div>
    );
  }
  if (status.mode === "partial") {
    return <p className="text-[11px] text-slate-500">※ 一部の日は競合データ不足のためルールのみで算出しています。</p>;
  }
  return null;
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-slate-50 px-2 py-1.5">
      <dt className="text-[10px] font-semibold text-slate-400">{label}</dt>
      <dd className="text-xs text-slate-700">{children}</dd>
    </div>
  );
}

/** 2. データ状況バー + 警告 */
export function DataStatusBar({ d, api }: { d: PricingDashboard; api: PricingActions }) {
  const [result, setResult] = useState<string | null>(null);
  const { status, compset } = d;
  // デモの注意は上部のバナーで表示済みなので重複させない
  const warnings = status.warnings.filter((w) => !(status.mode === "demo" && w.startsWith("デモデータ")));
  const members = compset.members.length;
  const relaxed = compset.relaxations.length > 0;

  const importIcal = async () => {
    const res = await api.run({ action: "importIcal" });
    if (res) setResult(res.message);
  };

  return (
    <section className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
        <Item label="CompSet">
          {members}件（厳格 {compset.strictCount}件 / {relaxed ? "緩和あり" : "緩和なし"}）
        </Item>
        <Item label="カレンダー新鮮">
          {status.freshMembers}/{members}
        </Item>
        <Item label="最新スナップショット">{status.lastSnapshotDate ? md(status.lastSnapshotDate) : "なし"}</Item>
        <Item label="Pace">
          {status.paceAvailable
            ? `算出済み${status.paceWindowDays != null ? `（${Math.round(status.paceWindowDays)}日間隔）` : ""}`
            : status.paceAvailableFrom
              ? `${md(status.paceAvailableFrom)} から`
              : "未算出"}
        </Item>
        <Item label="自社予約の出所">
          {OWN_STATUS_SOURCE_LABEL[status.ownStatusSource]}
          {status.icalLastImport && (
            <span className={`ml-1 text-[10px] ${status.icalLastImport.ok ? "text-slate-400" : "text-rose-600"}`}>
              （iCal {status.icalLastImport.ok ? `${status.icalLastImport.imported}日取込` : "取込失敗"}）
            </span>
          )}
        </Item>
        <Item label="自社価格の出所">{OWN_PRICE_SOURCE_LABEL[status.ownPriceSource]}</Item>
        <Item label="通知">
          {status.alertChannel === "webhook" ? "毎朝7:00に通知" : "通知なし（画面表示のみ）"}
        </Item>
        <Item label="競合の自動取得">
          {status.compsetAutoRefresh
            ? `オン: 約${usd(status.autoRefreshMonthlyUsd)}/月`
            : `オフ（オンで約${usd(status.autoRefreshMonthlyUsd)}/月）`}
        </Item>
      </dl>

      {!api.disabled && (status.refreshPlan.count > 0 || status.icalConfigured) && (
        <div className="flex flex-wrap gap-2">
          {status.mode !== "no_market_data" && <RefreshButton d={d} api={api} onResult={setResult} />}
          {status.icalConfigured && (
            <button type="button" onClick={importIcal} disabled={api.busy !== null} className={buttonSecondary}>
              {api.busy === "importIcal" ? "取り込み中…" : "iCal取り込み"}
            </button>
          )}
        </div>
      )}
      {result && <p className="rounded-lg bg-indigo-50 px-2 py-1.5 text-xs text-slate-700">{result}</p>}
      {status.icalLastImport && !status.icalLastImport.ok && status.icalLastImport.error && (
        <p className="text-[11px] text-rose-600">iCal 取り込みエラー: {status.icalLastImport.error}</p>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5">
              <span aria-hidden>⚠</span>
              <span className="min-w-0 break-words">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
