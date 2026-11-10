"use client";

import { type ReactNode, useState } from "react";
import type { CoefficientDetail, DayRecommendation, OwnStatus, PricingDashboard } from "@/lib/pricing/types";
import {
  ACTION_LABEL,
  OWN_PRICE_SOURCE_LABEL,
  OWN_STATUS_LABEL,
  OWN_STATUS_SOURCE_LABEL,
  type PricingActions,
  SIGNAL_LABEL,
  changeClass,
  changeLabel,
  coefPct,
  dowClass,
  mdw,
  num1,
  ownChipClass,
  pct,
  signedPt,
  yen,
} from "./shared";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-bold text-slate-700">{title}</h4>
      {children}
    </div>
  );
}

function KV({ k, v, strong = false }: { k: string; v: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-100 py-0.5 text-xs">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className={`min-w-0 text-right ${strong ? "font-bold text-slate-900" : "text-slate-700"}`}>{v}</span>
    </div>
  );
}

interface Step {
  label: string;
  coef: string | null;
  price: number;
  reason: string;
  emphasis?: boolean;
}

function breakdown(day: DayRecommendation, d: PricingDashboard): Step[] {
  const p = day.pricing;
  const coefs: [string, CoefficientDetail][] = [
    ["×(1+δ) 曜日属性", p.delta],
    ["×(1+α) 競合占有率", p.alpha],
    ["×(1+β) 消化ペース", p.beta],
    ["×(1+γ) リードタイム", p.gamma],
  ];
  const steps: Step[] = [
    {
      label: "P_base 基準価格",
      coef: null,
      price: p.basePrice,
      reason:
        d.config.basePriceWeekday === null ? "平日基準（設定画面の自物件基準価格）" : "平日基準（エンジン設定の基準価格）",
    },
  ];
  let cur = p.basePrice;
  for (const [label, c] of coefs) {
    const v = Number.isFinite(c.value) ? c.value : 0;
    cur = cur * (1 + v);
    steps.push({ label, coef: coefPct(v), price: cur, reason: c.reason });
  }
  const guard =
    p.clampedBy === "floor"
      ? `下限 ${yen(p.floor)} を適用`
      : p.clampedBy === "ceiling"
        ? `上限 ${yen(p.ceiling)} を適用`
        : "範囲内（調整なし）";
  steps.push({
    label: "ガードレール",
    coef: null,
    price: p.clampedBy === "floor" ? p.floor : p.clampedBy === "ceiling" ? p.ceiling : p.rawPrice,
    reason: `算出価格 ${yen(p.rawPrice)}／下限 ${yen(p.floor)}〜上限 ${yen(p.ceiling)}：${guard}`,
  });
  steps.push({
    label: "推奨価格",
    coef: null,
    price: p.recommended,
    reason: `${d.config.roundTo.toLocaleString("ja-JP")}円単位に丸め・${SIGNAL_LABEL[p.signal]}`,
    emphasis: true,
  });
  return steps;
}

