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
}

/* ------------------------------------------------------------------ */
/* 設定                                                                 */
/* ------------------------------------------------------------------ */

export interface CompSetFilterConfig {
  radiusKm: number; // 自社からの半径 (仕様 5〜7km)
  maxRadiusKm: number; // 自動緩和で広げてよい上限半径
  entireHomeOnly: boolean; // 一棟貸しのみ
  adrBandPct: number; // 自社基準価格の ±何% を同価格帯とするか (仕様 30)
  guestsMin: number; // 最大収容人数の下限 (仕様 6)
  guestsMax: number; // 上限 (仕様 10)
  minRating: number; // 評価の下限 (仕様 4.7)
  minReviews: number; // レビュー件数の下限 (仕様 5)
  minSize: number; // この件数を下回ったら段階的に条件を緩和 (0 = 緩和しない)
}

export interface AlphaConfig {
  highOcc: number; // 80: これ以上で強気設定
  highMin: number; // 15 (%): highOcc ちょうどでの補正
  highMax: number; // 25 (%): 占有率100%での補正
  midOcc: number; // 50: これ以上 highOcc 未満で中位の補正
  midMin: number; // 5
  midMax: number; // 10
  lowOcc: number; // 30: これ未満かつ lead <= lowMaxLead で値下げ
  lowMaxLead: number; // 14
  lowMin: number; // 10 (%): lowOcc ちょうど付近の値下げ幅
  lowMax: number; // 20 (%): 占有率0%での値下げ幅
}

export interface BetaConfig {
  surgePt: number; // 10: Pace がこの pt/7日 以上で「急増」
  surgeFullPt: number; // 30: この pt/7日 で上限の補正
  surgeMin: number; // 5 (%)
  surgeMax: number; // 15 (%)
  stagnantPt: number; // 2: Pace がこの pt/7日 以下なら「停滞」
  stagnantMaxLead: number; // 30: 停滞判定を行う最大リードタイム
  stagnantMax: number; // 5 (%): 当日に近いほど最大この幅で値下げ
}

export interface GammaConfig {
  lastMinuteDays: number; // 7: この日数以内の未稼働に直前値下げ
  weekdayMaxDiscount: number; // 25 (%)
  weekendMaxDiscount: number; // 10 (%)
  earlyLead: number; // 45: これ以上先は早期予約枠
  earlyMode: "auto" | "discount" | "premium";
  earlyDiscount: number; // 5 (%): 早期確約ディスカウント
  earlyPremium: number; // 5 (%): ハイシーズン先行高値
  earlyStrongOcc: number; // 40: auto時、早期でもこの占有率以上なら先行高値
}

