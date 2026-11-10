/**
 * デモモード (Turso 未設定) 用の決定的な PricingInputs。
 * 本番データが無い環境でも /pricing 画面と全指標 (Pace・予約曲線・シミュレーション) が動くことを確認できるようにする。
 *
 * 生成内容 (乱数は seed 固定の mulberry32。同じ today なら常に同じ結果):
 * - lumina: lat 35.42038, lng 138.90478 (山中湖), basePrice 110000, listingId "demo_lumina",
 *   priceSource "demo", maxGuests 8
 * - candidates 約30件: うち 12件は厳格条件を満たす一棟貸しヴィラ (半径7km以内, 定員6〜10, 評価4.7+, レビュー5+,
 *   adrRef 80,000〜140,000)、残りは条件外 (遠い・ホテル・個室・低評価・安価) を混ぜる。roomType は実データ同様
 *   "entire_home"/"private_room"/"hotel_room"。reservedShare 0.6〜0.95。
 *   CompSet 12件の ratesSyncedAt/lastAttemptAt: 9件 today−1、1件 today−20 (stale)、1件 null/null (none)、
 *   1件 ratesSyncedAt null かつ lastAttemptAt today−2 (failed)
 * - calendar: ratesSyncedAt があるものについて date ∈ [today−14, today+horizon+7]、fetchedAt = ratesSyncedAt
 *   (stale 物件は today−20 時点の状態)。予約確率は「週末 > 平日」「リードタイムが近いほど高い」
 *   「特定連休 (年末年始等) は高い」を反映。price は adrRef × (週末1.2, 連休1.6) × ノイズ。予約不可日の price は 0
 * - snapshots: ratesSyncedAt を持つ物件のみ、snapshotDate ≤ その物件の ratesSyncedAt の日付だけ:
 *   fresh 物件は today−8 と today−1 の2時点 (today−1 の内容は calendar と一致。today−8 は数件ずつ予約が
 *   埋まる前の状態にし、いくつかの週末で 3件以上の新規予約 = spike が出るように)、stale 物件は today−20 のみ
 * - own: date ∈ [today−14, today+horizon]、約25%を booked (週末寄り)、2日を blocked、残り vacant、
 *   statusSource "manual"、apiPrice は null (現在価格は config.ownPriceWeekday/Weekend で与える)
 * - config = 引数 config に ownPriceWeekday 110000 / ownPriceWeekend 125000 を (null なら) 入れたもの
 * - icalConfigured false、icalLastImport null、alertChannel "none"、lastNotifiedAt null、dataSource "demo"
 */
import { addDaysStr, classifyNight, diffDays } from "./holidays";
import type {
  CalendarRow,
  CandidateProperty,
  OwnDay,
  PeakPeriod,
  PricingConfig,
  PricingInputs,
  SnapshotRow,
} from "./types";

const LUMINA_LAT = 35.42038;
const LUMINA_LNG = 138.90478;
const SEED = 0x5f3759df;

