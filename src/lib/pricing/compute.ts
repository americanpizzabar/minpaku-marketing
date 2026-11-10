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
 *     特定連休 (peakPeriod != null) の夜は max(weekendPct, peakPct) で求めた上限を使う
 *  9. 自社の現在価格 (各日): own 行 (無ければ status "vacant", statusSource "none", apiPrice null) について
 *       apiPrice != null → currentPrice = apiPrice, source "api"
 *       それ以外で cfg.ownPriceWeekend/Weekday (night.type に対応する方。特定連休は weekend) が非 null → source "manual"
 *       それ以外 → currentPrice = round(basePrice × (1 + δ_night)/roundTo)×roundTo, source "assumed"
 *         (δ_night = 特定連休 peakPct / 週末 weekendPct / 平日 0)
 *     days[i] = { date, lead, night, market, own: {status, statusSource, currentPrice, currentPriceSource},
 *                 pricing: priceDay({... premium, guard: 区分の guard ...}) }
 * 10. past = computePastDays(today, compset.members, calendar, snapshots, inputs.own, cfg)
 * 11. simulation = simulateRevenue(days, curves, cfg)
 * 12. kpis: weekdayOcc/weekendOcc = 区分別に dataQuality "ok" かつ market.occ != null の日の平均 (小数1桁)、*Days はその日数、
 *     *AvgRec = 区分別の推奨価格の平均 (整数)、spikeDates = market.spike の日、
 *     raiseDays/lowerDays = 自社 vacant かつ action raise/lower の日数、past14*Occ = past の区分別 occ 平均 (units >= minUnitsForSignal の日のみ)
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
 *       - mode "no_market_data": 原因別に1つ。members < minUnitsForSignal → CompSet が小さい (条件を広げる。取得は勧めない)、
 *           freshCount < minUnitsForSignal → "競合カレンダーが未取得/古いため…（競合連動にするには「競合カレンダーを取得」）"、
 *           それ以外 → 取得済みカレンダーが対象期間をカバーしていない
 *       - 0 < freshCount < members: "{members − fresh}件のカレンダーが未取得/古い状態です"
 *       - failed の member があれば: "{k}件はカレンダーを取得できませんでした（掲載終了の可能性）"
 *       - !paceAvailable かつ paceAvailableFrom: 自動取得オン → "{M/D} 以降の自動取得で算出（追加の手動取得は不要）"、
 *           オフ → 2回目の取得が必要 ({M/D}以降に「競合カレンダーを取得」)。paceAvailableFrom が無く自動取得オフ → 急増は検知されない旨
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
import { deriveAlerts, formatYen } from "./alerts";
import { selectCompSet } from "./compset";
import { maskPricingConfig } from "./config";
import { measurePremiums, priceDay, resolveGuardrails } from "./engine";
import { addDaysStr, classifyNight, diffDays } from "./holidays";
import { applyPace, buildBookingCurves, computeMarketDays, computePace, computePastDays } from "./metrics";
import { simulateRevenue } from "./simulate";
import type {
  DayRecommendation,
  MarketDay,
  NightClass,
  NightType,
  OwnDay,
  OwnPriceSource,
  PricingDashboard,
  PricingInputs,
  PricingKpis,
  PricingStatus,
} from "./types";

const COST_PER_CALL_USD = 0.1;

