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
 *   "room"/"個室"/"ドミトリー"/"dorm" を含まない場合に true。いずれも inferred=true
 */
export function isEntireHome(c: CandidateProperty): { entire: boolean; inferred: boolean } {
  void c;
  throw new Error("not implemented");
}

/** 1件が条件 f を満たすか (距離は distanceKm を外から渡す)。basePrice は ADR 帯の中心 */
export function passesFilters(
  c: CandidateProperty,
  distanceKm: number,
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
 * 1. lumina.lat/lng が null の場合は距離条件を使わず (distanceKm=0 とし) 他の条件のみで判定し、
 *    relaxations に "自社の緯度経度が未設定のため距離条件なし" を入れる。
 * 2. 厳格条件 config.compset で絞り、strictCount を記録。
 * 3. 件数 < minSize (かつ minSize > 0) なら、次の緩和ラダーを順に「累積」適用し、件数 >= minSize
 *    になった時点で止める (各ステップで relaxations に日本語の説明を追加):
 *      a. ADR帯 +10pt (例 ±30%→±40%)   b. ADR帯 さらに +10pt (→±50%)
 *      c. 定員 下限-1・上限+2 (6〜10→5〜12)
 *      d. 評価下限を -0.1 (4.7→4.6)、レビュー件数下限を max(2, minReviews − 2) (5→3)
 *      e. 半径を maxRadiusKm まで拡大 (radiusKm < maxRadiusKm のときのみ)
 *    例: relaxations = ["ADR帯 ±30% → ±40%"]。ステップ a〜e の各説明文は日本語で変化前→後を明記。
 *    ラダーを使い切っても不足ならその時点の結果を返す (warnings は compute 側で出す)。
 * 4. members は distanceKm 昇順。strict = 緩和前の条件を満たすか。
 * 5. calendarStatus: ratesSyncedAt が null → "none", today - ratesSyncedAt <= freshnessDays → "fresh",
 *    それ以外 "stale"。needsRefreshIds = fresh でない member の id。
 * 6. basePricePercentile: 「距離・一棟貸し・定員・評価・レビュー の条件 (ADR帯を除く、緩和後の値)」を
 *    満たし adrRef を持つ候補の adrRef 分布に対し、basePrice が何%点か (0〜100, 小数1桁)。
 *    該当 3件未満は null。
 * basePrice は ADR 帯の中心 = config.basePriceWeekday ?? lumina.basePrice を呼び出し側が渡す。
 */
export function selectCompSet(
  candidates: CandidateProperty[],
  lumina: { lat: number | null; lng: number | null },
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
