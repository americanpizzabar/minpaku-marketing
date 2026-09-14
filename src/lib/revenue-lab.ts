import { getDashboardData } from "./analytics";
import { getSyncConfig } from "./airroi";
import { getDb } from "./db";
import { LUMINA_PROFILE } from "./demo-data";
import { AREAS, type Filters, type PropertyRow } from "./types";

/**
 * 収益最適化ラボ — レベニューマネジメント/計量経済学に基づく実証分析。
 *  1. ヘドニック価格回帰 (log-ADR の Ridge多重回帰): スペック・差別化設備の価格効果を推定
 *  2. 実証的な適正価格帯分析: 近接competitorを価格帯に分け、RevPARが最大になる価格帯を特定
 *     (異質な物件横断の価格-稼働回帰は需要曲線を識別できないため、経験分布で評価)
 *  3. 差別化設備の収益貢献 (上位パフォーマーの保有率 & RevPAR差)
 *  4. 収益機会の定量化 (実証ベース)
 */

// コモディティ(ほぼ全物件が保有=非差別化)を除外し、差別化に効く設備だけを対象にする
const VALUE_DRIVER_KEYWORDS = [
  "hottub", "hot tub", "jacuzzi", "spa", "onsen", "hotspring", "hot spring",
  "sauna", "pool", "bbq", "barbecue", "grill", "fireplace", "firepit", "fire pit",
  "woodburning", "wood-burning", "evcharger", "ev charger", "electric vehicle",
  "view", "lakefront", "waterfront", "beachfront", "lakeaccess",
  "pet", "ski", "piano", "gym", "exercise", "workout",
  "projector", "cinema", "theater", "gameconsole", "gameroom", "pooltable", "billiard",
  "garden", "patio", "terrace", "balcony", "outdoorshower", "outdoordining", "outdoorfurniture",
  "privateentrance", "waterfront", "kayak", "boat", "hammock", "firework",
].map((k) => k.toLowerCase().replace(/[\s_・（）()]/g, ""));

function normAmenity(s: string): string {
  return s.toLowerCase().replace(/[\s_・（）()-]/g, "");
}
function isValueDriver(display: string): boolean {
  const n = normAmenity(display);
  return VALUE_DRIVER_KEYWORDS.some((k) => n.includes(k));
}

export interface FeatureEffect {
  key: string;
  label: string;
  pctEffect: number; // ADRへの推定効果 (%)
  yenAtMedian: number; // 市場中央値ADR基準での金額換算 (円)
  kind: "spec" | "amenity" | "area";
  luminaHas: boolean | null;
}

export interface PriceBand {
  label: string;
  lo: number;
  hi: number;
  count: number;
  medRevpar: number;
  medOcc: number;
  medAdr: number;
  isBest: boolean;
  isCurrent: boolean; // 自物件の現行価格が属する帯
}

export interface ValueDriverGap {
  name: string;
  topPct: number; // 上位パフォーマーの保有率 (%)
  allPct: number; // 全体保有率 (%)
  upliftRevpar: number; // 保有/非保有の平均RevPAR差
  luminaHas: boolean;
}

export interface RevenueLab {
  available: boolean;
  reason?: string;
  sampleSize: number;
  // ヘドニック回帰
  r2: number;
  medianAdr: number;
  predictedLuminaAdr: number | null;
  currentLuminaAdr: number | null;
  priceGapPct: number | null; // (predicted-current)/current *100
  featureEffects: FeatureEffect[];
  // 実証的な価格帯分析
  comparableCount: number;
  compBasis: string;
  priceBands: PriceBand[];
  bestBandLo: number | null;
  bestBandHi: number | null;
  bestBandRevpar: number | null;
  currentLuminaRevpar: number | null;
  // 差別化設備
  valueDriverGaps: ValueDriverGap[];
  // 収益機会
  annualPricingOpportunity: number | null;
  pricingVerdict: string;
  luminaTitle: string;
}