/** seed 固定の擬似乱数 (0 以上 1 未満) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 文字列キー → 32bit ハッシュ (FNV-1a)。物件×日付ごとに独立した乱数列を作り、today がずれても同じ日は同じ結果にする */
function hashKey(key: string): number {
  let h = 0x811c9dc5 ^ SEED;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rngFor(key: string): () => number {
  return mulberry32(hashKey(key));
}

interface DemoSpec {
  key: string;
  title: string;
  area: string;
  distKm: number;
  bearingDeg: number;
  roomType: "entire_home" | "private_room" | "hotel_room";
  listingType: string;
  propertyType: string;
  maxGuests: number;
  rating: number;
  reviews: number;
  adrRef: number;
  reservedShare: number;
  demand: number; // 予約確率の物件係数
}

/** 厳格条件 (半径7km・一棟貸し・定員6〜10・評価4.7+・レビュー5+・ADR±30%) を満たす 12件 */
const COMPSET_SPECS: DemoSpec[] = [
  ["湖畔の森ヴィラ", 1.2, 20, 8, 4.92, 48, 118000, 0.88, 1.05],
  ["平野ヴィラ・レイクビュー", 1.8, 75, 10, 4.85, 23, 132000, 0.82, 1.0],
  ["旭日丘コテージヴィラ", 2.3, 140, 6, 4.78, 15, 86000, 0.74, 0.95],
  ["富士望むプライベートヴィラ", 2.9, 200, 8, 4.95, 102, 125000, 0.93, 1.1],
  ["山中湖サウナヴィラ", 3.4, 260, 9, 4.81, 31, 98000, 0.8, 1.0],
  ["森のグランヴィラ", 3.9, 310, 10, 4.88, 12, 139000, 0.66, 0.9],
  ["湖北ヴィラ・ステイ", 4.4, 45, 7, 4.74, 9, 92000, 0.71, 0.92],
  ["ファイヤーピットのある別邸", 4.8, 110, 8, 4.9, 66, 112000, 0.9, 1.05],
  ["山中ヴィラ・リトリート", 5.3, 170, 6, 4.83, 27, 81000, 0.77, 0.97],
  ["高原のラグジュアリーヴィラ", 5.9, 230, 10, 4.97, 7, 136000, 0.62, 0.9],
  ["湖畔テラスハウス", 6.3, 290, 8, 4.76, 19, 104000, 0.85, 1.0],
  ["ドッグヴィラ山中湖", 6.8, 340, 9, 4.86, 40, 121000, 0.79, 0.98],
].map(([title, distKm, bearingDeg, maxGuests, rating, reviews, adrRef, reservedShare, demand], i) => ({
  key: `c${String(i + 1).padStart(2, "0")}`,
  title: String(title),
  area: "山中湖村",
  distKm: Number(distKm),
  bearingDeg: Number(bearingDeg),
  roomType: "entire_home" as const,
  listingType: "Entire villa",
  propertyType: "villa",
  maxGuests: Number(maxGuests),
  rating: Number(rating),
  reviews: Number(reviews),
  adrRef: Number(adrRef),
  reservedShare: Number(reservedShare),
  demand: Number(demand),
}));

/** 条件外の候補 18件 (遠い・ホテル・個室・低評価・安価・大人数) */
const OTHER_SPECS: DemoSpec[] = [
  // 遠い (半径外) 一棟貸し
  ["河口湖ヴィラ・ノース", "富士河口湖町", 11.5, 290, "entire_home", "Entire villa", "villa", 8, 4.91, 54, 115000, 0.84],
  ["西湖の一棟貸し", "富士河口湖町", 15.2, 280, "entire_home", "Entire home", "house", 10, 4.82, 21, 99000, 0.78],
  ["富士吉田リゾートヴィラ", "富士吉田市", 9.6, 315, "entire_home", "Entire villa", "villa", 8, 4.88, 35, 128000, 0.8],
  ["鳴沢の森ヴィラ", "鳴沢村", 18.4, 285, "entire_home", "Entire cabin", "villa", 6, 4.75, 12, 87000, 0.69],
  // ホテル
  ["レイクサイドホテル ツイン", "山中湖村", 1.5, 100, "hotel_room", "Room in hotel", "hotel", 3, 4.6, 210, 32000, 0.9],
  ["富士見ホテル 和洋室", "山中湖村", 2.6, 220, "hotel_room", "Room in boutique hotel", "hotel", 4, 4.72, 88, 45000, 0.87],
  ["湖畔リゾートホテル", "山中湖村", 3.8, 30, "hotel_room", "Room in hotel", "hotel", 2, 4.8, 140, 38000, 0.92],
  // 個室
  ["ゲストハウス 個室A", "山中湖村", 2.1, 160, "private_room", "Private room in home", "house", 2, 4.85, 76, 12000, 0.7],
  ["ペンション 個室", "山中湖村", 3.1, 250, "private_room", "Private room in bed and breakfast", "pension", 3, 4.9, 41, 18000, 0.75],
  ["民家ステイ 和室", "忍野村", 5.5, 330, "private_room", "Private room in home", "house", 4, 4.7, 9, 15000, 0.65],
  // 低評価の一棟貸し
  ["山中湖ファミリーハウス", "山中湖村", 2.7, 60, "entire_home", "Entire home", "house", 8, 4.45, 33, 95000, 0.72],
  ["湖畔ヴィラ・ベーシック", "山中湖村", 4.1, 190, "entire_home", "Entire villa", "villa", 9, 4.55, 18, 108000, 0.68],
  ["森の一棟貸しロッジ", "山中湖村", 5.0, 120, "entire_home", "Entire cabin", "villa", 7, 4.6, 26, 88000, 0.74],
  // 安価な一棟貸し
  ["山中湖エコノミーハウス", "山中湖村", 1.9, 300, "entire_home", "Entire home", "house", 8, 4.82, 57, 38000, 0.86],
  ["バジェットコテージ", "山中湖村", 3.6, 80, "entire_home", "Entire cottage", "house", 6, 4.77, 22, 45000, 0.81],
  ["素泊まり一棟貸し", "忍野村", 6.1, 345, "entire_home", "Entire home", "house", 7, 4.73, 14, 52000, 0.79],
  // 大人数・高額
  ["大型グループヴィラ", "山中湖村", 2.4, 230, "entire_home", "Entire villa", "villa", 16, 4.89, 29, 210000, 0.83],
  ["団体向け貸別荘", "山中湖村", 4.6, 150, "entire_home", "Entire home", "house", 20, 4.71, 11, 180000, 0.6],
].map(
  ([title, area, distKm, bearingDeg, roomType, listingType, propertyType, maxGuests, rating, reviews, adrRef, reservedShare], i) => ({
    key: `x${String(i + 1).padStart(2, "0")}`,
    title: String(title),
    area: String(area),
    distKm: Number(distKm),
    bearingDeg: Number(bearingDeg),
    roomType: roomType as DemoSpec["roomType"],
    listingType: String(listingType),
    propertyType: String(propertyType),
    maxGuests: Number(maxGuests),
    rating: Number(rating),
    reviews: Number(reviews),
    adrRef: Number(adrRef),
    reservedShare: Number(reservedShare),
    demand: 1,
  }),
);

/** CompSet 12件のカレンダー状況 (index → 状態)。それ以外は fresh */
const STALE_INDEX = 5;
const NONE_INDEX = 9;
const FAILED_INDEX = 11;

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function positionOf(spec: DemoSpec): { lat: number; lng: number } {
  const rad = (spec.bearingDeg * Math.PI) / 180;
  const dLat = (spec.distKm * Math.cos(rad)) / 111;
  const dLng = (spec.distKm * Math.sin(rad)) / (111 * Math.cos((LUMINA_LAT * Math.PI) / 180));
  return { lat: round(LUMINA_LAT + dLat, 5), lng: round(LUMINA_LNG + dLng, 5) };
}

function inPeak(date: string, periods: PeakPeriod[]): boolean {
  const md = date.slice(5);
  return periods.some((p) => (p.start <= p.end ? md >= p.start && md <= p.end : md >= p.start || md <= p.end));
}

type NightKind = "weekday" | "weekend" | "peak";

/** 宿泊夜の種類。holidays.ts の classifyNight を使い、使えない場合は曜日 (金土) と特定連休だけで判定 */
function makeNightKind(periods: PeakPeriod[]): (date: string) => NightKind {
  const cache = new Map<string, NightKind>();
  return (date) => {
    const hit = cache.get(date);
    if (hit) return hit;
    let kind: NightKind;
    try {
      const n = classifyNight(date, periods);
      kind = n.peakPeriod ? "peak" : n.type;
    } catch {
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      kind = inPeak(date, periods) ? "peak" : dow === 5 || dow === 6 ? "weekend" : "weekday";
    }
    cache.set(date, kind);
    return kind;
  };
}

interface DayFate {
  willBook: boolean;
  bookLead: number; // この日数前 (リードタイム) に予約が入る
  hostBlocked: boolean;
  noise: number; // 価格ノイズ 0.92〜1.08
}

export function buildDemoPricingInputs(today: string, config: PricingConfig): PricingInputs {
  const cfg: PricingConfig = {
    ...config,
    ownPriceWeekday: config.ownPriceWeekday ?? 110000,
    ownPriceWeekend: config.ownPriceWeekend ?? 125000,
  };
  const H = cfg.horizonDays;
  const nightKind = makeNightKind(cfg.peakPeriods);
  const calFrom = addDaysStr(today, -14);
  const calTo = addDaysStr(today, H + 7);

  // --- candidates ---
  const candidates: CandidateProperty[] = [];
  const specById = new Map<string, DemoSpec>();
  COMPSET_SPECS.forEach((spec, i) => {
    let ratesSyncedAt: string | null = addDaysStr(today, -1);
    let lastAttemptAt: string | null = addDaysStr(today, -1);
    if (i === STALE_INDEX) {
      ratesSyncedAt = addDaysStr(today, -20);
      lastAttemptAt = addDaysStr(today, -20);
    } else if (i === NONE_INDEX) {
      ratesSyncedAt = null;
      lastAttemptAt = null;
    } else if (i === FAILED_INDEX) {
      ratesSyncedAt = null;
      lastAttemptAt = addDaysStr(today, -2);
    }
    candidates.push(toCandidate(spec, ratesSyncedAt, lastAttemptAt));
    specById.set(`airroi_demo_${spec.key}`, spec);
  });
  for (const spec of OTHER_SPECS) {
    candidates.push(toCandidate(spec, null, null));
    specById.set(`airroi_demo_${spec.key}`, spec);
  }

  // --- 物件×日付の「運命」(予約されるか・何日前に予約されるか・ホストのブロック) ---
  const freshIds = candidates
    .filter((c) => c.ratesSyncedAt === addDaysStr(today, -1))
    .map((c) => c.id);
  const forced = forcedNewBookings(today, H, nightKind, freshIds);

  const fateCache = new Map<string, DayFate>();
  const fateOf = (c: CandidateProperty, date: string): DayFate => {
    const key = `${c.id}|${date}`;
    const hit = fateCache.get(key);
    if (hit) return hit;
    const spec = specById.get(c.id);
    const rand = rngFor(key);
    const kind = nightKind(date);
    const baseP = kind === "peak" ? 0.92 : kind === "weekend" ? 0.78 : 0.42;
    const pFinal = Math.min(0.97, baseP * (spec?.demand ?? 1));
    const u1 = rand();
    const u2 = rand();
    const u3 = rand();
    const u4 = rand();
    // 予約が入るリードタイム: 連休・週末は早く埋まり、平日は直前に積み上がる
    const bookLead =
      kind === "peak"
        ? Math.floor(120 * Math.pow(u2, 0.5))
        : kind === "weekend"
          ? Math.floor(90 * Math.pow(u2, 0.6))
          : Math.floor(45 * Math.pow(u2, 2.2));
    let fate: DayFate = {
      willBook: u1 < pFinal,
      bookLead,
      hostBlocked: u3 < (1 - (c.reservedShare ?? 0.8)) * 0.25,
      noise: 0.92 + 0.16 * u4,
    };
    const forcedLead = forced.get(key);
    if (forcedLead !== undefined) {
      fate = { ...fate, willBook: true, bookLead: forcedLead, hostBlocked: false };
    }
    fateCache.set(key, fate);
    return fate;
  };

  /** 観測日 observedAt 時点の状態 */
  const stateAt = (c: CandidateProperty, date: string, observedAt: string): { available: boolean; price: number } => {
    const fate = fateOf(c, date);
    const lead = diffDays(observedAt, date);
    const booked = fate.willBook && lead <= fate.bookLead;
    const available = !booked && !fate.hostBlocked;
    if (!available) return { available, price: 0 };
    const kind = nightKind(date);
    const mult = kind === "peak" ? 1.6 : kind === "weekend" ? 1.2 : 1;
    const price = Math.round(((c.adrRef ?? 100000) * mult * fate.noise) / 100) * 100;
    return { available, price };
  };

  // --- calendar ---
  const calendar: CalendarRow[] = [];
  const nCal = diffDays(calFrom, calTo);
  for (const c of candidates) {
    if (!c.ratesSyncedAt) continue;
    for (let i = 0; i <= nCal; i++) {
      const date = addDaysStr(calFrom, i);
      const s = stateAt(c, date, c.ratesSyncedAt);
      calendar.push({ propertyId: c.id, date, available: s.available, price: s.price, fetchedAt: c.ratesSyncedAt });
    }
  }

  // --- snapshots (fresh: today−8 と today−1 / stale: today−20) ---
  const snapshots: SnapshotRow[] = [];
  for (const c of candidates) {
    if (!c.ratesSyncedAt) continue;
    const snapDates =
      c.ratesSyncedAt === addDaysStr(today, -1) ? [addDaysStr(today, -8), addDaysStr(today, -1)] : [c.ratesSyncedAt];
    for (const snapshotDate of snapDates) {
      const n = diffDays(snapshotDate, calTo);
      for (let i = 0; i <= n; i++) {
        const date = addDaysStr(snapshotDate, i);
        const s = stateAt(c, date, snapshotDate);
        snapshots.push({ snapshotDate, propertyId: c.id, date, available: s.available, price: s.price });
      }
    }
  }

  return {
    today,
    dataSource: "demo",
    lumina: {
      lat: LUMINA_LAT,
      lng: LUMINA_LNG,
      basePrice: 110000,
      listingId: "demo_lumina",
      priceSource: "demo",
      maxGuests: 8,
    },
    candidates,
    calendar,
    snapshots,
    own: buildOwn(today, H, nightKind),
    config: cfg,
    icalConfigured: false,
    icalLastImport: null,
    alertChannel: "none",
    lastNotifiedAt: null,
  };
}

function toCandidate(spec: DemoSpec, ratesSyncedAt: string | null, lastAttemptAt: string | null): CandidateProperty {
  const pos = positionOf(spec);
  return {
    id: `airroi_demo_${spec.key}`,
    title: spec.title,
    url: null,
    area: spec.area,
    lat: pos.lat,
    lng: pos.lng,
    roomType: spec.roomType,
    listingType: spec.listingType,
    propertyType: spec.propertyType,
    maxGuests: spec.maxGuests,
    rating: spec.rating,
    reviews: spec.reviews,
    adrRef: spec.adrRef,
    reservedShare: spec.reservedShare,
    ratesSyncedAt,
    lastAttemptAt,
  };
}

/**
 * 予約急増 (spike) を演出する日: リードタイム 14〜45日の週末 (最大3夜) と平日 1夜に、
 * fresh 物件の一部へ「today−8 〜 today−1 の間に予約が入る」予約リードタイムを割り当てる。
 * 戻り値: "物件id|日付" → 予約リードタイム
 */
function forcedNewBookings(
  today: string,
  horizon: number,
  nightKind: (date: string) => NightKind,
  freshIds: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (freshIds.length === 0) return out;
  const weekendDates: string[] = [];
  let weekdayDate: string | null = null;
  for (let lead = 14; lead <= Math.min(45, horizon); lead++) {
    const date = addDaysStr(today, lead);
    const kind = nightKind(date);
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    if (kind === "weekend" && dow === 6 && weekendDates.length < 3) weekendDates.push(date);
  }
  for (let lead = 8; lead <= Math.min(20, horizon); lead++) {
    const date = addDaysStr(today, lead);
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    if (nightKind(date) === "weekday" && (dow === 2 || dow === 3)) {
      weekdayDate = date;
      break;
    }
  }
  const plan: [string, number][] = weekendDates.map((d, i) => [d, i === 0 ? 4 : 3]);
  if (weekdayDate) plan.push([weekdayDate, 3]);
  plan.forEach(([date, count], k) => {
    const lead = diffDays(today, date);
    const rand = rngFor(`forced|${date}`);
    for (let j = 0; j < Math.min(count, freshIds.length); j++) {
      const id = freshIds[(k * 2 + j) % freshIds.length];
      // today−1 の観測 (リード lead+1) では予約済、today−8 の観測 (リード lead+8) では空き
      out.set(`${id}|${date}`, lead + 1 + Math.floor(rand() * 7));
    }
  });
  return out;
}

/** 自社の予約状況 (約25%を予約済・週末寄り、2日をブロック、残り空室。すべて手動指定扱い) */
function buildOwn(today: string, horizon: number, nightKind: (date: string) => NightKind): OwnDay[] {
  const from = addDaysStr(today, -14);
  const own: OwnDay[] = [];
  for (let i = 0; i <= horizon + 14; i++) {
    const date = addDaysStr(from, i);
    const kind = nightKind(date);
    const p = kind === "peak" ? 0.7 : kind === "weekend" ? 0.45 : 0.14;
    const booked = rngFor(`own|${date}`)() < p;
    own.push({ date, apiPrice: null, status: booked ? "booked" : "vacant", statusSource: "manual" });
  }
  // ブロック 2日: リードタイム 20日以降で最初の空室の平日 2夜
  let blocked = 0;
  for (const d of own) {
    if (blocked >= 2) break;
    if (diffDays(today, d.date) >= 20 && d.status === "vacant" && nightKind(d.date) === "weekday") {
      d.status = "blocked";
      blocked += 1;
    }
  }
  return own;
}
