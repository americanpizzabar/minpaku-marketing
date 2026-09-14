import { getDashboardData } from "./analytics";
import { getSyncConfig } from "./airroi";
import { getDb } from "./db";
import type { Filters, PropertyRow } from "./types";

export interface MetricComparison {
  key: string;
  label: string;
  unit: "yen" | "pct" | "num" | "nights" | "star";
  winner: number | null; // 勝ち組平均
  market: number | null; // 市場平均
  lumina: number | null; // 自物件
  higherIsBetter: boolean;
  behind: boolean; // 自物件が勝ち組に劣後しているか
}

export interface AmenityGap {
  name: string;
  winnerPct: number; // 勝ち組の保有率 (%)
  luminaHas: boolean;
}

export interface Recommendation {
  priority: "high" | "mid" | "low";
  title: string;
  detail: string;
}

export interface WinnerRow {
  title: string;
  area: string;
  adr: number;
  occ: number;
  revpar: number;
  rating: number | null;
  maxGuests: number;
  bedrooms: number;
  url: string | null;
}

export interface CompetitiveAnalysis {
  available: boolean;
  reason?: string;
  totalCount: number;
  winnerCount: number;
  criteria: string;
  adrThreshold: number;
  occThreshold: number;
  winners: WinnerRow[];
  metrics: MetricComparison[];
  amenityGaps: AmenityGap[];
  recommendations: Recommendation[];
  luminaSpecKnown: boolean;
  luminaTitle: string;
}

function pctile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}
function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
function rate(items: (boolean | null)[]): number | null {
  const known = items.filter((v) => v !== null) as boolean[];
  if (known.length === 0) return null;
  return Math.round((known.filter(Boolean).length / known.length) * 1000) / 10;
}
function normAmenity(s: string): string {
  return s.toLowerCase().replace(/[\s_・（）()]/g, "");
}

