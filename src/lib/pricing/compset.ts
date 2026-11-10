/**
 * 競合セット (CompSet) の抽出・フィルタリング (仕様 2章)。
 *
 * 【担当: market-analytics】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { CandidateProperty, CompSetFilterConfig, CompSetResult, PricingConfig } from "./types";

/** 2点間の大円距離 (km, 地球半径 6371km) */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  void lat1;
  void lng1;
  void lat2;
  void lng2;
  throw new Error("not implemented");
}

/**
 * 一棟貸し判定。
 * - roomType が非 null: roomType === "entire_home" のときのみ true (inferred=false)
 * - roomType が null: listingType が "Entire" で始まる (大文字小文字無視) なら true、
 *   listingType も null なら propertyType が "hotel" 以外かつタイトルに
 *   "room"/"個室"/"ドミトリー"/"dorm" (大文字小文字無視) を含まない場合に true。いずれも inferred=true
 */
export function isEntireHome(c: CandidateProperty): { entire: boolean; inferred: boolean } {
  void c;
  throw new Error("not implemented");
}

/**
 * 1件が条件 f を満たすか。distanceKm が null = 自社の緯度経度が未設定 (距離条件を使わない)。
 * 規則 (すべて満たすと true):
 * - 距離: distanceKm == null、または distanceKm <= f.radiusKm。候補の lat/lng が null で自社側は設定済み
 *   (呼び出し側が distanceKm = NaN を渡す) → false
 * - 一棟貸し: f.entireHomeOnly が true のとき isEntireHome(c).entire
 * - 価格帯: adrRef != null かつ |adrRef − basePrice| <= basePrice × adrBandPct/100 (境界を含む)。adrRef null → false
 * - 定員: guestsMin <= maxGuests <= guestsMax (0 は不可)
 * - 評価: rating != null かつ rating >= minRating
 * - レビュー: reviews >= minReviews
 */
export function passesFilters(
  c: CandidateProperty,
  distanceKm: number | null,
  f: CompSetFilterConfig,
  basePrice: number,
): boolean {
  void c;
  void distanceKm;
  void f;
  void basePrice;
  throw new Error("not implemented");
}

/**
 * CompSet を選ぶ。
 * 0. basePrice <= 0 なら members=[] で返す (relaxations に "自社基準価格が未設定")。
 *    lumina.listingId が非 null なら id === "airroi_" + listingId の候補を除外 (自社を競合に含めない)。
 * 1. lumina.lat/lng が null の場合は距離条件を使わず (distanceKm=null, 表示用 distanceKm は 0) 他の条件のみで判定し、
 *    relaxations に "自社の緯度経度が未設定のため距離条件なし" を入れる。
 * 2. 厳格条件 = config.compset そのもの。strictCount を記録。strict フラグ = 厳格条件を満たすか。
 * 3. 件数 < minSize (かつ minSize > 0) なら、次の緩和ラダーを順に「累積」適用し、件数 >= minSize
 *    になった時点で止める (各ステップで relaxations に日本語の説明を追加):
 *      a. ADR帯 +10pt (例 ±30%→±40%)   b. ADR帯 さらに +10pt (→±50%)
 *      c. 定員 下限-1・上限+2 (6〜10→5〜12)
 *      d. 評価下限を -0.1 (4.7→4.6)、レビュー件数下限を max(2, minReviews − 2) (5→3)
 *      e. 半径を maxRadiusKm まで拡大 (radiusKm < maxRadiusKm のときのみ)
 *    例: relaxations = ["ADR帯 ±30% → ±40%"]。各説明文は日本語で変化前→後を明記。
 *    ラダーを使い切っても不足ならその時点の結果を返す。effective = 最終的に使った条件。
 * 4. members は distanceKm 昇順。
 * 5. calendarStatus (diffDays で日数差。上から順に判定):
 *      a. failed: lastAttemptAt != null かつ today − lastAttemptAt <= 30 かつ
 *         (ratesSyncedAt == null または lastAttemptAt − ratesSyncedAt >= max(2, 2 × compsetRefreshDays))
 *         = 試行したのに成功データが無い/古いまま (掲載終了等)。30日経てば再試行対象に戻る
 *      b. none: ratesSyncedAt == null
 *      c. fresh: today − ratesSyncedAt <= freshnessDays
 *      d. stale: それ以外
 *    lastFetched = ratesSyncedAt。
 *    needsRefreshIds = calendarStatus が "stale"/"none" の member id を、ratesSyncedAt の古い順 (null が先) に。
 * 6. basePricePercentile: 「距離・一棟貸し・定員・評価・レビュー の条件 (ADR帯を除く、effective の値)」を満たし
 *    adrRef を持つ候補 (自社除外) の adrRef 分布 n 件に対し、x = basePrice × (1 + weekendPremiumPct/100 × 2/7)
 *    (平日5泊・週末2泊を混ぜた想定平均単価。参照ADRが全泊の実績平均であるため) の中位順位
 *    pct = (count(adrRef < x) + 0.5·count(adrRef == x)) / n × 100 (小数1桁)。n < 3 なら null。
 *    basePriceAboveAll = n >= 3 かつ count(adrRef >= x) == 0 なら { max: 最大 adrRef }、それ以外 null。
 */
export function selectCompSet(
  candidates: CandidateProperty[],
  lumina: { lat: number | null; lng: number | null; listingId: string | null },
  basePrice: number,
  config: PricingConfig,
  today: string,
): CompSetResult {
  void candidates;
  void lumina;
  void basePrice;
  void config;
  void today;
  throw new Error("not implemented");
}
