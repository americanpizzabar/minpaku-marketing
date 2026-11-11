"use client";

import { useMemo, useState } from "react";
import { toDetailCsv, toPriceCsv, toPriceRanges } from "@/lib/pricing/csv";
import type { PricingDashboard } from "@/lib/pricing/types";
import { Card, buttonPrimary, buttonSecondary } from "./shared";

function download(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API が使えない環境 (http 等) 向けのフォールバック
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 8. 推奨価格の反映 (Airbnb 入力用の期間一覧 + CSV ダウンロード) */
export default function PriceExport({ d }: { d: PricingDashboard }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ranges = useMemo(() => {
    try {
      return { list: toPriceRanges(d), error: null as string | null };
    } catch (e) {
      return { list: [], error: e instanceof Error ? e.message : String(e) };
    }
  }, [d]);

  // 競合データに基づく推奨だけを入力対象にする (ルールのみの推奨は判定も据え置き。参考として別に出す)
  const actionable = ranges.list.filter((r) => !r.rulesOnly);
  const reference = ranges.list.filter((r) => r.rulesOnly);
  const hasUnlinked = d.days.some((x) => x.lead >= 0 && x.own.status === "vacant" && x.own.statusSource === "none");

  const handleCopy = async () => {
    const ok = await copyText(actionable.map((r) => r.label).join("\n"));
    setCopied(ok ? "コピーしました" : "コピーできませんでした（長押しで選択してください）");
    setTimeout(() => setCopied(null), 3000);
  };

  const handleDownload = (kind: "detail" | "price") => {
    setError(null);
    try {
      if (kind === "detail") download(toDetailCsv(d), `pricing-detail-${d.today}.csv`);
      else download(toPriceCsv(d), `pricing-price-${d.today}.csv`);
    } catch (e) {
      setError(`CSV を作成できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Card title="推奨価格の反映">
      <p className="mb-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900">
        Airbnb には価格を CSV で一括取り込みする機能がありません。下の一覧を見ながら、Airbnb アプリのカレンダーで
        期間を選んで価格を入力してください（自社が空室の日のみ・同じ価格の連続日はまとめています）。
        {hasUnlinked && <> 予約状況が未連携の日も空室として含まれているため、予約済みの日は入力不要です。</>}
      </p>
      {ranges.error ? (
        <p className="text-xs text-rose-600">一覧を作成できませんでした: {ranges.error}</p>
      ) : actionable.length === 0 ? (
        <p className="text-xs text-slate-500">
          {reference.length > 0
            ? "競合データに基づく推奨価格がまだ無いため、入力をおすすめする期間はありません。"
            : "反映対象の空室日はありません"}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">{actionable.length}区間</p>
            <button type="button" onClick={handleCopy} className={buttonSecondary}>
              📋 一覧をコピー
            </button>
          </div>
          {copied && <p className="mt-1 text-[11px] text-emerald-700">{copied}</p>}
          <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono text-xs text-slate-700">
            {actionable.map((r) => (
              <li key={`${r.from}-${r.to}`} className="break-words">
                {r.label}
              </li>
            ))}
          </ul>
        </>
      )}
      {!ranges.error && reference.length > 0 && (
        <details className="mt-2 text-[11px] text-slate-500">
          <summary className="cursor-pointer select-none text-slate-600">
            参考: 競合データ不足の日（曜日・直前ルールのみ・{reference.length}区間）
          </summary>
          <p className="mt-1 leading-relaxed">
            基準価格に曜日・直前の係数を掛けただけの参考値で、値上げ/値下げの判定は「据え置き」にしています。
            競合カレンダーを取得するか、基準価格が実際の販売価格に合っているか確認するまでは入力をおすすめしません。
          </p>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 bg-white p-2 font-mono text-slate-400">
            {reference.map((r) => (
              <li key={`${r.from}-${r.to}`} className="break-words">
                {r.label}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => handleDownload("detail")} className={buttonPrimary}>
          ⬇ 詳細CSV（分析用）
        </button>
        <button type="button" onClick={() => handleDownload("price")} className={buttonSecondary}>
          ⬇ 価格CSV（表計算・チャネルマネージャ取込用）
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        価格CSVには競合データに基づく推奨の日だけを含めます（ルールのみの日は詳細CSVで確認できます）。
      </p>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </Card>
  );
}
