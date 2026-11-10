/**
 * データ層: sync-config.ts (airroi.ts から切り出した getSyncConfig / saveSyncConfig) が切り出し前と同じに振る舞うこと。
 * 切り出し前 (ed0687d の airroi.ts) の実装と同じ DB 行で突き合わせた結果 (環境変数あり/なし) を固定値として確認する。
 * 既定値は import 時に環境変数から決まるため、環境変数を設定してから動的 import する (node --test はファイルごとに別プロセス)。
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";

process.env.AIRROI_SEARCH_REFRESH_DAYS = "9";
process.env.AIRROI_RATES_REFRESH_DAYS = "3";
process.env.AIRROI_DAILY_RATES_CALLS = "7";
process.env.LUMINA_LISTING_ID = ' "555" ';
process.env.LUMINA_BASE_PRICE = "88000";
process.env.AIRROI_RATES_SUBSET_SIZE = "12";

type SyncConfigModule = typeof import("../sync-config");
let M: SyncConfigModule;
let airroi: typeof import("../airroi");

before(async () => {
  M = await import("../sync-config");
  airroi = await import("../airroi");
});

async function stateDb(rows: Record<string, string> = {}): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)");
  for (const [k, v] of Object.entries(rows)) {
    await db.execute({ sql: "INSERT INTO sync_state (key, value) VALUES (?, ?)", args: [k, v] });
  }
  return db;
}

describe("getSyncConfig", () => {
  it("未保存なら環境変数の既定値 (引用符・空白を除去) と固定の既定値", async () => {
    const cfg = await M.getSyncConfig(await stateDb());
    assert.deepEqual(cfg, {
      autoSync: true,
      searchRefreshDays: 9,
      ratesRefreshDays: 3,
      dailyRatesCalls: 7,
      luminaListingId: "555",
      luminaBasePrice: 88000,
      luminaBedrooms: 4,
      luminaMaxGuests: 10,
      luminaOccupancy: null,
      luminaLat: null,
      luminaLng: null,
      luminaRating: null,
      luminaReviews: null,
      luminaPhotos: null,
      luminaSuperhost: null,
      luminaAmenities: [],
      kpiCards: [],
      tableColumns: [],
      dataMode: "actual",
      ratesSubsetSize: 12,
    });
  });

  it("空文字・不正値・範囲外は既定値/null に倒す (切り出し前と同一)", async () => {
    const cfg = await M.getSyncConfig(
      await stateDb({
        "config:auto_sync": "0",
        "config:search_refresh_days": "7",
        "config:rates_refresh_days": "",
        "config:daily_rates_calls": "-3",
        "config:lumina_listing_id": "  123  ",
        "config:lumina_base_price": "abc",
        "config:lumina_occupancy": "150",
        "config:lumina_lat": "",
        "config:lumina_lng": "0",
        "config:lumina_rating": "0",
        "config:lumina_reviews": "",
        "config:lumina_photos": "12",
        "config:lumina_superhost": "1",
        "config:lumina_amenities": " wifi, sauna ,,",
        "config:kpi_cards": "a,,b",
        "config:table_columns": "",
        "config:data_mode": "calendar",
        "config:rates_subset_size": "5",
      }),
    );
    assert.equal(cfg.autoSync, false);
    assert.equal(cfg.searchRefreshDays, 7);
    assert.equal(cfg.ratesRefreshDays, 3); // 空文字 → 環境変数の既定値
    assert.equal(cfg.dailyRatesCalls, 7); // 負数 → 既定値
    assert.equal(cfg.luminaListingId, "123");
    assert.equal(cfg.luminaBasePrice, 88000);
    assert.equal(cfg.luminaOccupancy, null);
    assert.equal(cfg.luminaLat, null, "空文字の緯度は 0 ではなく null");
    assert.equal(cfg.luminaLng, null, "0 は未設定扱い");
    assert.equal(cfg.luminaRating, null);
    assert.equal(cfg.luminaReviews, null);
    assert.equal(cfg.luminaPhotos, 12);
    assert.equal(cfg.luminaSuperhost, true);
    assert.deepEqual(cfg.luminaAmenities, ["wifi", "sauna"]);
    assert.deepEqual(cfg.kpiCards, ["a", "b"]);
    assert.deepEqual(cfg.tableColumns, []);
    assert.equal(cfg.dataMode, "calendar");
    assert.equal(cfg.ratesSubsetSize, 5);
  });

  it("空の listing id は環境変数の既定値、緯度経度・稼働率は数値で読む", async () => {
    const cfg = await M.getSyncConfig(
      await stateDb({
        "config:lumina_listing_id": "",
        "config:lumina_lat": "35.4",
        "config:lumina_lng": "138.9",
        "config:lumina_occupancy": "55.5",
        "config:lumina_superhost": "0",
        "config:lumina_rating": "4.9",
        "config:data_mode": "weird",
        "config:lumina_bedrooms": "",
        "config:lumina_max_guests": "8",
      }),
    );
    assert.equal(cfg.luminaListingId, "555");
    assert.equal(cfg.luminaLat, 35.4);
    assert.equal(cfg.luminaLng, 138.9);
    assert.equal(cfg.luminaOccupancy, 55.5);
    assert.equal(cfg.luminaSuperhost, false);
    assert.equal(cfg.luminaRating, 4.9);
    assert.equal(cfg.dataMode, "actual");
    assert.equal(cfg.luminaBedrooms, 4);
    assert.equal(cfg.luminaMaxGuests, 8);
  });

  it("数値でない緯度経度・空のスーパーホストは null", async () => {
    const cfg = await M.getSyncConfig(
      await stateDb({ "config:lumina_lat": "abc", "config:lumina_lng": "  ", "config:lumina_superhost": "" }),
    );
    assert.equal(cfg.luminaLat, null);
    assert.equal(cfg.luminaLng, null);
    assert.equal(cfg.luminaSuperhost, null);
  });
});

describe("saveSyncConfig", () => {
  it("渡したキーだけを保存し、null は空文字として保存 → 読み戻すと null", async () => {
    const db = await stateDb({ "config:pricing": "{}", "config:kpi_cards": "x" });
    await M.saveSyncConfig(db, {
      autoSync: false,
      luminaLat: null,
      luminaLng: 138.9,
      luminaListingId: " 99 ",
      luminaSuperhost: null,
      luminaAmenities: ["a", "b"],
    });
    const rows = await db.execute("SELECT key, value FROM sync_state ORDER BY key");
    assert.deepEqual(
      rows.rows.map((r) => [String(r.key), String(r.value)]),
      [
        ["config:auto_sync", "0"],
        ["config:kpi_cards", "x"],
        ["config:lumina_amenities", "a,b"],
        ["config:lumina_lat", ""],
        ["config:lumina_listing_id", "99"],
        ["config:lumina_lng", "138.9"],
        ["config:lumina_superhost", ""],
        ["config:pricing", "{}"],
      ],
    );
    const cfg = await M.getSyncConfig(db);
    assert.equal(cfg.luminaLat, null);
    assert.equal(cfg.luminaLng, 138.9);
    assert.equal(cfg.luminaSuperhost, null);
    assert.equal(cfg.luminaListingId, "99");
  });

  it("上書き保存 (ON CONFLICT) と真偽値・配列の表現", async () => {
    const db = await stateDb();
    await M.saveSyncConfig(db, { luminaSuperhost: false, kpiCards: ["k1"], dailyRatesCalls: 10 });
    await M.saveSyncConfig(db, {
      luminaSuperhost: true,
      luminaOccupancy: null,
      luminaRating: 4.8,
      dataMode: "calendar",
      kpiCards: [],
      ratesSubsetSize: 0,
      dailyRatesCalls: 0,
    });
    const cfg = await M.getSyncConfig(db);
    assert.equal(cfg.luminaSuperhost, true);
    assert.equal(cfg.luminaOccupancy, null);
    assert.equal(cfg.luminaRating, 4.8);
    assert.equal(cfg.dataMode, "calendar");
    assert.deepEqual(cfg.kpiCards, []);
    assert.equal(cfg.ratesSubsetSize, 0);
    assert.equal(cfg.dailyRatesCalls, 0, "0 (自動取得なし) は既定値に戻さない");
  });
});

describe("airroi.ts の再エクスポート", () => {
  it("既存の import 先 (airroi.ts) から同じ関数・定数が使える", () => {
    assert.equal(airroi.getSyncConfig, M.getSyncConfig);
    assert.equal(airroi.saveSyncConfig, M.saveSyncConfig);
    assert.equal(airroi.COST_PER_RATES_CALL, 0.1);
    assert.equal(airroi.COST_PER_SEARCH_CALL, 0.5);
  });
});
