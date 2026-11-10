/**
 * 稼働進捗の指標化 (仕様 3.2): 競合占有率 Occ_t / 競合平均販売価格 CompADR_t / Pace Index PI_t、
 * 予約曲線 (平日・週末別のリードタイム別 予約確定タイミング)、直近14日の実績。
 *
 * 【担当: market-analytics】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * ■ 共通: ブロック補正 (有効競合総室数)
 * AirROI の将来カレンダーは「予約済」と「ホストのブロック」を区別できない (どちらも available=false)。
 * 各物件の過去12ヶ月実績から r_i = 予約日 / (予約日 + ブロック日) を推定し、
 *   予約不可 u_i ∈ {0,1} の物件 i について
 *     推定予約済 expectedBooked = Σ u_i · r_i
 *     有効総室数 effectiveUnits = Σ (1 − u_i · (1 − r_i))
 *     Occ(補正) = expectedBooked / effectiveUnits
 * r_i が null の物件は「CompSet 内の r_i の中央値」、それも無ければ 1 を使う。
 * config.blockAdjust=false のときは全員 r_i=1 (= 予約不可をすべて予約済とみなす、仕様の素朴定義)。
 */
import type {
  BookingCurve,
  CalendarRow,
  CompSetMember,
  MarketDay,
  NightClass,
  OwnDay,
  PastDay,
  PricingConfig,
  SnapshotRow,
} from "./types";

/** member id → r_i (上記の既定値ルール適用後, 0〜1) */
export function reservedShareFor(members: CompSetMember[], config: PricingConfig): Map<string, number> {
  void members;
  void config;
  throw new Error("not implemented");
}

/**
 * 競合平均販売価格の統計量。prices は 0 以下を除外して計算。
 * - "median": 中央値 (偶数個は中央2値の平均)
 * - "trimmed": 上下 10% (floor(n*0.1) 個ずつ) を除いた平均。n < 3 は中央値
 * 空なら null。四捨五入して整数円。
 */
export function centralPrice(prices: number[], stat: "median" | "trimmed"): number | null {
  void prices;
  void stat;
  throw new Error("not implemented");
}

/**
 * 将来日 dates (lead 0..horizon) ごとの市場指標を計算する (pace/paceDays/newBookings は null, spike=false)。
 * - 各 member の当日行は、calendar のうち fetchedAt >= today − freshnessDays のもののみ有効
 * - units = 有効行のある member 数、unavailable = そのうち available=false の数
 * - expectedBooked/effectiveUnits はブロック補正 (ファイル冒頭)。occRaw = unavailable/units×100、
 *   occAdj = expectedBooked/effectiveUnits×100 (units=0 なら null)
 * - 少数サンプル補正 (縮小推定 / empirical Bayes):
 *     事前平均 prior_t = 同じ区分 (nights.get(date).type) で、lead が ±7 日以内の「他の日」の
 *       Σ expectedBooked / Σ effectiveUnits。プールの effectiveUnits 合計 < 1 なら同区分の全日、
 *       それも無ければ occAdj/100 (補正なし)
 *     k = config.shrinkStrength
 *     occ = (expectedBooked + k·prior) / (effectiveUnits + k) × 100
 *     80% 信用区間: a = expectedBooked + k·prior, b = effectiveUnits − expectedBooked + k·(1−prior),
 *       m = a/(a+b), sd = sqrt(ab / ((a+b)²(a+b+1))), [m − 1.2816·sd, m + 1.2816·sd] を 0..1 に丸めて×100
 *   units=0 の日は occ/occCi も null
 * - remaining = 有効行で available=true の member 数
 * - compAdr = centralPrice(有効行で available=true かつ price>0 の価格, config.adrStat)、priceCount = その個数
 * - dataQuality: units >= minUnitsForSignal → "ok", 1..min−1 → "low", 0 → "none"
 * 数値は % を小数1桁、価格は整数に丸める。
 */
export function computeMarketDays(
  dates: string[],
  nights: Map<string, NightClass>,
  members: CompSetMember[],
  calendar: CalendarRow[],
  config: PricingConfig,
  today: string,
): Map<string, MarketDay> {
  void dates;
  void nights;
  void members;
  void calendar;
  void config;
  void today;
  throw new Error("not implemented");
}

export interface PaceResult {
  byDate: Map<string, { pace: number | null; paceDays: number | null; newBookings: number | null }>;
  lastSnapshotDate: string | null; // 比較に使った最新側スナップショット日の最大値
  prevSnapshotDate: string | null; // 比較に使った過去側スナップショット日 (最頻値, 同数なら新しい方)
}

