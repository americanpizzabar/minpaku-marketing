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
 *     推定予約済 b_i = u_i · r_i、有効室 e_i = 1 − u_i · (1 − r_i)
 *     expectedBooked = Σ b_i、effectiveUnits = Σ e_i、Occ(補正) = expectedBooked / effectiveUnits
 * 計算途中の値は丸めない (丸めは DTO に入れる最終値のみ)。0 除算になる場合は null 扱い。
 *
 * ■ 共通: 行の有効性 (将来日)
 * member の宿泊日 d (lead L = d − today) の calendar 行は、age = today − fetchedAt が
 *   age <= freshnessDays かつ age <= max(compsetRefreshDays + 1, floor(L / 2))
 * のときのみ有効 (直前の日ほど新しい観測を要求する。10日前の観測で明日の需給を判断しない)。
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

/**
 * member id → r_i。reservedShare を [0.05, 1] にクランプ。null の物件は「members の非 null 値の中央値」
 * (それも無ければ 1)。config.blockAdjust=false のときは全員 1。
 */
export function reservedShareFor(members: CompSetMember[], config: PricingConfig): Map<string, number> {
  void members;
  void config;
  throw new Error("not implemented");
}

/**
 * 競合平均販売価格の統計量。prices は 0 以下・非有限を除外して計算。
 * - "median": 中央値 (偶数個は中央2値の平均)
 * - "trimmed": n >= 3 なら g = max(1, floor(n×0.1)) 個ずつ上下を除いた平均 (n − 2g < 1 なら中央値)。n < 3 は中央値
 * 空なら null。四捨五入して整数円。
 */
export function centralPrice(prices: number[], stat: "median" | "trimmed"): number | null {
  void prices;
  void stat;
  throw new Error("not implemented");
}

/**
 * 将来日 dates (lead 0..horizon) ごとの市場指標を計算する (pace 系は null, spike=false で返す)。
 * - 有効行 (冒頭の規則) のある member だけを使う。units = その数、unavailable = そのうち available=false
 * - expectedBooked/effectiveUnits はブロック補正。effectiveUnits <= 0 または units = 0 の日は
 *   occRaw/occAdj/occ/occCi = null、dataQuality = "none"
 * - occRaw = unavailable/units×100、occAdj = expectedBooked/effectiveUnits×100
 * - 少数サンプル補正 (縮小推定 / empirical Bayes):
 *     窓幅 w_t = max(2, min(7, L, horizon − L)) (L = lead)。事前平均 prior_t = 同じ区分 (nights.get(d).type) で
 *       |lead' − L| <= w_t の「他の日」の Σ expectedBooked / Σ effectiveUnits。そのプールの Σ effectiveUnits < 1 なら
 *       窓幅 7、それでも < 1 なら同区分の全日 (自身を除く)、それも無ければ prior = occAdj/100 (補正なし)
 *     k = config.shrinkStrength
 *     occ = (expectedBooked + k·prior) / (effectiveUnits + k) × 100
 *     80% 信用区間: a = expectedBooked + k·prior + 0.5, b = effectiveUnits − expectedBooked + k·(1−prior) + 0.5,
 *       m = a/(a+b), sd = sqrt(ab / ((a+b)²(a+b+1))), [m − 1.2816·sd, m + 1.2816·sd] を 0..1 に丸めて×100
 * - remaining = 有効行で available=true の数。remainingEst = units > 0 ? round(remaining × members.length / units) : null
 * - compAdr = centralPrice(有効行で available かつ price>0 の価格, config.adrStat)、priceCount = その個数
 * - maxAgeDays = 使った有効行の age の最大 (無ければ null)
 * - listings = 有効行の { id, available, price: available && price>0 ? price : null } (member の距離順)
 * - dataQuality: units >= minUnitsForSignal → "ok", 1..min−1 → "low", それ以外 "none"
 * DTO の値: % は小数1桁、expectedBooked/effectiveUnits は小数2桁、価格は整数。
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
  byDate: Map<
    string,
    {
      pace: number | null; // 超過ペース (pt/7日) = paceRaw − paceExpected
      paceRaw: number | null;
      paceExpected: number | null;
      paceDays: number | null;
      newBookings: number | null;
    }
  >;
  lastSnapshotDate: string | null; // members の snapshotDate のうち [today − freshnessDays, today] の最大 (ペア有無に関係なく)
  paceCompareDate: string | null; // 採用した C_p の最頻値 (同数なら新しい方)
  paceWindowDays: number | null; // 採用した (S_p − C_p) の平均 (小数1桁)
  paceAvailableFrom: string | null; // byDate に pace 非 null が1つも無いとき: (S_p が存在する member の最小 S_p) + 3日。それ以外 null
}

/**
 * Pace Index (仕様 3.2「直近7日間における占有率増加スピード」, 3.3「直近3〜7日で急増」)。
 * 予約曲線から期待される「通常の積み増し」を差し引いた超過ペースを PI_t とする
 * (当日に近づけば自然に埋まる分を「急増」と誤認しないため)。
 * 物件 p ごとに
 *   S_p = p のスナップショット日のうち [today − (compsetRefreshDays + 1), today] にある最新日
 *   C_p = p のスナップショット日のうち [S_p − 7, S_p − 3] にあり、(S_p − C_p) が 7 に最も近い日 (同距離なら古い方)
 *   どちらか無ければ p は除外。g_p = S_p − C_p
 * 宿泊日 d ごとに、S_p と C_p の両方に d の行があり d >= S_p の p の集合 P_d で
 *   (b, e はブロック補正。b_pS, b_pC = 各時点の推定予約、e_pS = S 時点の有効室)
 *   rawRate = 7 · Σ_p (b_pS − b_pC)/g_p / Σ_p e_pS
 *   F = curves[区分].fitted を lead → occ/100 にした関数 (lead が無い所は最も近い lead の値)
 *   expRate = 7 · Σ_p e_pS · (F(d − S_p) − F(d − C_p))/g_p / Σ_p e_pS
 *   paceRaw = 100·rawRate、paceExpected = 100·expRate、pace = paceRaw − paceExpected (いずれも小数1桁)
 *   paceDays = mean(g_p) (小数1桁)、newBookings = P_d 内で C で available かつ S で unavailable の数
 * |P_d| < minUnitsForSignal なら5値とも null。曲線 (fitted) が空の区分の日は pace/paceExpected = null (paceRaw は計算)。
 * 区分は nights (dates の各日) から取る。dates にない日は byDate に入れない。
 */
