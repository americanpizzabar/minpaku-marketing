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

  const handleCopy = async () => {
    const ok = await copyText(ranges.list.map((r) => r.label).join("\n"));
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
      </p>
      {ranges.error ? (
        <p className="text-xs text-rose-600">一覧を作成できませんでした: {ranges.error}</p>
      ) : ranges.list.length === 0 ? (
        <p className="text-xs text-slate-400">反映対象の空室日はありません</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">{ranges.list.length}区間</p>
            <button type="button" onClick={handleCopy} className={buttonSecondary}>
              📋 一覧をコピー
            </button>
          </div>
          {copied && <p className="mt-1 text-[11px] text-emerald-700">{copied}</p>}
          <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50 p-2 font-mono text-xs text-slate-700">
            {ranges.list.map((r) => (
              <li key={`${r.from}-${r.to}`} className="break-words">
                {r.label}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => handleDownload("detail")} className={buttonPrimary}>
          ⬇ 詳細CSV（分析用）
        </button>
        <button type="button" onClick={() => handleDownload("price")} className={buttonSecondary}>
          ⬇ 価格CSV（表計算・チャネルマネージャ取込用）
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </Card>
  );
}
