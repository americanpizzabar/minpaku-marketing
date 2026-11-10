/**
 * プライシング設定の既定値と検証 (純関数のみ。クライアントからも import 可能)。
 * DB への保存・読込は config-store.ts を参照。
 */
import type { AlphaConfig, BetaConfig, NightType, PeakPeriod, PricingConfig } from "./types";

export const DEFAULT_PEAK_PERIODS: PeakPeriod[] = [
  { name: "年末年始", start: "12-28", end: "01-03" },
  { name: "ゴールデンウィーク", start: "04-29", end: "05-05" },
  { name: "お盆", start: "08-11", end: "08-16" },
];

/** 仕様書 3.3 の表の値 (平日・週末とも同じ値から開始し、区分ごとに調整できる) */
export const DEFAULT_ALPHA: AlphaConfig = {
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
};

export const DEFAULT_BETA: BetaConfig = {
  surgePt: 10,
  surgeFullPt: 30,
  surgeMin: 5,
  surgeMax: 15,
  stagnantPt: 2,
  stagnantMaxLead: 30,
  stagnantMax: 5,
};

/** 仕様書 (2章・3.3章・6章) の値をそのまま既定値にする */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  horizonDays: 60,
  basePriceWeekday: null,
  weekendPremiumMode: "auto",
  weekendPremiumPct: 15,
  peakPremiumPct: 30,
  floorWeekday: 60000,
  floorWeekend: 90000,
  ceilingMode: "auto",
  ceilingWeekday: null,
  ceilingWeekend: null,
  roundTo: 1000,
  ownPriceWeekday: null,
  ownPriceWeekend: null,
  compset: {
    radiusKm: 7,
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
  alpha: { weekday: { ...DEFAULT_ALPHA }, weekend: { ...DEFAULT_ALPHA } },
  beta: { weekday: { ...DEFAULT_BETA }, weekend: { ...DEFAULT_BETA } },
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
  alerts: { weekendRemainingMax: 3, weekdaySpikePt: 15, changePct: 10 },
  elasticity: { low: -0.8, central: -1.5, high: -2.5 },
  tightnessDamping: 0,
  compsetAutoRefresh: false,
  compsetRefreshDays: 3,
  compsetRefreshMax: 20,
  icalUrl: null,
  peakPeriods: DEFAULT_PEAK_PERIODS,
};

type Json = Record<string, unknown>;

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (v === null || v === undefined || typeof v === "boolean" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numOrNull(v: unknown, fallback: number | null, min: number, max: number): number | null {
  if (v === null || v === "") return null;
  if (v === undefined) return fallback;
  const n = Number(v);
  if (typeof v === "boolean" || !Number.isFinite(n)) return fallback;
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
 * Airbnb の公式ドメイン (完全一致)。"airbnb." で始まる任意のドメイン (airbnb.evil.com など) を通さないよう、
 * サフィックスを列挙する。
 */
const AIRBNB_HOST =
  /^(www\.)?airbnb\.(com|jp|ca|de|fr|it|es|nl|ch|at|be|ie|pt|se|dk|no|fi|pl|cz|gr|cn|co\.jp|co\.uk|co\.nz|co\.kr|co\.in|com\.au|com\.sg|com\.hk|com\.tw|com\.my|com\.br|com\.mx|com\.ar)$/i;

/** Airbnb の iCal エクスポート URL のみ許可 (任意ホストへのサーバー側 fetch を防ぐ) */
export function isAllowedIcalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.port === "" &&
      u.username === "" &&
      u.password === "" &&
      AIRBNB_HOST.test(u.hostname) &&
      u.pathname.startsWith("/calendar/ical/")
    );
  } catch {
    return false;
  }
}

