"use client";

import { type ReactNode, useEffect, useState } from "react";
import { isAllowedIcalUrl } from "@/lib/pricing/config";
import type { AlphaConfig, BetaConfig, GammaConfig, NightType, PricingConfig, PricingDashboard } from "@/lib/pricing/types";
import { type PricingActions, buttonPrimary, buttonSecondary, num1, usd, yen } from "./shared";

const inputClass =
  "w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none disabled:bg-slate-50";
const labelClass = "mb-0.5 block text-[11px] font-semibold text-slate-500";

function NumField({
  label,
  value,
  onValue,
  unit,
  step = "any",
  placeholder,
  hint,
}: {
  label: string;
  value: number | null;
  onValue: (v: number | null) => void;
  unit?: string;
  step?: string;
  placeholder?: string;
  hint?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  // 外部から値が変わった (リセット・保存後の再読込) ときだけ入力欄を同期する
  useEffect(() => {
    setText((t) => {
      const parsed = t.trim() === "" ? null : Number(t);
      return parsed === value ? t : value === null ? "" : String(value);
    });
  }, [value]);
  return (
    <label className="block min-w-0">
      <span className={labelClass}>
        {label}
        {unit && <span className="ml-0.5 font-normal text-slate-400">({unit})</span>}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === "") onValue(null);
          else {
            const n = Number(t);
            if (Number.isFinite(n)) onValue(n);
          }
        }}
        className={inputClass}
      />
      {hint && <span className="mt-0.5 block text-[10px] text-slate-400">{hint}</span>}
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onValue,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onValue: (v: T) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className={labelClass}>{label}</span>
      <select value={value} onChange={(e) => onValue(e.target.value as T)} className={inputClass}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onValue, hint }: { label: string; checked: boolean; onValue: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex min-w-0 items-start gap-2 text-xs text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onValue(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
      />
      <span>
        {label}
        {hint && <span className="block text-[10px] text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-slate-200 p-2.5">
      <legend className="px-1 text-xs font-bold text-slate-700">{title}</legend>
      {note && <p className="mb-2 text-[11px] text-slate-500">{note}</p>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
    </fieldset>
  );
}

const ALPHA_FIELDS: [keyof AlphaConfig, string, string][] = [
  ["highOcc", "強気設定の占有率", "%以上"],
  ["highMin", "強気 補正(下端)", "%"],
  ["highMax", "強気 補正(占有率100%)", "%"],
  ["midOcc", "中位の占有率", "%以上"],
  ["midMin", "中位 補正(下端)", "%"],
  ["midMax", "中位 補正(上端)", "%"],
  ["lowOcc", "値下げの占有率", "%未満"],
  ["lowMaxLead", "値下げ対象リード", "日以内"],
  ["lowMin", "値下げ幅(下端)", "%"],
  ["lowMax", "値下げ幅(占有率0%)", "%"],
];

const BETA_FIELDS: [keyof BetaConfig, string, string][] = [
  ["surgePt", "急増とみなす超過Pace", "pt/7日"],
  ["surgeFullPt", "上限補正の超過Pace", "pt/7日"],
  ["surgeMin", "急増 補正(下端)", "%"],
  ["surgeMax", "急増 補正(上端)", "%"],
  ["stagnantPt", "停滞とみなす遅れ", "pt/7日"],
  ["stagnantMaxLead", "停滞判定の最大リード", "日"],
  ["stagnantMax", "停滞 値下げ幅(最大)", "%"],
];

const GAMMA_FIELDS: [Exclude<keyof GammaConfig, "earlyMode">, string, string][] = [
  ["lastMinuteDays", "直前値下げの日数", "日以内"],
  ["weekdayMaxDiscount", "平日 最大直前値下げ", "%"],
  ["weekendMaxDiscount", "週末 最大直前値下げ", "%"],
  ["earlyLead", "早期予約枠", "日以上先"],
  ["earlyDiscount", "早期確約ディスカウント", "%"],
  ["earlyPremium", "ハイシーズン先行高値", "%"],
  ["earlyStrongOcc", "先行高値にする占有率(auto)", "%以上"],
];

type IcalEdit = { mode: "keep" } | { mode: "set"; url: string } | { mode: "clear" };

/** 10. エンジン設定 (折りたたみ)。保存は saveConfig → router.refresh() */
export default function EngineSettings({ d, api }: { d: PricingDashboard; api: PricingActions }) {
  const [cfg, setCfg] = useState<PricingConfig>(() => structuredClone(d.config));
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<NightType>("weekday");
  const [ical, setIcal] = useState<IcalEdit>({ mode: "keep" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 保存後の再読込などでサーバーの設定が変わったら、未編集時のみ反映する
  const serverJson = JSON.stringify(d.config);
  useEffect(() => {
    if (!dirty) setCfg(JSON.parse(serverJson) as PricingConfig);
  }, [serverJson, dirty]);

  const edit = (fn: (draft: PricingConfig) => void) => {
    setCfg((c) => {
      const n = structuredClone(c);
      fn(n);
      return n;
    });
    setDirty(true);
  };
  /** 必須の数値 (空欄は無視) */
  const req = (fn: (draft: PricingConfig, v: number) => void) => (v: number | null) => {
    if (v !== null) edit((n) => fn(n, v));
  };

  const icalSet = d.status.icalConfigured;
  const members = d.compset.members.length;
  const monthly =
    (Math.min(members, Math.max(0, cfg.compsetRefreshMax)) * 0.1 * 30) / Math.max(1, cfg.compsetRefreshDays);

  const reset = () => {
    setCfg(structuredClone(d.config));
    setIcal({ mode: "keep" });
    setDirty(false);
    setMsg(null);
  };

  const save = async () => {
    setMsg(null);
    const payload: Partial<PricingConfig> = { ...cfg };
    delete payload.icalUrl;
    if (ical.mode === "set") {
      const url = ical.url.trim();
      if (!isAllowedIcalUrl(url)) {
        setMsg({
          ok: false,
          text: "Airbnb のカレンダーエクスポート URL（https://www.airbnb.…/calendar/ical/…）を入力してください",
        });
        return;
      }
      payload.icalUrl = url;
    } else if (ical.mode === "clear") {
      payload.icalUrl = "";
    }
    const res = await api.run({ action: "saveConfig", config: payload });
    if (!res) return;
    setMsg({ ok: res.ok, text: res.message });
    if (res.ok) {
      setDirty(false);
      setIcal({ mode: "keep" });
      if (res.config) setCfg(structuredClone(res.config));
    }
  };

  const a = cfg.alpha[tab];
  const b = cfg.beta[tab];

  return (
    <details className="group min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-3 text-sm font-bold text-slate-900 sm:px-4">
        <span>⚙ エンジン設定</span>
        <span className="text-xs font-normal text-slate-400 group-open:hidden">タップで開く</span>
      </summary>
      <div className="space-y-3 border-t border-slate-100 p-3 sm:p-4">
        <Group title="自社の価格" note="Airbnb で今設定している価格を入れると、乖離率・値上げ/値下げ判定・売上比較が実価格で行われます。">
          <NumField
            label="Airbnb の設定価格 平日"
            unit="円"
            value={cfg.ownPriceWeekday}
            placeholder="未入力"
            onValue={(v) => edit((n) => void (n.ownPriceWeekday = v))}
          />
          <NumField
            label="Airbnb の設定価格 週末"
            unit="円"
            value={cfg.ownPriceWeekend}
            placeholder="未入力"
            onValue={(v) => edit((n) => void (n.ownPriceWeekend = v))}
          />
          <NumField
            label="基準価格 P_base (平日)"
            unit="円"
            value={cfg.basePriceWeekday}
            placeholder={`空 = 設定画面の値`}
            hint={`現在の適用値 ${yen(d.basePrices.weekday)}`}
            onValue={(v) => edit((n) => void (n.basePriceWeekday = v))}
          />
        </Group>

        <Group
          title="曜日プレミアム δ"
          note={`現在の適用値: 週末 +${num1(d.basePrices.weekendPremiumPct)}% / 連休 +${num1(d.basePrices.peakPremiumPct)}%（${
            d.basePrices.premiumSource === "auto" ? "CompSet から自動測定" : d.basePrices.premiumSource === "fixed" ? "固定値" : "測定不能のため設定値"
          }）`}
        >
          <SelectField
            label="決め方"
            value={cfg.weekendPremiumMode}
            options={[
              ["auto", "自動（CompSet の価格比）"],
              ["fixed", "固定"],
            ]}
            onValue={(v) => edit((n) => void (n.weekendPremiumMode = v))}
          />
          <NumField
            label="週末プレミアム"
            unit="%"
            value={cfg.weekendPremiumPct}
            hint={cfg.weekendPremiumMode === "auto" ? "測定不能時に使用" : undefined}
            onValue={req((n, v) => void (n.weekendPremiumPct = v))}
          />
          <NumField
            label="特定連休プレミアム"
            unit="%"
            value={cfg.peakPremiumPct}
            hint={cfg.weekendPremiumMode === "auto" ? "測定不能時に使用" : undefined}
            onValue={req((n, v) => void (n.peakPremiumPct = v))}
          />
        </Group>

        <Group title="ガードレール（下限・上限・丸め）">
          <NumField label="下限 平日" unit="円" value={cfg.floorWeekday} onValue={req((n, v) => void (n.floorWeekday = v))} />
          <NumField label="下限 週末" unit="円" value={cfg.floorWeekend} onValue={req((n, v) => void (n.floorWeekend = v))} />
          <SelectField
            label="上限の決め方"
            value={cfg.ceilingMode}
            options={[
              ["auto", "自動（エリア受容上限）"],
              ["fixed", "固定"],
            ]}
            onValue={(v) => edit((n) => void (n.ceilingMode = v))}
          />
          {cfg.ceilingMode === "fixed" && (
            <>
              <NumField
                label="上限 平日"
                unit="円"
                value={cfg.ceilingWeekday}
                placeholder="未設定"
                onValue={(v) => edit((n) => void (n.ceilingWeekday = v))}
              />
              <NumField
                label="上限 週末"
                unit="円"
                value={cfg.ceilingWeekend}
                placeholder="未設定"
                onValue={(v) => edit((n) => void (n.ceilingWeekend = v))}
              />
            </>
          )}
          <NumField label="丸め単位" unit="円" value={cfg.roundTo} onValue={req((n, v) => void (n.roundTo = v))} />
        </Group>

        <Group title="CompSet 条件" note="件数が最小件数を下回ると ADR帯 → 定員 → 評価/レビュー の順に自動で緩和します。">
          <NumField label="半径" unit="km" value={cfg.compset.radiusKm} onValue={req((n, v) => void (n.compset.radiusKm = v))} />
          <NumField
            label="緩和時の最大半径"
            unit="km"
            value={cfg.compset.maxRadiusKm}
            onValue={req((n, v) => void (n.compset.maxRadiusKm = v))}
          />
          <NumField label="ADR帯 ±" unit="%" value={cfg.compset.adrBandPct} onValue={req((n, v) => void (n.compset.adrBandPct = v))} />
          <NumField label="定員 下限" unit="名" value={cfg.compset.guestsMin} onValue={req((n, v) => void (n.compset.guestsMin = v))} />
          <NumField label="定員 上限" unit="名" value={cfg.compset.guestsMax} onValue={req((n, v) => void (n.compset.guestsMax = v))} />
          <NumField label="評価 下限" value={cfg.compset.minRating} onValue={req((n, v) => void (n.compset.minRating = v))} />
          <NumField label="レビュー 下限" unit="件" value={cfg.compset.minReviews} onValue={req((n, v) => void (n.compset.minReviews = v))} />
          <NumField
            label="最小件数"
            unit="件"
            value={cfg.compset.minSize}
            hint="0 = 緩和しない"
            onValue={req((n, v) => void (n.compset.minSize = v))}
          />
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Toggle
              label="一棟貸しのみ"
              checked={cfg.compset.entireHomeOnly}
              onValue={(v) => edit((n) => void (n.compset.entireHomeOnly = v))}
            />
          </div>
        </Group>

        <Group title="指標">
          <NumField label="対象期間" unit="日" value={cfg.horizonDays} onValue={req((n, v) => void (n.horizonDays = v))} />
          <NumField label="カレンダー鮮度" unit="日以内" value={cfg.freshnessDays} onValue={req((n, v) => void (n.freshnessDays = v))} />
          <SelectField
            label="競合価格の統計量"
            value={cfg.adrStat}
            options={[
              ["median", "中央値"],
              ["trimmed", "トリム平均"],
            ]}
            onValue={(v) => edit((n) => void (n.adrStat = v))}
          />
          <NumField
            label="縮小推定の強さ"
            unit="疑似物件数"
            value={cfg.shrinkStrength}
            onValue={req((n, v) => void (n.shrinkStrength = v))}
          />
          <NumField
            label="需給係数の最小物件数"
            unit="件"
            value={cfg.minUnitsForSignal}
            onValue={req((n, v) => void (n.minUnitsForSignal = v))}
          />
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Toggle
              label="ブロック補正"
              hint="ホストのブロック日を実績比率で除外"
              checked={cfg.blockAdjust}
              onValue={(v) => edit((n) => void (n.blockAdjust = v))}
            />
          </div>
        </Group>

        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-2.5">
          <legend className="px-1 text-xs font-bold text-slate-700">補正係数 α・β（区分別）</legend>
          <div className="mb-2 inline-flex rounded-lg bg-slate-100 p-0.5" role="tablist">
            {(["weekday", "weekend"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1 text-xs font-semibold ${
                  tab === t ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"
                }`}
              >
                {t === "weekday" ? "平日" : "週末"}
              </button>
            ))}
          </div>
          <p className="mb-1 text-[11px] font-semibold text-slate-600">α 競合占有率係数</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {ALPHA_FIELDS.map(([key, label, unit]) => (
              <NumField
                key={`${tab}-a-${key}`}
                label={label}
                unit={unit}
                value={a[key]}
                onValue={req((n, v) => void (n.alpha[tab][key] = v))}
              />
            ))}
          </div>
          <p className="mb-1 mt-3 text-[11px] font-semibold text-slate-600">β 消化ペース係数</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {BETA_FIELDS.map(([key, label, unit]) => (
              <NumField
                key={`${tab}-b-${key}`}
                label={label}
                unit={unit}
                value={b[key]}
                onValue={req((n, v) => void (n.beta[tab][key] = v))}
              />
            ))}
          </div>
        </fieldset>

        <Group title="γ リードタイム係数">
          {GAMMA_FIELDS.map(([key, label, unit]) => (
            <NumField
              key={key}
              label={label}
              unit={unit}
              value={cfg.gamma[key]}
              onValue={req((n, v) => void (n.gamma[key] = v))}
            />
          ))}
          <SelectField
            label="早期予約枠の扱い"
            value={cfg.gamma.earlyMode}
            options={[
              ["auto", "自動（占有率で判定）"],
              ["discount", "早期確約ディスカウント"],
              ["premium", "ハイシーズン先行高値"],
            ]}
            onValue={(v) => edit((n) => void (n.gamma.earlyMode = v))}
          />
        </Group>

        <Group title="Pace・アラート">
          <NumField label="要注意日の超過Pace" unit="pt/7日" value={cfg.spike.minPt} onValue={req((n, v) => void (n.spike.minPt = v))} />
          <NumField
            label="要注意日の新規予約"
            unit="件以上"
            value={cfg.spike.minNewBookings}
            onValue={req((n, v) => void (n.spike.minNewBookings = v))}
          />
          <NumField
            label="週末の競合残室"
            unit="室以下"
            value={cfg.alerts.weekendRemainingMax}
            onValue={req((n, v) => void (n.alerts.weekendRemainingMax = v))}
          />
          <NumField
            label="平日の超過Pace"
            unit="pt/7日"
            value={cfg.alerts.weekdaySpikePt}
            onValue={req((n, v) => void (n.alerts.weekdaySpikePt = v))}
          />
          <NumField
            label="値上げ/値下げ判定"
            unit="%以上の差"
            value={cfg.alerts.changePct}
            onValue={req((n, v) => void (n.alerts.changePct = v))}
          />
        </Group>

        <Group
          title="CompSet 自動取得（有料）"
          note={
            <>
              毎日の定期実行で競合カレンダーを取得します（$0.10/件）。月額目安 = min({members}件, 上限) × $0.10 × 30 / 周期 ={" "}
              <span className="font-bold text-slate-800">約{usd(monthly)}/月</span>
              {cfg.compsetAutoRefresh ? "" : "（現在オフ: 費用は発生しません）"}
              。データ設定の「1日の料金カレンダー取得上限」とは別枠で、この取得にも同じ件数の日次上限がかかります。
            </>
          }
        >
          <div className="col-span-2 flex items-end sm:col-span-1">
            <Toggle
              label="自動取得する"
              checked={cfg.compsetAutoRefresh}
              onValue={(v) => edit((n) => void (n.compsetAutoRefresh = v))}
            />
          </div>
          <NumField
            label="取得周期"
            unit="日ごと"
            value={cfg.compsetRefreshDays}
            onValue={req((n, v) => void (n.compsetRefreshDays = v))}
          />
          <NumField
            label="1回の上限件数"
            unit="件"
            value={cfg.compsetRefreshMax}
            hint="最大50"
            onValue={req((n, v) => void (n.compsetRefreshMax = v))}
          />
        </Group>

        <Group title="売上シミュレーション（需要の価格弾力性・仮定）">
          <NumField label="感応度 低" value={cfg.elasticity.low} onValue={req((n, v) => void (n.elasticity.low = v))} />
          <NumField label="感応度 中" value={cfg.elasticity.central} onValue={req((n, v) => void (n.elasticity.central = v))} />
          <NumField label="感応度 高" value={cfg.elasticity.high} onValue={req((n, v) => void (n.elasticity.high = v))} />
          <NumField
            label="逼迫による弾力性補正"
            value={cfg.tightnessDamping}
            hint="0 = 使わない / 0〜1"
            onValue={req((n, v) => void (n.tightnessDamping = v))}
          />
        </Group>

        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-2.5">
          <legend className="px-1 text-xs font-bold text-slate-700">自社カレンダー（iCal）</legend>
          <p className="mb-1 text-[11px] text-slate-500">
            Airbnb のカレンダーエクスポート URL（https://www.airbnb.…/calendar/ical/…）。URL は秘密情報を含むため保存後は表示しません。
          </p>
          {ical.mode === "set" ? (
            <div className="flex flex-col gap-1.5 sm:flex-row">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={ical.url}
                placeholder="https://www.airbnb.jp/calendar/ical/….ics?s=…"
                onChange={(e) => {
                  setIcal({ mode: "set", url: e.target.value });
                  setDirty(true);
                }}
                className={inputClass}
              />
              <button type="button" onClick={() => setIcal({ mode: "keep" })} className={buttonSecondary}>
                取消
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600">
                {ical.mode === "clear" ? "（保存時に削除）" : icalSet || cfg.icalUrl ? "••••••••（設定済み）" : "未設定"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setIcal({ mode: "set", url: "" });
                  setDirty(true);
                }}
                className={buttonSecondary}
              >
                {icalSet ? "変更" : "設定"}
              </button>
              {(icalSet || cfg.icalUrl) && ical.mode !== "clear" && (
                <button
                  type="button"
                  onClick={() => {
                    setIcal({ mode: "clear" });
                    setDirty(true);
                  }}
                  className="text-xs font-semibold text-rose-600 hover:underline"
                >
                  削除
                </button>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-2.5">
          <legend className="px-1 text-xs font-bold text-slate-700">特定連休</legend>
          <p className="mb-1 text-[11px] text-slate-500">MM-DD 形式。終了日を含む。開始 &gt; 終了 は年末→年始とみなします。</p>
          <div className="space-y-1.5">
            {cfg.peakPeriods.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_4.5rem_4.5rem_auto] items-center gap-1.5">
                <input
                  aria-label="名称"
                  value={p.name}
                  onChange={(e) => edit((n) => void (n.peakPeriods[i].name = e.target.value))}
                  className={inputClass}
                />
                <input
                  aria-label="開始 MM-DD"
                  value={p.start}
                  placeholder="12-28"
                  onChange={(e) => edit((n) => void (n.peakPeriods[i].start = e.target.value))}
                  className={inputClass}
                />
                <input
                  aria-label="終了 MM-DD"
                  value={p.end}
                  placeholder="01-03"
                  onChange={(e) => edit((n) => void (n.peakPeriods[i].end = e.target.value))}
                  className={inputClass}
                />
                <button
                  type="button"
                  aria-label="削除"
                  onClick={() => edit((n) => void n.peakPeriods.splice(i, 1))}
                  className="px-1 text-slate-400 hover:text-rose-600"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => edit((n) => void n.peakPeriods.push({ name: "", start: "", end: "" }))}
              className="text-xs font-semibold text-indigo-600 hover:underline"
            >
              ＋ 連休を追加
            </button>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={api.disabled || api.busy !== null || !dirty} className={buttonPrimary}>
            {api.busy === "saveConfig" ? "保存中…" : "設定を保存"}
          </button>
          <button type="button" onClick={reset} disabled={!dirty} className={buttonSecondary}>
            元に戻す
          </button>
          {api.disabled && <span className="text-[11px] text-slate-400">デモモードでは保存できません</span>}
          {dirty && !api.disabled && <span className="text-[11px] text-amber-700">未保存の変更があります</span>}
        </div>
        {msg && (
          <p className={`rounded-lg px-2 py-1.5 text-xs ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>
            {msg.text}
          </p>
        )}
      </div>
    </details>
  );
}
