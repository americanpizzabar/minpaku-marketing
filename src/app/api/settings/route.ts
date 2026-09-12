import { NextRequest, NextResponse } from "next/server";
import {
  getSyncConfig,
  refreshLuminaRates,
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
  return NextResponse.json({
    configured: true,
    config,
    trackedProperties,
    estimatedMonthlyCostUsd: estimateMonthlyCost(trackedProperties, config),
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

  const config = await getSyncConfig(db);

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
  const countRes = await db.execute(
    "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
  );
  const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
  return NextResponse.json({
    saved: true,
    config,
    trackedProperties,
    estimatedMonthlyCostUsd: estimateMonthlyCost(trackedProperties, config),
  });
}

function estimateMonthlyCost(
  trackedProperties: number,
  config: {
    autoSync: boolean;
    ratesRefreshDays: number;
    searchRefreshDays: number;
    dataMode: "actual" | "calendar";
    ratesSubsetSize: number;
  },
): number {
  if (!config.autoSync) return 0;
  // actualモードは自物件＋近似競合の一部のみカレンダー取得、calendarは全物件
  const ratesTargets =
    config.dataMode === "actual"
      ? Math.min(config.ratesSubsetSize, trackedProperties) + 1 // +1 = 自物件
      : trackedProperties + 1;
  const ratesPerMonth = (ratesTargets / Math.max(config.ratesRefreshDays, 1)) * 30;
  // カタログ(検索)は全物件を取得: エリアごとに (物件上限 ÷ ページサイズ10) 回
  const searchesPerRefresh = ALL_AREAS.length * 10;
  const searchPerMonth = (searchesPerRefresh / Math.max(config.searchRefreshDays, 1)) * 30;
  return (
    Math.round(
      (ratesPerMonth * COST_PER_RATES_CALL + searchPerMonth * COST_PER_SEARCH_CALL) * 100,
    ) / 100
  );
}
