/**
 * 競合稼働連動型ダイナミックプライシング・モジュールの型定義 (実装の契約)。
 *
 * 単位の約束:
 * - 占有率 (occ*) は 0〜100 の % 表記 (既存アプリの稼働率表記と同じ)
 * - 係数 (CoefficientDetail.value) は小数 (0.15 = +15%, -0.10 = -10%)
 * - PricingConfig 内の係数パラメータは利用者が編集する値なので % 表記 (15 = 15%)
 * - 日付はすべて JST の "YYYY-MM-DD" 文字列。lead (t) は today からの日数 (0 = 今夜)
 * - 金額は円
 */

/* ------------------------------------------------------------------ */
/* 日別属性 (3.1)                                                      */
/* ------------------------------------------------------------------ */

/** 宿泊する夜の区分。weekday = 平日 / weekend = 週末・ハイバリュー日 */
export type NightType = "weekday" | "weekend";

/** 特定連休 (年をまたぐ指定も可。start > end のときは年末→年始とみなす) */
export interface PeakPeriod {
  name: string; // 例: "年末年始"
  start: string; // "MM-DD"
  end: string; // "MM-DD" (この日を含む)
}

export interface NightClass {
  date: string; // 宿泊日 (その夜)
  type: NightType;
  dow: number; // 0=日 … 6=土
  isHoliday: boolean; // その日自体が国民の祝日 (日曜は含まない)
  holidayName: string | null;
  isPreHoliday: boolean; // 翌日が国民の祝日 (= 祝前日)
  peakPeriod: string | null; // 特定連休に含まれる場合その名称
  reason: string; // 区分理由 (日本語。例: "土曜" / "祝前日（文化の日）" / "年末年始" / "平日")
  tag: string; // 画面のセルに出す2文字以内の短い印: "連休" / "祝前" / "金" / "土" / "祝" / "" (通常の平日)
}

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

export interface CompSetFilterConfig {
  radiusKm: number; // 自社からの半径 (仕様 5〜7km の上限 7 を既定)
  maxRadiusKm: number; // 自動緩和の最終段で広げてよい上限半径 (radiusKm と同じなら半径は緩和しない)
  entireHomeOnly: boolean; // 一棟貸しのみ
  adrBandPct: number; // 自社基準価格の ±何% を同価格帯とするか (仕様 30)
  guestsMin: number; // 最大収容人数の下限 (仕様 6)
  guestsMax: number; // 上限 (仕様 10)
  minRating: number; // 評価の下限 (仕様 4.7)
  minReviews: number; // レビュー件数の下限 (仕様 5)
  minSize: number; // この件数を下回ったら段階的に条件を緩和 (0 = 緩和しない)
}

export interface AlphaConfig {
  highOcc: number; // 80: これ以上で強気設定 (<= 99)
  highMin: number; // 15 (%): highOcc ちょうどでの補正
  highMax: number; // 25 (%): 占有率100%での補正
  midOcc: number; // 50: これ以上 highOcc 未満で中位の補正 (< highOcc)
  midMin: number; // 5
  midMax: number; // 10
  lowOcc: number; // 30: これ未満かつ lead <= lowMaxLead で値下げ (<= midOcc)
  lowMaxLead: number; // 14
  lowMin: number; // 10 (%): lowOcc ちょうど付近の値下げ幅
  lowMax: number; // 20 (%): 占有率0%での値下げ幅
}

export interface BetaConfig {
  surgePt: number; // 10: 超過Pace がこの pt/7日 以上 (かつ新規予約が spike.minNewBookings 以上) で「急増」
  surgeFullPt: number; // 30: この pt/7日 で上限の補正
  surgeMin: number; // 5 (%)
  surgeMax: number; // 15 (%)
  stagnantPt: number; // 2: 超過Pace が −stagnantPt 以下 (= 通常の積み増しより遅れている) なら「停滞」
  stagnantMaxLead: number; // 30: 停滞判定を行う最大リードタイム
  stagnantMax: number; // 5 (%): 当日に近いほど最大この幅で値下げ
}

