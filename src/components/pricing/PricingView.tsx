"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PricingApiRequest, PricingDashboard } from "@/lib/pricing/types";
import AlertsList from "./AlertsList";
import CompSetTable from "./CompSetTable";
import DayDetail from "./DayDetail";
import DeepDive from "./DeepDive";
import EngineSettings from "./EngineSettings";
import KpiSummary from "./KpiSummary";
import Methodology from "./Methodology";
import MonthCalendar from "./MonthCalendar";
import PastStrip from "./PastStrip";
import PriceExport from "./PriceExport";
import { DataStatusBar, StatusBanner } from "./StatusPanel";
import Timeline from "./Timeline";
import { Card, type PricingActions, postPricing } from "./shared";

const MOBILE_QUERY = "(max-width: 767px)";

/** /pricing 画面の本体。PricingDashboard だけから描画し、操作は POST /api/pricing → router.refresh() */
export default function PricingView({ d }: { d: PricingDashboard }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const demo = d.status.mode === "demo" || d.dataSource === "demo";

  const run = useCallback(
    async (req: PricingApiRequest) => {
      if (demo) return null;
      setBusy(req.action);
      try {
        const res = await postPricing(req);
        if (res.ok) startTransition(() => router.refresh());
        return res;
      } finally {
        setBusy(null);
      }
    },
    [demo, router],
  );
  const api: PricingActions = useMemo(() => ({ run, busy, disabled: demo }), [run, busy, demo]);

  const selectedDay = selected ? d.days.find((x) => x.date === selected) ?? null : null;
  const close = useCallback(() => setSelected(null), []);

  // スマホのボトムシート表示中は背面のスクロールを止める / Esc で閉じる
  useEffect(() => {
    if (!selectedDay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    const mobile = window.matchMedia(MOBILE_QUERY).matches;
    const prev = document.body.style.overflow;
    if (mobile) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [selectedDay, close]);

  // md 以上ではパネルを画面内に入れる (アラート・バッジから選んだとき用)
  useEffect(() => {
    if (!selected || window.matchMedia(MOBILE_QUERY).matches) return;
    detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  return (
    <div className="min-w-0 space-y-4">
      <StatusBanner d={d} api={api} />
      <DataStatusBar d={d} api={api} />
      <AlertsList alerts={d.alerts} onSelectDate={setSelected} />
      <KpiSummary d={d} onSelectDate={setSelected} />

      <Card
        title={`${d.horizonDays}日ビュー`}
        right={<span className="text-[11px]">日付をタップで詳細</span>}
      >
        <div className="md:hidden">
          <MonthCalendar days={d.days} selected={selected} onSelect={setSelected} />
        </div>
        <div className="hidden md:block">
          <Timeline days={d.days} selected={selected} onSelect={setSelected} />
        </div>
      </Card>

      {selectedDay && (
        <>
          <div className="fixed inset-0 z-40 bg-slate-900/40 md:hidden" onClick={close} aria-hidden />
          <div
            ref={detailRef}
            role="dialog"
            aria-label="日別詳細"
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto overscroll-contain rounded-t-2xl bg-white px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:static md:z-auto md:max-h-none md:overflow-visible md:rounded-xl md:border md:border-slate-200 md:p-4 md:shadow-sm"
          >
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-300 md:hidden" />
            <DayDetail key={selectedDay.date} day={selectedDay} d={d} api={api} onClose={close} />
          </div>
        </>
      )}

      <DeepDive d={d} />
      <PastStrip past={d.past} />
      <PriceExport d={d} />
      <CompSetTable compset={d.compset} />
      <EngineSettings d={d} api={api} />
      <Methodology />

      {isPending && (
        <div className="fixed right-3 bottom-3 z-30 rounded-full bg-slate-900/80 px-3 py-1 text-[11px] text-white shadow">
          再読み込み中…
        </div>
      )}
    </div>
  );
}
