"use client";

import { useEffect, useState } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatJpy, formatPercent } from "@/lib/format";
import {
  DEFAULT_KPI_ORDER,
  KPI_SEGMENTS,
  type KpiMetricId,
  type KpiSegmentId,
} from "@/lib/kpi-cards";
import type { Kpis } from "@/lib/types";

const ORDER_KEY = "kpi-card-order-v3";

// セグメントごとの配色とバッジ
const SEGMENT_STYLE: Record<
  KpiSegmentId,
  { card: string; badge: string; badgeLabel: string }
> = {
  all: {
    card: "border-slate-200 bg-white",
    badge: "bg-slate-600 text-white",
    badgeLabel: "全物件",
  },
  top: {
    card: "border-amber-200 bg-amber-50",
    badge: "bg-amber-500 text-white",
    badgeLabel: "上位20%",
  },
  own: {
    card: "border-rose-200 bg-rose-50",
    badge: "bg-rose-500 text-white",
    badgeLabel: "Lumina",
  },
};

interface CardDef {
  id: string;
  segment: KpiSegmentId;
  label: string;
  value: string;
  sub?: string;
  accent?: "up" | "down" | null;
}

function Card({ def }: { def: CardDef }) {
  const style = SEGMENT_STYLE[def.segment];
  return (
    <div className={`h-full rounded-lg border p-2.5 shadow-sm ${style.card}`}>
      <p className="flex flex-wrap items-start gap-1 pr-4 text-[10px] leading-tight font-semibold text-slate-500">
        <span
          className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold ${style.badge}`}
        >
          {style.badgeLabel}
        </span>
        {def.label}
      </p>
      <p className="mt-0.5 text-lg font-bold tracking-tight text-slate-900 md:text-xl">
        {def.value}
      </p>
      {def.sub && (
        <p
          className={`mt-0.5 text-[10px] leading-tight ${
            def.accent === "up"
              ? "text-emerald-600"
              : def.accent === "down"
                ? "text-rose-600"
                : "text-slate-500"
          }`}
        >
          {def.sub}
        </p>
      )}
    </div>
  );
}

/**
 * ドラッグハンドル (⠿) 方式の並び替えラッパー。
 * touch-action: none はハンドルのみに適用し、カード本体はスクロール可能に保つ。
 */
function SortableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative select-none ${isDragging ? "z-10 opacity-90 shadow-xl ring-2 ring-indigo-400" : ""}`}
    >
      {children}
      <button
        {...attributes}
        {...listeners}
        style={{ touchAction: "none", WebkitTouchCallout: "none" }}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="ドラッグして並び替え"
        className="absolute top-1 right-1 cursor-grab rounded px-1 py-0.5 text-xs leading-none text-slate-300 hover:bg-slate-100 hover:text-slate-500 active:cursor-grabbing"
      >
        ⠿
      </button>
    </div>
  );
}

