/**
 * 競合セット (CompSet) の抽出・フィルタリング (仕様 2章)。
 *
 * 【担当: market-analytics】
 */
import { diffDays } from "./holidays";
import type {
  CandidateProperty,
  CompSetFilterConfig,
  CompSetMember,
  CompSetResult,
  PricingConfig,
} from "./types";

/** 浮動小数の境界比較の許容誤差 (4.7 − 0.1 = 4.6000000000000005 等への対策) */
const EPS = 1e-9;

/** 2点間の大円距離 (km, 地球半径 6371km) */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 一棟貸し判定。
 * - roomType が非 null: roomType === "entire_home" のときのみ true (inferred=false)
 * - roomType が null: listingType が "Entire" で始まる (大文字小文字無視) なら true、
 *   listingType も null なら propertyType が "hotel" 以外かつタイトルに
 *   "room"/"個室"/"ドミトリー"/"dorm" (大文字小文字無視) を含まない場合に true。いずれも inferred=true
 */
export function isEntireHome(c: CandidateProperty): { entire: boolean; inferred: boolean } {
  if (c.roomType !== null) return { entire: c.roomType === "entire_home", inferred: false };
  if (c.listingType !== null) {
    return { entire: c.listingType.trim().toLowerCase().startsWith("entire"), inferred: true };
  }
  const title = (c.title ?? "").toLowerCase();
  const roomLike = ["room", "個室", "ドミトリー", "dorm"].some((w) => title.includes(w));
  return { entire: c.propertyType !== "hotel" && !roomLike, inferred: true };
}

/** ADR帯以外の条件 (距離・一棟貸し・定員・評価・レビュー) */
function passesNonPriceFilters(c: CandidateProperty, distanceKm: number | null, f: CompSetFilterConfig): boolean {
  if (distanceKm !== null && !(Number.isFinite(distanceKm) && distanceKm <= f.radiusKm + EPS)) return false;
  if (f.entireHomeOnly && !isEntireHome(c).entire) return false;
  if (!(c.maxGuests > 0 && c.maxGuests >= f.guestsMin && c.maxGuests <= f.guestsMax)) return false;
  if (c.rating === null || !Number.isFinite(c.rating) || c.rating < f.minRating - EPS) return false;
  if (!(c.reviews >= f.minReviews)) return false;
  return true;
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
  if (!passesNonPriceFilters(c, distanceKm, f)) return false;
  if (c.adrRef === null || !Number.isFinite(c.adrRef)) return false;
  const band = (basePrice * f.adrBandPct) / 100;
  return Math.abs(c.adrRef - basePrice) <= band + EPS * Math.max(1, Math.abs(basePrice));
}

/** 表示用の数値 (小数2桁までに丸めて余分な 0 を出さない) */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 緩和ラダー (累積適用)。各ステップは変化が無ければ null を返す */
type RelaxStep = (f: CompSetFilterConfig) => { next: CompSetFilterConfig; label: string } | null;

const RELAX_LADDER: RelaxStep[] = [
  // a. ADR帯 +10pt
  (f) => {
    const band = f.adrBandPct + 10;
    return { next: { ...f, adrBandPct: band }, label: `ADR帯 ±${fmt(f.adrBandPct)}% → ±${fmt(band)}%` };
  },
  // b. ADR帯 さらに +10pt
  (f) => {
    const band = f.adrBandPct + 10;
    return { next: { ...f, adrBandPct: band }, label: `ADR帯 ±${fmt(f.adrBandPct)}% → ±${fmt(band)}%` };
  },
  // c. 定員 下限-1・上限+2
  (f) => {
    const gMin = Math.max(1, f.guestsMin - 1);
    const gMax = f.guestsMax + 2;
    return {
      next: { ...f, guestsMin: gMin, guestsMax: gMax },
      label: `定員 ${f.guestsMin}〜${f.guestsMax}名 → ${gMin}〜${gMax}名`,
    };
  },
  // d. 評価 -0.1、レビュー件数 max(2, minReviews−2) (元の値より厳しくはしない)
  (f) => {
    const rating = Math.max(0, Math.round((f.minRating - 0.1) * 100) / 100);
    const reviews = Math.min(f.minReviews, Math.max(2, f.minReviews - 2));
    const parts: string[] = [];
    if (rating !== f.minRating) parts.push(`評価 ${fmt(f.minRating)}以上 → ${fmt(rating)}以上`);
    if (reviews !== f.minReviews) parts.push(`レビュー ${f.minReviews}件以上 → ${reviews}件以上`);
    if (parts.length === 0) return null;
    return { next: { ...f, minRating: rating, minReviews: reviews }, label: parts.join("、") };
  },
  // e. 半径を maxRadiusKm まで拡大
  (f) => {
    if (!(f.radiusKm < f.maxRadiusKm)) return null;
    return {
      next: { ...f, radiusKm: f.maxRadiusKm },
      label: `半径 ${fmt(f.radiusKm)}km → ${fmt(f.maxRadiusKm)}km`,
    };
  },
];

