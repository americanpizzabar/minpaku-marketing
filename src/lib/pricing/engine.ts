/**
 * 最適推奨価格の算出エンジン (仕様 3.3)。
 *   P_raw = P_base × (1 + δ) × (1 + α) × (1 + β) × (1 + γ)
 *   P = clamp(round(P_raw), Floor, Ceiling)
 * δ = 曜日属性係数 (週末・ハイバリュー日のプレミアム。平日 0)、α = 競合占有率係数、
 * β = 消化ペース係数、γ = リードタイム係数。各係数は根拠文 (reason) 付きで返し、UIで内訳を説明する。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 * reason の書式例 (日本語・数値入り):
 *   α: "競合占有率 86%（80%以上）: 市場在庫の払底 → +17%"
 *   β: "直近の予約急増 +24pt/7日 → +12%" / "Pace未算出（比較スナップショット不足）"
 *   γ: "直前3日・未稼働（平日）: 段階的ディスカウント → −16%"
 *   δ: "週末・ハイバリュー日（祝前日（文化の日））: 週末プレミアム +18%"
 * 係数値は小数第3位 (0.001) で丸める。
 */
import type {
  CoefficientDetail,
  DayPricing,
  MarketDay,
  NightClass,
  NightType,
  OwnStatus,
  PricingConfig,
} from "./types";

/** a + (b − a)·t。t は 0..1 にクランプ */
export function lerp(a: number, b: number, t: number): number {
  void a;
  void b;
  void t;
  throw new Error("not implemented");
}

/**
 * α (競合占有率係数)。occ は縮小推定後の Occ_t (%)。
 * - dataQuality != "ok" または occ == null → 0 (reason: "競合データ不足のため補正なし（有効N件）")
 * - occ >= highOcc: +lerp(highMin, highMax, (occ − highOcc)/(100 − highOcc)) %
 * - midOcc <= occ < highOcc: +lerp(midMin, midMax, (occ − midOcc)/(highOcc − midOcc)) %
 * - occ < lowOcc かつ lead <= lowMaxLead: −lerp(lowMin, lowMax, (lowOcc − occ)/lowOcc) %
 * - それ以外: 0 (reason に「中立帯」である旨)
 */
export function alphaCoef(market: MarketDay, lead: number, cfg: PricingConfig): CoefficientDetail {
  void market;
  void lead;
  void cfg;
  throw new Error("not implemented");
}

/**
 * β (消化ペース係数)。pace は PI_t (pt/7日)。
 * - pace == null → 0 (reason: Pace未算出)
 * - pace >= surgePt: +lerp(surgeMin, surgeMax, (pace − surgePt)/(surgeFullPt − surgePt)) %
 *   (surgeFullPt == surgePt のときは surgeMax)
 * - pace <= stagnantPt かつ lead <= stagnantMaxLead かつ (occ == null || occ < alpha.midOcc):
 *   −stagnantMax × (1 − lead/stagnantMaxLead) %   (当日に近いほど大きい。lead=stagnantMaxLead で 0)
 * - それ以外: 0
 */
export function betaCoef(market: MarketDay, lead: number, cfg: PricingConfig): CoefficientDetail {
  void market;
  void lead;
  void cfg;
  throw new Error("not implemented");
}

/**
 * γ (リードタイム係数)。
 * - lead <= lastMinuteDays:
 *     自社が vacant のとき: −maxDisc × (lastMinuteDays + 1 − lead)/(lastMinuteDays + 1) %
 *       (maxDisc は weekday → weekdayMaxDiscount, weekend → weekendMaxDiscount。lead=0 で最大)
 *     vacant 以外: 0 (reason: 予約済/ブロックのため直前値下げなし)
 * - lead >= earlyLead:
 *     earlyMode "discount" → −earlyDiscount %、"premium" → +earlyPremium %
 *     "auto" → night.peakPeriod != null または (occ != null かつ occ >= earlyStrongOcc) なら +earlyPremium %
 *              (ハイシーズン先行高値)、それ以外 −earlyDiscount % (早期確約ディスカウント)
 * - それ以外: 0
 */