/** 指定セグメントのKPIセットからカード定義を組み立てる */
function buildSegmentCards(kpis: Kpis, segment: KpiSegmentId): CardDef[] {
  const luminaDiff =
    kpis.luminaAdr !== null && kpis.adr > 0
      ? ((kpis.luminaAdr - kpis.adr) / kpis.adr) * 100
      : null;
  const dist = kpis.minStayDist;
  const distTotal = dist.n1 + dist.n2 + dist.n3plus;
  const pct = (n: number) => (distTotal > 0 ? Math.round((n / distTotal) * 100) : 0);
  const isOwn = segment === "own";

  const byMetric: Record<KpiMetricId, Omit<CardDef, "id" | "segment">> = {
    adr: {
      label: "平均客室単価 (ADR)",
      value: formatJpy(kpis.adr),
      sub: isOwn ? "自物件の平均価格" : `${kpis.propertiesCount}物件の平均`,
    },
    occupancy: {
      label: "平均稼働率",
      value: formatPercent(kpis.occupancyRate),
      sub: isOwn ? "自物件 (実績または設定値)" : "指定期間の予約埋まり率",
    },
    revpar: { label: "RevPAR", value: formatJpy(kpis.revpar), sub: "ADR × 稼働率" },
    pacing: {
      label: "Pacing 稼働率",
      value: formatPercent(kpis.pacingOccupancy30),
      sub: `今後30日 / 60日: ${formatPercent(kpis.pacingOccupancy60)}`,
    },
    ppg: {
      label: "1人当たり平均単価",
      value: formatJpy(kpis.pricePerGuest),
      sub: "1泊料金 ÷ 収容定員",
    },
    lumina: isOwn
      ? {
          label: "Lumina Fuji 差異",
          value: "—",
          sub: "自物件のため対象外",
        }
      : {
          label: "Lumina Fuji 差異",
          value:
            luminaDiff !== null ? `${luminaDiff >= 0 ? "+" : ""}${luminaDiff.toFixed(1)}%` : "—",
          sub:
            kpis.luminaAdr !== null
              ? `自社ADR ${formatJpy(kpis.luminaAdr)} との比較`
              : "自社データ未登録",
          accent: luminaDiff !== null ? (luminaDiff >= 0 ? "up" : "down") : null,
        },
    alos: {
      label: "平均滞在日数 (ALOS)",
      value: kpis.alos !== null ? `${kpis.alos}泊` : "—",
      sub:
        kpis.alos !== null
          ? "過去12ヶ月実績 (AirROI集計)"
          : isOwn
            ? "AirROI収録後に表示"
            : "設定の「物件情報を今すぐ更新」後に表示",
    },
    weekend: {
      label: "週末プレミアム",
      value:
        kpis.weekendPremium !== null
          ? `${kpis.weekendPremium >= 0 ? "+" : ""}${kpis.weekendPremium.toFixed(1)}%`
          : "—",
      sub: `平日 ${formatJpy(kpis.weekdayAdr)} → 休前日 ${formatJpy(kpis.preholidayAdr)}`,
      accent: kpis.weekendPremium !== null && kpis.weekendPremium > 0 ? "up" : null,
    },
    minstay: isOwn
      ? {
          label: "最低2泊以上の物件",
          value: "—",
          sub: "AirROI収録後に表示",
        }
      : {
          label: "最低2泊以上の物件",
          value: formatPercent(kpis.minStay2PlusShare),
          sub: `1泊OK ${pct(dist.n1)}% / 2泊 ${pct(dist.n2)}% / 3泊+ ${pct(dist.n3plus)}%`,
        },
  };

  const seg = KPI_SEGMENTS.find((s) => s.id === segment)!;
  return seg.metricIds.map((mid) => ({
    id: `${segment}:${mid}`,
    segment,
    ...byMetric[mid],
  }));
}

export default function KpiCards({
  kpis,
  kpisTop20,
  kpisLumina,
  visibleCards = [],
}: {
  kpis: Kpis;
  kpisTop20: Kpis;
  kpisLumina: Kpis;
  visibleCards?: string[];
}) {
  const allCards: CardDef[] = [
    ...buildSegmentCards(kpis, "all"),
    ...buildSegmentCards(kpisTop20, "top"),
    ...buildSegmentCards(kpisLumina, "own"),
  ];
  // 既定順: 指標ごとに全物件→上位20%のペア、最後にLumina群 (2列表示で左右に揃う)
  const defaultOrder = DEFAULT_KPI_ORDER;
  const [order, setOrder] = useState<string[]>(defaultOrder);

  // 端末に保存された並び順を復元 (新しいカードは末尾に追加)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as unknown;
      if (Array.isArray(saved)) {
        const valid = saved.filter((id): id is string => defaultOrder.includes(String(id)));
        if (valid.length > 0) {
          const missing = defaultOrder.filter((id) => !valid.includes(id));
          setOrder([...valid, ...missing]);
        }
      }
    } catch {
      // 保存データが壊れている場合は既定順のまま
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ハンドル方式のため長押し不要。誤操作防止に短い遅延のみ設定
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setOrder((current) => {
      const next = arrayMove(
        current,
        current.indexOf(String(active.id)),
        current.indexOf(String(over.id)),
      );
      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify(next));
      } catch {
        // ストレージ不可でも並び替え自体は機能させる
      }
      return next;
    });
  };

  const byId = new Map(allCards.map((c) => [c.id, c]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((c): c is CardDef => Boolean(c))
    // 設定画面で選択されたカードのみ表示 (未設定 = 全て表示)
    .filter((c) => visibleCards.length === 0 || visibleCards.includes(c.id));

  return (
    <div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={ordered.map((c) => c.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 gap-2 xl:grid-cols-6">
            {ordered.map((c) => (
              <SortableCard key={c.id} id={c.id}>
                <Card def={c} />
              </SortableCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <p className="mt-1.5 text-right text-[11px] text-slate-400">
        カード右上の ⠿ をドラッグで自由に並び替え (この端末に保存) / 表示するカードは「⚙ 設定」で選択
      </p>
    </div>
  );
}
