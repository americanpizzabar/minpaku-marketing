/**
 * PricingInputs → PricingDashboard (純関数のオーケストレーター)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 手順:
 *  1. cfg = inputs.config, H = cfg.horizonDays, basePrice = cfg.basePriceWeekday ?? inputs.lumina.basePrice
 *  2. 将来日 dates = today + 0..H、nights = classifyNight(各日, cfg.peakPeriods)
 *  3. compset = selectCompSet(candidates, lumina, basePrice, cfg, today)
 *  4. market = computeMarketDays(dates, nights, compset.members, calendar, cfg, today)
 *     pace = computePace(...); applyPace(market, pace, cfg)
 *  5. premium = measureWeekendPremium(...)
 *  6. 区分ごとに marketPrices = horizon 内の CompSet 有効行 (fresh) で available かつ price>0 の価格
 *     guard = resolveGuardrails(type, basePrice, premium.pct, marketPrices, cfg)
 *  7. own = inputs.own の該当日 (無ければ status "vacant", statusSource "none", currentPrice = basePrice)
 *     days[i] = { date, lead, night, market, own, pricing: priceDay(...) }
 *  8. curves = buildBookingCurves(compset.members, snapshots, market, cfg, today)
 *  9. past = computePastDays(today, compset.members, calendar, snapshots, inputs.own, cfg)
 * 10. simulation = simulateRevenue(days, curves, cfg, inputs.lumina.priceSource === "manual")
 * 11. kpis: weekdayOcc/weekendOcc = 区分別に market.occ != null の日の平均 (小数1桁)、*Days はその日数、
 *     *AvgRec = 区分別の推奨価格の平均 (整数)、spikeDates = market.spike の日、
 *     raiseDays/lowerDays = 自社 vacant かつ action raise/lower の日数、
 *     past14*Occ = past の区分別 occ 平均
 * 12. alerts = deriveAlerts(days, cfg)
 * 13. status: lastSnapshotDate/prevSnapshotDate = pace の値、paceAvailable = pace が1日でも非null、
 *     freshMembers = compset.freshCount、ownPriceSource = inputs.lumina.priceSource、
 *     ownStatusSource = 将来日 own の statusSource の集合が1種類ならそれ ("none" 含む)、複数なら "mixed"、
 *     icalConfigured = inputs.icalConfigured、refreshCostUsd = needsRefreshIds.length × 0.1 (小数2桁)、
 *     warnings (日本語, 該当するものだけ):
 *       - CompSet が minSize 未満のまま: "CompSetが{n}件と少なく、占有率の推定誤差が大きくなります"
 *       - freshCount == 0: "CompSetのカレンダーが未取得/古いため、需給係数(α・β)は計算されていません。…"
 *       - 0 < freshCount < members: "{k}件のカレンダーが未取得/古い状態です（更新費用 約${cost}）"
 *       - !paceAvailable: "Pace（消化ペース）は2回目以降のスナップショット取得（3日以上間隔）で算出されます"
 *       - ownStatusSource が "none": "自社の予約状況が未連携です（iCal連携または手動入力で反映）"
 *       - ownPriceSource "manual": "自社の現在価格はAirROI未収録のため基準価格で代替しています"
 *       - basePricePercentile != null かつ >= 90: "自社基準価格は品質同等の周辺物件の上位{100−pct}%に位置します"
 *       - relaxations が非空: "条件を緩和してCompSetを構成: {relaxations.join('、')}"
 * 14. config = maskPricingConfig(cfg)
 * generatedAt = now ?? new Date().toISOString()
 */
import type { PricingDashboard, PricingInputs } from "./types";

export function computePricingDashboard(inputs: PricingInputs, now?: string): PricingDashboard {
  void inputs;
  void now;
  throw new Error("not implemented");
}