function round(x: number, digits: number): number {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

function avg(xs: number[], digits: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  return round(v.reduce((a, b) => a + b, 0) / v.length, digits);
}

/** 市場データが無い日の空の MarketDay (computeMarketDays が日を返さなかった場合の保険) */
function emptyMarketDay(): MarketDay {
  return {
    units: 0,
    unavailable: 0,
    expectedBooked: 0,
    effectiveUnits: 0,
    occRaw: null,
    occAdj: null,
    occ: null,
    occCi: null,
    remaining: 0,
    remainingEst: null,
    compAdr: null,
    priceCount: 0,
    maxAgeDays: null,
    listings: [],
    pace: null,
    paceRaw: null,
    paceExpected: null,
    paceDays: null,
    newBookings: null,
    spike: false,
    dataQuality: "none",
  };
}

/** "YYYY-MM-DD" → "M/D" */
function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/** ISO 日時 → JST の "YYYY-MM-DD" (不正なら null) */
function jstDate(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function computePricingDashboard(inputs: PricingInputs, now?: string): PricingDashboard {
  // 1. 設定と基準価格
  const cfg = inputs.config;
  const H = cfg.horizonDays;
  const today = inputs.today;
  const rawBase = cfg.basePriceWeekday ?? inputs.lumina.basePrice;
  const basePrice = Number.isFinite(rawBase) ? rawBase : 0;
  const unit = cfg.roundTo > 0 ? cfg.roundTo : 1;

  // 2. 将来日と区分
  const dates: string[] = [];
  for (let i = 0; i <= H; i++) dates.push(addDaysStr(today, i));
  const nights = new Map<string, NightClass>();
  for (const d of dates) nights.set(d, classifyNight(d, cfg.peakPeriods));

  // 3〜6. CompSet → 市場指標 → 予約曲線 → Pace (曲線を先に作る: 超過Pace は曲線の通常積み増しを差し引く)
  const compset = selectCompSet(
    inputs.candidates,
    { lat: inputs.lumina.lat, lng: inputs.lumina.lng, listingId: inputs.lumina.listingId },
    basePrice,
    cfg,
    today,
  );
  const members = compset.members;
  const market = computeMarketDays(dates, nights, members, inputs.calendar, cfg, today);
  for (const d of dates) if (!market.has(d)) market.set(d, emptyMarketDay());
  const curves = buildBookingCurves(members, inputs.snapshots, market, cfg, today);
  const pace = computePace(dates, nights, members, inputs.snapshots, curves, cfg, today);
  applyPace(market, pace, cfg);

  const nightOf = (d: string): NightClass => nights.get(d) ?? classifyNight(d, cfg.peakPeriods);
  const marketOf = (d: string): MarketDay => market.get(d) ?? emptyMarketDay();

  // 7. 週末・特定連休プレミアム
  const premium = measurePremiums(
    dates.map((d) => ({ night: nightOf(d), market: marketOf(d) })),
    cfg,
  );
  const premiumArg = { weekendPct: premium.weekendPct, peakPct: premium.peakPct };

  // 8. ガードレール (特定連休の夜は classifyNight で weekend になっている)
  const pricesByType: Record<NightType, { memberId: string; price: number }[]> = { weekday: [], weekend: [] };
  for (const d of dates) {
    for (const l of marketOf(d).listings) {
      if (l.price != null) pricesByType[nightOf(d).type].push({ memberId: l.id, price: l.price });
    }
  }
  const guard: Record<NightType, { floor: number; ceiling: number }> = {
    weekday: resolveGuardrails("weekday", basePrice, premium.weekendPct, pricesByType.weekday, cfg),
    weekend: resolveGuardrails("weekend", basePrice, premium.weekendPct, pricesByType.weekend, cfg),
  };
  // 特定連休 (年末年始など) の夜は週末より大きいプレミアムが乗るため、上限もそのプレミアムで求める
  // (週末の上限で切ると、ピークのプレミアムが打ち消される)
  const guardPeak = resolveGuardrails(
    "weekend",
    basePrice,
    Math.max(premium.weekendPct, premium.peakPct),
    pricesByType.weekend,
    cfg,
  );

  // 9. 自社の現在価格 (api > 設定画面の入力値 > 基準価格からの仮定) と日別の推奨価格
  const ownByDate = new Map<string, OwnDay>();
  for (const o of inputs.own) ownByDate.set(o.date, o);
  const days: DayRecommendation[] = dates.map((date, lead) => {
    const night = nightOf(date);
    const m = marketOf(date);
    const own = ownByDate.get(date);
    const status = own?.status ?? "vacant";
    const statusSource = own?.statusSource ?? "none";
    const configured = night.type === "weekend" ? cfg.ownPriceWeekend : cfg.ownPriceWeekday;
    let currentPrice: number | null;
    let currentPriceSource: OwnPriceSource;
    if (own?.apiPrice != null && Number.isFinite(own.apiPrice)) {
      currentPrice = own.apiPrice;
      currentPriceSource = "api";
    } else if (configured != null) {
      currentPrice = configured;
      currentPriceSource = "manual";
    } else {
      const deltaPct = night.peakPeriod != null ? premium.peakPct : night.type === "weekend" ? premium.weekendPct : 0;
      // 基準価格が未設定なら仮定価格も出さない (0円を「現在価格」として扱わない)
      currentPrice = basePrice > 0 ? Math.round((basePrice * (1 + deltaPct / 100)) / unit) * unit : null;
      currentPriceSource = "assumed";
    }
    const pricing = priceDay({
      basePrice,
      night,
      lead,
      market: m,
      ownStatus: status,
      currentPrice,
      currentPriceSource,
      premium: premiumArg,
      guard: night.peakPeriod != null ? guardPeak : guard[night.type],
      cfg,
    });
    return { date, lead, night, market: m, own: { status, statusSource, currentPrice, currentPriceSource }, pricing };
  });

  // 10〜11. 直近実績とシミュレーション
  const past = computePastDays(today, members, inputs.calendar, inputs.snapshots, inputs.own, cfg);
  const simulation = simulateRevenue(days, curves, cfg);

  // 12. KPI
  const byType = (t: NightType) => days.filter((d) => d.night.type === t);
  // 平均占有率は有効物件数が minUnitsForSignal 以上の日 (dataQuality "ok") だけで出す
  // (1〜2物件で算出した日を混ぜると、少数の物件の状態が「市場の占有率」に見えてしまうため)
  const occsOf = (t: NightType) =>
    byType(t)
      .filter((d) => d.market.dataQuality === "ok")
      .map((d) => d.market.occ)
      .filter((x): x is number => x != null && Number.isFinite(x));
  const recAvg = (t: NightType) => {
    const a = avg(
      byType(t).map((d) => d.pricing.recommended),
      0,
    );
    return a == null ? null : Math.round(a);
  };
  const pastOcc = (t: NightType) =>
    avg(
      past
        .filter((p) => p.night.type === t && p.units >= cfg.minUnitsForSignal)
        .map((p) => p.occ)
        .filter((x): x is number => x != null),
      1,
    );
  const kpis: PricingKpis = {
    weekdayOcc: avg(occsOf("weekday"), 1),
    weekendOcc: avg(occsOf("weekend"), 1),
    weekdayDays: occsOf("weekday").length,
    weekendDays: occsOf("weekend").length,
    weekdayAvgRec: recAvg("weekday"),
    weekendAvgRec: recAvg("weekend"),
    spikeDates: days.filter((d) => d.market.spike).map((d) => d.date),
    raiseDays: days.filter((d) => d.own.status === "vacant" && d.pricing.action === "raise").length,
    lowerDays: days.filter((d) => d.own.status === "vacant" && d.pricing.action === "lower").length,
    past14WeekdayOcc: pastOcc("weekday"),
    past14WeekendOcc: pastOcc("weekend"),
  };

  // 13. アラート
  const alerts = deriveAlerts(days, cfg);

  // 14. 状態
  const isDemo = inputs.dataSource === "demo";
  const rulesOnly = days.filter((d) => d.pricing.signal === "rules_only").length;
  const rho = days.length > 0 ? rulesOnly / days.length : 1;
  const mode: PricingStatus["mode"] = isDemo ? "demo" : rho === 1 ? "no_market_data" : rho > 0.5 ? "partial" : "ok";
  const paceAvailable = [...pace.byDate.values()].some((p) => p.pace != null);

  const vacantDays = days.filter((d) => d.own.status === "vacant");
  const priceSourcePool = vacantDays.length > 0 ? vacantDays : days;
  const sourceCounts: Record<OwnPriceSource, number> = { api: 0, manual: 0, assumed: 0 };
  for (const d of priceSourcePool) sourceCounts[d.own.currentPriceSource]++;
  // 最頻値。同数なら assumed を優先 (次いで manual)
  let ownPriceSource: OwnPriceSource = "assumed";
  for (const s of ["manual", "api"] as const) {
    if (sourceCounts[s] > sourceCounts[ownPriceSource]) ownPriceSource = s;
  }

  const statusSources = new Set(days.map((d) => d.own.statusSource));
  const ownStatusSource: PricingStatus["ownStatusSource"] =
    statusSources.size === 0 ? "none" : statusSources.size === 1 ? [...statusSources][0] : "mixed";

  const refreshIds = isDemo ? [] : compset.needsRefreshIds.slice(0, Math.max(0, cfg.compsetRefreshMax));
  const refreshPlan = {
    ids: refreshIds,
    count: refreshIds.length,
    costUsd: round(refreshIds.length * COST_PER_CALL_USD, 2),
  };
  const autoRefreshMonthlyUsd = round(
    (Math.min(members.length, cfg.compsetRefreshMax) * COST_PER_CALL_USD * 30) / Math.max(1, cfg.compsetRefreshDays),
    2,
  );

  const warnings: string[] = [];
  if (isDemo) warnings.push("デモデータを表示中です（実際の予約・競合データではありません）");
  if (basePrice <= 0) warnings.push("自社基準価格が未設定です（設定画面で入力してください）");
  if (members.length < compset.effective.minSize) {
    warnings.push(`CompSetが${members.length}件と少なく、占有率の推定誤差が大きくなります`);
  }
  if (compset.relaxations.length > 0) {
    warnings.push(`条件を緩和してCompSetを構成: ${compset.relaxations.join("、")}`);
  }
  if (mode === "no_market_data") {
    const min = cfg.minUnitsForSignal;
    if (members.length < min) {
      // カレンダーを取得しても解消しない (有料の取得を勧めない)
      warnings.push(
        `CompSetが${members.length}件で、市場シグナルに必要な${min}件に足りないため、推奨価格は曜日・直前ルールのみで算出されています（設定でCompSetの条件を広げてください）`,
      );
    } else if (compset.freshCount < min) {
      warnings.push(
        "競合カレンダーが未取得/古いため、推奨価格は曜日・直前ルールのみで算出されています（競合連動にするには「競合カレンダーを取得」）",
      );
    } else {
      warnings.push(
        `取得済みの競合カレンダーが対象期間の日付を${min}件以上カバーしていないため、推奨価格は曜日・直前ルールのみで算出されています`,
      );
    }
  }
  if (compset.freshCount > 0 && compset.freshCount < members.length) {
    warnings.push(`${members.length - compset.freshCount}件のカレンダーが未取得/古い状態です`);
  }
  const failed = members.filter((m) => m.calendarStatus === "failed").length;
  if (failed > 0) warnings.push(`${failed}件はカレンダーを取得できませんでした（掲載終了の可能性）`);
  if (!paceAvailable && pace.paceAvailableFrom) {
    warnings.push(
      cfg.compsetAutoRefresh
        ? `Pace（消化ペース）は ${md(pace.paceAvailableFrom)} 以降の自動取得で算出されます（追加の手動取得は不要です）`
        : `Pace（消化ペース）の算出には2回目の取得が必要です。競合の自動取得がオフのため、${md(pace.paceAvailableFrom)}以降（初回の取得から3〜7日後）に「競合カレンダーを取得」を実行してください`,
    );
  } else if (!paceAvailable && !isDemo && !cfg.compsetAutoRefresh && compset.freshCount > 0) {
    warnings.push(
      "Pace（消化ペース）は3〜7日間隔の2回の取得から算出します。競合の自動取得がオフのため、予約の急増は検知されません",
    );
  }
  if (paceAvailable && cfg.compsetRefreshDays > 1) {
    const w = pace.paceWindowDays ?? cfg.compsetRefreshDays;
    warnings.push(`差分検知は前日比ではなく約${w}日間隔のスナップショット比較です（費用削減のため）`);
  }
  if (ownStatusSource === "none") warnings.push("自社の予約状況が未連携です（iCal連携または手動入力で反映）");
  if (inputs.icalConfigured) {
    const li = inputs.icalLastImport;
    const at = li ? jstDate(li.at) : null;
    const stale = at == null || diffDays(at, today) >= 2;
    if (!li || !li.ok || stale) {
      const atLabel = at ? md(at) : "設定";
      const error = li?.error ?? (li == null ? "未実行" : li.ok ? "2日以上取り込みがありません" : "原因不明");
      warnings.push(`iCal取り込みが${atLabel}以降失敗/停止しています（${error}）`);
    }
  }
  if (ownPriceSource === "assumed") {
    warnings.push(
      "自社の現在価格が未入力のため、乖離率は表示していません（設定で「Airbnbで設定中の価格」を入力すると比較できます）",
    );
  }
  if (compset.basePriceAboveAll) {
    warnings.push(
      `自社基準価格は品質同等の周辺物件すべての参照ADRを上回ります（最高 ${formatYen(compset.basePriceAboveAll.max)}）`,
    );
  } else if (compset.basePricePercentile != null && compset.basePricePercentile >= 90) {
    const top = round(Math.max(0.1, 100 - compset.basePricePercentile), 1);
    warnings.push(`自社基準価格は品質同等の周辺物件の上位${top}%に位置します`);
  }
  if (inputs.alertChannel === "none") warnings.push("アラートは画面表示のみで、通知先（Slack/Discord等）は未設定です");

  const status: PricingStatus = {
    mode,
    lastSnapshotDate: pace.lastSnapshotDate,
    paceCompareDate: pace.paceCompareDate,
    paceWindowDays: pace.paceWindowDays,
    paceAvailable,
    paceAvailableFrom: pace.paceAvailableFrom,
    freshMembers: compset.freshCount,
    ownPriceSource,
    ownStatusSource,
    icalConfigured: inputs.icalConfigured,
    icalLastImport: inputs.icalLastImport,
    refreshPlan,
    compsetAutoRefresh: cfg.compsetAutoRefresh,
    autoRefreshMonthlyUsd,
    alertChannel: inputs.alertChannel,
    lastNotifiedAt: inputs.lastNotifiedAt,
    warnings,
  };

  // 15〜16.
  return {
    generatedAt: now ?? new Date().toISOString(),
    today,
    horizonDays: H,
    dataSource: inputs.dataSource,
    config: maskPricingConfig(cfg),
    basePrices: {
      weekday: basePrice,
      weekendPremiumPct: premium.weekendPct,
      peakPremiumPct: premium.peakPct,
      premiumSource: premium.source,
    },
    compset,
    days,
    past,
    curves,
    kpis,
    simulation,
    alerts,
    status,
  };
}
