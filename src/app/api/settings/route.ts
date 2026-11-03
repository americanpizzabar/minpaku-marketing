import { NextRequest, NextResponse } from "next/server";
import {
  getSyncConfig,
  refreshLuminaRates,
  refreshLuminaSpecs,
  saveSyncConfig,
  COST_PER_RATES_CALL,
  COST_PER_SEARCH_CALL,
  ALL_AREAS,
} from "@/lib/airroi";
import { KPI_CARD_DEFS } from "@/lib/kpi-cards";
import { TABLE_COLUMN_IDS } from "@/lib/table-columns";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 現在のデータ取得設定と、その設定での推定月額コストを返す。
 * CRON_SECRET付き (`key`) の場合はクエリパラメータでの設定保存にも対応 (リモート管理用)。
 */
export async function GET(request: NextRequest) {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ configured: false, message: "デモモードのため設定はありません" });
  }
  await ensureSchema(db);

  const params = request.nextUrl.searchParams;
  const secret = process.env.CRON_SECRET;
  if (secret && params.get("key") === secret) {
    const numParam = (name: string, min: number, max: number): number | undefined => {
      const v = params.get(name);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) return undefined;
      return Math.max(min, Math.min(max, Math.round(n)));
    };
    const floatParam = (name: string, min: number, max: number): number | null | undefined => {
      const v = params.get(name);
      if (v === null) return undefined;
      if (v === "" || v === "none") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    const autoSyncParam = params.get("autoSync");
    await saveSyncConfig(db, {
      autoSync: autoSyncParam === null ? undefined : autoSyncParam !== "0",
      ratesRefreshDays: numParam("ratesRefreshDays", 1, 90),
      searchRefreshDays: numParam("searchRefreshDays", 7, 365),
      dailyRatesCalls: numParam("dailyRatesCalls", 0, 1000),
      luminaListingId: params.get("luminaListingId")?.replace(/\D/g, "") || undefined,
      luminaBasePrice: numParam("luminaBasePrice", 0, 10_000_000),
      luminaBedrooms: numParam("luminaBedrooms", 1, 20),
      luminaMaxGuests: numParam("luminaMaxGuests", 1, 50),
      luminaOccupancy:
        params.get("luminaOccupancy") === "none" ? null : numParam("luminaOccupancy", 0, 100),
      luminaLat: floatParam("luminaLat", 20, 46),
      luminaLng: floatParam("luminaLng", 122, 154),
      dataMode:
        params.get("dataMode") === "actual"
          ? "actual"
          : params.get("dataMode") === "calendar"
            ? "calendar"
            : undefined,
      ratesSubsetSize: numParam("ratesSubsetSize", 0, 1000),
    });
    const cols = params.get("tableColumns");
    if (cols !== null) {
      await saveSyncConfig(db, {
        tableColumns: cols.split(",").map((s) => s.trim()).filter((id) => TABLE_COLUMN_IDS.includes(id)),
      });
    }
    if (params.get("luminaListingId") !== null || params.get("luminaBasePrice") !== null) {
      await db.execute("DELETE FROM sync_state WHERE key = 'lumina_rates_at'");
    }
  }

  const config = await getSyncConfig(db);
  const countRes = await db.execute(
    "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
  );
  const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
  const costEstimate = estimateCosts(trackedProperties, config);
  return NextResponse.json({
    configured: true,
    config,
    trackedProperties,
    costEstimate,
    estimatedMonthlyCostUsd: costEstimate.autoSync ? costEstimate.monthlyIfAutoUsd : 0,
  });
}