function alphaOf(v: unknown, base: AlphaConfig): AlphaConfig {
  const a = obj(v);
  const cfg: AlphaConfig = {
    highOcc: num(a.highOcc, base.highOcc, 1, 99),
    highMin: num(a.highMin, base.highMin, 0, 200),
    highMax: num(a.highMax, base.highMax, 0, 200),
    midOcc: num(a.midOcc, base.midOcc, 0, 98),
    midMin: num(a.midMin, base.midMin, 0, 200),
    midMax: num(a.midMax, base.midMax, 0, 200),
    lowOcc: num(a.lowOcc, base.lowOcc, 0, 98),
    lowMaxLead: Math.round(num(a.lowMaxLead, base.lowMaxLead, 0, 120)),
    lowMin: num(a.lowMin, base.lowMin, 0, 90),
    lowMax: num(a.lowMax, base.lowMax, 0, 90),
  };
  // 帯の順序 lowOcc <= midOcc < highOcc を保証し、上下限の逆転を防ぐ
  if (cfg.midOcc >= cfg.highOcc) cfg.midOcc = cfg.highOcc - 1;
  if (cfg.lowOcc > cfg.midOcc) cfg.lowOcc = cfg.midOcc;
  if (cfg.midMax < cfg.midMin) cfg.midMax = cfg.midMin;
  // 係数も帯の順に単調にする (中位の上限 > 高位の下限だと、競合が埋まって高位帯に入った瞬間に推奨が下がる)
  if (cfg.highMin < cfg.midMax) cfg.highMin = cfg.midMax;
  if (cfg.highMax < cfg.highMin) cfg.highMax = cfg.highMin;
  if (cfg.lowMax < cfg.lowMin) cfg.lowMax = cfg.lowMin;
  return cfg;
}

function betaOf(v: unknown, base: BetaConfig): BetaConfig {
  const b = obj(v);
  const cfg: BetaConfig = {
    surgePt: num(b.surgePt, base.surgePt, 0, 100),
    surgeFullPt: num(b.surgeFullPt, base.surgeFullPt, 0, 100),
    surgeMin: num(b.surgeMin, base.surgeMin, 0, 200),
    surgeMax: num(b.surgeMax, base.surgeMax, 0, 200),
    stagnantPt: num(b.stagnantPt, base.stagnantPt, 0, 100),
    stagnantMaxLead: Math.round(num(b.stagnantMaxLead, base.stagnantMaxLead, 1, 120)),
    stagnantMax: num(b.stagnantMax, base.stagnantMax, 0, 90),
  };
  if (cfg.surgeMax < cfg.surgeMin) cfg.surgeMax = cfg.surgeMin;
  if (cfg.surgeFullPt < cfg.surgePt) cfg.surgeFullPt = cfg.surgePt;
  return cfg;
}

/** alpha/beta は { weekday, weekend } 形式。旧形式 (区分なしの1組) は両区分に適用する */
function byNightType<T>(v: unknown, base: Record<NightType, T>, parse: (x: unknown, b: T) => T): Record<NightType, T> {
  const o = obj(v);
  if ("weekday" in o || "weekend" in o) {
    return { weekday: parse(o.weekday, base.weekday), weekend: parse(o.weekend, base.weekend) };
  }
  if (Object.keys(o).length > 0) {
    return { weekday: parse(o, base.weekday), weekend: parse(o, base.weekend) };
  }
  return { weekday: parse({}, base.weekday), weekend: parse({}, base.weekend) };
}

/**
 * 保存値 (部分的・不正値を含みうる) を既定値とマージして、範囲内に収めた完全な設定を返す。
 * base を渡した場合はその値を土台にする (部分更新用)。
 */
