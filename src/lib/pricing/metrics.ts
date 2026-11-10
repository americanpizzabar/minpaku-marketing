/**
 * 稼働進捗の指標化 (仕様 3.2): 競合占有率 Occ_t / 競合平均販売価格 CompADR_t / Pace Index PI_t、
 * 予約曲線 (平日・週末別のリードタイム別 予約確定タイミング)、直近14日の実績。
 *
 * 【担当: market-analytics】
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
import { addDaysStr, classifyNight, diffDays } from "./holidays";
import type {
  BookingCurve,
  BookingCurvePoint,
  CalendarRow,
  CompSetMember,
  MarketDay,
  MarketListingState,
  NightClass,
  NightType,
  OwnDay,
  PastDay,
  PricingConfig,
  SnapshotRow,
} from "./types";

/* ------------------------------------------------------------------ */
/* 小道具                                                               */
/* ------------------------------------------------------------------ */

// "+ 0" で -0 を 0 にそろえる
const round1 = (x: number): number => Math.round(x * 10) / 10 + 0;
const round2 = (x: number): number => Math.round(x * 100) / 100 + 0;

/** ブロック補正: 予約可能 → (b=0, e=1)、予約不可 → (b=r, e=r) */
function blockAdjusted(available: boolean, r: number): { b: number; e: number } {
  return available ? { b: 0, e: 1 } : { b: r, e: r };
}

