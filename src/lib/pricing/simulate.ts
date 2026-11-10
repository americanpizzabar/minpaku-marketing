/**
 * 推奨価格追従時の想定売上シミュレーション (仕様 4.1 サマリーKPI)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 目的: 推奨に従った場合と、従わずに据え置いた場合の空室日の想定売上を、需要の価格感応度 (弾力性 ε)
 * の仮定ごとに比較する。結果の符号は ε の仮定に強く依存するため、損益分岐の ε (breakEvenElasticity) も必ず出す。
 *
 * モデル (自社が vacant の将来日 d, リードタイム L ごと):
 *   F = curves[night.type].fitted を lead → occ/100 の関数に (無ければもう一方の区分の曲線。両方空なら available=false)
 *     F(L) = lead が L に最も近い点の値、F0 = 最小 lead の点の値
 *   残り在庫の成約確率 (条件付きピックアップ): q = F(L) < 1 ? clamp((F0 − F(L)) / (1 − F(L)), 0, 0.95) : 0
 *   品質調整した参照価格: typeBase = basePrice × (1 + δ) (pricing.delta.value)
 *     ref = market.compAdr != null かつ 区分の compAdr 中央値 M_type が非 null
 *           ? typeBase × market.compAdr / M_type   (市場の日別の高低だけを反映し、自社の品質プレミアムは割高とみなさない)
 *           : typeBase
 *     M_type = horizon 内の同区分の日の compAdr の中央値
 *   弾力性 ε_d = ε × (1 − tightnessDamping × occNow)  (occNow = (market.occ ?? 0)/100。既定 tightnessDamping=0 = 一定)
 *   成約確率 p(P) = clamp(q × (P / ref)^ε_d, 0, 0.95)
 *   売上 = Σ P × p(P)、泊数 = Σ p(P)   (据え置き価格 と 推奨価格 でそれぞれ計算)
 * 据え置き価格 (baseline):
 *   - 将来の空室日の半数以上で own.currentPriceSource が "assumed" でないなら baseline "current":
 *     各日の currentPrice (assumed の日は除外して計算) / baselineLabel "現在価格"
 *   - それ以外 baseline "assumed_seasonal": 各日 typeBase を roundTo で丸めた固定シーズン料金 /
 *     baselineLabel "固定シーズン料金（基準価格×週末係数・仮定）" (仕様1章「固定シーズン料金に依存せず」の比較対象)
 * - own.status "booked" の日: lockedRevenue += currentPrice ?? typeBase (丸め)、bookedDays++ (比較対象外)
 * - "blocked" の日はスキップ
 * - 3シナリオ ε = cfg.elasticity.low/central/high。label: "価格感応度: 低" / "価格感応度: 中（標準）" / "価格感応度: 高"
 * - upliftPct = currentRevenue > 0 ? (recommendedRevenue − currentRevenue)/currentRevenue × 100 (小数1桁) : null
 * - breakEvenElasticity: tightnessDamping=0 として recommendedRevenue(ε) − currentRevenue(ε) の符号が
 *   ε ∈ [−5, −0.1] の両端で異なれば二分探索 (40回) で求めた ε (小数2桁)、異ならなければ null
 * - 金額は整数円、泊数は小数1桁に丸める
 * - assumptions (日本語, 必ず含める): 予約曲線による残り在庫の成約確率、参照価格は自社の品質プレミアムを保った市場連動価格、
 *   弾力性は実測ではなく仮定 (3シナリオの値)、損益分岐の弾力性の意味、予約済日は比較対象外、
 *   baseline が assumed_seasonal ならその旨と「設定で現在価格を入力すると実価格で比較」
 * - 計算可能な空室日が 0 日なら available=false, reason に理由 (例: "予約曲線が未算出（競合カレンダー取得後に表示）")
 */
import type {
  BookingCurve,
  DayRecommendation,
  NightType,
  PricingConfig,
  Simulation,
  SimulationScenario,
} from "./types";

const P_MAX = 0.95;
const BREAK_EVEN_LO = -5;
const BREAK_EVEN_HI = -0.1;

const SEASONAL_LABEL = "固定シーズン料金（基準価格×週末係数・仮定）";

function round(x: number, digits: number): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** fitted (lead 昇順) → lead から占有率 (0..1) を引く関数。空なら null */
function curveFn(fitted: { lead: number; occ: number }[]): { at: (lead: number) => number; f0: number } | null {
  const pts = fitted.filter((p) => Number.isFinite(p.lead) && Number.isFinite(p.occ));
  if (pts.length === 0) return null;
  const sorted = [...pts].sort((a, b) => a.lead - b.lead);
  const at = (lead: number): number => {
    let best = sorted[0];
    for (const p of sorted) {
      if (Math.abs(p.lead - lead) < Math.abs(best.lead - lead)) best = p;
    }
    return clamp(best.occ / 100, 0, 1);
  };
  return { at, f0: clamp(sorted[0].occ / 100, 0, 1) };
}