export function normalizePricingConfig(raw: unknown, base: PricingConfig = DEFAULT_PRICING_CONFIG): PricingConfig {
  const r = obj(raw);
  const c = obj(r.compset);
  const g = obj(r.gamma);
  const sp = obj(r.spike);
  const al = obj(r.alerts);
  const el = obj(r.elasticity);

  const compsetRadius = num(c.radiusKm, base.compset.radiusKm, 0.5, 30);
  const guestsMin = Math.round(num(c.guestsMin, base.compset.guestsMin, 1, 50));
  const guestsMax = Math.round(num(c.guestsMax, base.compset.guestsMax, 1, 50));

  let icalUrl: string | null = base.icalUrl;
  if (r.icalUrl === null || r.icalUrl === "") icalUrl = null;
  else if (typeof r.icalUrl === "string" && isAllowedIcalUrl(r.icalUrl.trim())) icalUrl = r.icalUrl.trim().slice(0, 1000);

  const lastMinuteDays = Math.round(num(g.lastMinuteDays, base.gamma.lastMinuteDays, 0, 60));
  const earlyLead = Math.max(lastMinuteDays + 1, Math.round(num(g.earlyLead, base.gamma.earlyLead, 1, 365)));

  return {
    horizonDays: Math.round(num(r.horizonDays, base.horizonDays, 14, 120)),
    basePriceWeekday: numOrNull(r.basePriceWeekday, base.basePriceWeekday, 1000, 10_000_000),
    weekendPremiumMode: oneOf(r.weekendPremiumMode, ["auto", "fixed"] as const, base.weekendPremiumMode),
    weekendPremiumPct: num(r.weekendPremiumPct, base.weekendPremiumPct, 0, 100),
    peakPremiumPct: num(r.peakPremiumPct, base.peakPremiumPct, 0, 300),
    floorWeekday: num(r.floorWeekday, base.floorWeekday, 0, 10_000_000),
    floorWeekend: num(r.floorWeekend, base.floorWeekend, 0, 10_000_000),
    ceilingMode: oneOf(r.ceilingMode, ["auto", "fixed"] as const, base.ceilingMode),
    ceilingWeekday: numOrNull(r.ceilingWeekday, base.ceilingWeekday, 1000, 10_000_000),
    ceilingWeekend: numOrNull(r.ceilingWeekend, base.ceilingWeekend, 1000, 10_000_000),
    roundTo: Math.round(num(r.roundTo, base.roundTo, 1, 100_000)),
    ownPriceWeekday: numOrNull(r.ownPriceWeekday, base.ownPriceWeekday, 1000, 10_000_000),
    ownPriceWeekend: numOrNull(r.ownPriceWeekend, base.ownPriceWeekend, 1000, 10_000_000),
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
    alpha: byNightType(r.alpha, base.alpha, alphaOf),
    beta: byNightType(r.beta, base.beta, betaOf),
    gamma: {
      lastMinuteDays,
      weekdayMaxDiscount: num(g.weekdayMaxDiscount, base.gamma.weekdayMaxDiscount, 0, 90),
      weekendMaxDiscount: num(g.weekendMaxDiscount, base.gamma.weekendMaxDiscount, 0, 90),
      earlyLead,
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
      changePct: num(al.changePct ?? al.deviationPct, base.alerts.changePct, 0, 100),
    },
    elasticity: {
      low: num(el.low, base.elasticity.low, -10, -0.05),
      central: num(el.central, base.elasticity.central, -10, -0.05),
      high: num(el.high, base.elasticity.high, -10, -0.05),
    },
    tightnessDamping: num(r.tightnessDamping, base.tightnessDamping, 0, 1),
    compsetAutoRefresh: bool(r.compsetAutoRefresh, base.compsetAutoRefresh),
    compsetRefreshDays: Math.round(num(r.compsetRefreshDays, base.compsetRefreshDays, 1, 60)),
    compsetRefreshMax: Math.round(num(r.compsetRefreshMax, base.compsetRefreshMax, 0, 50)),
    icalUrl,
    peakPeriods: peakPeriods(r.peakPeriods, base.peakPeriods),
  };
}

/** UI に返す設定。iCal URL は秘密トークンを含むため伏せる */
export function maskPricingConfig(cfg: PricingConfig): PricingConfig {
  return { ...cfg, icalUrl: cfg.icalUrl ? "(設定済み)" : null };
}

/** UI が編集した設定を保存用に正規化する。マスク値 "(設定済み)" は既存値を保持する意味 */
export function mergeEditedPricingConfig(current: PricingConfig, edited: unknown): PricingConfig {
  const e = obj(edited);
  const icalUrl = e.icalUrl === "(設定済み)" ? current.icalUrl : e.icalUrl;
  return normalizePricingConfig({ ...e, icalUrl }, current);
}
