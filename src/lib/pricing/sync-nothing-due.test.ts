/**
 * 手動同期で料金カレンダーを1件も取得しなかったとき (すべて更新周期内) に、理由と次に更新対象になる日を返す。
 * 本番の事象: 「同期完了: 料金更新0物件 (APIコール0回 / 約$0)」とだけ表示され、理由が分からなかった。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncStep } from "../airroi";
import { getSyncConfig, saveSyncConfig } from "../sync-config";
import { freshDb, propertyStmt } from "./data-fixtures.test";

const realFetch = globalThis.fetch;
const realLog = console.log;
let calls = 0;

beforeEach(() => {
  calls = 0;
  console.log = () => {};
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("AirROI を呼んではいけない");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

function jstMd(msAgoDays: number, plusDays: number): string {
  const d = new Date(Date.now() - msAgoDays * 86_400_000 + plusDays * 86_400_000 + 9 * 3_600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

describe("syncStep: 更新周期内で何も取得しないとき", () => {
  it("料金は発生せず、理由と次に更新対象になる日 (最も古い取得日 + 周期) を返す", async () => {
    const db = await freshDb();
    await saveSyncConfig(db, {
      luminaListingId: "1628678015262671191",
      luminaLat: 35.42,
      luminaLng: 138.9,
      ratesRefreshDays: 30,
      dataMode: "actual",
      ratesSubsetSize: 40,
      // 本番と同じく自物件スペックは手入力済み (未設定だとスペックの自動再取得が走る)
      luminaRating: 4.93,
      luminaReviews: 15,
    });
    await db.batch(
      [
        propertyStmt({ id: "airroi_1", lat: 35.43, lng: 138.91, ratesSyncedAt: "datetime('now', '-5 days')" }),
        propertyStmt({ id: "airroi_2", lat: 35.44, lng: 138.92, ratesSyncedAt: "datetime('now', '-10 days')" }),
        {
          sql: "INSERT INTO sync_state (key, value) VALUES ('lumina_rates_at', datetime('now', '-16 days'))",
          args: [],
        },
      ],
      "write",
    );
    const r = await syncStep(db, "manual_refresh", 40, await getSyncConfig(db), { skipCatalog: true });
    assert.equal(calls, 0);
    assert.equal(r.status, "SUCCESS");
    assert.equal(r.ratesCalls, 0);
    assert.equal(r.estimatedCostUsd, 0);
    assert.match(r.message ?? "", /更新周期（30日）以内のため、取得は不要でした（料金は発生していません）/);
    // 最も古いのは自物件の16日前 → 16日前 + 30日 = 14日後
    assert.ok((r.message ?? "").includes(`次に更新対象になるのは ${jstMd(16, 30)} 以降です`), r.message);
  });
});