/** 比較対象の1日 (計算に必要な値だけ) */
interface SimDay {
  q: number; // 残り在庫の成約確率 (条件付きピックアップ)
  ref: number; // 品質調整した参照価格
  occNow: number; // 0..1
  baseline: number; // 据え置き価格
  recommended: number;
}

function bookProb(d: SimDay, price: number, eps: number): number {
  if (!(price > 0) || !(d.ref > 0) || d.q <= 0) return 0;
  const p = d.q * Math.pow(price / d.ref, eps);
  return Number.isFinite(p) ? clamp(p, 0, P_MAX) : P_MAX;
}

function evaluate(
  simDays: SimDay[],
  eps: number,
  damping: number,
): { cur: number; rec: number; curN: number; recN: number } {
  let cur = 0;
  let rec = 0;
  let curN = 0;
  let recN = 0;
  for (const d of simDays) {
    const e = eps * (1 - damping * d.occNow);
    const pc = bookProb(d, d.baseline, e);
    const pr = bookProb(d, d.recommended, e);
    cur += d.baseline * pc;
    rec += d.recommended * pr;
    curN += pc;
    recN += pr;
  }
  return { cur, rec, curN, recN };
}

export function simulateRevenue(
  days: DayRecommendation[],
  curves: { weekday: BookingCurve; weekend: BookingCurve },
  cfg: PricingConfig,
): Simulation {
  const unit = cfg.roundTo > 0 ? cfg.roundTo : 1;
  const damping = Number.isFinite(cfg.tightnessDamping) ? clamp(cfg.tightnessDamping, 0, 1) : 0;
  const fn: Record<NightType, ReturnType<typeof curveFn>> = {
    weekday: curveFn(curves.weekday?.fitted ?? []),
    weekend: curveFn(curves.weekend?.fitted ?? []),
  };
  const curveFor = (t: NightType) => fn[t] ?? fn[t === "weekday" ? "weekend" : "weekday"];
  const hasCurve = fn.weekday != null || fn.weekend != null;

  const typeBaseOf = (d: DayRecommendation): number => {
    const bp = Number.isFinite(d.pricing.basePrice) && d.pricing.basePrice > 0 ? d.pricing.basePrice : 0;
    const delta = Number.isFinite(d.pricing.delta.value) ? d.pricing.delta.value : 0;
    return bp * (1 + delta);
  };

  // 区分別の compAdr 中央値 M_type (horizon 内の全日)
  const adrs: Record<NightType, number[]> = { weekday: [], weekend: [] };
  for (const d of days) {
    const a = d.market.compAdr;
    if (a != null && Number.isFinite(a) && a > 0) adrs[d.night.type].push(a);
  }
  const mType: Record<NightType, number | null> = { weekday: median(adrs.weekday), weekend: median(adrs.weekend) };

  const vacant = days.filter((d) => d.own.status === "vacant");
  const nonAssumed = vacant.filter((d) => d.own.currentPriceSource !== "assumed").length;
  const baseline: Simulation["baseline"] =
    vacant.length > 0 && nonAssumed * 2 >= vacant.length ? "current" : "assumed_seasonal";

  let bookedDays = 0;
  let lockedRevenue = 0;
  const simDays: SimDay[] = [];
  for (const d of days) {
    const typeBase = typeBaseOf(d);
    const seasonal = Math.round(typeBase / unit) * unit;
    if (d.own.status === "booked") {
      bookedDays++;
      const p = d.own.currentPrice;
      lockedRevenue += p != null && Number.isFinite(p) && p > 0 ? p : seasonal;
      continue;
    }
    if (d.own.status !== "vacant") continue; // blocked
    const curve = curveFor(d.night.type);
    if (!curve) continue;
    let basePriceForDay: number;
    if (baseline === "current") {
      // 仮定価格の日は「現在価格」と比較できないため除外
      const p = d.own.currentPrice;
      if (d.own.currentPriceSource === "assumed" || p == null || !Number.isFinite(p) || p <= 0) continue;
      basePriceForDay = p;
    } else {
      basePriceForDay = seasonal;
    }
    const m = mType[d.night.type];
    const adr = d.market.compAdr;
    const ref = adr != null && Number.isFinite(adr) && adr > 0 && m != null && m > 0 ? (typeBase * adr) / m : typeBase;
    if (!(ref > 0) || !(basePriceForDay > 0)) continue;
    const fL = curve.at(d.lead);
    const q = fL < 1 ? clamp((curve.f0 - fL) / (1 - fL), 0, P_MAX) : 0;
    const occNow = d.market.occ != null && Number.isFinite(d.market.occ) ? clamp(d.market.occ / 100, 0, 1) : 0;
    simDays.push({
      q: Number.isFinite(q) ? q : 0,
      ref,
      occNow,
      baseline: basePriceForDay,
      recommended: d.pricing.recommended,
    });
  }

  const baselineLabel = baseline === "current" ? "現在価格" : SEASONAL_LABEL;
  const e = cfg.elasticity;
  const assumptions: string[] = [
    "空室日の成約確率は、競合の予約曲線から求めた「残り在庫がこれから埋まる確率」（条件付きピックアップ）を基準にしています",
    "参照価格は自社の品質プレミアムを保った市場連動価格（基準価格×曜日係数×その日の競合中央価格/区分の中央値）で、自社の価格水準そのものは割高とみなしていません",
    `需要の価格弾力性は実測ではなく仮定です（低 ${e.low} / 中 ${e.central} / 高 ${e.high} の3シナリオ）`,
    "損益分岐の弾力性: 需要の弾力性がこの値より非弾力的（0に近い）なら推奨価格への追従が有利、より弾力的なら据え置きが有利です",
    "予約済の日の売上は両シナリオ共通（比較対象外）、ブロック日は除外しています",
  ];
  if (damping > 0) {
    assumptions.push(`競合が埋まっている日ほど弾力性を弱めています（逼迫補正 ${damping}）`);
  }
  if (baseline === "assumed_seasonal") {
    assumptions.push(
      "据え置き側は実際の現在価格ではなく、固定シーズン料金（基準価格×週末係数）を仮定しています。設定で現在価格を入力すると実価格で比較します",
    );
  } else if (nonAssumed < vacant.length) {
    assumptions.push("現在価格が仮定値の空室日は比較から除外しています");
  }

  const base = {
    baseline,
    baselineLabel,
    vacantDays: simDays.length,
    bookedDays,
    lockedRevenue: Math.round(lockedRevenue),
    assumptions,
  };

  if (simDays.length === 0) {
    let reason = "比較できる空室日がありません";
    if (!hasCurve) reason = "予約曲線が未算出（競合カレンダー取得後に表示）";
    else if (vacant.length > 0 && !days.some((d) => typeBaseOf(d) > 0)) reason = "自社基準価格が未設定のため算出できません";
    return { available: false, reason, ...base, scenarios: [], central: null, breakEvenElasticity: null };
  }

  const defs: { key: SimulationScenario["key"]; label: string; elasticity: number }[] = [
    { key: "low", label: "価格感応度: 低", elasticity: e.low },
    { key: "central", label: "価格感応度: 中（標準）", elasticity: e.central },
    { key: "high", label: "価格感応度: 高", elasticity: e.high },
  ];
  const scenarios: SimulationScenario[] = defs.map((s) => {
    const r = evaluate(simDays, s.elasticity, damping);
    const currentRevenue = Math.round(r.cur);
    const recommendedRevenue = Math.round(r.rec);
    return {
      key: s.key,
      label: s.label,
      elasticity: s.elasticity,
      currentRevenue,
      recommendedRevenue,
      currentNights: round(r.curN, 1),
      recommendedNights: round(r.recN, 1),
      upliftPct:
        currentRevenue > 0 ? round(((recommendedRevenue - currentRevenue) / currentRevenue) * 100, 1) : null,
    };
  });

  // 損益分岐の弾力性 (逼迫補正なし)
  const diff = (eps: number): number => {
    const r = evaluate(simDays, eps, 0);
    return r.rec - r.cur;
  };
  let breakEvenElasticity: number | null = null;
  let lo = BREAK_EVEN_LO;
  let hi = BREAK_EVEN_HI;
  let dLo = diff(lo);
  const dHi = diff(hi);
  if (Number.isFinite(dLo) && Number.isFinite(dHi) && dLo * dHi < 0) {
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const dMid = diff(mid);
      if (dMid === 0) {
        lo = hi = mid;
        break;
      }
      if (dLo * dMid < 0) {
        hi = mid;
      } else {
        lo = mid;
        dLo = dMid;
      }
    }
    breakEvenElasticity = round((lo + hi) / 2, 2);
  }

  return {
    available: true,
    reason: null,
    ...base,
    scenarios,
    central: scenarios.find((s) => s.key === "central") ?? null,
    breakEvenElasticity,
  };
}
