/**
 * 推奨価格追従時の想定売上シミュレーション (仕様 4.1 サマリーKPI)。
 *
 * 目的: 推奨に従った場合と、従わずに据え置いた場合の空室日の想定売上を比較する。
 * 結果は需要の価格感応度 (弾力性 ε) の仮定に強く依存するため、2段構えで示す:
 *   1. 損益分岐の予約数変化 (breakEven, 需要モデルに依存しない): 値上げ日・値下げ日を分けて、
 *      「予約が何%減っても (増えれば) 推奨追従の売上が据え置き以上か」= Σ据え置き価格 / Σ推奨価格 − 1。
 *      各日が現在価格で同じ確率で予約されると仮定した、価格だけで決まる値。
 *      (一定弾力性モデルの「損益分岐の弾力性」は売上 ∝ P^(1+ε) のため価格や日によらず常に −1 になり、
 *       値上げ日と値下げ日で有利な向きも逆になるため使わない)
 *   2. 弾力性3シナリオの試算 (scenarios): 下記モデルによる売上の差。仮定の幅として示す。
 *
 * モデル (自社が vacant の将来日 d, リードタイム L ごと):
 *   F = curves[night.type].fitted を lead → occ/100 の関数に (無ければもう一方の区分の曲線。両方空なら available=false)
 *     F(L) = lead が L に最も近い点の値、F0 = 最小 lead の点の値
 *   残り在庫の成約確率 (条件付きピックアップ):
 *     市場がこれから埋める量 Δ = F0 − F(L) を、その日の競合の残り在庫 (1 − 現在の占有率) で割る。
 *     q = clamp(Δ / (1 − occNow), 0, 0.95)   occNow = その日の競合占有率 (dataQuality "ok" の日のみ。無ければ F(L))
 *     → 競合が埋まっている日ほど残りの部屋が予約されやすい (逼迫を反映)。曲線が平坦 (Δ=0) なら q=0
 *   品質調整した参照価格: typeBase = basePrice × (1 + δ) (pricing.delta.value)
 *     ref = market.compAdr != null かつ 区分の compAdr 中央値 M_type が非 null
 *           ? typeBase × market.compAdr / M_type   (市場の日別の高低だけを反映し、自社の品質プレミアムは割高とみなさない)
 *           : typeBase
 *     M_type = horizon 内の同区分の日の compAdr の中央値
 *   弾力性 ε_d = ε × (1 − tightnessDamping × occNow)  (既定 tightnessDamping=0 = 一定)
 *   成約確率 p(P) = clamp(q × (P / ref)^ε_d, 0, 0.95)
 *   売上 = Σ P × p(P)、泊数 = Σ p(P)   (据え置き価格 と 推奨価格 でそれぞれ計算)
 * 据え置き価格 (baseline):
 *   - 将来の空室日の半数以上で own.currentPriceSource が "assumed" でないなら baseline "current":
 *     各日の currentPrice (assumed の日は除外して計算) / baselineLabel "現在価格"
 *   - それ以外 baseline "assumed_seasonal": 各日 typeBase を roundTo で丸めた固定シーズン料金 /
 *     baselineLabel "固定シーズン料金（基準価格×週末係数・仮定）" (仕様1章「固定シーズン料金に依存せず」の比較対象)
 * - own.status "booked" の日: lockedRevenue += currentPrice ?? typeBase (丸め)、bookedDays++ (比較対象外)
 * - "blocked" の日はスキップ
 * - 推奨が曜日・直前ルールのみ (pricing.signal "rules_only" = 競合データ不足) の空室日は比較しない
 *   (市場の根拠が無い推奨を「従うと得」と示さない。engine で値上げ/値下げ判定をしないのと同じ方針)
 * - 3シナリオ ε = cfg.elasticity.low/central/high。label: "価格感応度: 低" / "価格感応度: 中（標準）" / "価格感応度: 高"
 * - upliftPct = currentRevenue > 0 ? (recommendedRevenue − currentRevenue)/currentRevenue × 100 (小数1桁) : null
 * - 金額は整数円、泊数・%は小数1桁に丸める
 * - 計算可能な空室日が 0 日なら available=false, reason に理由 (例: "予約曲線が未算出（競合カレンダー取得後に表示）")
 */
