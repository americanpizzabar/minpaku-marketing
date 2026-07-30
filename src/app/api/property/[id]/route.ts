import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 物件1件の全属性 (details_json 含む) を返す。
 * テーブルの「詳細」ボタンから呼び出され、AirROIが返す全フィールドを表示するために使う。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "デモモードのため詳細データはありません" }, { status: 404 });
  }
  await ensureSchema(db);

  const res = await db.execute({
    sql: "SELECT * FROM properties WHERE id = ?",
    args: [id],
  });
  if (res.rows.length === 0) {
    return NextResponse.json({ error: "物件が見つかりません" }, { status: 404 });
  }

  const row = res.rows[0] as Record<string, unknown>;
  let details: Record<string, unknown> | null = null;
  if (row.details_json) {
    try {
      details = JSON.parse(String(row.details_json)) as Record<string, unknown>;
    } catch {
      details = null;
    }
  }

  const { details_json: _omit, ...columns } = row;
  void _omit;
  return NextResponse.json({ property: columns, details });
}