export interface GammaConfig {
  lastMinuteDays: number; // 7: この日数以内の未稼働に直前値下げ (< earlyLead)
  weekdayMaxDiscount: number; // 25 (%)
  weekendMaxDiscount: number; // 10 (%)
  earlyLead: number; // 45: これ以上先は早期予約枠
  earlyMode: "auto" | "discount" | "premium";
  earlyDiscount: number; // 5 (%): 早期確約ディスカウント
  earlyPremium: number; // 5 (%): ハイシーズン先行高値
  earlyStrongOcc: number; // 40: auto時、早期でもこの占有率以上なら先行高値
}

export interface PricingConfig {
  horizonDays: number; // 60 (t = 0..horizonDays を対象, 最大 120)
  // 基準価格・ガードレール
  basePriceWeekday: number | null; // null = 設定画面の自物件基準価格を使う
  weekendPremiumMode: "auto" | "fixed"; // auto = CompSet の同一物件内の 週末/平日 価格比から測定
  weekendPremiumPct: number; // fixed 時の週末プレミアム δ。auto で測定不能時のフォールバック (15)
  peakPremiumPct: number; // fixed 時の特定連休プレミアム。auto で測定不能時のフォールバック (30)
  floorWeekday: number; // 60000
  floorWeekend: number; // 90000
  ceilingMode: "auto" | "fixed";
  ceilingWeekday: number | null; // fixed 時
  ceilingWeekend: number | null;
  roundTo: number; // 推奨価格の丸め単位 (1000)
  // 自社の「今 Airbnb で設定している価格」(AirROI 未収録の自社用。null = 未入力)
  ownPriceWeekday: number | null;
  ownPriceWeekend: number | null;
  // CompSet
  compset: CompSetFilterConfig;
  // 指標
  freshnessDays: number; // カレンダーがこの日数より古ければ使わない (10)
  blockAdjust: boolean; // ホストのブロック日を実績比率で除外補正する
  adrStat: "median" | "trimmed"; // 競合平均販売価格の統計量
  shrinkStrength: number; // 少数サンプル補正の強さ (疑似物件数, 2)
  minUnitsForSignal: number; // これ未満の物件数の日は需給係数を使わない (3)
  // 補正係数 (仕様6章「平日・週末別の閾値」→ 区分ごとに保持。既定値は両区分とも仕様の表の値)
  alpha: Record<NightType, AlphaConfig>;
  beta: Record<NightType, BetaConfig>;
  gamma: GammaConfig;
  // Pace・アラート
  spike: { minPt: number; minNewBookings: number }; // 要注意日 (超過Pace 20pt/7日 かつ 新規予約2件以上)
  alerts: {
    weekendRemainingMax: number; // 週末の競合残室 (推定) がこれ以下でアラート (3)
    weekdaySpikePt: number; // 平日の超過Pace がこれ以上 (かつ新規予約 minNewBookings 以上) でアラート (15)
    changePct: number; // 現在価格→推奨価格の変更率がこの % 以上で 値上げ/値下げ 判定 (10)
  };
  // 売上シミュレーション (需要の価格弾力性。負の値)
  elasticity: { low: number; central: number; high: number }; // -0.8 / -1.5 / -2.5
  tightnessDamping: number; // 競合が埋まるほど弾力性を弱める度合い (0 = 使わない。既定 0)
  // データ取得コスト管理
  compsetAutoRefresh: boolean; // 毎日の定期実行で CompSet カレンダーを自動取得する (有料。既定 false)
  compsetRefreshDays: number; // 自動取得の周期 (3)
  compsetRefreshMax: number; // 1回に取得する CompSet の上限件数 (20, 最大 50)
  // 自社カレンダー
  icalUrl: string | null; // Airbnb の iCal エクスポート URL (https://www.airbnb.*/calendar/ical/… のみ)
  peakPeriods: PeakPeriod[];
}

/* ------------------------------------------------------------------ */
/* 入力 (DB / デモから組み立てる)                                       */
/* ------------------------------------------------------------------ */

export interface CandidateProperty {
  id: string; // "airroi_<listing_id>"
  title: string;
  url: string | null;
  area: string;
  lat: number | null;
  lng: number | null;
  roomType: string | null; // AirROI listing_info.room_type ("entire_home" 等)
  listingType: string | null; // AirROI listing_info.listing_type ("Entire villa" 等)
  propertyType: string; // アプリの分類 villa/house/hotel/pension
  maxGuests: number;
  rating: number | null;
  reviews: number;
  adrRef: number | null; // 価格帯判定用の参照ADR = l90d_avg_rate ?? ttm_avg_rate
  reservedShare: number | null; // TTMの 予約日 / (予約日 + ブロック日)。不明は null
  ratesSyncedAt: string | null; // カレンダーの最終「取得成功」日 = MAX(daily_metrics.fetched_at) の JST 日付
  lastAttemptAt: string | null; // カレンダー取得の最終「試行」日 = properties.rates_synced_at の JST 日付 (失敗でも進む)
}

