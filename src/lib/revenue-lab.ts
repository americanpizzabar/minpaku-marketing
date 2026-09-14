import { getDashboardData } from "./analytics";
import { getSyncConfig } from "./airroi";
import { getDb } from "./db";
import { LUMINA_PROFILE } from "./demo-data";
import { AREAS, type Filters, type PropertyRow } from "./types";

/**
 * 収益最適化ラボ — レベニューマネジメント/計量経済学に基づく高度分析。
 *  1. ヘドニック価格回帰 (Ridge多重回帰): スペック→適正ADRを推定し、各機能の金額価値を算出
 *  2. 価格弾力性の推定と RevPAR 最大化価格の数理最適化
 *  3. アメニティの収益貢献 (RevPAR差分)
 *  4. 年間収益機会の定量化
 */

export interface FeatureValue {
  key: string;
  label: string;
  coefYen: number; // 1単位(0/1機能は保有)あたりの推定ADR寄与 (円)
  kind: "spec" | "amenity" | "area";
  luminaHas: boolean | null; // 0/1機能で自物件が保有しているか
}

export interface ElasticityPoint {
  price: number;
  occ: number; // 0-100
  revpar: number;
}

export interface AmenityUplift {
  name: string;
  upliftRevpar: number; // 保有/非保有の平均RevPAR差
  adoption: number; // 市場保有率 %
  luminaHas: boolean;
}

export interface RevenueLab {
  available: boolean;
  reason?: string;
  sampleSize: number;
  // ヘドニック回帰
  r2: number;
  predictedLuminaAdr: number | null; // モデルが示す適正ADR
  currentLuminaAdr: number | null;
  priceGap: number | null; // predicted - current (正=値上げ余地)
  featureValues: FeatureValue[];
  // 価格弾力性・最適化
  elasticity: number | null; // 価格弾力性 (%変化/%変化)
  elasticityCurve: ElasticityPoint[];
  optimalPrice: number | null;
  optimalRevpar: number | null;
  currentRevpar: number | null;
  comparableCount: number;
  // アメニティROI
  amenityUplift: AmenityUplift[];
  // 収益機会
  annualPricingOpportunity: number | null; // 価格最適化による年間増収 (円)
  annualAmenityOpportunity: number | null; // 未保有トップ設備導入の年間増収余地 (円)
  luminaTitle: string;
}

// ---------- 線形代数 (Ridge回帰用) ----------
function transpose(m: number[][]): number[][] {
  return m[0].map((_, j) => m.map((row) => row[j]));
}
function matmul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0].length;
  const k = b.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let t = 0; t < k; t++) s += a[i][t] * b[t][j];
      out[i][j] = s;
    }
  return out;
}
/** ガウス・ジョルダン法で A x = b を解く */
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

interface FeatureSpec {
  key: string;
  label: string;
  kind: "spec" | "amenity" | "area";
  value: (r: PropertyRow, amen: Set<string>) => number;
  luminaValue: number;
  luminaHas: boolean | null;
}

function normAmenity(s: string): string {
  return s.toLowerCase().replace(/[\s_・（）()]/g, "");
}