import type {
  BookingCurve,
  BreakEvenGroup,
  DayRecommendation,
  NightType,
  PricingConfig,
  Simulation,
  SimulationScenario,
} from "./types";

const P_MAX = 0.95;

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
  let zeroPickupDays = 0;
  let rulesOnlyDays = 0;
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
    if (d.pricing.signal === "rules_only") {
      rulesOnlyDays++;
      continue;
    }
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
    const mOcc =
      d.market.dataQuality === "ok" && d.market.occ != null && Number.isFinite(d.market.occ)
        ? clamp(d.market.occ / 100, 0, 1)
        : null;
    // 市場がこれから埋める量を、その日の競合の残り在庫で割る (埋まっている日ほど残りの部屋が予約されやすい)
    const remainingShare = 1 - (mOcc ?? fL);
    const q = remainingShare > 0 ? clamp((curve.f0 - fL) / remainingShare, 0, P_MAX) : 0;
    if (!(q > 0)) zeroPickupDays++;
    simDays.push({
      q: Number.isFinite(q) ? q : 0,
      ref,
      occNow: mOcc ?? 0,
      baseline: basePriceForDay,
      recommended: d.pricing.recommended,
    });
  }

  const baselineLabel = baseline === "current" ? "現在価格" : SEASONAL_LABEL;
  const e = cfg.elasticity;
  const assumptions: string[] = [
    "損益分岐の予約数変化は価格だけから求めた値で、需要の仮定に依存しません（各日が現在価格で同じ確率で予約されるとした場合）",
    "試算の成約確率は、競合の予約曲線で市場がこれから埋める量を、その日の競合の残り在庫で割った値です（競合が埋まっている日ほど高い）",
    "参照価格は自社の品質プレミアムを保った市場連動価格（基準価格×曜日係数×その日の競合中央価格/区分の中央値）で、自社の価格水準そのものは割高とみなしていません",
    `試算の需要の価格弾力性は実測ではなく仮定です（低 ${e.low} / 中 ${e.central} / 高 ${e.high} の3シナリオ）。売上の差の符号はこの仮定に強く依存します`,
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

  if (rulesOnlyDays > 0) {
    assumptions.push(`競合データ不足で推奨が曜日・直前ルールのみの空室 ${rulesOnlyDays}日は比較から除外しています`);
  }
  if (zeroPickupDays > 0) {
    assumptions.push(
      `${zeroPickupDays}日は予約曲線上これ以上の予約が見込めない（曲線が平坦な）リードタイムのため、試算では売上0としています`,
    );
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
    if (rulesOnlyDays > 0 && rulesOnlyDays === vacant.length)
      reason = "競合データが不足しているため算出していません（推奨が曜日・直前ルールのみの日は比較しません）";
    else if (!hasCurve) reason = "予約曲線が未算出（競合カレンダー取得後に表示）";
    else if (vacant.length > 0 && !days.some((d) => typeBaseOf(d) > 0)) reason = "自社基準価格が未設定のため算出できません";
    return { available: false, reason, ...base, scenarios: [], central: null, breakEven: { raise: null, lower: null } };
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

  // 損益分岐の予約数変化 (価格だけで決まる。値上げ日・値下げ日を分ける)
  const group = (pick: (d: SimDay) => boolean): BreakEvenGroup | null => {
    const g = simDays.filter(pick);
    if (g.length === 0) return null;
    const sumBase = g.reduce((s, d) => s + d.baseline, 0);
    const sumRec = g.reduce((s, d) => s + d.recommended, 0);
    if (!(sumBase > 0) || !(sumRec > 0)) return null;
    return {
      days: g.length,
      avgChangePct: round((sumRec / sumBase - 1) * 100, 1),
      bookingChangePct: round((sumBase / sumRec - 1) * 100, 1),
    };
  };
  const breakEven = {
    raise: group((d) => d.recommended > d.baseline),
    lower: group((d) => d.recommended > 0 && d.recommended < d.baseline),
  };

  return {
    available: true,
    reason: null,
    ...base,
    scenarios,
    central: scenarios.find((s) => s.key === "central") ?? null,
    breakEven,
  };
}