export async function getCompetitiveAnalysis(filters: Filters): Promise<CompetitiveAnalysis> {
  const data = await getDashboardData(filters);
  const rows = data.rows;
  const db = getDb();
  const config = db ? await getSyncConfig(db) : null;
  const luminaTitle = "Lumina Fuji";

  const empty = (reason: string): CompetitiveAnalysis => ({
    available: false,
    reason,
    totalCount: rows.length,
    winnerCount: 0,
    criteria: "",
    adrThreshold: 0,
    occThreshold: 0,
    winners: [],
    metrics: [],
    amenityGaps: [],
    recommendations: [],
    luminaSpecKnown: false,
    luminaTitle,
  });

  if (rows.length < 8) {
    return empty("分析に十分な競合物件データがありません (8物件以上が必要)。フィルタを緩めるか、データ同期後にお試しください。");
  }

  // --- 勝ち組の定義: ADR上位30% かつ 稼働率が中央値以上 (高単価×高稼働) ---
  const adrSorted = rows.map((r) => r.adr).sort((a, b) => a - b);
  const occSorted = rows.map((r) => r.occupancyRate).sort((a, b) => a - b);
  let adrThreshold = pctile(adrSorted, 70);
  const occThreshold = pctile(occSorted, 50);
  let winnerRows = rows.filter(
    (r) => r.adr >= adrThreshold && r.occupancyRate >= occThreshold && r.occupancyRate > 0,
  );
  // 少なすぎる場合は基準を緩める
  if (winnerRows.length < 3) {
    adrThreshold = pctile(adrSorted, 50);
    winnerRows = rows.filter(
      (r) => r.adr >= adrThreshold && r.occupancyRate >= occThreshold && r.occupancyRate > 0,
    );
  }
  if (winnerRows.length < 3) {
    return empty("高単価かつ高稼働の『勝ち組』物件を十分に抽出できませんでした。");
  }
  // RevPAR降順で並べる
  const withRevpar = winnerRows
    .map((r) => ({ r, revpar: (r.adr * r.occupancyRate) / 100 }))
    .sort((a, b) => b.revpar - a.revpar);

  const winners: WinnerRow[] = withRevpar.slice(0, 15).map(({ r, revpar }) => ({
    title: r.title,
    area: r.area,
    adr: r.adr,
    occ: r.occupancyRate,
    revpar: Math.round(revpar),
    rating: r.rating,
    maxGuests: r.maxGuests,
    bedrooms: r.bedrooms,
    url: r.url,
  }));

  // --- 詳細 (details_json) から設備・写真枚数・評価内訳を集計 ---
  const winnerIds = winnerRows.map((r) => r.id);
  const amenityCount = new Map<string, { display: string; count: number }>();
  const winnerPhotos: number[] = [];
  let winnersWithDetails = 0;
  if (db) {
    try {
      const placeholders = winnerIds.map(() => "?").join(",");
      const res = await db.execute({
        sql: `SELECT id, details_json FROM properties WHERE id IN (${placeholders})`,
        args: winnerIds,
      });
      for (const row of res.rows) {
        if (!row.details_json) continue;
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(String(row.details_json)) as Record<string, unknown>;
        } catch {
          continue;
        }
        // 1階層フラット化 (listing_info / property_details など)
        const flat: Record<string, unknown> = { ...raw };
        for (const v of Object.values(raw)) {
          if (typeof v === "object" && v !== null && !Array.isArray(v)) Object.assign(flat, v);
        }
        winnersWithDetails += 1;
        const photos = Number(flat.photos_count);
        if (Number.isFinite(photos) && photos > 0) winnerPhotos.push(photos);
        const amen = Array.isArray(flat.amenities) ? (flat.amenities as unknown[]) : [];
        const seen = new Set<string>();
        for (const a of amen) {
          const disp = String(a).trim();
          if (!disp) continue;
          const key = normAmenity(disp);
          if (seen.has(key)) continue;
          seen.add(key);
          const cur = amenityCount.get(key);
          if (cur) cur.count += 1;
          else amenityCount.set(key, { display: disp, count: 1 });
        }
      }
    } catch {
      // details取得失敗時は設備分析をスキップ
    }
  }

  // --- 自物件スペック ---
  const luminaAdr = data.kpisLumina.adr || (config?.luminaBasePrice ?? 0);
  const luminaOcc = data.kpisLumina.occupancyRate * 100; // 0-100
  const luminaAmenNorm = new Set((config?.luminaAmenities ?? []).map(normAmenity));
  const luminaSpecKnown = Boolean(
    config &&
      (config.luminaRating !== null ||
        config.luminaReviews !== null ||
        config.luminaPhotos !== null ||
        config.luminaAmenities.length > 0),
  );

  // --- 指標比較 (勝ち組平均 / 市場平均 / 自物件) ---
  const winnerAvg = (sel: (r: PropertyRow) => number | null): number | null => {
    const vals = winnerRows.map(sel).filter((v): v is number => v !== null);
    return vals.length ? Math.round(avg(vals) * 10) / 10 : null;
  };
  const marketAvg = (sel: (r: PropertyRow) => number | null): number | null => {
    const vals = rows.map(sel).filter((v): v is number => v !== null);
    return vals.length ? Math.round(avg(vals) * 10) / 10 : null;
  };

  const mk = (
    key: string,
    label: string,
    unit: MetricComparison["unit"],
    sel: (r: PropertyRow) => number | null,
    lumina: number | null,
    higherIsBetter = true,
  ): MetricComparison => {
    const winner = winnerAvg(sel);
    const market = marketAvg(sel);
    const behind =
      lumina !== null && winner !== null
        ? higherIsBetter
          ? lumina < winner
          : lumina > winner
        : false;
    return { key, label, unit, winner, market, lumina, higherIsBetter, behind };
  };

  const superhostWinner = rate(winnerRows.map((r) => r.superhost));
  const superhostMarket = rate(rows.map((r) => r.superhost));
  const instantWinner = rate(winnerRows.map((r) => r.instantBook));
  const guestFavWinner = rate(winnerRows.map((r) => r.guestFavorite));

  const metrics: MetricComparison[] = [
    mk("adr", "ADR (平均単価)", "yen", (r) => r.adr, luminaAdr || null),
    mk("occ", "稼働率", "pct", (r) => r.occupancyRate, luminaOcc || null),
    mk("revpar", "RevPAR", "yen", (r) => (r.adr * r.occupancyRate) / 100, luminaAdr && luminaOcc ? Math.round((luminaAdr * luminaOcc) / 100) : null),
    mk("rating", "評価 (★)", "star", (r) => r.rating, config?.luminaRating ?? null),
    mk("reviews", "レビュー数", "num", (r) => r.reviewsCount, config?.luminaReviews ?? null),
    mk("photos", "写真枚数", "num", () => null, config?.luminaPhotos ?? null),
    mk("maxGuests", "定員", "num", (r) => r.maxGuests, config?.luminaMaxGuests ?? null),
    mk("bedrooms", "寝室数", "num", (r) => r.bedrooms, config?.luminaBedrooms ?? null),
    mk("beds", "ベッド数", "num", (r) => r.beds, null),
    mk("cleaningFee", "清掃料", "yen", (r) => r.cleaningFee, null, false),
    mk("minNights", "最低泊数", "nights", (r) => r.minNights, null, false),
  ];
  // 写真枚数の勝ち組平均は details から
  const photosMetric = metrics.find((m) => m.key === "photos");
  if (photosMetric) {
    photosMetric.winner = winnerPhotos.length ? Math.round(avg(winnerPhotos)) : null;
    photosMetric.behind =
      photosMetric.lumina !== null && photosMetric.winner !== null
        ? photosMetric.lumina < photosMetric.winner
        : false;
  }
  // スーパーホスト率 (別枠、割合指標)
  metrics.push({
    key: "superhost",
    label: "スーパーホスト率",
    unit: "pct",
    winner: superhostWinner,
    market: superhostMarket,
    lumina: config?.luminaSuperhost === null || config?.luminaSuperhost === undefined ? null : config.luminaSuperhost ? 100 : 0,
    higherIsBetter: true,
    behind:
      config?.luminaSuperhost === false && superhostWinner !== null && superhostWinner > 50,
  });

  // --- 設備ギャップ (勝ち組の高頻度設備で、自物件が保有していないもの) ---
  const amenityGaps: AmenityGap[] = [...amenityCount.values()]
    .map((a) => ({
      name: a.display,
      winnerPct: winnersWithDetails ? Math.round((a.count / winnersWithDetails) * 100) : 0,
      luminaHas: [...luminaAmenNorm].some(
        (la) => la && (normAmenity(a.display).includes(la) || la.includes(normAmenity(a.display))),
      ),
    }))
    .filter((a) => a.winnerPct >= 30) // 勝ち組の3割以上が持つ設備
    .sort((a, b) => b.winnerPct - a.winnerPct)
    .slice(0, 20);

  // --- 提言の自動生成 ---
  const recommendations: Recommendation[] = [];
  const push = (priority: Recommendation["priority"], title: string, detail: string) =>
    recommendations.push({ priority, title, detail });

  const m = (k: string) => metrics.find((x) => x.key === k);
  const adrM = m("adr");
  const occM = m("occ");
  if (occM?.behind && occM.winner && occM.lumina !== null) {
    push(
      "high",
      `稼働率が勝ち組に${(occM.winner - occM.lumina).toFixed(1)}pt不足`,
      `勝ち組平均 ${occM.winner}% に対し自物件は ${occM.lumina}%。価格を下げずに埋めるには、下の設備・評価・写真の改善で「選ばれる理由」を強化するのが先決です。`,
    );
  }
  if (adrM && adrM.winner && adrM.lumina !== null && adrM.lumina < adrM.winner && !occM?.behind) {
    push(
      "mid",
      `単価に${Math.round(adrM.winner - adrM.lumina).toLocaleString("ja-JP")}円の上げ余地`,
      `高稼働を維持できているなら、勝ち組平均 ¥${adrM.winner.toLocaleString("ja-JP")} まで段階的に値上げする余地があります。繁忙期・休前日から試すのが安全です。`,
    );
  }
  const ratingM = m("rating");
  if (config?.luminaRating == null) {
    push("high", "評価スコアが未登録", "設定画面で自物件の評価(★)を登録すると、勝ち組との差が可視化されます。勝ち組は高評価が稼働を支えています。");
  } else if (ratingM?.behind && ratingM.winner) {
    push("high", `評価が勝ち組(★${ratingM.winner})に及ばない`, `清潔さ・立地案内・コミュニケーションの徹底で★を底上げ。レビュー依頼の仕組み化も有効です。`);
  }
  const reviewsM = m("reviews");
  if (reviewsM?.behind && reviewsM.winner && reviewsM.lumina !== null) {
    push("mid", `レビュー数が勝ち組平均(${reviewsM.winner}件)より少ない`, `社会的証明が予約率を左右します。チェックアウト後の自動レビュー依頼、初期は割引でレビュー獲得を加速。`);
  }
  const photosM = m("photos");
  if (photosM?.behind && photosM.winner && photosM.lumina !== null) {
    push("mid", `写真が勝ち組平均(${photosM.winner}枚)より少ない`, `プロ撮影で30〜40枚以上に拡充。富士山ビュー・内装・アメニティ・夜景を網羅すると検索面のCTRが上がります。`);
  }
  if (config?.luminaSuperhost === false) {
    const sh = metrics.find((x) => x.key === "superhost");
    if (sh?.winner && sh.winner > 50) push("mid", `勝ち組の${sh.winner}%がスーパーホスト`, "応答率・キャンセル率・★4.8以上の維持でスーパーホスト獲得を目指すと、掲載順位と信頼が向上します。");
  }
  // 設備ギャップの上位を提言化
  const topGaps = amenityGaps.filter((a) => !a.luminaHas).slice(0, 5);
  for (const g of topGaps) {
    push(
      g.winnerPct >= 60 ? "high" : "mid",
      `設備「${g.name}」の導入検討`,
      `勝ち組の${g.winnerPct}%が保有。自物件は未登録/未保有のため、導入すれば差別化と単価維持につながります。`,
    );
  }
  if (recommendations.length === 0) {
    push("low", "現状は勝ち組と大きな差はありません", "主要指標で目立った劣後はありません。設定画面で自物件のスペック(評価・レビュー・写真・設備)を登録すると、より精緻な比較ができます。");
  }
  // 優先度順
  const order = { high: 0, mid: 1, low: 2 };
  recommendations.sort((a, b) => order[a.priority] - order[b.priority]);

  return {
    available: true,
    totalCount: rows.length,
    winnerCount: winnerRows.length,
    criteria: `ADR ¥${Math.round(adrThreshold).toLocaleString("ja-JP")}以上 かつ 稼働率 ${occThreshold.toFixed(0)}%以上`,
    adrThreshold: Math.round(adrThreshold),
    occThreshold: Math.round(occThreshold),
    winners,
    metrics,
    amenityGaps,
    recommendations,
    luminaSpecKnown,
    luminaTitle,
  };
}