/** daily_metrics の行 = 各物件の「最新取得時点」のカレンダー状態 */
export interface CalendarRow {
  propertyId: string;
  date: string; // 宿泊日
  available: boolean; // false = 予約済 または ホストのブロック
  price: number; // 販売価格。0 = 価格情報なし (予約不可日は常に 0)
  fetchedAt: string; // 取得日 (JST "YYYY-MM-DD")
}

/** calendar_snapshots の行 = 取得のたびに保存する履歴 (Pace の差分検知に使う) */
export interface SnapshotRow {
  snapshotDate: string; // 取得日 (JST)
  propertyId: string;
  date: string;
  available: boolean;
  price: number;
}

export type OwnStatus = "booked" | "blocked" | "vacant";
export type OwnStatusSource = "manual" | "ical" | "api" | "none";
/** 現在価格の出所。api = AirROI の実カレンダー / manual = 利用者が設定画面で入力 / assumed = 基準価格からの仮定値 */
export type OwnPriceSource = "api" | "manual" | "assumed";

export interface OwnDay {
  date: string;
  /** AirROI の実カレンダー価格 (priceSource "api" で configured_price > 0 の日のみ)。それ以外は null */
  apiPrice: number | null;
  status: OwnStatus;
  statusSource: OwnStatusSource;
}

export interface IcalImportStatus {
  at: string; // ISO 日時
  ok: boolean;
  imported: number;
  error: string | null;
}

export interface PricingInputs {
  today: string;
  dataSource: "turso" | "demo";
  lumina: {
    lat: number | null;
    lng: number | null;
    basePrice: number; // 設定画面の基準価格 (config.basePriceWeekday が null のとき採用)。<= 0 は未設定
    listingId: string | null; // CompSet から自社を除外するのに使う
    priceSource: "api" | "manual" | "demo"; // lumina_fuji_metrics の出所 (manual = 基準価格で埋めた代替値)
    maxGuests: number;
  };
  candidates: CandidateProperty[]; // 自社から maxRadiusKm 程度の範囲の全候補 (フィルタ前, 自社は除外済み)
  calendar: CalendarRow[]; // candidates の daily_metrics (date ∈ [today-14, today+horizon+7])
  snapshots: SnapshotRow[]; // CompSet member の calendar_snapshots (snapshotDate >= today-120)
  own: OwnDay[]; // date ∈ [today-14, today+horizon]
  config: PricingConfig;
  icalConfigured: boolean;
  icalLastImport: IcalImportStatus | null;
  alertChannel: "webhook" | "none"; // 環境変数 ALERT_WEBHOOK_URL の有無 (URL 自体は渡さない)
  lastNotifiedAt: string | null; // pricing_alerts.notified_at の最大 (実送信のみ)
}

/* ------------------------------------------------------------------ */
/* 出力 DTO (UI に渡す)                                                 */
/* ------------------------------------------------------------------ */

export interface CompSetMember {
  id: string;
  title: string;
  url: string | null;
  area: string;
  distanceKm: number;
  maxGuests: number;
  rating: number | null;
  reviews: number;
  adrRef: number | null;
  roomType: string | null;
  strict: boolean; // 緩和前の厳格条件 (config.compset の値) も満たす
  entireHomeInferred: boolean; // room_type 不明のため listing_type 等から一棟貸しと推定した
  /** fresh = 最終取得成功が freshnessDays 以内 / stale = それより古い / none = 未取得 /
   *  failed = 取得を試みたが成功していない (掲載終了の可能性。再取得の対象外) */
  calendarStatus: "fresh" | "stale" | "none" | "failed";
  lastFetched: string | null; // = ratesSyncedAt
  lastAttemptAt: string | null;
  reservedShare: number | null;
}