export interface PricingConfig {
  horizonDays: number; // 60 (t = 0..horizonDays を対象)
  // 基準価格・ガードレール
  basePriceWeekday: number | null; // null = 設定画面の自物件基準価格を使う
  weekendPremiumMode: "auto" | "fixed"; // auto = 競合の週末/平日 中央価格比から測定
  weekendPremiumPct: number; // fixed 時の値。auto で測定不能時のフォールバックにも使う
  floorWeekday: number; // 60000
  floorWeekend: number; // 90000
  ceilingMode: "auto" | "fixed";
  ceilingWeekday: number | null; // fixed 時
  ceilingWeekend: number | null;
  roundTo: number; // 推奨価格の丸め単位 (1000)
  // CompSet
  compset: CompSetFilterConfig;
  // 指標
  freshnessDays: number; // カレンダーがこの日数より古ければ使わない (10)
  blockAdjust: boolean; // ホストのブロック日を実績比率で除外補正する
  adrStat: "median" | "trimmed"; // 競合平均販売価格の統計量
  shrinkStrength: number; // 少数サンプル補正の強さ (疑似物件数, 2)
  minUnitsForSignal: number; // これ未満の物件数の日は需給係数を使わない (3)
  // 補正係数
  alpha: AlphaConfig;
  beta: BetaConfig;
  gamma: GammaConfig;
  // Pace・アラート
  spike: { minPt: number; minNewBookings: number }; // 要注意日 (20pt/7日 かつ 新規予約2件以上)
  alerts: {
    weekendRemainingMax: number; // 週末の競合残室がこれ以下でアラート (3)
    weekdaySpikePt: number; // 平日の Pace がこれ以上でアラート (15)
    deviationPct: number; // 現在価格と推奨価格の乖離がこれ以上で 値上げ/値下げ 判定 (10)
  };
  // 売上シミュレーション (需要の価格弾力性。負の値)
  elasticity: { low: number; central: number; high: number }; // -0.8 / -1.5 / -2.5
  tightnessDamping: number; // 競合が埋まるほど弾力性を弱める度合い (0.7)
  // データ取得コスト管理
  compsetRefreshDays: number; // CompSet カレンダーの更新周期 (3)
  compsetRefreshMax: number; // 1回の同期で更新する CompSet の上限件数 (20)
  // 自社カレンダー
  icalUrl: string | null; // Airbnb のカレンダーエクスポート (iCal) URL
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
  ratesSyncedAt: string | null; // カレンダー最終取得日 (JST "YYYY-MM-DD")
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

export interface OwnDay {
  date: string;
  currentPrice: number | null; // 現在の販売価格 (AirROI未収録時は設定の基準価格)
  status: OwnStatus;
  statusSource: OwnStatusSource;
}

export interface PricingInputs {
  today: string;
  dataSource: "turso" | "demo";
  lumina: {
    lat: number | null;
    lng: number | null;
    basePrice: number; // 設定画面の基準価格 (config.basePriceWeekday が null のとき採用)
    listingId: string | null;
    priceSource: "api" | "manual" | "demo"; // 現在価格の出所 (manual = 基準価格で代替)
    maxGuests: number;
  };
  candidates: CandidateProperty[]; // 自社から maxRadiusKm 程度の範囲の全候補 (フィルタ前)
  calendar: CalendarRow[]; // candidates の daily_metrics (date ∈ [today-14, today+horizon+7])
  snapshots: SnapshotRow[]; // candidates の calendar_snapshots (snapshotDate >= today-90)
  own: OwnDay[]; // date ∈ [today-14, today+horizon]
  config: PricingConfig;
  icalConfigured: boolean;
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
  strict: boolean; // 緩和前の厳格条件も満たす
  entireHomeInferred: boolean; // room_type 不明のため listing_type 等から一棟貸しと推定した
  calendarStatus: "fresh" | "stale" | "none";
  lastFetched: string | null;
  reservedShare: number | null;
}

export interface CompSetResult {
  members: CompSetMember[];
  strictCount: number;
  candidatesConsidered: number;
  relaxations: string[]; // 適用した緩和 (日本語。例: "ADR帯 ±30% → ±40%")
  effective: CompSetFilterConfig; // 実際に使った条件
  freshCount: number;
  needsRefreshIds: string[]; // カレンダーが stale/none で取得が必要な member id
  basePricePercentile: number | null; // 自社基準価格が「品質同等の周辺物件」の参照ADR分布の何%点か
}

export interface CoefficientDetail {
  value: number; // 小数 (0.15 = +15%)
  reason: string; // 日本語の根拠
}

export interface MarketDay {
  units: number; // その日のカレンダーが新鮮な CompSet 物件数
  unavailable: number; // 予約不可 (予約済 or ブロック) の物件数
  expectedBooked: number; // ブロック補正後の推定予約済室数
  effectiveUnits: number; // ブロック補正後の有効競合総室数
  occRaw: number | null; // 予約不可率 (%)
  occAdj: number | null; // ブロック補正後の占有率 (%), 縮小推定前
  occ: number | null; // 縮小推定後の占有率 (%) = α に使う Occ_t
  occCi: [number, number] | null; // 80% 信用区間 (%)
  remaining: number; // 競合残室数 (予約可能な物件数)
  compAdr: number | null; // 競合平均販売価格 CompADR_t (予約可能物件の中央値/トリム平均)
  priceCount: number; // compAdr の算出に使った価格数
  pace: number | null; // Pace Index PI_t (pt / 7日)
  paceDays: number | null; // 比較したスナップショットの平均間隔 (日)
  newBookings: number | null; // 比較期間に 予約可能→予約不可 になった物件数
  spike: boolean; // 要注意日 (予約急増)
  dataQuality: "ok" | "low" | "none"; // ok: units >= minUnitsForSignal / low: 1..min-1 / none: 0
}

export type PricingAction = "raise" | "lower" | "hold" | "booked" | "blocked";

export interface DayPricing {
  basePrice: number; // P_base (平日基準)
  delta: CoefficientDetail; // 曜日属性係数 δ (週末プレミアム。平日は 0)
  alpha: CoefficientDetail; // 競合占有率係数
  beta: CoefficientDetail; // 消化ペース係数
  gamma: CoefficientDetail; // リードタイム係数
  rawPrice: number; // P_base × (1+δ)(1+α)(1+β)(1+γ)
  floor: number;
  ceiling: number;
  recommended: number; // ガードレール適用・丸め後
  clampedBy: "floor" | "ceiling" | null;
  deviationPct: number | null; // (現在価格 - 推奨) / 推奨 × 100
  action: PricingAction;
}

export interface DayRecommendation {
  date: string;
  lead: number;
  night: NightClass;
  market: MarketDay;
  own: { status: OwnStatus; statusSource: OwnStatusSource; currentPrice: number | null };
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
  fitted: { lead: number; occ: number }[]; // 単調化した平均予約曲線 (lead 0..horizon)
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
  currentRevenue: number; // 現在価格に据え置いた場合の想定売上 (空室日)
  recommendedRevenue: number; // 推奨価格に追従した場合の想定売上 (空室日)
  currentNights: number; // 想定予約泊数
  recommendedNights: number;
  upliftPct: number | null;
}

export interface Simulation {
  available: boolean;
  reason: string | null; // available=false の理由
  vacantDays: number;
  bookedDays: number;
  lockedRevenue: number; // 予約済の日の売上 (現在価格。両シナリオ共通)
  scenarios: SimulationScenario[]; // low / central / high
  central: SimulationScenario | null;
  assumptions: string[]; // 日本語の前提一覧
}

export type AlertKind =
  | "weekend_low_inventory"
  | "weekday_spike"
  | "spike"
  | "raise_opportunity"
  | "discount_needed";

export interface PricingAlert {
  date: string;
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
  raiseDays: number; // 値上げ余地のある空室日数
  lowerDays: number; // 値下げ検討の空室日数
  past14WeekdayOcc: number | null; // 直近14日 実績
  past14WeekendOcc: number | null;
}

export interface PricingStatus {
  lastSnapshotDate: string | null; // CompSet の最新スナップショット日
  prevSnapshotDate: string | null; // Pace 比較に使った過去スナップショット日 (代表値)
  paceAvailable: boolean;
  freshMembers: number;
  ownPriceSource: "api" | "manual" | "demo";
  ownStatusSource: "api" | "ical" | "manual" | "none" | "mixed";
  icalConfigured: boolean;
  refreshCostUsd: number; // needsRefreshIds の取得コスト ($0.10/件)
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
    weekendPremiumPct: number; // δ (%)
    weekendPremiumSource: "auto" | "fixed" | "fallback";
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
/* ------------------------------------------------------------------ */

export type PricingApiRequest =
  /** 設定を保存 (部分更新可。icalUrl に "(設定済み)" を渡すと既存値を保持、"" で削除) */
  | { action: "saveConfig"; config: Partial<PricingConfig> }
  /** CompSet のうちカレンダーが未取得/古い物件を今すぐ取得 (有料: $0.10/件) */
  | { action: "refreshCompset" }
  /** 今日の推奨価格とアラートを pricing_recommendations / pricing_alerts に保存 */
  | { action: "persist" }
  /** 自社の予約状況を手動で上書き ("vacant" は手動上書きの解除) */
  | { action: "setOwnStatus"; date: string; status: OwnStatus }
  /** 設定済み iCal URL から自社の予約・ブロックを取り込む */
  | { action: "importIcal" };

export interface PricingApiResponse {
  ok: boolean;
  message: string; // 日本語 (成功・失敗とも UI にそのまま表示できる文)
  config?: PricingConfig; // saveConfig 時 (マスク済み)
  refreshed?: number; // refreshCompset 時の取得件数
  costUsd?: number; // refreshCompset 時の推定コスト
  saved?: number; // persist 時の保存行数
  alerts?: number; // persist 時のアラート件数
  imported?: number; // importIcal 時の取り込み日数
}
