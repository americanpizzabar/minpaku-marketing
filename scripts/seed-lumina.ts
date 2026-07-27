/**
 * Lumina Fuji 自社物件の設定価格・稼働実績の初期データ投入スクリプト
 *
 * 実行: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npx tsx scripts/seed-lumina.ts
 *
 * デフォルトではデモ生成ロジック (季節・曜日係数入りの設定価格) を投入します。
 * 実運用では実際の設定価格・予約実績に合わせてこのスクリプトを書き換えるか、
 * lumina_fuji_metrics テーブルへ直接UPSERTしてください。
 */
import { ensureSchema, getDb } from "../src/lib/db";
import { generateDemoLuminaMetrics } from "../src/lib/demo-data";

async function main() {
  const db = getDb();
  if (!db) {
    console.error("TURSO_DATABASE_URL が設定されていません。");
    process.exit(1);
  }
  await ensureSchema(db);

  const rows = generateDemoLuminaMetrics();
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO lumina_fuji_metrics (target_date, configured_price, is_booked, actual_revenue)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(target_date) DO UPDATE SET
              configured_price=excluded.configured_price,
              is_booked=excluded.is_booked,
              actual_revenue=excluded.actual_revenue`,
      args: [r.targetDate, r.configuredPrice, r.isBooked ? 1 : 0, r.actualRevenue],
    });
  }
  console.log(`✅ lumina_fuji_metrics へ ${rows.length}件を投入しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