function shareOf(r: Map<string, number>, id: string): number {
  return r.get(id) ?? 1;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function nightTypeResolver(nights: Map<string, NightClass> | null, config: PricingConfig): (d: string) => NightType {
  const memo = new Map<string, NightType>();
  return (d) => {
    const n = nights?.get(d);
    if (n) return n.type;
    let t = memo.get(d);
    if (t === undefined) {
      t = classifyNight(d, config.peakPeriods).type;
      memo.set(d, t);
    }
    return t;
  };
}

/** member ごとのスナップショット: snapshotDate → (宿泊日 → 行)、および snapshotDate の昇順リスト */
interface MemberSnapshots {
  byDate: Map<string, Map<string, SnapshotRow>>;
  dates: string[];
}

function indexSnapshots(members: CompSetMember[], snapshots: SnapshotRow[]): Map<string, MemberSnapshots> {
  const ids = new Set(members.map((m) => m.id));
  const out = new Map<string, MemberSnapshots>();
  for (const s of snapshots) {
    if (!ids.has(s.propertyId)) continue;
    let ms = out.get(s.propertyId);
    if (!ms) {
      ms = { byDate: new Map(), dates: [] };
      out.set(s.propertyId, ms);
    }
    let rows = ms.byDate.get(s.snapshotDate);
    if (!rows) {
      rows = new Map();
      ms.byDate.set(s.snapshotDate, rows);
    }
    rows.set(s.date, s);
  }
  for (const ms of out.values()) ms.dates = [...ms.byDate.keys()].sort();
  return out;
}

/** 候補日 list の中で target に最も近い日 (同距離なら古い方)。無ければ null */
function closestDate(list: string[], target: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const s of list) {
    const dist = Math.abs(diffDays(target, s));
    if (dist < bestDist || (dist === bestDist && best !== null && s < best)) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* ブロック補正・統計量                                                 */
/* ------------------------------------------------------------------ */

/**
 * member id → r_i。reservedShare を [0.05, 1] にクランプ。null の物件は「members の非 null 値の中央値」
 * (それも無ければ 1)。config.blockAdjust=false のときは全員 1。
 */
export function reservedShareFor(members: CompSetMember[], config: PricingConfig): Map<string, number> {
  const out = new Map<string, number>();
  if (!config.blockAdjust) {
    for (const m of members) out.set(m.id, 1);
    return out;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0.05, v));
  const known = members
    .map((m) => m.reservedShare)
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .map(clamp)
    .sort((a, b) => a - b);
  const fallback = known.length > 0 ? median(known) : 1;
  for (const m of members) {
    const v = m.reservedShare;
    out.set(m.id, v !== null && Number.isFinite(v) ? clamp(v) : fallback);
  }
  return out;
}

/**
 * 競合平均販売価格の統計量。prices は 0 以下・非有限を除外して計算。
 * - "median": 中央値 (偶数個は中央2値の平均)
 * - "trimmed": n >= 3 なら g = max(1, floor(n×0.1)) 個ずつ上下を除いた平均 (n − 2g < 1 なら中央値)。n < 3 は中央値
 * 空なら null。四捨五入して整数円。
 */
export function centralPrice(prices: number[], stat: "median" | "trimmed"): number | null {
  const xs = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return null;
  if (stat === "trimmed" && n >= 3) {
    const g = Math.max(1, Math.floor(n * 0.1));
    if (n - 2 * g >= 1) {
      const kept = xs.slice(g, n - g);
      return Math.round(kept.reduce((s, v) => s + v, 0) / kept.length);
    }
  }
  return Math.round(median(xs));
}

/* ------------------------------------------------------------------ */
/* 将来日の市場指標                                                     */
/* ------------------------------------------------------------------ */

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
  const r = reservedShareFor(members, config);
  const typeOf = nightTypeResolver(nights, config);
  const ids = new Set(members.map((m) => m.id));
  const orderedMembers = [...members].sort((a, b) => a.distanceKm - b.distanceKm);

  // 宿泊日 → (物件 → 行)。同じ (物件, 日) が複数あれば取得日の新しい方
  const idx = new Map<string, Map<string, CalendarRow>>();
  for (const row of calendar) {
    if (!ids.has(row.propertyId)) continue;
    let m = idx.get(row.date);
    if (!m) {
      m = new Map();
      idx.set(row.date, m);
    }
    const prev = m.get(row.propertyId);
    if (!prev || row.fetchedAt > prev.fetchedAt) m.set(row.propertyId, row);
  }

  interface Agg {
    date: string;
    lead: number;
    type: NightType;
    units: number;
    unavailable: number;
    eb: number;
    eu: number;
    remaining: number;
    prices: number[];
    maxAge: number | null;
    listings: MarketListingState[];
  }

  const uniqueDates = [...new Set(dates)];
  const aggs: Agg[] = uniqueDates.map((date) => {
    const lead = diffDays(today, date);
    const ageLimit = Math.min(config.freshnessDays, Math.max(config.compsetRefreshDays + 1, Math.floor(lead / 2)));
    const rows = idx.get(date);
    const a: Agg = {
      date,
      lead,
      type: typeOf(date),
      units: 0,
      unavailable: 0,
      eb: 0,
      eu: 0,
      remaining: 0,
      prices: [],
      maxAge: null,
      listings: [],
    };
    if (!rows) return a;
    for (const m of orderedMembers) {
      const row = rows.get(m.id);
      if (!row) continue;
      const age = diffDays(row.fetchedAt, today);
      if (age > ageLimit) continue;
      const { b, e } = blockAdjusted(row.available, shareOf(r, m.id));
      a.units += 1;
      a.eb += b;
      a.eu += e;
      if (row.available) {
        a.remaining += 1;
        if (Number.isFinite(row.price) && row.price > 0) a.prices.push(row.price);
      } else {
        a.unavailable += 1;
      }
      a.maxAge = a.maxAge === null ? age : Math.max(a.maxAge, age);
      a.listings.push({
        id: m.id,
        available: row.available,
        price: row.available && Number.isFinite(row.price) && row.price > 0 ? row.price : null,
      });
    }
    return a;
  });

  const H = config.horizonDays;
  const k = config.shrinkStrength;
  const poolSum = (self: number, pred: (o: Agg) => boolean) => {
    let b = 0;
    let e = 0;
    aggs.forEach((o, j) => {
      if (j === self || o.type !== aggs[self].type || !pred(o)) return;
      b += o.eb;
      e += o.eu;
    });
    return { b, e };
  };

  const out = new Map<string, MarketDay>();
  aggs.forEach((a, i) => {
    const hasData = a.units > 0 && a.eu > 0;
    let occRaw: number | null = null;
    let occAdj: number | null = null;
    let occ: number | null = null;
    let occCi: [number, number] | null = null;

    if (hasData) {
      const adj = a.eb / a.eu;
      const w = Math.max(2, Math.min(7, a.lead, H - a.lead));
      let pool = poolSum(i, (o) => Math.abs(o.lead - a.lead) <= w);
      if (pool.e < 1) pool = poolSum(i, (o) => Math.abs(o.lead - a.lead) <= 7);
      if (pool.e < 1) pool = poolSum(i, () => true);
      const prior = pool.e > 0 ? pool.b / pool.e : adj;

      occRaw = round1((a.unavailable / a.units) * 100);
      occAdj = round1(adj * 100);
      occ = round1(((a.eb + k * prior) / (a.eu + k)) * 100);

      const alpha = a.eb + k * prior + 0.5;
      const beta = a.eu - a.eb + k * (1 - prior) + 0.5;
      const s = alpha + beta;
      const mean = alpha / s;
      const sd = Math.sqrt((alpha * beta) / (s * s * (s + 1)));
      const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
      occCi = [round1(clamp01(mean - 1.2816 * sd) * 100), round1(clamp01(mean + 1.2816 * sd) * 100)];
    }

    const dataQuality: MarketDay["dataQuality"] = !hasData
      ? "none"
      : a.units >= config.minUnitsForSignal
        ? "ok"
        : "low";

    out.set(a.date, {
      units: a.units,
      unavailable: a.unavailable,
      expectedBooked: round2(a.eb),
      effectiveUnits: round2(a.eu),
      occRaw,
      occAdj,
      occ,
      occCi,
      remaining: a.remaining,
      remainingEst: a.units > 0 ? Math.round((a.remaining * members.length) / a.units) : null,
      compAdr: centralPrice(a.prices, config.adrStat),
      priceCount: a.prices.length,
      maxAgeDays: a.maxAge,
      listings: a.listings,
      pace: null,
      paceRaw: null,
      paceExpected: null,
      paceDays: null,
      newBookings: null,
      spike: false,
      dataQuality,
    });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Pace                                                                 */
/* ------------------------------------------------------------------ */

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

/** fitted (lead 昇順) を lead → occ/100 の関数にする。lead が無い所は最も近い lead (同距離なら小さい lead) */
function curveFn(fitted: { lead: number; occ: number }[]): ((lead: number) => number) | null {
  if (fitted.length === 0) return null;
  const pts = [...fitted].sort((a, b) => a.lead - b.lead);
  return (lead) => {
    let best = pts[0];
    for (const p of pts) {
      if (Math.abs(p.lead - lead) < Math.abs(best.lead - lead)) best = p;
    }
    return best.occ / 100;
  };
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
  const r = reservedShareFor(members, config);
  const typeOf = nightTypeResolver(nights, config);
  const snaps = indexSnapshots(members, snapshots);
  const F: Record<NightType, ((lead: number) => number) | null> = {
    weekday: curveFn(curves.weekday.fitted),
    weekend: curveFn(curves.weekend.fitted),
  };

  // 最新スナップショット日 (ペア有無に関係なく)
  const freshFrom = addDaysStr(today, -config.freshnessDays);
  let lastSnapshotDate: string | null = null;
  for (const ms of snaps.values()) {
    for (const s of ms.dates) {
      if (s >= freshFrom && s <= today && (lastSnapshotDate === null || s > lastSnapshotDate)) lastSnapshotDate = s;
    }
  }

  // 物件ごとの比較ペア (S_p, C_p)
  const sFrom = addDaysStr(today, -(config.compsetRefreshDays + 1));
  interface Pair {
    id: string;
    S: string;
    C: string;
    g: number;
    rowsS: Map<string, SnapshotRow>;
    rowsC: Map<string, SnapshotRow>;
  }
  const pairs: Pair[] = [];
  const sDates: string[] = [];
  for (const m of members) {
    const ms = snaps.get(m.id);
    if (!ms) continue;
    const inS = ms.dates.filter((s) => s >= sFrom && s <= today);
    if (inS.length === 0) continue;
    const S = inS[inS.length - 1];
    sDates.push(S);
    const cLo = addDaysStr(S, -7);
    const cHi = addDaysStr(S, -3);
    const C = closestDate(
      ms.dates.filter((s) => s >= cLo && s <= cHi),
      addDaysStr(S, -7),
    );
    if (C === null) continue;
    pairs.push({
      id: m.id,
      S,
      C,
      g: diffDays(C, S),
      rowsS: ms.byDate.get(S) ?? new Map(),
      rowsC: ms.byDate.get(C) ?? new Map(),
    });
  }

  const byDate: PaceResult["byDate"] = new Map();
  const used = new Set<string>();
  const empty = { pace: null, paceRaw: null, paceExpected: null, paceDays: null, newBookings: null };

  for (const d of new Set(dates)) {
    const type = typeOf(d);
    const P = pairs.filter((p) => p.rowsS.has(d) && p.rowsC.has(d) && diffDays(p.S, d) >= 0);
    if (P.length < config.minUnitsForSignal || P.length === 0) {
      byDate.set(d, { ...empty });
      continue;
    }
    const f = F[type];
    let sumE = 0;
    let rawNum = 0;
    let expNum = 0;
    let gSum = 0;
    let newBookings = 0;
    for (const p of P) {
      const share = shareOf(r, p.id);
      const rs = p.rowsS.get(d) as SnapshotRow;
      const rc = p.rowsC.get(d) as SnapshotRow;
      const s = blockAdjusted(rs.available, share);
      const c = blockAdjusted(rc.available, share);
      sumE += s.e;
      rawNum += (s.b - c.b) / p.g;
      if (f) expNum += (s.e * (f(diffDays(p.S, d)) - f(diffDays(p.C, d)))) / p.g;
      gSum += p.g;
      if (rc.available && !rs.available) newBookings += 1;
      used.add(p.id);
    }
    if (!(sumE > 0)) {
      byDate.set(d, { ...empty });
      continue;
    }
    const raw = (100 * 7 * rawNum) / sumE;
    const exp = f ? (100 * 7 * expNum) / sumE : null;
    byDate.set(d, {
      pace: exp === null ? null : round1(raw - exp),
      paceRaw: round1(raw),
      paceExpected: exp === null ? null : round1(exp),
      paceDays: round1(gSum / P.length),
      newBookings,
    });
  }

  // 実際に比較に使った物件のペアから代表値を出す
  const usedPairs = pairs.filter((p) => used.has(p.id));
  let paceCompareDate: string | null = null;
  let paceWindowDays: number | null = null;
  if (usedPairs.length > 0) {
    const counts = new Map<string, number>();
    for (const p of usedPairs) counts.set(p.C, (counts.get(p.C) ?? 0) + 1);
    let bestCount = -1;
    for (const [c, n] of counts) {
      if (n > bestCount || (n === bestCount && paceCompareDate !== null && c > paceCompareDate)) {
        paceCompareDate = c;
        bestCount = n;
      }
    }
    paceWindowDays = round1(usedPairs.reduce((s, p) => s + p.g, 0) / usedPairs.length);
  }

  const anyPace = [...byDate.values()].some((v) => v.pace !== null);
  let paceAvailableFrom: string | null = null;
  if (!anyPace && sDates.length > 0) {
    paceAvailableFrom = addDaysStr(sDates.sort()[0], 3);
  }

  return { byDate, lastSnapshotDate, paceCompareDate, paceWindowDays, paceAvailableFrom };
}

/**
 * computeMarketDays の結果に Pace を書き込み (破壊的更新)、要注意日を判定する。
 * spike = pace != null && pace >= config.spike.minPt && (newBookings ?? 0) >= config.spike.minNewBookings
 */
export function applyPace(market: Map<string, MarketDay>, pace: PaceResult, config: PricingConfig): void {
  for (const [d, m] of market) {
    const p = pace.byDate.get(d);
    if (p) {
      m.pace = p.pace;
      m.paceRaw = p.paceRaw;
      m.paceExpected = p.paceExpected;
      m.paceDays = p.paceDays;
      m.newBookings = p.newBookings;
    }
    m.spike =
      m.pace !== null && m.pace >= config.spike.minPt && (m.newBookings ?? 0) >= config.spike.minNewBookings;
  }
}

/* ------------------------------------------------------------------ */
/* 予約曲線                                                             */
/* ------------------------------------------------------------------ */

/**
 * 重み付き Pool-Adjacent-Violators による「x に対して単調非増加」な回帰。
 * 入力は x 昇順でなくてもよい (内部でソート、同じ x は重み付き平均にまとめる)。w <= 0 や非有限の点は無視。
 * 出力は x 昇順、各 x に当てはめ値 y。空入力は空配列。
 */
export function isotonicNonIncreasing(points: { x: number; y: number; w: number }[]): { x: number; y: number }[] {
  const byX = new Map<number, { sw: number; swy: number }>();
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.w) || p.w <= 0) continue;
    const g = byX.get(p.x) ?? { sw: 0, swy: 0 };
    g.sw += p.w;
    g.swy += p.w * p.y;
    byX.set(p.x, g);
  }
  const xs = [...byX.keys()].sort((a, b) => a - b);
  if (xs.length === 0) return [];

  // ブロック = { 重み, 加重平均, 含む x の個数 }
  const blocks: { w: number; y: number; n: number }[] = [];
  for (const x of xs) {
    const g = byX.get(x) as { sw: number; swy: number };
    blocks.push({ w: g.sw, y: g.swy / g.sw, n: 1 });
    // 非増加の違反 (前のブロックより大きい) を併合
    while (blocks.length >= 2 && blocks[blocks.length - 2].y < blocks[blocks.length - 1].y) {
      const last = blocks.pop() as { w: number; y: number; n: number };
      const prev = blocks[blocks.length - 1];
      const w = prev.w + last.w;
      prev.y = (prev.y * prev.w + last.y * last.w) / w;
      prev.w = w;
      prev.n += last.n;
    }
  }
  const out: { x: number; y: number }[] = [];
  let i = 0;
  for (const b of blocks) {
    for (let j = 0; j < b.n; j++) out.push({ x: xs[i++], y: b.y });
  }
  return out;
}

