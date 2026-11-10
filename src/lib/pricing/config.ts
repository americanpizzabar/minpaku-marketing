/**
 * プライシング設定の既定値と検証 (純関数のみ。クライアントからも import 可能)。
 * DB への保存・読込は config-store.ts を参照。
 */
import type { PeakPeriod, PricingConfig } from "./types";

export const DEFAULT_PEAK_PERIODS: PeakPeriod[] = [
  { name: "年末年始", start: "12-28", end: "01-03" },
  { name: "ゴールデンウィーク", start: "04-29", end: "05-05" },
  { name: "お盆", start: "08-11", end: "08-16" },
];

/** 仕様書 (2章・3.3章・6章) の値をそのまま既定値にする */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  horizonDays: 60,
  basePriceWeekday: null,
  weekendPremiumMode: "auto",
  weekendPremiumPct: 15,
  floorWeekday: 60000,
  floorWeekend: 90000,
  ceilingMode: "auto",
  ceilingWeekday: null,
  ceilingWeekend: null,
  roundTo: 1000,
  compset: {
    radiusKm: 6,
    maxRadiusKm: 7,
    entireHomeOnly: true,
    adrBandPct: 30,
    guestsMin: 6,
    guestsMax: 10,
    minRating: 4.7,
    minReviews: 5,
    minSize: 8,
  },
  freshnessDays: 10,
  blockAdjust: true,
  adrStat: "median",
  shrinkStrength: 2,
  minUnitsForSignal: 3,
  alpha: {
    highOcc: 80,
    highMin: 15,
    highMax: 25,
    midOcc: 50,
    midMin: 5,
    midMax: 10,
    lowOcc: 30,
    lowMaxLead: 14,
    lowMin: 10,
    lowMax: 20,
  },
  beta: {
    surgePt: 10,
    surgeFullPt: 30,
    surgeMin: 5,
    surgeMax: 15,
    stagnantPt: 2,
    stagnantMaxLead: 30,
    stagnantMax: 5,
  },
  gamma: {
    lastMinuteDays: 7,
    weekdayMaxDiscount: 25,
    weekendMaxDiscount: 10,
    earlyLead: 45,
    earlyMode: "auto",
    earlyDiscount: 5,
    earlyPremium: 5,
    earlyStrongOcc: 40,
  },
  spike: { minPt: 20, minNewBookings: 2 },
  alerts: { weekendRemainingMax: 3, weekdaySpikePt: 15, deviationPct: 10 },
  elasticity: { low: -0.8, central: -1.5, high: -2.5 },
  tightnessDamping: 0.7,
  compsetRefreshDays: 3,
  compsetRefreshMax: 20,
  icalUrl: null,
  peakPeriods: DEFAULT_PEAK_PERIODS,
};

