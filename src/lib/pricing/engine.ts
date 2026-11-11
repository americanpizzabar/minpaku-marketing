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

function roundTo(x: number, digits: number): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r; // -0 を 0 にそろえる
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 表示用の数値 (小数1桁まで、末尾の .0 は省く) */
function fmtNum(x: number): string {
  return String(roundTo(x, 1));
}

/** 表示用の符号付き % ("+17%" / "−9%" / "±0%") */
function fmtSignedPct(pct: number): string {
  const r = roundTo(pct, 1);
  if (r === 0) return "±0%";
  return `${r > 0 ? "+" : "−"}${fmtNum(Math.abs(r))}%`;
}

/** 符号付きの pt 表記 ("+24" / "−3") */
function fmtSignedPt(pt: number): string {
  const r = roundTo(pt, 1);
  if (r === 0) return "±0";
  return `${r > 0 ? "+" : "−"}${fmtNum(Math.abs(r))}`;
}

/** 係数 (% 指定) を小数第3位で丸めた CoefficientDetail にする。reason の末尾に「→ ±X%」を付ける */
function coef(pct: number, prefix: string): CoefficientDetail {
  const value = roundTo(pct / 100, 3);
  return { value, reason: `${prefix} → ${fmtSignedPct(value * 100)}` };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 線形補間のパーセンタイル (p は 0..1) */
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(p, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** a + (b − a)·t。t は 0..1 にクランプ。t が非有限 (0/0 等) なら t = 1 とみなす */
export function lerp(a: number, b: number, t: number): number {
  const tt = Number.isFinite(t) ? clamp(t, 0, 1) : 1;
  return a + (b - a) * tt;
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
  const A = cfg.alpha[night.type];
  const occ = market.occ;
  if (market.dataQuality !== "ok" || occ == null || !Number.isFinite(occ)) {
    return { value: 0, reason: `競合データ不足のため補正なし（有効${market.units}件）` };
  }
  const o = fmtNum(occ);
  if (occ >= A.highOcc) {
    const pct = lerp(A.highMin, A.highMax, (occ - A.highOcc) / (100 - A.highOcc));
    return coef(pct, `競合占有率 ${o}%（${fmtNum(A.highOcc)}%以上）: 市場在庫の払底`);
  }
  if (occ >= A.midOcc) {
    const pct = lerp(A.midMin, A.midMax, (occ - A.midOcc) / (A.highOcc - A.midOcc));
    return coef(pct, `競合占有率 ${o}%（${fmtNum(A.midOcc)}〜${fmtNum(A.highOcc)}%）: 需要が堅調`);
  }
  if (A.lowOcc > 0 && occ < A.lowOcc) {
    if (lead <= A.lowMaxLead) {
      const pct = -lerp(A.lowMin, A.lowMax, (A.lowOcc - occ) / A.lowOcc);
      return coef(pct, `競合占有率 ${o}%（${fmtNum(A.lowOcc)}%未満・${lead}日前）: 直前需給低迷のため集客優先`);
    }
    return {
      value: 0,
      reason: `競合占有率 ${o}%（${fmtNum(A.lowOcc)}%未満だが${A.lowMaxLead}日より先）: 中立帯のため補正なし`,
    };
  }
  return { value: 0, reason: `競合占有率 ${o}%: 中立帯（${fmtNum(A.midOcc)}%未満）のため補正なし` };
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
 * - market.dataQuality != "ok" の日は pace があっても 0 (α と同じく、データ不足の日に補正しない)
 * 例 (既定値, newBookings=2): pace 10→+5%, 20→+10%, 30→+15%, 50→+15%; newBookings=1 で pace 30→0;
 *   pace −2, lead 0, 期待1室以上→−5%; lead 15→−2.5%; lead 30→0; 期待0.5室→0
 */
export function betaCoef(market: MarketDay, lead: number, night: NightClass, cfg: PricingConfig): CoefficientDetail {
  const B = cfg.beta[night.type];
  const pace = market.pace;
  // 占有率が使えない日 (有効物件数不足・カレンダーが古い) は Pace も信頼できない (α と同じ基準)
  if (market.dataQuality !== "ok" && pace != null) {
    return { value: 0, reason: `競合データ不足のためPace補正なし（有効${market.units}件）` };
  }
  if (pace == null || !Number.isFinite(pace)) {
    let why = "比較スナップショット不足";
    if (market.units === 0) why = "競合カレンダーなし";
    else if (market.paceRaw != null) why = "予約曲線が未算出のため通常ペースを差し引けない";
    return { value: 0, reason: `Pace未算出（${why}）` };
  }
  const nb = market.newBookings ?? 0;
  const minNb = cfg.spike.minNewBookings;
  if (pace >= B.surgePt) {
    if (nb >= minNb) {
      const t = B.surgeFullPt === B.surgePt ? 1 : (pace - B.surgePt) / (B.surgeFullPt - B.surgePt);
      return coef(lerp(B.surgeMin, B.surgeMax, t), `通常ペースを上回る予約 ${fmtSignedPt(pace)}pt/7日（新規${nb}件）`);
    }
    return {
      value: 0,
      reason: `通常ペースを上回る予約 ${fmtSignedPt(pace)}pt/7日だが新規予約${nb}件（${minNb}件未満）のため補正なし`,
    };
  }
  if (pace <= -B.stagnantPt && lead <= B.stagnantMaxLead) {
    // 期待積み増し室数: 通常ならこの期間に何室埋まるはずだったか (1室未満なら「停滞」と言えない)
    const expectedRooms = ((market.paceExpected ?? 0) / 100) * market.units * ((market.paceDays ?? 7) / 7);
    if (expectedRooms >= 1) {
      const pct = -B.stagnantMax * (1 - lead / Math.max(1, B.stagnantMaxLead));
      return coef(pct, `予約進捗が通常ペースより停滞 ${fmtSignedPt(pace)}pt/7日（${lead}日前）`);
    }
    return {
      value: 0,
      reason: `予約進捗が通常ペースより遅れ ${fmtSignedPt(pace)}pt/7日だが、期待される積み増しが1室未満のため補正なし`,
    };
  }
  return { value: 0, reason: `消化ペースは通常範囲（超過 ${fmtSignedPt(pace)}pt/7日）: 補正なし` };
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
  const G = cfg.gamma;
  const occOk = occ != null && Number.isFinite(occ);
  if (lead <= G.lastMinuteDays) {
    const leadLabel = lead <= 0 ? "当日" : `直前${lead}日`;
    if (ownStatus !== "vacant") {
      return { value: 0, reason: `${ownStatus === "booked" ? "予約済" : "ブロック中"}のため直前値下げなし` };
    }
    const isWeekday = night.type === "weekday";
    const maxDisc = isWeekday ? G.weekdayMaxDiscount : G.weekendMaxDiscount;
    const n = G.lastMinuteDays + 1;
    const base = (-maxDisc * (n - Math.max(0, lead))) / n;
    const A = cfg.alpha[night.type];
    let s = 0;
    if (occOk) {
      const span = A.highOcc - A.midOcc;
      s = span > 0 ? clamp((occ - A.midOcc) / span, 0, 1) : occ >= A.highOcc ? 1 : 0;
    }
    const typeLabel = isWeekday ? "平日" : "週末";
    if (s <= 0) return coef(base, `${leadLabel}・未稼働（${typeLabel}）: 段階的ディスカウント`);
    const o = occOk ? fmtNum(occ) : "—";
    if (s >= 1) return { value: 0, reason: `${leadLabel}・未稼働だが競合逼迫（占有率${o}%）のため直前値下げなし` };
    return coef(
      base * (1 - s),
      `${leadLabel}・未稼働だが競合逼迫（占有率${o}%）のため割引を${fmtNum((1 - s) * 100)}%に縮小`,
    );
  }
  if (lead >= G.earlyLead) {
    const head = `早期予約枠（${lead}日前）`;
    if (G.earlyMode === "discount") return coef(-G.earlyDiscount, `${head}: 早期確約ディスカウント`);
    if (G.earlyMode === "premium") return coef(G.earlyPremium, `${head}: ハイシーズン先行高値`);
    if (night.peakPeriod != null) {
      return coef(G.earlyPremium, `${head}・${night.peakPeriod}: ハイシーズン先行高値`);
    }
    if (occOk && occ >= G.earlyStrongOcc) {
      return coef(
        G.earlyPremium,
        `${head}・競合占有率${fmtNum(occ)}%（${fmtNum(G.earlyStrongOcc)}%以上）: ハイシーズン先行高値`,
      );
    }
    return coef(-G.earlyDiscount, `${head}: 早期確約ディスカウント`);
  }
  return { value: 0, reason: `リードタイム${lead}日: 補正なし` };
}

/** δ (曜日属性係数)。night.peakPeriod != null → +peakPct/100、weekend → +weekendPct/100、weekday → 0 */
export function deltaCoef(night: NightClass, premium: { weekendPct: number; peakPct: number }): CoefficientDetail {
  if (night.peakPeriod != null) {
    const value = roundTo(premium.peakPct / 100, 3);
    return { value, reason: `特定連休（${night.peakPeriod}）: 連休プレミアム ${fmtSignedPct(value * 100)}` };
  }
  if (night.type === "weekend") {
    const value = roundTo(premium.weekendPct / 100, 3);
    return {
      value,
      reason: `週末・ハイバリュー日（${night.reason}）: 週末プレミアム ${fmtSignedPct(value * 100)}`,
    };
  }
  return { value: 0, reason: "平日: 曜日プレミアムなし" };
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
  if (cfg.weekendPremiumMode === "fixed") {
    return { weekendPct: cfg.weekendPremiumPct, peakPct: cfg.peakPremiumPct, source: "fixed" };
  }
  // 物件ごとに 平日 / 週末(特定連休を除く) / 特定連休 の販売価格を集める
  const byMember = new Map<string, { weekday: number[]; weekend: number[]; peak: number[] }>();
  for (const { night, market } of days) {
    if (!market) continue;
    const bucket: "weekday" | "weekend" | "peak" =
      night.peakPeriod != null ? "peak" : night.type === "weekend" ? "weekend" : "weekday";
    for (const l of market.listings) {
      if (!l.available || l.price == null || !Number.isFinite(l.price) || l.price <= 0) continue;
      let m = byMember.get(l.id);
      if (!m) {
        m = { weekday: [], weekend: [], peak: [] };
        byMember.set(l.id, m);
      }
      m[bucket].push(l.price);
    }
  }
  // 同一物件内の価格比 (物件の顔ぶれの違いに左右されない)
  const ratios = (key: "weekend" | "peak", minCount: number): number[] => {
    const out: number[] = [];
    for (const m of byMember.values()) {
      if (m.weekday.length < 3 || m[key].length < minCount) continue;
      const wd = median(m.weekday);
      const other = median(m[key]);
      if (wd != null && other != null && wd > 0) out.push(other / wd);
    }
    return out;
  };
  const weekendRatios = ratios("weekend", 3);
  const peakRatios = ratios("peak", 2);
  const weekendMeasured = weekendRatios.length >= 3;
  const peakMeasured = peakRatios.length >= 3;
  const weekendPct = weekendMeasured
    ? roundTo(clamp(((median(weekendRatios) ?? 1) - 1) * 100, 0, 50), 1)
    : cfg.weekendPremiumPct;
  const peakPct = peakMeasured ? roundTo(clamp(((median(peakRatios) ?? 1) - 1) * 100, 0, 150), 1) : cfg.peakPremiumPct;
  return { weekendPct, peakPct, source: weekendMeasured ? "auto" : "fallback" };
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
  const isWeekend = type === "weekend";
  const unit = cfg.roundTo > 0 ? cfg.roundTo : 1;
  const floorRaw = isWeekend ? cfg.floorWeekend : cfg.floorWeekday;
  const fixedCeiling = isWeekend ? cfg.ceilingWeekend : cfg.ceilingWeekday;
  let ceilingRaw: number;
  if (cfg.ceilingMode === "fixed" && fixedCeiling != null) {
    ceilingRaw = fixedCeiling;
  } else {
    const bp = Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0;
    const prem = Number.isFinite(premiumPct) ? premiumPct : 0;
    const typeBase = bp * (1 + (isWeekend ? prem / 100 : 0));
    const valid = marketPrices.filter((m) => Number.isFinite(m.price) && m.price > 0);
    const distinct = new Set(valid.map((m) => m.memberId)).size;
    const p95 = valid.length >= 10 && distinct >= 3 ? percentile(valid.map((m) => m.price), 0.95) : null;
    ceilingRaw = p95 != null ? Math.max(p95 * 1.25, typeBase * 1.4) : typeBase * 1.6;
  }
  const floor = Math.ceil((Number.isFinite(floorRaw) ? floorRaw : 0) / unit) * unit;
  const ceilingRounded = Math.floor((Number.isFinite(ceilingRaw) ? ceilingRaw : 0) / unit) * unit;
  return { floor, ceiling: Math.max(ceilingRounded, floor) };
}

/**
 * 1日分の推奨価格。
 * δ = deltaCoef(night, premium), α = alphaCoef, β = betaCoef,
 * γ = gammaCoef(lead, night, ownStatus, dataQuality == "ok" ? market.occ : null, cfg)
 * rawPrice = round(basePrice × (1+δ)(1+α)(1+β)(1+γ))
 * recommended = clamp(round(rawPrice / roundTo) × roundTo, floor, ceiling)
 * clampedBy = round(rawPrice/roundTo)×roundTo が floor 未満なら "floor"、ceiling 超なら "ceiling"、それ以外 null
 * changePct = basePrice > 0 かつ currentPrice != null かつ currentPriceSource != "assumed" かつ currentPrice > 0
 *   ? (recommended − currentPrice)/currentPrice × 100 (小数1桁) : null
 *   (基準価格が未設定の推奨は下限値などの仮の値なので、実価格と比較しない)
 * action: ownStatus booked → "booked", blocked → "blocked", changePct == null → "hold", signal "rules_only" → "hold" (競合データ無しで実価格を動かす根拠にしない),
 *   changePct > 0 かつ >= +alerts.changePct → "raise" (値上げ余地), changePct < 0 かつ <= −alerts.changePct → "lower",
 *   それ以外 "hold" (閾値 0 でも乖離 0 は hold)
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
  const { night, lead, market, ownStatus, currentPrice, currentPriceSource, premium, guard, cfg } = args;
  const basePrice = Number.isFinite(args.basePrice) && args.basePrice > 0 ? args.basePrice : 0;
  const delta = deltaCoef(night, premium);
  const alpha = alphaCoef(market, lead, night, cfg);
  const beta = betaCoef(market, lead, night, cfg);
  // 占有率が使えない日 (データ不足) は γ の逼迫補正・先行高値にも使わない (α・β と同じ基準。ルールのみの推奨を1物件の状態で動かさない)
  const gamma = gammaCoef(lead, night, ownStatus, market.dataQuality === "ok" ? market.occ : null, cfg);
  const product = basePrice * (1 + delta.value) * (1 + alpha.value) * (1 + beta.value) * (1 + gamma.value);
  const rawPrice = Number.isFinite(product) ? Math.max(0, Math.round(product)) : 0;
  const unit = cfg.roundTo > 0 ? cfg.roundTo : 1;
  const rounded = Math.round(rawPrice / unit) * unit;
  let clampedBy: DayPricing["clampedBy"] = null;
  let recommended = rounded;
  if (rounded < guard.floor) {
    recommended = guard.floor;
    clampedBy = "floor";
  } else if (rounded > guard.ceiling) {
    recommended = guard.ceiling;
    clampedBy = "ceiling";
  }
  const changePct =
    basePrice > 0 &&
    currentPrice != null &&
    currentPriceSource !== "assumed" &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0
      ? roundTo(((recommended - currentPrice) / currentPrice) * 100, 1)
      : null;
  const signal: DayPricing["signal"] =
    market.dataQuality !== "ok" ? "rules_only" : market.pace == null ? "partial" : "market";
  let action: DayPricing["action"];
  if (ownStatus === "booked") action = "booked";
  else if (ownStatus === "blocked") action = "blocked";
  else if (changePct == null) action = "hold";
  // 競合データの無い日 (曜日・直前ルールのみの推奨) は、実際の販売価格を上げ下げする根拠にしない。
  // 推奨価格と乖離率は参考として表示するが、値上げ/値下げの判定・アラートは出さない
  else if (signal === "rules_only") action = "hold";
  else if (changePct > 0 && changePct >= cfg.alerts.changePct) action = "raise";
  else if (changePct < 0 && changePct <= -cfg.alerts.changePct) action = "lower";
  else action = "hold";
  return {
    basePrice,
    delta,
    alpha,
    beta,
    gamma,
    rawPrice,
    floor: guard.floor,
    ceiling: guard.ceiling,
    recommended,
    clampedBy,
    changePct,
    action,
    signal,
  };
}