interface CurveObs {
  date: string;
  lead: number;
  b: number;
  e: number;
  current: boolean;
}

function emptyCurve(type: NightType): BookingCurve {
  return { type, points: [], fitted: [], reach50: null, reach80: null, sampleSize: 0 };
}

function reachLead(fitted: { lead: number; occ: number }[], threshold: number): number | null {
  if (fitted.length === 0 || fitted[0].occ < threshold) return null;
  let best: number | null = null;
  for (const f of fitted) if (f.occ >= threshold) best = f.lead;
  return best;
}

function buildCurve(type: NightType, obs: CurveObs[], config: PricingConfig): BookingCurve {
  if (obs.length === 0) return emptyCurve(type);
  const H = config.horizonDays;

  // 散布図: (宿泊日, 3日刻みの lead) ごとに1点
  const groups = new Map<string, { date: string; lead: number; b: number; e: number; n: number; current: boolean }>();
  for (const o of obs) {
    const l3 = 3 * Math.round(o.lead / 3);
    const key = `${o.date}|${l3}`;
    const g = groups.get(key) ?? { date: o.date, lead: l3, b: 0, e: 0, n: 0, current: false };
    g.b += o.b;
    g.e += o.e;
    g.n += 1;
    g.current = g.current || o.current;
    groups.set(key, g);
  }
  const allPoints: BookingCurvePoint[] = [...groups.values()]
    .filter((g) => g.n >= config.minUnitsForSignal && g.e > 0)
    .map((g) => ({
      lead: g.lead,
      occ: round1((g.b / g.e) * 100),
      date: g.date,
      source: g.current ? ("current" as const) : ("snapshot" as const),
    }))
    .sort((a, b) => a.lead - b.lead || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const MAX_POINTS = 400;
  const points =
    allPoints.length <= MAX_POINTS
      ? allPoints
      : Array.from({ length: MAX_POINTS }, (_, i) => allPoints[Math.floor((i * allPoints.length) / MAX_POINTS)]);

  // 平均予約曲線: lead ±2 日をプールした Σb/Σe を単調化
  const sumB = new Array<number>(H + 1).fill(0);
  const sumE = new Array<number>(H + 1).fill(0);
  const cnt = new Array<number>(H + 1).fill(0);
  for (const o of obs) {
    if (o.lead < 0 || o.lead > H) continue;
    sumB[o.lead] += o.b;
    sumE[o.lead] += o.e;
    cnt[o.lead] += 1;
  }
  const raw: { x: number; y: number; w: number }[] = [];
  for (let L = 0; L <= H; L++) {
    let b = 0;
    let e = 0;
    let n = 0;
    for (let j = Math.max(0, L - 2); j <= Math.min(H, L + 2); j++) {
      b += sumB[j];
      e += sumE[j];
      n += cnt[j];
    }
    if (n > 0 && e > 0) raw.push({ x: L, y: (b / e) * 100, w: e });
  }
  const fitted = isotonicNonIncreasing(raw).map((p) => ({ lead: p.x, occ: round1(p.y) }));

  return {
    type,
    points,
    fitted,
    reach50: reachLead(fitted, 50),
    reach80: reachLead(fitted, 80),
    sampleSize: allPoints.length,
  };
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
  const r = reservedShareFor(members, config);
  const ids = new Set(members.map((m) => m.id));
  const typeOf = nightTypeResolver(null, config);
  const H = config.horizonDays;
  const obs: Record<NightType, CurveObs[]> = { weekday: [], weekend: [] };

  // (2) 現在の市場
  const currentKeys = new Set<string>();
  for (const [d, md] of market) {
    const lead = diffDays(today, d);
    if (lead < 0 || lead > H) continue;
    for (const l of md.listings) {
      const key = `${l.id}|${d}`;
      if (currentKeys.has(key)) continue;
      currentKeys.add(key);
      const { b, e } = blockAdjusted(l.available, shareOf(r, l.id));
      obs[typeOf(d)].push({ date: d, lead, b, e, current: true });
    }
  }

  // (1) スナップショット (物件の最新スナップショット日で現在の市場と重なる (p, d) は除く)
  const latestSnap = new Map<string, string>();
  for (const s of snapshots) {
    if (!ids.has(s.propertyId)) continue;
    const prev = latestSnap.get(s.propertyId);
    if (prev === undefined || s.snapshotDate > prev) latestSnap.set(s.propertyId, s.snapshotDate);
  }
  const seen = new Set<string>();
  for (const s of snapshots) {
    if (!ids.has(s.propertyId)) continue;
    const lead = diffDays(s.snapshotDate, s.date);
    if (lead < 0 || lead > H) continue;
    const key = `${s.propertyId}|${s.date}`;
    if (latestSnap.get(s.propertyId) === s.snapshotDate && currentKeys.has(key)) continue;
    const rowKey = `${s.snapshotDate}|${key}`;
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    const { b, e } = blockAdjusted(s.available, shareOf(r, s.propertyId));
    obs[typeOf(s.date)].push({ date: s.date, lead, b, e, current: false });
  }

  return {
    weekday: buildCurve("weekday", obs.weekday, config),
    weekend: buildCurve("weekend", obs.weekend, config),
  };
}

/* ------------------------------------------------------------------ */
/* 直近14日の実績                                                       */
/* ------------------------------------------------------------------ */

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
  const r = reservedShareFor(members, config);
  const ids = new Set(members.map((m) => m.id));
  const snaps = indexSnapshots(members, snapshots);
  const ownByDate = new Map(own.map((o) => [o.date, o]));

  // 宿泊日 → (物件 → 行の一覧)
  const cal = new Map<string, Map<string, CalendarRow[]>>();
  for (const row of calendar) {
    if (!ids.has(row.propertyId)) continue;
    let m = cal.get(row.date);
    if (!m) {
      m = new Map();
      cal.set(row.date, m);
    }
    const list = m.get(row.propertyId) ?? [];
    list.push(row);
    m.set(row.propertyId, list);
  }

  const out: PastDay[] = [];
  for (let i = 14; i >= 1; i--) {
    const d = addDaysStr(today, -i);
    const from = addDaysStr(d, -config.freshnessDays);

    // 実績占有率・競合価格
    let units = 0;
    let eb = 0;
    let eu = 0;
    const prices: number[] = [];
    for (const [pid, rows] of cal.get(d) ?? new Map<string, CalendarRow[]>()) {
      let best: CalendarRow | null = null;
      for (const row of rows) {
        if (row.fetchedAt < from || row.fetchedAt > d) continue;
        if (!best || row.fetchedAt > best.fetchedAt) best = row;
      }
      if (!best) continue;
      const { b, e } = blockAdjusted(best.available, shareOf(r, pid));
      units += 1;
      eb += b;
      eu += e;
      if (best.available && Number.isFinite(best.price) && best.price > 0) prices.push(best.price);
    }

    // pickup7: 最後の約7日間の積み増し
    let b1 = 0;
    let e1 = 0;
    let b0 = 0;
    let e0 = 0;
    let paired = 0;
    for (const [pid, ms] of snaps) {
      const withRow = ms.dates.filter((s) => s <= d && ms.byDate.get(s)?.has(d));
      if (withRow.length === 0) continue;
      const s1 = withRow[withRow.length - 1];
      const lo = addDaysStr(s1, -10);
      const hi = addDaysStr(s1, -4);
      const s0 = closestDate(
        withRow.filter((s) => s >= lo && s <= hi),
        addDaysStr(s1, -7),
      );
      if (s0 === null) continue;
      const share = shareOf(r, pid);
      const x1 = blockAdjusted((ms.byDate.get(s1)?.get(d) as SnapshotRow).available, share);
      const x0 = blockAdjusted((ms.byDate.get(s0)?.get(d) as SnapshotRow).available, share);
      b1 += x1.b;
      e1 += x1.e;
      b0 += x0.b;
      e0 += x0.e;
      paired += 1;
    }
    const pickup7 =
      paired >= config.minUnitsForSignal && paired > 0 && e1 > 0 && e0 > 0 ? round1((b1 / e1 - b0 / e0) * 100) : null;

    const o = ownByDate.get(d);
    out.push({
      date: d,
      night: classifyNight(d, config.peakPeriods),
      occ: units > 0 && eu > 0 ? round1((eb / eu) * 100) : null,
      compAdr: units > 0 ? centralPrice(prices, config.adrStat) : null,
      units,
      pickup7,
      own: { status: o?.status ?? "vacant", currentPrice: o?.apiPrice ?? null },
    });
  }
  return out;
}