export interface CompSetResult {
  members: CompSetMember[];
  strictCount: number;
  candidatesConsidered: number;
  relaxations: string[]; // 適用した緩和 (日本語。例: "ADR帯 ±30% → ±40%")
  effective: CompSetFilterConfig; // 実際に使った条件
  freshCount: number;
  needsRefreshIds: string[]; // calendarStatus が stale/none の member id (failed は含めない), 取得日の古い順 (未取得が先)
  basePricePercentile: number | null; // 自社の想定平均単価が「品質同等の周辺物件」の参照ADR分布の何%点か
  basePriceAboveAll: { max: number } | null; // 自社が分布の全物件を上回るとき、その最高値
}

export interface CoefficientDetail {
  value: number; // 小数 (0.15 = +15%)
  reason: string; // 日本語の根拠
}

export interface MarketListingState {
  id: string; // CompSetMember.id
  available: boolean;
  price: number | null; // available かつ price>0 のときのみ
}

export interface MarketDay {
  units: number; // その日の有効な (新鮮な) カレンダーがある CompSet 物件数
  unavailable: number; // 予約不可 (予約済 or ブロック) の物件数
  expectedBooked: number; // ブロック補正後の推定予約済室数
  effectiveUnits: number; // ブロック補正後の有効競合総室数
  occRaw: number | null; // 予約不可率 (%)
  occAdj: number | null; // ブロック補正後の占有率 (%), 縮小推定前
  occ: number | null; // 縮小推定後の占有率 (%) = α に使う Occ_t
  occCi: [number, number] | null; // 80% 信用区間 (%)
  remaining: number; // 競合残室数 (有効行で予約可能な物件数)
  remainingEst: number | null; // CompSet 全体に引き伸ばした推定残室数 = round(remaining × members/units)
  compAdr: number | null; // 競合平均販売価格 CompADR_t (予約可能物件の中央値/トリム平均)
  priceCount: number; // compAdr の算出に使った価格数
  maxAgeDays: number | null; // 使ったカレンダー行のうち最も古いものの経過日数
  listings: MarketListingState[]; // その日に有効行がある CompSet 物件の状態 (詳細パネル用)
  pace: number | null; // Pace Index PI_t = 予約曲線から期待される通常の積み増しを差し引いた「超過」ペース (pt/7日)
  paceRaw: number | null; // 差し引く前の生の占有率増加ペース (pt/7日)
  paceExpected: number | null; // 予約曲線から期待される積み増し (pt/7日)
  paceDays: number | null; // 比較したスナップショットの平均間隔 (日)
  newBookings: number | null; // 比較期間に 予約可能→予約不可 になった物件数
  spike: boolean; // 要注意日 (予約急増)
  dataQuality: "ok" | "low" | "none"; // ok: units >= minUnitsForSignal / low: 1..min-1 / none: 0
}

export type PricingAction = "raise" | "lower" | "hold" | "booked" | "blocked";

export interface DayPricing {
  basePrice: number; // P_base (平日基準)
  delta: CoefficientDetail; // 曜日属性係数 δ (週末/特定連休のプレミアム。平日は 0)
  alpha: CoefficientDetail; // 競合占有率係数
  beta: CoefficientDetail; // 消化ペース係数
  gamma: CoefficientDetail; // リードタイム係数
  rawPrice: number; // P_base × (1+δ)(1+α)(1+β)(1+γ)
  floor: number;
  ceiling: number;
  recommended: number; // ガードレール適用・丸め後
  clampedBy: "floor" | "ceiling" | null;
  /** 乖離率 = 現在価格から推奨価格への変更率 (recommended − current)/current × 100。
   *  現在価格が仮定値 (assumed) または null のときは null (比較しない) */
  changePct: number | null;
  action: PricingAction;
  /** market = 競合連動 (α と β が算出済み) / partial = α のみ (Pace 未算出) / rules_only = 競合データ不足で曜日・リードタイムのみ */
  signal: "market" | "partial" | "rules_only";
}

export interface DayRecommendation {
  date: string;
  lead: number;
  night: NightClass;
  market: MarketDay;
  own: {
    status: OwnStatus;
    statusSource: OwnStatusSource;
    currentPrice: number | null;
    currentPriceSource: OwnPriceSource;
  };
  pricing: DayPricing;
}

export interface BookingCurvePoint {
  lead: number;
  occ: number; // %
  date: string; // 宿泊日
  source: "current" | "snapshot";
}

