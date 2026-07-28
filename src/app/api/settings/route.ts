import { NextRequest, NextResponse } from "next/server";
import { getSyncConfig, saveSyncConfig, COST_PER_RATES_CALL, COST_PER_SEARCH_CALL, ALL_AREAS } from "@/lib/airroi";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** 現在のデータ取得設定と、その設定での推定月額コストを返す */
export async function GET() {
  const db = getDb();
  if (!db) {
    return NextResponse.json({ configured: false, message: "デモモードのため設定はありません" });
  }
  await ensureSchema(db);
  const config = await getSyncConfig(db);
  const countRes = await db.execute(
    "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
  );
  const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
  return NextResponse.json({
    configured: true,
    config,
    trackedProperties,
    estimatedMonthlyCostUsd: estimateMonthlyCost(
      trackedProperties,
      config.ratesRefreshDays,
      config.searchRefreshDays,
      config.autoSync,
    ),
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

  const luminaListingId =
    typeof body.luminaListingId === "string"
      ? body.luminaListingId.trim().replace(/\D/g, "")
      : undefined;

  await saveSyncConfig(db, {
    autoSync: typeof body.autoSync === "boolean" ? body.autoSync : undefined,
    ratesRefreshDays: numField(body.ratesRefreshDays, 1, 90),
    searchRefreshDays: numField(body.searchRefreshDays, 7, 365),
    dailyRatesCalls: numField(body.dailyRatesCalls, 0, 1000),
    luminaListingId,
  });

  const config = await getSyncConfig(db);
  const countRes = await db.execute(
    "SELECT COUNT(*) AS c FROM properties WHERE id LIKE 'airroi_%'",
  );
  const trackedProperties = Number(countRes.rows[0]?.c ?? 0);
  return NextResponse.json({
    saved: true,
    config,
    trackedProperties,
    estimatedMonthlyCostUsd: estimateMonthlyCost(
      trackedProperties,
      config.ratesRefreshDays,
      config.searchRefreshDays,
      config.autoSync,
    ),
  });
}

function estimateMonthlyCost(
  trackedProperties: number,
  ratesRefreshDays: number,
  searchRefreshDays: number,
  autoSync: boolean,
): number {
  if (!autoSync) return 0;
  // 料金カレンダー: 物件数 ÷ 更新周期 × 30日分 + 自物件1件
  const ratesPerMonth = (trackedProperties / Math.max(ratesRefreshDays, 1)) * 30 + 30 / Math.max(ratesRefreshDays, 1);
  // カタログ: エリアごとに (物件上限 ÷ ページサイズ10) 回の検索を周期ごとに実行
  const searchesPerRefresh = ALL_AREAS.length * 10;
  const searchPerMonth = (searchesPerRefresh / Math.max(searchRefreshDays, 1)) * 30;
  return (
    Math.round(
      (ratesPerMonth * COST_PER_RATES_CALL + searchPerMonth * COST_PER_SEARCH_CALL) * 100,
    ) / 100
  );
}
