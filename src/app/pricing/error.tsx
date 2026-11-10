"use client";

import Link from "next/link";
import { useEffect } from "react";

/** /pricing の読み込みに失敗したとき (DB への接続失敗など)。デモデータで代替すると実データと誤認するため、再試行を促す */
export default function PricingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto max-w-lg space-y-3 p-6">
      <h2 className="text-lg font-bold text-slate-900">価格最適化を表示できませんでした</h2>
      <p className="text-sm leading-relaxed text-slate-600">
        データベースへの接続またはデータの読み込みに失敗しました。一時的な問題の可能性があるため、少し待ってから再試行してください。
      </p>
      {error.digest && <p className="text-xs text-slate-400">エラーID: {error.digest}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
        >
          再試行
        </button>
        <Link href="/" className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
          ダッシュボードへ
        </Link>
      </div>
    </main>
  );
}