type Json = Record<string, unknown>;

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numOrNull(v: unknown, fallback: number | null, min: number, max: number): number | null {
  if (v === null || v === "") return null;
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function obj(v: unknown): Json {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function peakPeriods(v: unknown, fallback: PeakPeriod[]): PeakPeriod[] {
  if (!Array.isArray(v)) return fallback;
  const out: PeakPeriod[] = [];
  for (const raw of v) {
    const p = obj(raw);
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 40) : "";
    const start = typeof p.start === "string" ? p.start.trim() : "";
    const end = typeof p.end === "string" ? p.end.trim() : "";
    if (name && MMDD.test(start) && MMDD.test(end)) out.push({ name, start, end });
  }
  return out.slice(0, 20);
}

/**
 * 保存値 (部分的・不正値を含みうる) を既定値とマージして、範囲内に収めた完全な設定を返す。
 * base を渡した場合はその値を土台にする (部分更新用)。
 */
export function normalizePricingConfig(raw: unknown, base: PricingConfig = DEFAULT_PRICING_CONFIG): PricingConfig {
  const r = obj(raw);
  const c = obj(r.compset);
  const a = obj(r.alpha);
  const b = obj(r.beta);
  const g = obj(r.gamma);
  const sp = obj(r.spike);
  const al = obj(r.alerts);
  const el = obj(r.elasticity);

  const compsetRadius = num(c.radiusKm, base.compset.radiusKm, 0.5, 30);
  const guestsMin = Math.round(num(c.guestsMin, base.compset.guestsMin, 1, 50));
  const guestsMax = Math.round(num(c.guestsMax, base.compset.guestsMax, 1, 50));

  const cfg: PricingConfig = {
    horizonDays: Math.round(num(r.horizonDays, base.horizonDays, 14, 120)),
    basePriceWeekday: numOrNull(r.basePriceWeekday, base.basePriceWeekday, 1000, 10_000_000),
    weekendPremiumMode: oneOf(r.weekendPremiumMode, ["auto", "fixed"] as const, base.weekendPremiumMode),
    weekendPremiumPct: num(r.weekendPremiumPct, base.weekendPremiumPct, 0, 100),
    floorWeekday: num(r.floorWeekday, base.floorWeekday, 0, 10_000_000),
    floorWeekend: num(r.floorWeekend, base.floorWeekend, 0, 10_000_000),
    ceilingMode: oneOf(r.ceilingMode, ["auto", "fixed"] as const, base.ceilingMode),
    ceilingWeekday: numOrNull(r.ceilingWeekday, base.ceilingWeekday, 1000, 10_000_000),
    ceilingWeekend: numOrNull(r.ceilingWeekend, base.ceilingWeekend, 1000, 10_000_000),
    roundTo: Math.round(num(r.roundTo, base.roundTo, 1, 100_000)),
    compset: {
      radiusKm: compsetRadius,
      maxRadiusKm: Math.max(compsetRadius, num(c.maxRadiusKm, base.compset.maxRadiusKm, 0.5, 50)),
      entireHomeOnly: bool(c.entireHomeOnly, base.compset.entireHomeOnly),
      adrBandPct: num(c.adrBandPct, base.compset.adrBandPct, 1, 300),
      guestsMin: Math.min(guestsMin, guestsMax),
      guestsMax: Math.max(guestsMin, guestsMax),
      minRating: num(c.minRating, base.compset.minRating, 0, 5),
      minReviews: Math.round(num(c.minReviews, base.compset.minReviews, 0, 10_000)),
      minSize: Math.round(num(c.minSize, base.compset.minSize, 0, 100)),
    },
    freshnessDays: Math.round(num(r.freshnessDays, base.freshnessDays, 1, 60)),
    blockAdjust: bool(r.blockAdjust, base.blockAdjust),
    adrStat: oneOf(r.adrStat, ["median", "trimmed"] as const, base.adrStat),
    shrinkStrength: num(r.shrinkStrength, base.shrinkStrength, 0, 50),
    minUnitsForSignal: Math.round(num(r.minUnitsForSignal, base.minUnitsForSignal, 1, 50)),
    alpha: {
      highOcc: num(a.highOcc, base.alpha.highOcc, 0, 100),
      highMin: num(a.highMin, base.alpha.highMin, 0, 200),
      highMax: num(a.highMax, base.alpha.highMax, 0, 200),
      midOcc: num(a.midOcc, base.alpha.midOcc, 0, 100),
      midMin: num(a.midMin, base.alpha.midMin, 0, 200),
      midMax: num(a.midMax, base.alpha.midMax, 0, 200),
      lowOcc: num(a.lowOcc, base.alpha.lowOcc, 0, 100),
      lowMaxLead: Math.round(num(a.lowMaxLead, base.alpha.lowMaxLead, 0, 120)),
      lowMin: num(a.lowMin, base.alpha.lowMin, 0, 90),
      lowMax: num(a.lowMax, base.alpha.lowMax, 0, 90),
    },
    beta: {
      surgePt: num(b.surgePt, base.beta.surgePt, 0, 100),
      surgeFullPt: num(b.surgeFullPt, base.beta.surgeFullPt, 0, 100),
      surgeMin: num(b.surgeMin, base.beta.surgeMin, 0, 200),
      surgeMax: num(b.surgeMax, base.beta.surgeMax, 0, 200),
      stagnantPt: num(b.stagnantPt, base.beta.stagnantPt, -100, 100),
      stagnantMaxLead: Math.round(num(b.stagnantMaxLead, base.beta.stagnantMaxLead, 1, 120)),
      stagnantMax: num(b.stagnantMax, base.beta.stagnantMax, 0, 90),
    },
    gamma: {
      lastMinuteDays: Math.round(num(g.lastMinuteDays, base.gamma.lastMinuteDays, 0, 60)),
      weekdayMaxDiscount: num(g.weekdayMaxDiscount, base.gamma.weekdayMaxDiscount, 0, 90),
      weekendMaxDiscount: num(g.weekendMaxDiscount, base.gamma.weekendMaxDiscount, 0, 90),
      earlyLead: Math.round(num(g.earlyLead, base.gamma.earlyLead, 1, 365)),
      earlyMode: oneOf(g.earlyMode, ["auto", "discount", "premium"] as const, base.gamma.earlyMode),
      earlyDiscount: num(g.earlyDiscount, base.gamma.earlyDiscount, 0, 90),
      earlyPremium: num(g.earlyPremium, base.gamma.earlyPremium, 0, 200),
      earlyStrongOcc: num(g.earlyStrongOcc, base.gamma.earlyStrongOcc, 0, 100),
    },
    spike: {
      minPt: num(sp.minPt, base.spike.minPt, 0, 100),
      minNewBookings: Math.round(num(sp.minNewBookings, base.spike.minNewBookings, 0, 100)),
    },
    alerts: {
      weekendRemainingMax: Math.round(num(al.weekendRemainingMax, base.alerts.weekendRemainingMax, 0, 100)),
      weekdaySpikePt: num(al.weekdaySpikePt, base.alerts.weekdaySpikePt, 0, 100),
      deviationPct: num(al.deviationPct, base.alerts.deviationPct, 0, 100),
    },
    elasticity: {
      low: num(el.low, base.elasticity.low, -10, 0),
      central: num(el.central, base.elasticity.central, -10, 0),
      high: num(el.high, base.elasticity.high, -10, 0),
    },
    tightnessDamping: num(r.tightnessDamping, base.tightnessDamping, 0, 1),
    compsetRefreshDays: Math.round(num(r.compsetRefreshDays, base.compsetRefreshDays, 1, 60)),
    compsetRefreshMax: Math.round(num(r.compsetRefreshMax, base.compsetRefreshMax, 0, 200)),
    icalUrl:
      r.icalUrl === null || r.icalUrl === ""
        ? null
        : typeof r.icalUrl === "string" && /^https:\/\/\S+$/.test(r.icalUrl.trim())
          ? r.icalUrl.trim().slice(0, 1000)
          : base.icalUrl,
    peakPeriods: peakPeriods(r.peakPeriods, base.peakPeriods),
  };
  // 上限・下限の逆転を防ぐ
  if (cfg.alpha.highMax < cfg.alpha.highMin) cfg.alpha.highMax = cfg.alpha.highMin;
  if (cfg.alpha.midMax < cfg.alpha.midMin) cfg.alpha.midMax = cfg.alpha.midMin;
  if (cfg.alpha.lowMax < cfg.alpha.lowMin) cfg.alpha.lowMax = cfg.alpha.lowMin;
  if (cfg.beta.surgeMax < cfg.beta.surgeMin) cfg.beta.surgeMax = cfg.beta.surgeMin;
  if (cfg.beta.surgeFullPt < cfg.beta.surgePt) cfg.beta.surgeFullPt = cfg.beta.surgePt;
  return cfg;
}

/** UI に返す設定。iCal URL は秘密トークンを含むため伏せる */
export function maskPricingConfig(cfg: PricingConfig): PricingConfig {
  return { ...cfg, icalUrl: cfg.icalUrl ? "(設定済み)" : null };
}

/** UI が編集した設定を保存用に正規化する。マスク値 "(設定済み)" は既存値を保持する意味 */
export function mergeEditedPricingConfig(current: PricingConfig, edited: unknown): PricingConfig {
  const e = obj(edited);
  const next = normalizePricingConfig({ ...e, icalUrl: e.icalUrl === "(設定済み)" ? current.icalUrl : e.icalUrl }, current);
  return next;
}
