/**
 * 最適推奨価格の算出エンジン (仕様 3.3)。
 *   P_raw = P_base × (1 + δ) × (1 + α) × (1 + β) × (1 + γ)
 *   P = clamp(round(P_raw), Floor, Ceiling)
 * δ = 曜日属性係数 (週末/特定連休のプレミアム。平日 0)、α = 競合占有率係数、
 * β = 消化ペース係数、γ = リードタイム係数。各係数は根拠文 (reason) 付きで返し、UIで内訳を説明する。
 * α・β のパラメータは区分別: cfg.alpha[night.type], cfg.beta[night.type] (仕様6章「平日・週末別の閾値」)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 * reason の書式例 (日本語・数値入り):
 *   α: "競合占有率 86%（80%以上）: 市場在庫の払底 → +17%"
 *   β: "通常ペースを上回る予約 +24pt/7日（新規3件）→ +12%" / "Pace未算出（比較スナップショット不足）"
 *   γ: "直前3日・未稼働（平日）: 段階的ディスカウント → −16%" / "直前2日・未稼働だが競合逼迫（占有率74%）のため割引を40%に縮小 → −9%"
 *   δ: "週末・ハイバリュー日（祝前日（文化の日））: 週末プレミアム +18%" / "特定連休（年末年始）: 連休プレミアム +45%"
 * 係数値は小数第3位 (0.001) で丸める。非有限値 (NaN/Infinity) を絶対に返さない。
 */
import type {
  CoefficientDetail,
  DayPricing,
  MarketDay,
  NightClass,
  NightType,
  OwnPriceSource,
  OwnStatus,
  PricingConfig,
} from "./types";

/** a + (b − a)·t。t は 0..1 にクランプ。t が非有限 (0/0 等) なら t = 1 とみなす */
export function lerp(a: number, b: number, t: number): number {
  void a;
  void b;
  void t;
  throw new Error("not implemented");
}

/**
 * α (競合占有率係数)。occ は縮小推定後の Occ_t (%)。A = cfg.alpha[night.type]。
 * - dataQuality != "ok" または occ == null → 0 (reason: "競合データ不足のため補正なし（有効N件）")
 * - occ >= A.highOcc: +lerp(highMin, highMax, (occ − highOcc)/(100 − highOcc)) %
 * - A.midOcc <= occ < A.highOcc: +lerp(midMin, midMax, (occ − midOcc)/(highOcc − midOcc)) %
 * - occ < A.lowOcc かつ lead <= A.lowMaxLead: −lerp(lowMin, lowMax, (lowOcc − occ)/lowOcc) %  (lowOcc=0 なら該当なし)
 * - それ以外: 0 (reason に「中立帯」である旨)
 * 例 (既定値): occ 80→+15%, 90→+20%, 100→+25%, 50→+5%, 65→+7.5%, 49.9→0, 30(lead10)→0,
 *   29(lead14)→−10.333%, 0(lead0)→−20%, 10(lead15)→0
 */
export function alphaCoef(market: MarketDay, lead: number, night: NightClass, cfg: PricingConfig): CoefficientDetail {
  void market;
  void lead;
  void night;
  void cfg;
  throw new Error("not implemented");
}

/**
 * β (消化ペース係数)。pace は超過 Pace (pt/7日, 予約曲線の通常積み増しを差し引いたもの)。B = cfg.beta[night.type]。
 * - pace == null → 0 (reason: Pace未算出、理由も)
 * - 急増: pace >= B.surgePt かつ (newBookings ?? 0) >= cfg.spike.minNewBookings:
 *     +lerp(surgeMin, surgeMax, (pace − surgePt)/(surgeFullPt − surgePt)) % (surgeFullPt == surgePt なら surgeMax)
 * - 停滞: pace <= −B.stagnantPt かつ lead <= B.stagnantMaxLead かつ 期待積み増し室数 >= 1
 *     (期待積み増し室数 = (paceExpected ?? 0)/100 × units × (paceDays ?? 7)/7) :
 *     −B.stagnantMax × (1 − lead/B.stagnantMaxLead) %  (当日に近いほど大きい。lead=stagnantMaxLead で 0)
 * - それ以外: 0 (pace が surgePt 以上でも新規予約が足りない場合は reason にその旨)
 * 例 (既定値, newBookings=2): pace 10→+5%, 20→+10%, 30→+15%, 50→+15%; newBookings=1 で pace 30→0;
 *   pace −2, lead 0, 期待1室以上→−5%; lead 15→−2.5%; lead 30→0; 期待0.5室→0
 */
export function betaCoef(market: MarketDay, lead: number, night: NightClass, cfg: PricingConfig): CoefficientDetail {
  void market;
  void lead;
  void night;
  void cfg;
  throw new Error("not implemented");
}