export function computePace(
  dates: string[],
  nights: Map<string, NightClass>,
  members: CompSetMember[],
  snapshots: SnapshotRow[],
  curves: { weekday: BookingCurve; weekend: BookingCurve },
  config: PricingConfig,
  today: string,
): PaceResult {
  void dates;
  void nights;
  void members;
  void snapshots;
  void curves;
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
 * 入力は x 昇順でなくてもよい (内部でソート、同じ x は重み付き平均にまとめる)。w <= 0 や非有限の点は無視。
 * 出力は x 昇順、各 x に当てはめ値 y。空入力は空配列。
 */
export function isotonicNonIncreasing(points: { x: number; y: number; w: number }[]): { x: number; y: number }[] {
  void points;
  throw new Error("not implemented");
}

/**
 * 平日・週末別の予約曲線 (仕様 4.1「リードタイムごとの競合の平均予約確定タイミング」)。
 * 観測 (物件単位) = 次の2種類の和集合:
 *   (1) snapshots の行 (snapshotDate s, 物件 p ∈ members, 宿泊日 d) で lead L = d − s が 0..horizonDays のもの
 *   (2) 現在の市場: market の各日 (lead = d − today) の listings の各物件 (source "current")
 *   ただし (2) と同じ (p, d) で s = その物件の最新スナップショット日のものは (1) から除く (二重計上防止)
 *   各観測は ブロック補正の (b, e) を持つ。区分は classifyNight(d, config.peakPeriods).type。
 * - points (散布図): 区分ごとに (宿泊日 d, lead を 3日刻みに丸めた L3 = 3·round(L/3)) で観測をまとめ、
 *   観測数 >= minUnitsForSignal の組だけ Σb/Σe×100 を1点に (lead = L3)。source は組の中に (2) 由来があれば
 *   "current"、無ければ "snapshot"。区分ごとに最大 400 点へ等間隔に間引く (sampleSize は間引き前)。
 * - fitted: L = 0..horizonDays ごとに lead が [L−2, L+2] の全観測をプールした Σb/Σe (重み Σe)。観測ゼロの L は除外。
 *   これを isotonicNonIncreasing (x=L, y=占有率, w=重み) で単調化し、occ を % 小数1桁に。
 * - reach50 / reach80: fitted で occ >= 50 (80) となる最大の lead (= 何日前までに到達しているか)。
 *   fitted の最小 lead の点が閾値未満なら null。
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
 *   compAdr (available の価格) を計算。units = その行数 (0 なら occ/compAdr null)
 * - pickup7: snapshots から、宿泊日 d について物件ごとに「d 以前で最新のスナップショット日 s1」と
 *   「[s1 − 10, s1 − 4] の中で s1 − 7 に最も近いスナップショット日 s0」を取り、両方ある物件が
 *   minUnitsForSignal 以上なら (occ_s1 − occ_s0) を pt で (小数1桁)。不足は null
 * - own は own 配列の該当日 (無ければ status "vacant", currentPrice は apiPrice ?? null)
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