/** 日別詳細: 推奨価格の内訳・占有率・Pace・競合一覧・自社の状況切替 */
export default function DayDetail({
  day,
  d,
  api,
  onClose,
}: {
  day: DayRecommendation;
  d: PricingDashboard;
  api: PricingActions;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { market, pricing, own, night } = day;
  const memberById = new Map(d.compset.members.map((m) => [m.id, m]));
  const unavailable = market.listings.filter((l) => !l.available);
  const available = market.listings
    .filter((l) => l.available)
    .sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
  const name = (id: string) => memberById.get(id)?.title ?? id;
  const noCalendar = d.compset.members.length - market.listings.length;

  const setStatus = async (status: OwnStatus) => {
    setMsg(null);
    const res = await api.run({ action: "setOwnStatus", date: day.date, status });
    if (res) setMsg({ ok: res.ok, text: res.message });
  };
  const clearStatus = async () => {
    setMsg(null);
    const res = await api.run({ action: "clearOwnStatus", date: day.date });
    if (res) setMsg({ ok: res.ok, text: res.message });
  };

  const steps = breakdown(day, d);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-base font-bold ${dowClass(night)}`}>
            {mdw(day.date)}
            <span className="ml-2 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
              {night.type === "weekend" ? "週末" : "平日"}
            </span>
          </p>
          <p className="text-[11px] text-slate-500">
            {night.reason}・{day.lead === 0 ? "今夜" : `${day.lead}日後`}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2 text-center">
        <div>
          <p className="text-[10px] text-slate-500">現在価格</p>
          <p className={`text-sm font-semibold ${own.currentPriceSource === "assumed" ? "text-slate-400" : "text-slate-800"}`}>
            {yen(own.currentPrice)}
            {own.currentPriceSource === "assumed" && own.currentPrice !== null && <span className="ml-0.5 text-[10px]">仮</span>}
          </p>
          <p className="text-[10px] text-slate-400">{OWN_PRICE_SOURCE_LABEL[own.currentPriceSource]}</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500">推奨価格</p>
          <p className={`text-sm text-indigo-700 ${pricing.signal === "rules_only" ? "font-normal" : "font-bold"}`}>
            {yen(pricing.recommended)}
          </p>
          <p className="text-[10px] text-slate-400">{pricing.signal === "rules_only" ? "ルール" : SIGNAL_LABEL[pricing.signal]}</p>
        </div>
        <div>
          <p className="text-[10px] text-slate-500">乖離率</p>
          <p className={`text-sm font-semibold ${own.status === "vacant" ? changeClass(pricing.changePct) : "text-slate-400"}`}>
            {own.status === "vacant" ? changeLabel(pricing.changePct) : "—"}
          </p>
          <p className="text-[10px] text-slate-400">{ACTION_LABEL[pricing.action]}</p>
        </div>
      </div>

      <Section title="自社の状況">
        <div className="flex flex-wrap items-center gap-2">
          {own.statusSource === "none" ? (
            <span className="rounded border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500">
              不明（空室と仮定して推奨を算出）
            </span>
          ) : (
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${ownChipClass(own.status)}`}>
              {OWN_STATUS_LABEL[own.status]}
            </span>
          )}
          <span className="text-[11px] text-slate-500">出所: {OWN_STATUS_SOURCE_LABEL[own.statusSource]}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {(["booked", "blocked", "vacant"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={api.disabled || api.busy !== null}
              onClick={() => setStatus(s)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                own.statusSource === "manual" && own.status === s
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {OWN_STATUS_LABEL[s]}にする
            </button>
          ))}
          {own.statusSource === "manual" && (
            <button
              type="button"
              disabled={api.disabled || api.busy !== null}
              onClick={clearStatus}
              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-rose-600 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              手動指定を解除
            </button>
          )}
        </div>
        {api.disabled && <p className="mt-1 text-[10px] text-slate-400">デモモードでは変更できません</p>}
        {msg && (
          <p className={`mt-1 rounded-lg px-2 py-1 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
            {msg.text}
          </p>
        )}
      </Section>

      <Section title="推奨価格の内訳">
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li
              key={i}
              className={`rounded-lg border px-2 py-1 ${s.emphasis ? "border-indigo-300 bg-indigo-50" : "border-slate-100"}`}
            >
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-700">
                  {s.label}
                  {s.coef && (
                    <span className={`ml-1.5 ${s.coef.startsWith("+") ? "text-rose-600" : s.coef.startsWith("−") ? "text-blue-600" : "text-slate-400"}`}>
                      {s.coef}
                    </span>
                  )}
                </span>
                <span className={s.emphasis ? "font-bold text-indigo-700" : "text-slate-800"}>{yen(s.price)}</span>
              </div>
              <p className="text-[11px] leading-snug text-slate-500">{s.reason}</p>
            </li>
          ))}
        </ol>
      </Section>

      <div className="grid gap-3 sm:grid-cols-2">
        <Section title="競合占有率">
          <KV k="補正前（予約不可率）" v={pct(market.occRaw)} />
          <KV k="ブロック補正後" v={pct(market.occAdj)} />
          <KV
            k="縮小推定（Occ_t）"
            v={
              <>
                {pct(market.occ)}
                {market.occCi && (
                  <span className="ml-1 text-[10px] text-slate-400">
                    80%区間 {num1(market.occCi[0])}〜{num1(market.occCi[1])}%
                  </span>
                )}
              </>
            }
            strong
          />
          <KV
            k="有効室数"
            v={`${num1(market.effectiveUnits)}室（取得 ${market.units}件・予約不可 ${market.unavailable}件・推定予約 ${num1(market.expectedBooked)}）`}
          />
          <KV
            k="残室"
            v={`${market.remaining}室${market.remainingEst !== null ? `（CompSet全体で推定 ${market.remainingEst}室）` : ""}`}
          />
          <KV k="競合中央価格" v={`${yen(market.compAdr)}${market.priceCount > 0 ? `（${market.priceCount}件）` : ""}`} />
          <KV k="データ鮮度" v={market.maxAgeDays === null ? "—" : `最古 ${market.maxAgeDays}日前の取得`} />
          <KV
            k="データ品質"
            v={market.dataQuality === "ok" ? "十分" : market.dataQuality === "low" ? "少（斜線）" : "なし"}
          />
        </Section>

        <Section title="消化ペース（Pace）">
          <KV k="生の増加ペース" v={market.paceRaw === null ? "—" : `${signedPt(market.paceRaw)} pt/7日`} />
          <KV k="予約曲線の期待値" v={market.paceExpected === null ? "—" : `${signedPt(market.paceExpected)} pt/7日`} />
          <KV
            k="超過ペース（PI_t）"
            v={market.pace === null ? "—（未算出）" : `${signedPt(market.pace)} pt/7日${market.spike ? " ⚡急増" : ""}`}
            strong
          />
          <KV k="比較間隔" v={market.paceDays === null ? "—" : `${num1(market.paceDays)}日`} />
          <KV k="新規予約" v={market.newBookings === null ? "—" : `${market.newBookings}件`} />
        </Section>
      </div>

      <Section title={`この日の競合（${market.listings.length}件）`}>
        {market.listings.length === 0 ? (
          <p className="text-xs text-slate-400">有効なカレンダーがある競合はありません</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-slate-500">予約不可（{unavailable.length}件）</p>
              <ul className="mt-0.5 space-y-0.5">
                {unavailable.map((l) => (
                  <li key={l.id} className="truncate text-xs text-slate-500">
                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-rose-400 align-middle" />
                    {name(l.id)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-slate-500">空き（{available.length}件）</p>
              <ul className="mt-0.5 space-y-0.5">
                {available.map((l) => (
                  <li key={l.id} className="flex items-baseline justify-between gap-2 text-xs text-slate-700">
                    <span className="min-w-0 truncate">
                      <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle" />
                      {name(l.id)}
                    </span>
                    <span className="shrink-0 font-semibold">{yen(l.price)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {noCalendar > 0 && (
          <p className="mt-1 text-[10px] text-slate-400">他 {noCalendar}件はこの日の有効なカレンダーがありません</p>
        )}
      </Section>
    </div>
  );
}
