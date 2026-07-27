/**
 * Turso DB スキーマ作成スクリプト
 * 実行: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:migrate
 */
import { ensureSchema, getDb } from "../src/lib/db";

async function main() {
  const db = getDb();
  if (!db) {
    console.error("TURSO_DATABASE_URL が設定されていません。");
    process.exit(1);
  }
  await ensureSchema(db);
  console.log("✅ スキーマ作成が完了しました。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