// ---------- 線形代数 (Ridge回帰) ----------
function transpose(m: number[][]): number[][] {
  return m[0].map((_, j) => m.map((row) => row[j]));
}
function matmul(a: number[][], b: number[][]): number[][] {
  const n = a.length, m = b[0].length, k = b.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let t = 0; t < k; t++) {
      const ait = a[i][t];
      if (ait === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += ait * b[t][j];
    }
  return out;
}
function solve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}
function median(vals: number[]): number {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface FeatureSpec {
  key: string;
  label: string;
  kind: "spec" | "amenity" | "area";
  value: (r: PropertyRow, amen: Set<string>) => number;
  luminaValue: number;
  luminaHas: boolean | null;
}

export async function getRevenueLab(filters: Filters): Promise<RevenueLab> {
  const data = await getDashboardData(filters);
  const rows = data.rows.filter((r) => r.adr > 0 && r.occupancyRate > 0);
  const db = getDb();
  const config = db ? await getSyncConfig(db) : null;
  const luminaTitle = "Lumina Fuji";
  const revparOf = (r: PropertyRow) => (r.adr * r.occupancyRate) / 100;

  const fail = (reason: string): RevenueLab => ({
    available: false, reason, sampleSize: rows.length, r2: 0, medianAdr: 0,
    predictedLuminaAdr: null, currentLuminaAdr: null, priceGapPct: null, featureEffects: [],
    comparableCount: 0, compBasis: "", priceBands: [], bestBandLo: null, bestBandHi: null,
    bestBandRevpar: null, currentLuminaRevpar: null, valueDriverGaps: [],
    annualPricingOpportunity: null, pricingVerdict: "", luminaTitle,
  });

  if (rows.length < 25) return fail("回帰分析には25物件以上のデータが必要です。フィルタを緩めるか同期後にお試しください。");

  // ---- details_json から設備を取得 ----
  const amenByProp = new Map<string, Set<string>>();
  const driverFreq = new Map<string, { display: string; count: number }>();
  if (db) {
    try {
      const ids = rows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const res = await db.execute({
          sql: `SELECT id, details_json FROM properties WHERE id IN (${chunk.map(() => "?").join(",")})`,
          args: chunk,
        });
        for (const row of res.rows) {
          const set = new Set<string>();
          if (row.details_json) {
            try {
              const raw = JSON.parse(String(row.details_json)) as Record<string, unknown>;
              const flat: Record<string, unknown> = { ...raw };
              for (const v of Object.values(raw))
                if (typeof v === "object" && v !== null && !Array.isArray(v)) Object.assign(flat, v);
              const amen = Array.isArray(flat.amenities) ? (flat.amenities as unknown[]) : [];
              const seen = new Set<string>();
              for (const a of amen) {
                const disp = String(a).trim();
                if (!disp || !isValueDriver(disp)) continue; // 差別化設備のみ
                const key = normAmenity(disp);
                set.add(key);
                if (!seen.has(key)) {
                  seen.add(key);
                  const cur = driverFreq.get(key);
                  if (cur) cur.count += 1;
                  else driverFreq.set(key, { display: disp, count: 1 });
                }
              }
            } catch { /* skip */ }
          }
          amenByProp.set(String(row.id), set);
        }
      }
    } catch { /* 設備なしで継続 */ }
  }

  const n = rows.length;
  // 回帰に使う差別化設備 (保有率5-80%、上位12件)
  const topDrivers = [...driverFreq.values()]
    .map((a) => ({ ...a, adoption: a.count / n }))
    .filter((a) => a.adoption >= 0.05 && a.adoption <= 0.8)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const luminaAmenNorm = new Set((config?.luminaAmenities ?? []).map(normAmenity));
  const luminaHasAmenity = (disp: string): boolean =>
    [...luminaAmenNorm].some((la) => la && (normAmenity(disp).includes(la) || la.includes(normAmenity(disp))));

  const ratingMed = median(rows.map((r) => r.rating ?? NaN)) || 4.8;
  const reviewsMed = median(rows.map((r) => r.reviewsCount));
  const bathMed = median(rows.map((r) => r.bathrooms ?? NaN)) || 1;
  const medianAdr = Math.round(median(rows.map((r) => r.adr)));
  const luminaArea = LUMINA_PROFILE.area;

  // ---- 特徴量 ----
  const specFeatures: FeatureSpec[] = [
    { key: "bedrooms", label: "寝室 +1室", kind: "spec", value: (r) => r.bedrooms, luminaValue: config?.luminaBedrooms ?? 4, luminaHas: null },
    { key: "maxGuests", label: "定員 +1名", kind: "spec", value: (r) => r.maxGuests, luminaValue: config?.luminaMaxGuests ?? 10, luminaHas: null },
    { key: "bathrooms", label: "バス +1", kind: "spec", value: (r) => r.bathrooms ?? bathMed, luminaValue: bathMed, luminaHas: null },
    { key: "rating", label: "評価 +1.0★", kind: "spec", value: (r) => r.rating ?? ratingMed, luminaValue: config?.luminaRating ?? ratingMed, luminaHas: null },
    { key: "logReviews", label: "レビュー数2倍", kind: "spec", value: (r) => Math.log1p(r.reviewsCount), luminaValue: Math.log1p(config?.luminaReviews ?? reviewsMed), luminaHas: null },
    { key: "superhost", label: "スーパーホスト", kind: "spec", value: (r) => (r.superhost ? 1 : 0), luminaValue: config?.luminaSuperhost ? 1 : 0, luminaHas: config?.luminaSuperhost ?? null },
  ];
  const amenityFeatures: FeatureSpec[] = topDrivers.map((a) => ({
    key: `am_${a.display}`, label: a.display, kind: "amenity" as const,
    value: (_r: PropertyRow, amen: Set<string>) => (amen.has(normAmenity(a.display)) ? 1 : 0),
    luminaValue: luminaHasAmenity(a.display) ? 1 : 0, luminaHas: luminaHasAmenity(a.display),
  }));
  const areaFeatures: FeatureSpec[] = AREAS.slice(1).map((ar) => ({
    key: `area_${ar}`, label: ar, kind: "area" as const,
    value: (r) => (r.area === ar ? 1 : 0), luminaValue: luminaArea === ar ? 1 : 0, luminaHas: null,
  }));
  const features = [...specFeatures, ...amenityFeatures, ...areaFeatures];

  // ---- log(ADR) を目的変数にした Ridge回帰 (標準化) ----
  const rawX = rows.map((r) => features.map((f) => f.value(r, amenByProp.get(r.id) ?? new Set())));
  const y = rows.map((r) => Math.log(r.adr));
  const p = features.length;
  const means = new Array(p).fill(0), sds = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    const col = rawX.map((row) => row[j]);
    const mu = col.reduce((a, b) => a + b, 0) / n;
    means[j] = mu;
    sds[j] = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / n) || 1;
  }
  const Xs = rawX.map((row) => [1, ...row.map((v, j) => (v - means[j]) / sds[j])]);
  const yMean = y.reduce((a, b) => a + b, 0) / n;
  const Xt = transpose(Xs);
  const XtX = matmul(Xt, Xs);
  const lambda = 3.0; // 正則化を強めに (係数安定化)
  for (let i = 1; i < XtX.length; i++) XtX[i][i] += lambda;
  const Xty = Xt.map((row) => row.reduce((s, v, i) => s + v * y[i], 0));
  const beta = solve(XtX, Xty);
  if (!beta) return fail("回帰の計算に失敗しました。");
  const yhat = Xs.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const ssRes = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // 係数(log)→ %効果 & ¥換算
  const featureEffects: FeatureEffect[] = features
    .map((f, j) => {
      const perUnitLog = beta[j + 1] / sds[j];
      const pct = (Math.exp(perUnitLog) - 1) * 100;
      return {
        key: f.key, label: f.label, kind: f.kind, luminaHas: f.luminaHas,
        pctEffect: Math.round(pct * 10) / 10,
        yenAtMedian: Math.round(medianAdr * (Math.exp(perUnitLog) - 1)),
      };
    })
    .filter((f) => Math.abs(f.pctEffect) >= 1)
    .sort((a, b) => Math.abs(b.pctEffect) - Math.abs(a.pctEffect));

  // 自物件の適正ADR (log予測→指数化)
  const luminaRaw = features.map((f) => f.luminaValue);
  const luminaStd = [1, ...luminaRaw.map((v, j) => (v - means[j]) / sds[j])];
  const predLog = luminaStd.reduce((s, v, j) => s + v * beta[j], 0);
  const predictedLuminaAdr = Math.round(Math.exp(predLog));
  const currentLuminaAdr = data.kpisLumina.adr || config?.luminaBasePrice || null;
  const priceGapPct = currentLuminaAdr ? Math.round(((predictedLuminaAdr - currentLuminaAdr) / currentLuminaAdr) * 1000) / 10 : null;

  // ---- 実証的な適正価格帯分析 (近接competitor) ----
  const luGuests = config?.luminaMaxGuests ?? 10;
  const luBed = config?.luminaBedrooms ?? 4;
  let comps = rows.filter((r) => Math.abs(r.maxGuests - luGuests) <= 3 && Math.abs(r.bedrooms - luBed) <= 2);
  let compBasis = `定員±3名・寝室±2室の近接競合`;
  if (comps.length < 20) {
    comps = rows.filter((r) => Math.abs(r.maxGuests - luGuests) <= 4);
    compBasis = `定員±4名の競合`;
  }
  if (comps.length < 20) { comps = rows; compBasis = "全競合"; }
  const comparableCount = comps.length;

  // 価格帯(5分位)ごとに RevPAR中央値
  const priceBands: PriceBand[] = [];
  let bestBandLo: number | null = null, bestBandHi: number | null = null, bestBandRevpar: number | null = null;
  const sortedComps = [...comps].sort((a, b) => a.adr - b.adr);
  const B = 5;
  if (sortedComps.length >= 20) {
    const size = Math.ceil(sortedComps.length / B);
    const bands: { lo: number; hi: number; revpars: number[]; occs: number[]; adrs: number[] }[] = [];
    for (let i = 0; i < sortedComps.length; i += size) {
      const seg = sortedComps.slice(i, i + size);
      if (!seg.length) continue;
      bands.push({
        lo: seg[0].adr, hi: seg[seg.length - 1].adr,
        revpars: seg.map(revparOf), occs: seg.map((r) => r.occupancyRate), adrs: seg.map((r) => r.adr),
      });
    }
    let bestIdx = 0, bestVal = -1;
    bands.forEach((b, i) => {
      const mr = median(b.revpars);
      if (mr > bestVal) { bestVal = mr; bestIdx = i; }
    });
    bands.forEach((b, i) => {
      priceBands.push({
        label: `¥${Math.round(b.lo / 1000)}k–${Math.round(b.hi / 1000)}k`,
        lo: b.lo, hi: b.hi, count: b.revpars.length,
        medRevpar: Math.round(median(b.revpars)), medOcc: Math.round(median(b.occs) * 10) / 10,
        medAdr: Math.round(median(b.adrs)), isBest: i === bestIdx,
        isCurrent: currentLuminaAdr !== null && currentLuminaAdr >= b.lo && currentLuminaAdr <= b.hi,
      });
    });
    bestBandLo = bands[bestIdx].lo;
    bestBandHi = bands[bestIdx].hi;
    bestBandRevpar = Math.round(bestVal);
  }

  // ---- 差別化設備: 上位パフォーマー(RevPAR上位25%)の保有率 & 収益差 ----
  const revSorted = [...comps].sort((a, b) => revparOf(b) - revparOf(a));
  const topPerformers = revSorted.slice(0, Math.max(5, Math.ceil(revSorted.length * 0.25)));
  const topSet = new Set(topPerformers.map((r) => r.id));
  const valueDriverGaps: ValueDriverGap[] = topDrivers
    .map((am) => {
      const withA: number[] = [], without: number[] = [];
      let topHas = 0;
      for (const r of comps) {
        const has = (amenByProp.get(r.id) ?? new Set()).has(normAmenity(am.display));
        (has ? withA : without).push(revparOf(r));
        if (has && topSet.has(r.id)) topHas += 1;
      }
      const mw = withA.length ? withA.reduce((a, b) => a + b, 0) / withA.length : 0;
      const mo = without.length ? without.reduce((a, b) => a + b, 0) / without.length : 0;
      return {
        name: am.display,
        topPct: topPerformers.length ? Math.round((topHas / topPerformers.length) * 100) : 0,
        allPct: Math.round((withA.length / comps.length) * 100),
        upliftRevpar: Math.round(mw - mo),
        luminaHas: luminaHasAmenity(am.display),
      };
    })
    .sort((a, b) => b.topPct - a.topPct);

  // ---- 収益機会 (実証ベース) ----
  const luminaOccFrac = data.kpisLumina.occupancyRate; // 0-1
  const currentLuminaRevpar =
    currentLuminaAdr && luminaOccFrac ? Math.round(currentLuminaAdr * luminaOccFrac) : null;
  let annualPricingOpportunity: number | null = null;
  let pricingVerdict = "";
  if (bestBandRevpar !== null && currentLuminaRevpar !== null) {
    const diff = bestBandRevpar - currentLuminaRevpar;
    annualPricingOpportunity = diff > 0 ? Math.round(diff * 365) : 0;
    if (currentLuminaAdr !== null && bestBandLo !== null && bestBandHi !== null) {
      if (currentLuminaAdr < bestBandLo)
        pricingVerdict = `現行価格 ¥${currentLuminaAdr.toLocaleString("ja-JP")} は最良価格帯(¥${Math.round(bestBandLo / 1000)}k–${Math.round(bestBandHi / 1000)}k)より低め。値上げ余地があります。`;
      else if (currentLuminaAdr > bestBandHi)
        pricingVerdict = `現行価格 ¥${currentLuminaAdr.toLocaleString("ja-JP")} は最良価格帯(¥${Math.round(bestBandLo / 1000)}k–${Math.round(bestBandHi / 1000)}k)より高め。稼働とのバランス確認を。`;
      else
        pricingVerdict = `現行価格は最良RevPAR価格帯に収まっています。価格より設備・評価の強化が収益改善の主軸です。`;
    }
  } else {
    pricingVerdict = "自物件の稼働率が未設定のため、価格帯との収益比較ができません。設定画面で稼働率を登録してください。";
  }

  return {
    available: true,
    sampleSize: n,
    r2: Math.round(r2 * 1000) / 1000,
    medianAdr,
    predictedLuminaAdr,
    currentLuminaAdr,
    priceGapPct,
    featureEffects,
    comparableCount,
    compBasis,
    priceBands,
    bestBandLo,
    bestBandHi,
    bestBandRevpar,
    currentLuminaRevpar,
    valueDriverGaps,
    annualPricingOpportunity,
    pricingVerdict,
    luminaTitle,
  };
}