export async function getRevenueLab(filters: Filters): Promise<RevenueLab> {
  const data = await getDashboardData(filters);
  const rows = data.rows.filter((r) => r.adr > 0);
  const db = getDb();
  const config = db ? await getSyncConfig(db) : null;
  const luminaTitle = "Lumina Fuji";

  const fail = (reason: string): RevenueLab => ({
    available: false,
    reason,
    sampleSize: rows.length,
    r2: 0,
    predictedLuminaAdr: null,
    currentLuminaAdr: null,
    priceGap: null,
    featureValues: [],
    elasticity: null,
    elasticityCurve: [],
    optimalPrice: null,
    optimalRevpar: null,
    currentRevpar: null,
    comparableCount: 0,
    amenityUplift: [],
    annualPricingOpportunity: null,
    annualAmenityOpportunity: null,
    luminaTitle,
  });

  if (rows.length < 25) {
    return fail("回帰分析には25物件以上のデータが必要です。フィルタを緩めるか同期後にお試しください。");
  }

  // ---- アメニティを details_json から取得 (物件ID→設備集合) ----
  const amenByProp = new Map<string, Set<string>>();
  const amenFreq = new Map<string, { display: string; count: number }>();
  if (db) {
    try {
      const ids = rows.map((r) => r.id);
      // クエリ長対策で分割
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
                if (!disp) continue;
                const key = normAmenity(disp);
                set.add(key);
                if (!seen.has(key)) {
                  seen.add(key);
                  const cur = amenFreq.get(key);
                  if (cur) cur.count += 1;
                  else amenFreq.set(key, { display: disp, count: 1 });
                }
              }
            } catch {
              /* skip */
            }
          }
          amenByProp.set(String(row.id), set);
        }
      }
    } catch {
      /* 設備なしで続行 */
    }
  }

  const n = rows.length;
  // 情報量のあるアメニティ (保有率20-85%) を最大10個、回帰特徴に採用
  const topAmenities = [...amenFreq.values()]
    .map((a) => ({ ...a, adoption: a.count / n }))
    .filter((a) => a.adoption >= 0.2 && a.adoption <= 0.85)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const luminaAmenNorm = new Set((config?.luminaAmenities ?? []).map(normAmenity));
  const luminaHasAmenity = (disp: string): boolean =>
    [...luminaAmenNorm].some(
      (la) => la && (normAmenity(disp).includes(la) || la.includes(normAmenity(disp))),
    );

  // 中央値 (欠損補完・自物件欠損用)
  const median = (vals: number[]): number => {
    const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const ratingMed = median(rows.map((r) => r.rating ?? NaN));
  const reviewsMed = median(rows.map((r) => r.reviewsCount));
  const bathMed = median(rows.map((r) => r.bathrooms ?? NaN)) || 1;
  const luminaArea = LUMINA_PROFILE.area;

  // ---- 特徴量の定義 ----
  const specFeatures: FeatureSpec[] = [
    { key: "bedrooms", label: "寝室 +1室", kind: "spec", value: (r) => r.bedrooms, luminaValue: config?.luminaBedrooms ?? 4, luminaHas: null },
    { key: "maxGuests", label: "定員 +1名", kind: "spec", value: (r) => r.maxGuests, luminaValue: config?.luminaMaxGuests ?? 10, luminaHas: null },
    { key: "bathrooms", label: "バス +1", kind: "spec", value: (r) => r.bathrooms ?? bathMed, luminaValue: bathMed, luminaHas: null },
    { key: "rating", label: "評価 +1.0★", kind: "spec", value: (r) => r.rating ?? ratingMed, luminaValue: config?.luminaRating ?? ratingMed, luminaHas: null },
    { key: "logReviews", label: "レビュー数(対数)", kind: "spec", value: (r) => Math.log1p(r.reviewsCount), luminaValue: Math.log1p(config?.luminaReviews ?? reviewsMed), luminaHas: null },
    {
      key: "superhost",
      label: "スーパーホスト",
      kind: "spec",
      value: (r) => (r.superhost ? 1 : 0),
      luminaValue: config?.luminaSuperhost ? 1 : 0,
      luminaHas: config?.luminaSuperhost ?? null,
    },
  ];
  const amenityFeatures: FeatureSpec[] = topAmenities.map((a) => ({
    key: `am_${a.display}`,
    label: a.display,
    kind: "amenity" as const,
    value: (_r: PropertyRow, amen: Set<string>) => (amen.has(normAmenity(a.display)) ? 1 : 0),
    luminaValue: luminaHasAmenity(a.display) ? 1 : 0,
    luminaHas: luminaHasAmenity(a.display),
  }));
  // エリアダミー (最初のエリアを基準に除外)
  const areaFeatures: FeatureSpec[] = AREAS.slice(1).map((ar) => ({
    key: `area_${ar}`,
    label: ar,
    kind: "area" as const,
    value: (r) => (r.area === ar ? 1 : 0),
    luminaValue: luminaArea === ar ? 1 : 0,
    luminaHas: null,
  }));
  const features = [...specFeatures, ...amenityFeatures, ...areaFeatures];

  // ---- 特徴行列 X (標準化) と 目的変数 y=ADR ----
  const rawX = rows.map((r) => features.map((f) => f.value(r, amenByProp.get(r.id) ?? new Set())));
  const y = rows.map((r) => r.adr);
  const p = features.length;
  const means = new Array(p).fill(0);
  const sds = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    const col = rawX.map((row) => row[j]);
    const mu = col.reduce((a, b) => a + b, 0) / n;
    const varr = col.reduce((a, b) => a + (b - mu) ** 2, 0) / n;
    means[j] = mu;
    sds[j] = Math.sqrt(varr) || 1;
  }
  const Xs = rawX.map((row) => [1, ...row.map((v, j) => (v - means[j]) / sds[j])]); // 先頭は切片
  const yMean = y.reduce((a, b) => a + b, 0) / n;

  // Ridge: (XᵀX + λI) β = Xᵀy   (切片は非正則化)
  const Xt = transpose(Xs);
  const XtX = matmul(Xt, Xs);
  const lambda = 1.0;
  for (let i = 1; i < XtX.length; i++) XtX[i][i] += lambda;
  const Xty = Xt.map((row) => row.reduce((s, v, i) => s + v * y[i], 0));
  const beta = solve(XtX, Xty);
  if (!beta) return fail("回帰の計算に失敗しました (データの多重共線性)。");

  // R²
  const yhat = Xs.map((row) => row.reduce((s, v, j) => s + v * beta[j], 0));
  const ssRes = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;

  // 標準化係数→元スケール (円/単位) に変換して機能価値を提示
  const featureValues: FeatureValue[] = features.map((f, j) => ({
    key: f.key,
    label: f.label,
    coefYen: Math.round((beta[j + 1] / sds[j]) * (f.kind === "spec" && f.key !== "superhost" ? 1 : 1)),
    kind: f.kind,
    luminaHas: f.luminaHas,
  }));

  // 自物件の適正ADR予測
  const luminaRaw = features.map((f) => f.luminaValue);
  const luminaStd = [1, ...luminaRaw.map((v, j) => (v - means[j]) / sds[j])];
  const predictedLuminaAdr = Math.round(luminaStd.reduce((s, v, j) => s + v * beta[j], 0));
  const currentLuminaAdr = data.kpisLumina.adr || config?.luminaBasePrice || null;
  const priceGap = currentLuminaAdr ? predictedLuminaAdr - currentLuminaAdr : null;

  // ---- 価格弾力性 & RevPAR最大化 ----
  // 比較群: 定員が近い(±3) 物件 (エリアは全体、サンプル確保優先)
  const luGuests = config?.luminaMaxGuests ?? 10;
  let comps = rows.filter((r) => Math.abs(r.maxGuests - luGuests) <= 3 && r.occupancyRate > 0);
  if (comps.length < 15) comps = rows.filter((r) => r.occupancyRate > 0);
  const comparableCount = comps.length;

  let elasticity: number | null = null;
  let elasticityCurve: ElasticityPoint[] = [];
  let optimalPrice: number | null = null;
  let optimalRevpar: number | null = null;
  let currentRevpar: number | null = null;

  if (comps.length >= 15) {
    // occ(0-1) = a + b*price の単回帰
    const px = comps.map((r) => r.adr);
    const oc = comps.map((r) => r.occupancyRate / 100);
    const pMean = px.reduce((a, b) => a + b, 0) / px.length;
    const oMean = oc.reduce((a, b) => a + b, 0) / oc.length;
    let cov = 0;
    let varP = 0;
    for (let i = 0; i < px.length; i++) {
      cov += (px[i] - pMean) * (oc[i] - oMean);
      varP += (px[i] - pMean) ** 2;
    }
    const b = varP > 0 ? cov / varP : 0; // 通常は負
    const a = oMean - b * pMean;
    // 弾力性 (現在価格での点弾力性) = (dQ/dP)*(P/Q)
    const basePrice = currentLuminaAdr ?? pMean;
    const occAt = (pr: number) => Math.max(0.02, Math.min(0.98, a + b * pr));
    const q0 = occAt(basePrice);
    elasticity = q0 > 0 ? Math.round((b * (basePrice / q0)) * 100) / 100 : null;

    // 価格グリッドで RevPAR = price × occ を最大化
    const lo = Math.max(5000, Math.round((pMean * 0.5) / 1000) * 1000);
    const hi = Math.round((pMean * 2.0) / 1000) * 1000;
    const step = Math.max(1000, Math.round((hi - lo) / 40 / 500) * 500);
    let best = { price: lo, revpar: -1, occ: 0 };
    for (let pr = lo; pr <= hi; pr += step) {
      const occ = occAt(pr);
      const rp = pr * occ;
      elasticityCurve.push({ price: pr, occ: Math.round(occ * 1000) / 10, revpar: Math.round(rp) });
      if (rp > best.revpar) best = { price: pr, revpar: rp, occ };
    }
    optimalPrice = best.price;
    optimalRevpar = Math.round(best.revpar);
    if (currentLuminaAdr) currentRevpar = Math.round(currentLuminaAdr * occAt(currentLuminaAdr));
  }

  // ---- アメニティの収益貢献 (保有/非保有の平均RevPAR差) ----
  const revparOf = (r: PropertyRow) => (r.adr * r.occupancyRate) / 100;
  const amenityUplift: AmenityUplift[] = topAmenities
    .map((am) => {
      const withA: number[] = [];
      const without: number[] = [];
      for (const r of rows) {
        const has = (amenByProp.get(r.id) ?? new Set()).has(normAmenity(am.display));
        (has ? withA : without).push(revparOf(r));
      }
      const mw = withA.length ? withA.reduce((a, b) => a + b, 0) / withA.length : 0;
      const mo = without.length ? without.reduce((a, b) => a + b, 0) / without.length : 0;
      return {
        name: am.display,
        upliftRevpar: Math.round(mw - mo),
        adoption: Math.round(am.adoption * 100),
        luminaHas: luminaHasAmenity(am.display),
      };
    })
    .sort((a, b) => b.upliftRevpar - a.upliftRevpar);

  // ---- 年間収益機会 ----
  const annualPricingOpportunity =
    optimalRevpar !== null && currentRevpar !== null && optimalRevpar > currentRevpar
      ? Math.round((optimalRevpar - currentRevpar) * 365)
      : 0;
  // 未保有で正の貢献があるトップ3設備の RevPAR差 × 365 の 50% (保守的)
  const annualAmenityOpportunity = Math.round(
    amenityUplift
      .filter((a) => !a.luminaHas && a.upliftRevpar > 0)
      .slice(0, 3)
      .reduce((s, a) => s + a.upliftRevpar, 0) *
      365 *
      0.5,
  );

  return {
    available: true,
    sampleSize: n,
    r2: Math.round(r2 * 1000) / 1000,
    predictedLuminaAdr,
    currentLuminaAdr,
    priceGap,
    featureValues,
    elasticity,
    elasticityCurve,
    optimalPrice,
    optimalRevpar,
    currentRevpar,
    comparableCount,
    amenityUplift,
    annualPricingOpportunity,
    annualAmenityOpportunity,
    luminaTitle,
  };
}