function calendarStatusOf(
  c: CandidateProperty,
  config: PricingConfig,
  today: string,
): CompSetMember["calendarStatus"] {
  const synced = c.ratesSyncedAt;
  const attempt = c.lastAttemptAt;
  if (attempt !== null && diffDays(attempt, today) <= 30) {
    const gap = Math.max(2, 2 * config.compsetRefreshDays);
    if (synced === null || diffDays(synced, attempt) >= gap) return "failed";
  }
  if (synced === null) return "none";
  return diffDays(synced, today) <= config.freshnessDays ? "fresh" : "stale";
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
  const ownId = lumina.listingId !== null ? `airroi_${lumina.listingId}` : null;
  const pool = candidates.filter((c) => c.id !== ownId);
  const strictCfg: CompSetFilterConfig = { ...config.compset };

  if (!(basePrice > 0) || !Number.isFinite(basePrice)) {
    return {
      members: [],
      strictCount: 0,
      candidatesConsidered: pool.length,
      relaxations: ["自社基準価格が未設定"],
      effective: strictCfg,
      freshCount: 0,
      needsRefreshIds: [],
      basePricePercentile: null,
      basePriceAboveAll: null,
    };
  }

  const relaxations: string[] = [];
  const hasLocation =
    lumina.lat !== null && lumina.lng !== null && Number.isFinite(lumina.lat) && Number.isFinite(lumina.lng);
  if (!hasLocation) relaxations.push("自社の緯度経度が未設定のため距離条件なし");

  // 判定用距離: null = 距離条件なし / NaN = 候補の座標なし (距離条件で落ちる)
  const distances = new Map<string, number | null>();
  for (const c of pool) {
    if (!hasLocation) distances.set(c.id, null);
    else if (c.lat === null || c.lng === null) distances.set(c.id, NaN);
    else distances.set(c.id, haversineKm(lumina.lat as number, lumina.lng as number, c.lat, c.lng));
  }
  const dist = (c: CandidateProperty) => distances.get(c.id) ?? null;
  const select = (f: CompSetFilterConfig) => pool.filter((c) => passesFilters(c, dist(c), f, basePrice));

  const strictSet = new Set(select(strictCfg).map((c) => c.id));
  let effective = strictCfg;
  let selected = select(effective);

  if (strictCfg.minSize > 0 && selected.length < strictCfg.minSize) {
    for (const step of RELAX_LADDER) {
      const r = step(effective);
      if (r === null) continue;
      effective = r.next;
      relaxations.push(r.label);
      selected = select(effective);
      if (selected.length >= strictCfg.minSize) break;
    }
  }

  const displayDistance = (c: CandidateProperty): number => {
    const d = dist(c);
    return d === null || !Number.isFinite(d) ? 0 : d;
  };

  const members: CompSetMember[] = selected
    .map((c) => {
      const entire = isEntireHome(c);
      return {
        id: c.id,
        title: c.title,
        url: c.url,
        area: c.area,
        distanceKm: displayDistance(c),
        maxGuests: c.maxGuests,
        rating: c.rating,
        reviews: c.reviews,
        adrRef: c.adrRef,
        roomType: c.roomType,
        strict: strictSet.has(c.id),
        entireHomeInferred: entire.inferred,
        calendarStatus: calendarStatusOf(c, config, today),
        lastFetched: c.ratesSyncedAt,
        lastAttemptAt: c.lastAttemptAt,
        reservedShare: c.reservedShare,
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const freshCount = members.filter((m) => m.calendarStatus === "fresh").length;
  // 取得日の古い順 (未取得が先)。同順位は距離順を保つ (Array.prototype.sort は安定)
  const needsRefreshIds = members
    .filter((m) => m.calendarStatus === "stale" || m.calendarStatus === "none")
    .sort((a, b) => {
      if (a.lastFetched === b.lastFetched) return 0;
      if (a.lastFetched === null) return -1;
      if (b.lastFetched === null) return 1;
      return a.lastFetched < b.lastFetched ? -1 : 1;
    })
    .map((m) => m.id);

  // 市場内順位: ADR帯以外の条件 (effective) を満たし参照ADRを持つ候補の分布
  const refAdrs = pool
    .filter((c) => passesNonPriceFilters(c, dist(c), effective))
    .map((c) => c.adrRef)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const n = refAdrs.length;
  let basePricePercentile: number | null = null;
  let basePriceAboveAll: { max: number } | null = null;
  if (n >= 3) {
    const x = basePrice * (1 + ((config.weekendPremiumPct / 100) * 2) / 7);
    const below = refAdrs.filter((v) => v < x).length;
    const equal = refAdrs.filter((v) => v === x).length;
    basePricePercentile = Math.round(((below + 0.5 * equal) / n) * 1000) / 10;
    if (below + equal === n && equal === 0) basePriceAboveAll = { max: Math.max(...refAdrs) };
  }

  return {
    members,
    strictCount: strictSet.size,
    candidatesConsidered: pool.length,
    relaxations,
    effective,
    freshCount,
    needsRefreshIds,
    basePricePercentile,
    basePriceAboveAll,
  };
}