export interface BookingCurve {
  type: NightType;
  points: BookingCurvePoint[]; // 散布図用 (最大 400 点に間引き)
  fitted: { lead: number; occ: number }[]; // 単調化した平均予約曲線 (lead 昇順)
  reach50: number | null; // 占有率50%に達する平均リードタイム (日前)
  reach80: number | null; // 同 80%
  sampleSize: number; // 点の総数 (間引き前)
}

export interface PastDay {
  date: string;
  night: NightClass;
  occ: number | null; // その夜の実績占有率 (ブロック補正後, %)
  compAdr: number | null;
  units: number;
  pickup7: number | null; // 最後の7日間に積み増した占有率 (pt)。スナップショット不足は null
  own: { status: OwnStatus; currentPrice: number | null };
}

export interface SimulationScenario {
  key: "low" | "central" | "high"; // 需要の価格感応度
  label: string; // 日本語ラベル
  elasticity: number;
  currentRevenue: number; // 現在価格 (または仮定の固定料金) に据え置いた場合の想定売上 (空室日)
  recommendedRevenue: number; // 推奨価格に追従した場合の想定売上 (空室日)
  currentNights: number; // 想定予約泊数
  recommendedNights: number;
  upliftPct: number | null;
}

export interface Simulation {
  available: boolean;
  reason: string | null; // available=false の理由
  baseline: "current" | "assumed_seasonal"; // 比較対象: 実際の現在価格 / 固定シーズン料金 (基準価格×週末係数) の仮定
  baselineLabel: string; // 例: "現在価格" / "固定シーズン料金（基準価格×週末係数・仮定）"
  vacantDays: number;
  bookedDays: number;
  lockedRevenue: number; // 予約済の日の売上 (両シナリオ共通)
  scenarios: SimulationScenario[]; // low / central / high
  central: SimulationScenario | null;
  /**
   * 損益分岐の予約数変化 (需要モデルに依存しない)。値上げ日・値下げ日を分けて、
   * 「各日が現在価格で同じ確率で予約される」とした場合に推奨追従と売上が等しくなる予約数の変化率。
   * (一定弾力性モデルの損益分岐の弾力性は価格や日によらず常に −1 になり情報が無いため、こちらを使う)
   */
  breakEven: {
    raise: BreakEvenGroup | null; // 推奨 > 据え置き の空室日
    lower: BreakEvenGroup | null; // 推奨 < 据え置き の空室日
  };
  assumptions: string[]; // 日本語の前提一覧
}

export interface BreakEvenGroup {
  days: number;
  avgChangePct: number; // 据え置き価格の合計に対する推奨価格の合計の変化率 (%, 小数1桁)
  /** 売上が据え置きと等しくなる予約数の変化率 (%, 小数1桁)。
   *  raise: 負の値 = この割合まで予約が減っても売上は維持 / lower: 正の値 = この割合以上予約が増えれば元が取れる */
  bookingChangePct: number;
}

export type AlertKind =
  | "weekend_low_inventory"
  | "weekday_spike"
  | "spike"
  | "raise_opportunity"
  | "discount_needed"
  | "own_status_unlinked";

export interface PricingAlert {
  date: string; // own_status_unlinked は today
  kind: AlertKind;
  severity: "high" | "medium" | "info";
  message: string; // 日本語
}

export interface PricingKpis {
  weekdayOcc: number | null; // 向こう horizon 日の平日 平均競合占有率 (%)
  weekendOcc: number | null;
  weekdayDays: number; // 集計対象日数
  weekendDays: number;
  weekdayAvgRec: number | null; // 平日の平均推奨価格
  weekendAvgRec: number | null;
  spikeDates: string[]; // 要注意日
  raiseDays: number; // 値上げ余地のある空室日数 (現在価格が実値の日のみ)
  lowerDays: number; // 値下げ検討の空室日数 (同上)
  past14WeekdayOcc: number | null; // 直近14日 実績
  past14WeekendOcc: number | null;
}

