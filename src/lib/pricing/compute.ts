/**
 * PricingInputs → PricingDashboard (純関数のオーケストレーター)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * 手順:
 *  1. cfg = inputs.config, H = cfg.horizonDays, basePrice = cfg.basePriceWeekday ?? inputs.lumina.basePrice
 *  2. 将来日 dates = today + 0..H、nights = classifyNight(各日, cfg.peakPeriods)
 *  3. compset = selectCompSet(candidates, {lat, lng, listingId}, basePrice, cfg, today)
 *  4. market = computeMarketDays(dates, nights, compset.members, calendar, cfg, today)
 *  5. curves = buildBookingCurves(compset.members, snapshots, market, cfg, today)   ← Pace より先に作る
 *  6. pace = computePace(dates, nights, compset.members, snapshots, curves, cfg, today); applyPace(market, pace, cfg)
 *  7. premium = measurePremiums(dates の {night, market}, cfg)
 *  8. 区分ごとに marketPrices = horizon 内の market[d].listings で price != null のもの ({memberId, price})
 *     (特定連休の夜は weekend に含める)、guard = resolveGuardrails(type, basePrice, premium.weekendPct, marketPrices, cfg)
 *  9. 自社の現在価格 (各日): own 行 (無ければ status "vacant", statusSource "none", apiPrice null) について
 *       apiPrice != null → currentPrice = apiPrice, source "api"
 *       それ以外で cfg.ownPriceWeekend/Weekday (night.type に対応する方。特定連休は weekend) が非 null → source "manual"
 *       それ以外 → currentPrice = round(basePrice × (1 + δ_night)/roundTo)×roundTo, source "assumed"
 *         (δ_night = 特定連休 peakPct / 週末 weekendPct / 平日 0)
 *     days[i] = { date, lead, night, market, own: {status, statusSource, currentPrice, currentPriceSource},
 *                 pricing: priceDay({... premium, guard: 区分の guard ...}) }
 * 10. past = computePastDays(today, compset.members, calendar, snapshots, inputs.own, cfg)
 * 11. simulation = simulateRevenue(days, curves, cfg)
 * 12. kpis: weekdayOcc/weekendOcc = 区分別に market.occ != null の日の平均 (小数1桁)、*Days はその日数、
 *     *AvgRec = 区分別の推奨価格の平均 (整数)、spikeDates = market.spike の日、
 *     raiseDays/lowerDays = 自社 vacant かつ action raise/lower の日数、past14*Occ = past の区分別 occ 平均
 * 13. alerts = deriveAlerts(days, cfg)
 * 14. status:
 *     mode: dataSource "demo" → "demo"。それ以外 rules_only の日の割合 ρ で ρ == 1 → "no_market_data"、
 *           ρ > 0.5 → "partial"、それ以外 "ok"
 *     lastSnapshotDate/paceCompareDate/paceWindowDays/paceAvailableFrom = pace の値、paceAvailable = pace が1日でも非null
 *     freshMembers = compset.freshCount
 *     ownPriceSource = 将来の空室日の currentPriceSource の最頻値 (同数なら "assumed" 優先)
 *     ownStatusSource = 将来日 own.statusSource の集合が1種類ならそれ ("none" 含む)、複数なら "mixed"
 *     icalConfigured / icalLastImport / alertChannel / lastNotifiedAt = inputs から
 *     refreshPlan: ids = compset.needsRefreshIds の先頭 cfg.compsetRefreshMax 件 (dataSource "demo" なら空)、
 *       count = ids.length, costUsd = round2(count × 0.10)
 *     compsetAutoRefresh = cfg.compsetAutoRefresh
 *     autoRefreshMonthlyUsd = round2(min(members.length, cfg.compsetRefreshMax) × 0.10 × 30 / cfg.compsetRefreshDays)
 *     warnings (日本語, 該当するものだけ, この順):
 *       - demo: "デモデータを表示中です（実際の予約・競合データではありません）"
 *       - basePrice <= 0: "自社基準価格が未設定です（設定画面で入力してください）"
 *       - members < effective.minSize: "CompSetが{n}件と少なく、占有率の推定誤差が大きくなります"
 *       - relaxations が非空: "条件を緩和してCompSetを構成: {relaxations.join('、')}"
 *       - mode "no_market_data": "競合カレンダーが未取得/古いため、推奨価格は曜日・直前ルールのみで算出されています（競合連動にするには「競合カレンダーを取得」）"
 *       - 0 < freshCount < members: "{members − fresh}件のカレンダーが未取得/古い状態です"
 *       - failed の member があれば: "{k}件はカレンダーを取得できませんでした（掲載終了の可能性）"
 *       - !paceAvailable かつ paceAvailableFrom: "Pace（消化ペース）は {M/D} 以降の取得で算出されます（追加の手動取得は不要です）"
 *       - paceAvailable かつ cfg.compsetRefreshDays > 1: "差分検知は前日比ではなく約{paceWindowDays}日間隔のスナップショット比較です（費用削減のため）"
 *       - ownStatusSource "none": "自社の予約状況が未連携です（iCal連携または手動入力で反映）"
 *       - icalConfigured かつ icalLastImport が (null か !ok か 2日以上前): "iCal取り込みが{at}以降失敗/停止しています（{error}）"
 *       - ownPriceSource "assumed": "自社の現在価格が未入力のため、乖離率は表示していません（設定で「Airbnbで設定中の価格」を入力すると比較できます）"
 *       - basePriceAboveAll: "自社基準価格は品質同等の周辺物件すべての参照ADRを上回ります（最高 ¥{max}）"
 *         それ以外で basePricePercentile >= 90: "自社基準価格は品質同等の周辺物件の上位{max(0.1, 100−pct)}%に位置します"
 *       - alertChannel "none": "アラートは画面表示のみで、通知先（Slack/Discord等）は未設定です"
 * 15. basePrices = { weekday: basePrice, weekendPremiumPct: premium.weekendPct, peakPremiumPct: premium.peakPct, premiumSource }
 * 16. config = maskPricingConfig(cfg)、generatedAt = now ?? new Date().toISOString()
 * basePrice <= 0 のときも例外を投げず、価格系は floor 等で埋めて warnings で知らせる (0 除算をしない)。
 */
import type { PricingDashboard, PricingInputs } from "./types";

export function computePricingDashboard(inputs: PricingInputs, now?: string): PricingDashboard {
  void inputs;
  void now;
  throw new Error("not implemented");
}
