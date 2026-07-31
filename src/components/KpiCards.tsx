import { formatJpy, formatPercent } from "@/lib/format";
import type { Kpis } from "@/lib/types";

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
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
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

export default function KpiCards({ kpis }: { kpis: Kpis }) {
  const luminaDiff =
    kpis.luminaAdr !== null && kpis.adr > 0
      ? ((kpis.luminaAdr - kpis.adr) / kpis.adr) * 100
      : null;

  const dist = kpis.minStayDist;
  const distTotal = dist.n1 + dist.n2 + dist.n3plus;
  const pct = (n: number) => (distTotal > 0 ? Math.round((n / distTotal) * 100) : 0);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Card
        label="平均客室単価 (ADR)"
        value={formatJpy(kpis.adr)}
        sub={`${kpis.propertiesCount}物件の平均`}
      />
      <Card label="平均稼働率" value={formatPercent(kpis.occupancyRate)} sub="指定期間の予約埋まり率" />
      <Card label="RevPAR" value={formatJpy(kpis.revpar)} sub="ADR × 稼働率" />
      <Card
        label="Pacing 稼働率"
        value={formatPercent(kpis.pacingOccupancy30)}
        sub={`今後30日 / 60日: ${formatPercent(kpis.pacingOccupancy60)}`}
      />
      <Card
        label="1人当たり平均単価"
        value={formatJpy(kpis.pricePerGuest)}
        sub="1泊料金 ÷ 収容定員"
      />
      <Card
        label="Lumina Fuji 差異"
        value={
          luminaDiff !== null ? `${luminaDiff >= 0 ? "+" : ""}${luminaDiff.toFixed(1)}%` : "—"
        }
        sub={
          kpis.luminaAdr !== null
            ? `自社ADR ${formatJpy(kpis.luminaAdr)} / 稼働 ${
                kpis.luminaOccupancy !== null ? formatPercent(kpis.luminaOccupancy) : "—"
              }`
            : "自社データ未登録"
        }
        accent={luminaDiff !== null ? (luminaDiff >= 0 ? "up" : "down") : null}
      />
      <Card
        label="上位20% ADR (ハイエンド層)"
        value={formatJpy(kpis.top20Adr)}
        sub={`RevPAR ${formatJpy(kpis.top20Revpar)} / 上位${kpis.top20Count}物件`}
      />
      <Card
        label="平均滞在日数 (ALOS)"
        value={kpis.alos !== null ? `${kpis.alos}泊` : "—"}
        sub={
          kpis.alos !== null
            ? "過去12ヶ月実績 (AirROI集計)"
            : "設定の「物件情報を今すぐ更新」後に表示"
        }
      />
      <Card
        label="週末プレミアム"
        value={
          kpis.weekendPremium !== null
            ? `${kpis.weekendPremium >= 0 ? "+" : ""}${kpis.weekendPremium.toFixed(1)}%`
            : "—"
        }
        sub={`平日 ${formatJpy(kpis.weekdayAdr)} → 休前日 ${formatJpy(kpis.preholidayAdr)}`}
        accent={kpis.weekendPremium !== null && kpis.weekendPremium > 0 ? "up" : null}
      />
      <Card
        label="最低2泊以上の物件"
        value={formatPercent(kpis.minStay2PlusShare)}
        sub={`1泊OK ${pct(dist.n1)}% / 2泊 ${pct(dist.n2)}% / 3泊+ ${pct(dist.n3plus)}%`}
      />
    </div>
  );
}