export interface PricingStatus {
  /** demo = デモデータ / no_market_data = 有効な競合カレンダーが無い (推奨はルールのみ) /
   *  partial = 一部の日だけ競合連動 / ok = 大半の日が競合連動 */
  mode: "demo" | "no_market_data" | "partial" | "ok";
  lastSnapshotDate: string | null; // CompSet の最新スナップショット日 (Pace の可否に関係なく)
  paceCompareDate: string | null; // Pace 比較に使った過去側スナップショット日 (最頻値)
  paceWindowDays: number | null; // Pace の比較間隔 (平均日数)
  paceAvailable: boolean;
  paceAvailableFrom: string | null; // Pace 未算出時、算出可能になる見込み日 (最新スナップショット + 3日)
  freshMembers: number;
  ownPriceSource: OwnPriceSource; // 将来日の現在価格の出所 (混在時は多い方)
  ownStatusSource: "api" | "ical" | "manual" | "none" | "mixed";
  icalConfigured: boolean;
  icalLastImport: IcalImportStatus | null;
  refreshPlan: { ids: string[]; count: number; costUsd: number }; // 「今すぐ取得」ボタンで実際に取得する対象と費用
  compsetAutoRefresh: boolean;
  autoRefreshMonthlyUsd: number; // 自動取得をオンにした場合の月額目安 = min(members, compsetRefreshMax) × 0.10 × 30 / compsetRefreshDays
  alertChannel: "webhook" | "none";
  lastNotifiedAt: string | null;
  warnings: string[]; // 日本語の注意事項
}

export interface PricingDashboard {
  generatedAt: string; // ISO
  today: string;
  horizonDays: number;
  dataSource: "turso" | "demo";
  config: PricingConfig; // icalUrl はマスク済み ("設定済み" の判定は status.icalConfigured)
  basePrices: {
    weekday: number;
    weekendPremiumPct: number; // δ 週末 (%)
    peakPremiumPct: number; // δ 特定連休 (%)
    premiumSource: "auto" | "fixed" | "fallback";
  };
  compset: CompSetResult;
  days: DayRecommendation[]; // lead 0..horizonDays
  past: PastDay[]; // 直近14日 (古い順)
  curves: { weekday: BookingCurve; weekend: BookingCurve };
  kpis: PricingKpis;
  simulation: Simulation;
  alerts: PricingAlert[];
  status: PricingStatus;
}

/* ------------------------------------------------------------------ */
/* API 契約: /api/pricing                                              */
/*   GET  → PricingDashboard (JSON)                                    */
/*   POST → body = PricingApiRequest, 応答 = PricingApiResponse        */
/*   POST は同一オリジン (Sec-Fetch-Site: same-origin または Origin のホスト = Host) か                */
/*   Authorization: Bearer CRON_SECRET のときのみ受け付ける。デモモードでは 400                       */
/* ------------------------------------------------------------------ */

export type PricingApiRequest =
  /** 設定を保存 (部分更新可。icalUrl に "(設定済み)" を渡すと既存値を保持、"" で削除) */
  | { action: "saveConfig"; config: Partial<PricingConfig> }
  /** status.refreshPlan.ids を渡す。サーバーは「現在の CompSet member かつ今日未取得」の id だけを
   *  上限 min(compsetRefreshMax, 設定画面の dailyRatesCalls) まで取得する (有料: $0.10/件) */
  | { action: "refreshCompset"; ids: string[] }
  /** 自社の予約状況を手動で指定 (iCal/AirROI より優先)。"vacant" も手動の「空室」指定として保存する */
  | { action: "setOwnStatus"; date: string; status: OwnStatus }
  /** その日の手動指定を解除 (iCal/AirROI の状態に戻る) */
  | { action: "clearOwnStatus"; date: string }
  /** 設定済み iCal URL から自社の予約・ブロックを取り込む */
  | { action: "importIcal" }
  /** 今日の推奨価格とアラートを保存 (通知はしない。定期実行でも毎日行われる) */
  | { action: "persist" };

export interface PricingApiResponse {
  ok: boolean;
  message: string; // 日本語 (成功・失敗とも UI にそのまま表示できる文。setOwnStatus/clearOwnStatus は結果の状態を明記)
  config?: PricingConfig; // saveConfig 時 (マスク済み)
  refreshed?: number; // refreshCompset 時の実取得件数
  costUsd?: number; // refreshCompset 時の実コスト
  saved?: number; // persist 時の保存行数
  alerts?: number; // persist 時のアラート件数
  imported?: number; // importIcal 時の取り込み日数
}