/**
 * Pace Index (仕様 3.2: 直近7日間における占有率増加スピード)。
 * 物件 p ごとに
 *   S_p = p のスナップショット日のうち today − freshnessDays 以上かつ today 以下の最新日
 *   C_p = p のスナップショット日のうち [S_p − 14, S_p − 3] にあり、(S_p − C_p) が 7 に最も近い日
 *         (同距離なら古い方)。無ければ p は Pace 計算から除外
 * 宿泊日 d ごとに、S_p と C_p の両方に d の行がある p の集合 P_d (d >= S_p のもの) で
 *   occ_S, occ_C をブロック補正推定 (縮小推定なし) で求め
 *   pace = (occ_S − occ_C) × 7 / mean(S_p − C_p)  [pt/7日, 小数1桁]
 *   paceDays = mean(S_p − C_p) (小数1桁), newBookings = P_d 内で C で available かつ S で unavailable の数
 * |P_d| < minUnitsForSignal なら3値とも null。dates にない日は byDate に入れない。
 */
export function computePace(
  dates: string[],
  members: CompSetMember[],
  snapshots: SnapshotRow[],
  config: PricingConfig,
  today: string,
): PaceResult {
  void dates;
  void members;
  void snapshots;
  void config;
  void today;
  throw new Error("not implemented");
}

/**
 * computeMarketDays の結果に Pace を書き込み (破壊的更新)、要注意日を判定する。
 * spike = pace != null && pace >= config.spike.minPt && (newBookings ?? 0) >= config.spike.minNewBookings
 */
export function applyPace(market: Map<string, MarketDay>, pace: PaceResult, config: PricingConfig): void {
  void market;
  void pace;
  void config;
  throw new Error("not implemented");
}

/**
 * 重み付き Pool-Adjacent-Violators による「x に対して単調非増加」な回帰。
 * 入力は x 昇順でなくてもよい (内部でソート、同じ x は重み付き平均にまとめる)。w <= 0 の点は無視。
 * 出力は x 昇順、各 x に当てはめ値 y。空入力は空配列。
 */
export function isotonicNonIncreasing(points: { x: number; y: number; w: number }[]): { x: number; y: number }[] {
  void points;
  throw new Error("not implemented");
}

/**
 * 平日・週末別の予約曲線 (仕様 4.1 「リードタイムごとの競合の平均予約確定タイミング」)。
 * 観測: snapshots の各行 (snapshotDate s, 物件 p, 宿泊日 d, available) で lead L = d − s が 0..horizonDays の
 *   もの (p は members に含まれること)。区分は classifyNight(d, config.peakPeriods).type。
 *   snapshots が空のときは market (将来日の computeMarketDays 結果, lead = d − today, occAdj) を観測とする。
 * - points (散布図): (s, d) ごとに member 数 >= minUnitsForSignal の組だけ、ブロック補正占有率を1点に。
 *   source = s が全スナップショット中の最新日なら "current"、それ以外 "snapshot"。
 *   market から作る場合は source="current"。区分ごとに最大 400 点へ等間隔に間引く (sampleSize は間引き前)。
 * - fitted: lead L = 0..horizonDays ごとに、lead が [L−2, L+2] の全観測をプールしたブロック補正占有率
 *   (Σ推定予約済/Σ有効総室数, 重み = Σ有効総室数)。観測ゼロの L は除外。これを isotonicNonIncreasing
 *   (x=L, y=占有率, w=重み) で単調化し、小数1桁に丸める。
 * - reach50 / reach80: fitted で occ >= 50 (80) となる最大の lead (= 何日前までに到達しているか)。
 *   fitted の lead 0 付近 (最小 lead) が閾値未満なら null。
 */
export function buildBookingCurves(
  members: CompSetMember[],
  snapshots: SnapshotRow[],
  market: Map<string, MarketDay>,
  config: PricingConfig,
  today: string,
): { weekday: BookingCurve; weekend: BookingCurve } {
  void members;
  void snapshots;
  void market;
  void config;
  void today;
  throw new Error("not implemented");
}

/**
 * 直近実績 (仕様 3.1: 過去14日間)。d = today−14 … today−1 (古い順) について
 * - members の calendar 行のうち fetchedAt が [d − freshnessDays, d] のものでブロック補正占有率 (縮小推定なし) と
 *   compAdr (available の価格) を計算。units = その行数
 * - pickup7: snapshots から、宿泊日 d について「d 以前で最新のスナップショット日 s1」と
 *   「s1 − 10 〜 s1 − 4 の中で s1 − 7 に最も近いスナップショット日 s0」を物件ごとに取り、両方ある物件が
 *   minUnitsForSignal 以上なら (occ_s1 − occ_s0) を pt で (小数1桁)。不足は null
 * - own は own 配列の該当日 (無ければ vacant / null)
 * - night は classifyNight(d, config.peakPeriods)
 */
export function computePastDays(
  today: string,
  members: CompSetMember[],
  calendar: CalendarRow[],
  snapshots: SnapshotRow[],
  own: OwnDay[],
  config: PricingConfig,
): PastDay[] {
  void today;
  void members;
  void calendar;
  void snapshots;
  void own;
  void config;
  throw new Error("not implemented");
}