/** 設定を保存する (Webアプリの設定パネルから呼び出し) */
export async function POST(request: NextRequest) {
  const db = getDb();
  if (!db) {
    return NextResponse.json(
      { error: "デモモードのため設定を保存できません (Turso DB未設定)" },
      { status: 400 },
    );
  }
  await ensureSchema(db);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  // 「自物件スペックを自動取得」: AirROI の単一リスティング詳細から取得して config に保存する
  if (body.action === "fetchLuminaSpecs") {
    const cfg = await getSyncConfig(db);
    if (!cfg.luminaListingId) {
      return NextResponse.json(
        { error: "先に自物件のAirbnbリスティングIDを保存してください。" },
        { status: 400 },
      );
    }
    const result = await refreshLuminaSpecs(db, cfg);
    const newConfig = await getSyncConfig(db);
    const countRes = await db.execute(
      "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
    );
    const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
    const costEstimate = estimateCosts(trackedProperties, newConfig);
    return NextResponse.json(
      {
        saved: result.ok,
        message: result.message,
        error: result.ok ? undefined : result.message,
        notFound: result.notFound ?? false,
        fetched: result.fetched,
        config: newConfig,
        trackedProperties,
        costEstimate,
        estimatedMonthlyCostUsd: costEstimate.autoSync ? costEstimate.monthlyIfAutoUsd : 0,
      },
      // 未収録(404)はサーバー障害ではなくデータ不在なので 200 で返し、UIで案内する
      { status: result.ok || result.notFound ? 200 : 502 },
    );
  }

  const numField = (v: unknown, min: number, max: number): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  // 緯度・経度用: 小数を丸めず、空文字/nullは「未設定に戻す」として扱う
  const floatField = (v: unknown, min: number, max: number): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

  const luminaListingId =
    typeof body.luminaListingId === "string"
      ? body.luminaListingId.trim().replace(/\D/g, "")
      : undefined;

  const prevConfig = await getSyncConfig(db);

  await saveSyncConfig(db, {
    autoSync: typeof body.autoSync === "boolean" ? body.autoSync : undefined,
    ratesRefreshDays: numField(body.ratesRefreshDays, 1, 90),
    searchRefreshDays: numField(body.searchRefreshDays, 7, 365),
    dailyRatesCalls: numField(body.dailyRatesCalls, 0, 1000),
    luminaListingId,
    luminaBasePrice: numField(body.luminaBasePrice, 0, 10_000_000),
    luminaBedrooms: numField(body.luminaBedrooms, 1, 20),
    luminaMaxGuests: numField(body.luminaMaxGuests, 1, 50),
    luminaOccupancy:
      "luminaOccupancy" in body
        ? body.luminaOccupancy === null || body.luminaOccupancy === ""
          ? null
          : numField(body.luminaOccupancy, 0, 100)
        : undefined,
    luminaLat: floatField(body.luminaLat, 20, 46),
    luminaLng: floatField(body.luminaLng, 122, 154),
    luminaRating:
      "luminaRating" in body
        ? body.luminaRating === null || body.luminaRating === ""
          ? null
          : Math.max(0, Math.min(5, Number(body.luminaRating) || 0)) || null
        : undefined,
    luminaReviews:
      "luminaReviews" in body
        ? body.luminaReviews === null || body.luminaReviews === ""
          ? null
          : numField(body.luminaReviews, 0, 100000) ?? null
        : undefined,
    luminaPhotos:
      "luminaPhotos" in body
        ? body.luminaPhotos === null || body.luminaPhotos === ""
          ? null
          : numField(body.luminaPhotos, 0, 500) ?? null
        : undefined,
    luminaSuperhost:
      "luminaSuperhost" in body
        ? typeof body.luminaSuperhost === "boolean"
          ? body.luminaSuperhost
          : null
        : undefined,
    luminaAmenities:
      "luminaAmenities" in body
        ? typeof body.luminaAmenities === "string"
          ? body.luminaAmenities.split(",").map((s) => s.trim()).filter(Boolean)
          : Array.isArray(body.luminaAmenities)
            ? (body.luminaAmenities as unknown[]).map(String).map((s) => s.trim()).filter(Boolean)
            : undefined
        : undefined,
    kpiCards: Array.isArray(body.kpiCards)
      ? (body.kpiCards as unknown[])
          .map(String)
          .filter((id) => KPI_CARD_DEFS.some((d) => d.id === id))
      : undefined,
    tableColumns: Array.isArray(body.tableColumns)
      ? (body.tableColumns as unknown[]).map(String).filter((id) => TABLE_COLUMN_IDS.includes(id))
      : undefined,
    dataMode:
      body.dataMode === "actual" ? "actual" : body.dataMode === "calendar" ? "calendar" : undefined,
    ratesSubsetSize: numField(body.ratesSubsetSize, 0, 1000),
  });

  let config = await getSyncConfig(db);

  // リスティングID・基準価格が変わった場合はその場でベンチマークを再生成し、
  // 保存直後のページ再読み込みでグラフに即時反映されるようにする
  if (
    config.luminaListingId !== prevConfig.luminaListingId ||
    config.luminaBasePrice !== prevConfig.luminaBasePrice
  ) {
    try {
      await refreshLuminaRates(db, config);
    } catch (err) {
      console.error("設定保存後のLuminaベンチマーク再生成に失敗:", err);
    }
  }

  // リスティングIDが新規登録・変更された場合は自物件スペックも自動取得する
  // (手動入力を尊重するため refreshLuminaSpecs 側で未設定項目のみ補完)
  if (config.luminaListingId && config.luminaListingId !== prevConfig.luminaListingId) {
    try {
      await refreshLuminaSpecs(db, config);
      config = await getSyncConfig(db);
    } catch (err) {
      console.error("設定保存後の自物件スペック取得に失敗:", err);
    }
  }
  const countRes = await db.execute(
    "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
  );
  const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
  const costEstimate = estimateCosts(trackedProperties, config);
  return NextResponse.json({
    saved: true,
    config,
    trackedProperties,
    costEstimate,
    estimatedMonthlyCostUsd: costEstimate.autoSync ? costEstimate.monthlyIfAutoUsd : 0,
  });
}