export function gammaCoef(
  lead: number,
  night: NightClass,
  ownStatus: OwnStatus,
  occ: number | null,
  cfg: PricingConfig,
): CoefficientDetail {
  void lead;
  void night;
  void ownStatus;
  void occ;
  void cfg;
  throw new Error("not implemented");
}

/** δ (曜日属性係数)。weekend → +weekendPremiumPct/100、weekday → 0 */
export function deltaCoef(night: NightClass, weekendPremiumPct: number): CoefficientDetail {
  void night;
  void weekendPremiumPct;
  throw new Error("not implemented");
}

/**
 * 週末プレミアム δ(%) を決める。
 * - cfg.weekendPremiumMode == "fixed" → { pct: cfg.weekendPremiumPct, source: "fixed" }
 * - "auto": dataQuality != "none" かつ compAdr != null の日を区分別に集め、各 3日以上あれば
 *     pct = clamp((median(週末compAdr) / median(平日compAdr) − 1)×100, 0, 50) (小数1桁), source "auto"
 *   不足なら { pct: cfg.weekendPremiumPct, source: "fallback" }
 */
export function measureWeekendPremium(
  days: { night: NightClass; market: MarketDay }[],
  cfg: PricingConfig,
): { pct: number; source: "auto" | "fixed" | "fallback" } {
  void days;
  void cfg;
  throw new Error("not implemented");
}

/**
 * ガードレール (Floor & Ceiling)。
 * - floor = type が weekday なら floorWeekday、weekend なら floorWeekend
 * - ceilingMode "fixed" かつ該当値が非 null → その値
 * - それ以外 (auto): typeBase = basePrice × (1 + (weekend ? weekendPremiumPct/100 : 0))
 *     marketPrices (その区分の horizon 内で観測された CompSet の販売価格, >0) が 10 件以上なら
 *       ceiling = max(P95(marketPrices) × 1.25, typeBase × 1.4)   ※ P95 は線形補間の 95 パーセンタイル
 *     10 件未満なら ceiling = typeBase × 1.6
 * - ceiling = max(ceiling, floor)。floor/ceiling とも roundTo 単位に丸める (floor は切り上げ, ceiling は切り捨て)
 */
export function resolveGuardrails(
  type: NightType,
  basePrice: number,
  weekendPremiumPct: number,
  marketPrices: number[],
  cfg: PricingConfig,
): { floor: number; ceiling: number } {
  void type;
  void basePrice;
  void weekendPremiumPct;
  void marketPrices;
  void cfg;
  throw new Error("not implemented");
}

/**
 * 1日分の推奨価格。
 * rawPrice = basePrice × (1+δ)(1+α)(1+β)(1+γ) (整数円に四捨五入)
 * recommended = clamp(round(rawPrice / roundTo) × roundTo, floor, ceiling)
 * clampedBy = rawPrice を丸めた値が floor 未満なら "floor"、ceiling 超なら "ceiling"、それ以外 null
 * deviationPct = currentPrice != null ? (currentPrice − recommended)/recommended × 100 (小数1桁) : null
 * action: ownStatus booked → "booked", blocked → "blocked", deviationPct == null → "hold",
 *   deviationPct <= −alerts.deviationPct → "raise" (現在価格が推奨より安い = 値上げ余地),
 *   deviationPct >= +alerts.deviationPct → "lower", それ以外 "hold"
 */
export function priceDay(args: {
  basePrice: number;
  night: NightClass;
  lead: number;
  market: MarketDay;
  ownStatus: OwnStatus;
  currentPrice: number | null;
  weekendPremiumPct: number;
  guard: { floor: number; ceiling: number };
  cfg: PricingConfig;
}): DayPricing {
  void args;
  throw new Error("not implemented");
}
