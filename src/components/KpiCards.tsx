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
import type { Kpis } from "@/lib/types";

const ORDER_KEY = "kpi-card-order-v1";

function Card({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "up" | "down" | null;
}) {
  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
      {sub && (
        <p
          className={`mt-1 text-xs ${
            accent === "up"
              ? "text-emerald-600"
              : accent === "down"
                ? "text-rose-600"
                : "text-slate-500"
          }`}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

/** 長押しでドラッグ開始できる並び替え対応ラッパー */
function SortableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        touchAction: "manipulation",
        WebkitTouchCallout: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
      {...attributes}
      {...listeners}
      className={`select-none ${isDragging ? "z-10 opacity-90 shadow-xl ring-2 ring-indigo-400" : ""}`}
    >
      {children}
    </div>
  );
}

interface CardDef {
  id: string;
  label: string;
  value: string;
  sub?: string;
  accent?: "up" | "down" | null;
}

export default function KpiCards({
  kpis: kpisAll,
  kpisTop20,
  visibleCards = [],
}: {
  kpis: Kpis;
  kpisTop20: Kpis;
  visibleCards?: string[];
}) {
  // 全物件 / ADR上位20% (ハイエンド層) の集計セグメント切替
  const [segment, setSegment] = useState<"all" | "top20">("all");
  const kpis = segment === "top20" ? kpisTop20 : kpisAll;

  const luminaDiff =
    kpis.luminaAdr !== null && kpis.adr > 0
      ? ((kpis.luminaAdr - kpis.adr) / kpis.adr) * 100
      : null;

  const dist = kpis.minStayDist;
  const distTotal = dist.n1 + dist.n2 + dist.n3plus;
  const pct = (n: number) => (distTotal > 0 ? Math.round((n / distTotal) * 100) : 0);

  const cards: CardDef[] = [
    {
      id: "adr",
      label: "平均客室単価 (ADR)",
      value: formatJpy(kpis.adr),
      sub: `${kpis.propertiesCount}物件の平均`,
    },
    {
      id: "occupancy",
      label: "平均稼働率",
      value: formatPercent(kpis.occupancyRate),
      sub: "指定期間の予約埋まり率",
    },
    { id: "revpar", label: "RevPAR", value: formatJpy(kpis.revpar), sub: "ADR × 稼働率" },
    {
      id: "pacing",
      label: "Pacing 稼働率",
      value: formatPercent(kpis.pacingOccupancy30),
      sub: `今後30日 / 60日: ${formatPercent(kpis.pacingOccupancy60)}`,
    },
    {
      id: "ppg",
      label: "1人当たり平均単価",
      value: formatJpy(kpis.pricePerGuest),
      sub: "1泊料金 ÷ 収容定員",
    },
    {
      id: "lumina",
      label: "Lumina Fuji 差異",
      value: luminaDiff !== null ? `${luminaDiff >= 0 ? "+" : ""}${luminaDiff.toFixed(1)}%` : "—",
      sub:
        kpis.luminaAdr !== null
          ? `自社ADR ${formatJpy(kpis.luminaAdr)} / 稼働 ${
              kpis.luminaOccupancy !== null ? formatPercent(kpis.luminaOccupancy) : "—"
            }`
          : "自社データ未登録",
      accent: luminaDiff !== null ? (luminaDiff >= 0 ? "up" : "down") : null,
    },
    {
      id: "top20",
      label: "上位20% ADR (ハイエンド層)",
      value: formatJpy(kpis.top20Adr),
      sub: `RevPAR ${formatJpy(kpis.top20Revpar)} / 上位${kpis.top20Count}物件`,
    },
    {
      id: "alos",
      label: "平均滞在日数 (ALOS)",
      value: kpis.alos !== null ? `${kpis.alos}泊` : "—",
      sub:
        kpis.alos !== null
          ? "過去12ヶ月実績 (AirROI集計)"
          : "設定の「物件情報を今すぐ更新」後に表示",
    },
    {
      id: "weekend",
      label: "週末プレミアム",
      value:
        kpis.weekendPremium !== null
          ? `${kpis.weekendPremium >= 0 ? "+" : ""}${kpis.weekendPremium.toFixed(1)}%`
          : "—",
      sub: `平日 ${formatJpy(kpis.weekdayAdr)} → 休前日 ${formatJpy(kpis.preholidayAdr)}`,
      accent: kpis.weekendPremium !== null && kpis.weekendPremium > 0 ? "up" : null,
    },
    {
      id: "minstay",
      label: "最低2泊以上の物件",
      value: formatPercent(kpis.minStay2PlusShare),
      sub: `1泊OK ${pct(dist.n1)}% / 2泊 ${pct(dist.n2)}% / 3泊+ ${pct(dist.n3plus)}%`,
    },
  ];

  const defaultOrder = cards.map((c) => c.id);
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

  // 長押し (400ms) でドラッグ開始。それ未満の操作はスクロール等に譲る。
  // PointerSensorはモバイルでドラッグ中にブラウザのスクロールが介入して
  // pointercancelで解除されるため、touchmoveを抑止できるTouchSensorを使う。
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
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

  const byId = new Map(cards.map((c) => [c.id, c]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((c): c is CardDef => Boolean(c))
    // 設定画面で選択されたカードのみ表示 (未設定 = 全て表示)
    .filter((c) => visibleCards.length === 0 || visibleCards.includes(c.id));

  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        {(
          [
            ["all", `全物件 (${kpisAll.propertiesCount})`],
            ["top20", `上位20%のみ (${kpisTop20.propertiesCount})`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setSegment(value)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              segment === value
                ? "bg-indigo-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {label}
          </button>
        ))}
        {segment === "top20" && (
          <span className="text-[11px] text-slate-400">
            ADR上位20%のハイエンド層だけで全指標を再計算しています
          </span>
        )}
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {ordered.map((c) => (
              <SortableCard key={c.id} id={c.id}>
                <Card label={c.label} value={c.value} sub={c.sub} accent={c.accent} />
              </SortableCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <p className="mt-1.5 text-right text-[11px] text-slate-400">
        カードを長押しすると並び替えできます (並び順はこの端末に保存されます)
      </p>
    </div>
  );
}