/**
 * γ (リードタイム係数)。G = cfg.gamma。
 * - lead <= G.lastMinuteDays:
 *     ownStatus が vacant のとき:
 *       base = −maxDisc × (lastMinuteDays + 1 − lead)/(lastMinuteDays + 1) %
 *         (maxDisc は weekday → weekdayMaxDiscount, weekend → weekendMaxDiscount。lead=0 で最大)
 *       逼迫による縮小: A = cfg.alpha[night.type]、s = occ == null ? 0 : clamp((occ − A.midOcc)/(A.highOcc − A.midOcc), 0, 1)
 *       γ = base × (1 − s)   (競合が埋まっている夜に投げ売りしない。occ < midOcc なら仕様どおり満額)
 *     vacant 以外: 0 (reason: 予約済/ブロックのため直前値下げなし)
 * - lead >= G.earlyLead:
 *     earlyMode "discount" → −earlyDiscount %、"premium" → +earlyPremium %
 *     "auto" → night.peakPeriod != null または (occ != null かつ occ >= earlyStrongOcc) なら +earlyPremium %
 *              (ハイシーズン先行高値)、それ以外 −earlyDiscount % (早期確約ディスカウント)
 * - それ以外: 0
 * 例 (既定値, vacant, occ 20): 平日 lead0→−25%, lead3→−15.625%, lead7→−3.125%; 週末 lead0→−10%;
 *   平日 lead0 occ65→−12.5% (s=0.5), occ80→0; lead8→0; lead45 平常 occ10→−5%; lead50 年末年始→+5%
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

/** δ (曜日属性係数)。night.peakPeriod != null → +peakPct/100、weekend → +weekendPct/100、weekday → 0 */
export function deltaCoef(night: NightClass, premium: { weekendPct: number; peakPct: number }): CoefficientDetail {
  void night;
  void premium;
  throw new Error("not implemented");
}

/**
 * 週末・特定連休プレミアム δ(%) を決める (同一物件内の価格比 = 物件の顔ぶれの違いに左右されない)。
 * - cfg.weekendPremiumMode == "fixed" → { weekendPct: cfg.weekendPremiumPct, peakPct: cfg.peakPremiumPct, source: "fixed" }
 * - "auto": days の market.listings から物件ごとに 予約可能かつ価格>0 の価格を 平日 / 週末(特定連休を除く) / 特定連休 に分け、
 *     週末: 平日3件以上かつ週末3件以上の物件 m で r_m = median(週末_m)/median(平日_m)。そのような物件が 3件以上なら
 *       weekendPct = clamp((median_m r_m − 1)×100, 0, 50) (小数1桁)
 *     特定連休: 同様に 平日3件以上かつ連休2件以上の物件で、3件以上なら peakPct = clamp((median r − 1)×100, 0, 150)
 *     どちらも測定できたら source "auto"。測定できない方は cfg の値 (fallback) を使い、
 *     週末が測定できなければ source "fallback"。
 */
export function measurePremiums(
  days: { night: NightClass; market: MarketDay }[],
  cfg: PricingConfig,
): { weekendPct: number; peakPct: number; source: "auto" | "fixed" | "fallback" } {
  void days;
  void cfg;
  throw new Error("not implemented");
}

/**
 * ガードレール (Floor & Ceiling)。
 * - floor = type が weekday なら floorWeekday、weekend なら floorWeekend
 * - ceilingMode "fixed" かつ該当値が非 null → その値
 * - それ以外 (auto): typeBase = basePrice × (1 + (weekend ? premiumPct/100 : 0))
 *     marketPrices (その区分の horizon 内で観測された CompSet の販売価格) のうち price>0 が 10 件以上 かつ
 *     異なる memberId が 3 件以上なら ceiling = max(P95(価格) × 1.25, typeBase × 1.4)
 *       ※ P95 は線形補間の 95 パーセンタイル
 *     それ以外 ceiling = typeBase × 1.6
 * - まず floor を roundTo 単位に切り上げ、ceiling を切り捨て、その後 ceiling = max(ceiling, floor)
 */
export function resolveGuardrails(
  type: NightType,
  basePrice: number,
  premiumPct: number,
  marketPrices: { memberId: string; price: number }[],
  cfg: PricingConfig,
): { floor: number; ceiling: number } {
  void type;
  void basePrice;
  void premiumPct;
  void marketPrices;
  void cfg;
  throw new Error("not implemented");
}

/**
 * 1日分の推奨価格。
 * δ = deltaCoef(night, premium), α = alphaCoef, β = betaCoef, γ = gammaCoef(lead, night, ownStatus, market.occ, cfg)
 * rawPrice = round(basePrice × (1+δ)(1+α)(1+β)(1+γ))
 * recommended = clamp(round(rawPrice / roundTo) × roundTo, floor, ceiling)
 * clampedBy = round(rawPrice/roundTo)×roundTo が floor 未満なら "floor"、ceiling 超なら "ceiling"、それ以外 null
 * changePct = currentPrice != null かつ currentPriceSource != "assumed" かつ currentPrice > 0
 *   ? (recommended − currentPrice)/currentPrice × 100 (小数1桁) : null
 * action: ownStatus booked → "booked", blocked → "blocked", changePct == null → "hold",
 *   changePct >= +alerts.changePct → "raise" (値上げ余地), changePct <= −alerts.changePct → "lower", それ以外 "hold"
 * signal: market.dataQuality != "ok" → "rules_only"、market.pace == null → "partial"、それ以外 "market"
 */
export function priceDay(args: {
  basePrice: number;
  night: NightClass;
  lead: number;
  market: MarketDay;
  ownStatus: OwnStatus;
  currentPrice: number | null;
  currentPriceSource: OwnPriceSource;
  premium: { weekendPct: number; peakPct: number };
  guard: { floor: number; ceiling: number };
  cfg: PricingConfig;
}): DayPricing {
  void args;
  throw new Error("not implemented");
}