interface CostEstimate {
  autoSync: boolean;
  /** カタログ全更新1回のコスト (検索$0.50 × 全エリアの最大ページ数) */
  catalogRefreshUsd: number;
  /** 料金カレンダー更新1回(手動)のコスト (dailyRatesCalls件 + 自物件) */
  ratesSyncUsd: number;
  /** 自動同期ON時の推定月額 (カタログ + 料金) */
  monthlyIfAutoUsd: number;
}

function estimateCosts(
  trackedProperties: number,
  config: {
    autoSync: boolean;
    ratesRefreshDays: number;
    searchRefreshDays: number;
    dailyRatesCalls: number;
    dataMode: "actual" | "calendar";
    ratesSubsetSize: number;
  },
): CostEstimate {
  const round = (v: number) => Math.round(v * 100) / 100;
  // カタログ(検索)は全エリアを取得: エリアごとに最大 (物件上限100 ÷ ページ10)=10ページ
  const searchesPerRefresh = ALL_AREAS.length * 10;
  const catalogRefreshUsd = round(searchesPerRefresh * COST_PER_SEARCH_CALL);

  // 1回の料金更新で取得する対象 (手動更新は dailyRatesCalls が上限)
  const ratesTargetsTotal =
    config.dataMode === "actual"
      ? Math.min(config.ratesSubsetSize, trackedProperties) + 1 // +1 = 自物件
      : trackedProperties + 1;
  const ratesPerSync = Math.min(config.dailyRatesCalls + 1, ratesTargetsTotal);
  const ratesSyncUsd = round(ratesPerSync * COST_PER_RATES_CALL);

  // 自動同期ON時の月額: 料金は周期ごとに対象全件、カタログは searchRefreshDays ごとに1回
  const ratesPerMonth = (ratesTargetsTotal / Math.max(config.ratesRefreshDays, 1)) * 30;
  const searchPerMonth = (searchesPerRefresh / Math.max(config.searchRefreshDays, 1)) * 30;
  const monthlyIfAutoUsd = round(
    ratesPerMonth * COST_PER_RATES_CALL + searchPerMonth * COST_PER_SEARCH_CALL,
  );

  return { autoSync: config.autoSync, catalogRefreshUsd, ratesSyncUsd, monthlyIfAutoUsd };
}
