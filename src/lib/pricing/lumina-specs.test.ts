/**
 * 自物件スペックの自動取得 (airroi.ts の refreshLuminaSpecs)。AirROI の /listings はモック。
 * AirROI は Airbnb を定期収集したデータなので実際より古いことがある (本番: Airbnb ★4.93・15件 / AirROI ★4.9・10件)。
 * 手入力した新しい値を、古い AirROI のデータで上書きしないことを確認する。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getLuminaSpecLastFetch, refreshLuminaSpecs } from "../airroi";
import { getSyncConfig, saveSyncConfig } from "../sync-config";
import { freshDb } from "./data-fixtures.test";

const realFetch = globalThis.fetch;
const realKey = process.env.AIRROI_API_KEY;
const realError = console.error;
let calls = 0;

function serveListing(ratings: { rating_overall?: number; num_reviews?: number }, extra: Record<string, unknown> = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes("/listings?id=")) throw new Error(`unexpected fetch: ${url}`);
    calls += 1;
    return new Response(
      JSON.stringify({
        results: [
          {
            listing_info: {
              listing_name: "Lumina Fuji",
              photos_count: 100,
              superhost: true,
              amenities: ["Wifi", "Hot tub"],
              bedrooms: 3,
              person_capacity: 7,
            },
            ratings,
            ...extra,
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

async function setup(saved: { rating: number | null; reviews: number | null }) {
  const db = await freshDb();
  await saveSyncConfig(db, {
    luminaListingId: "1628678015262671191",
    luminaRating: saved.rating,
    luminaReviews: saved.reviews,
  });
  return db;
}

beforeEach(() => {
  calls = 0;
  process.env.AIRROI_API_KEY = "test-key";
  console.error = () => {};
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.AIRROI_API_KEY;
  else process.env.AIRROI_API_KEY = realKey;
  console.error = realError;
});

describe("refreshLuminaSpecs: AirROI のデータの新旧", () => {
  it("AirROI の方が古い (レビュー数が少ない) なら、手入力した評価・レビュー数を上書きしない", async () => {
    const db = await setup({ rating: 4.93, reviews: 15 });
    serveListing({ rating_overall: 4.9, num_reviews: 10 }, { last_scraped: "2026-09-28T03:12:00Z" });
    const r = await refreshLuminaSpecs(db, await getSyncConfig(db));
    assert.equal(calls, 1);
    assert.equal(r.ok, true);
    assert.match(r.message, /AirROIのデータ（★4\.9・レビュー10件）（AirROIのデータ時点 2026-09-28）は保存済みの値（★4\.93・レビュー15件）より古いため、上書きしませんでした/);
    const cfg = await getSyncConfig(db);
    assert.equal(cfg.luminaRating, 4.93);
    assert.equal(cfg.luminaReviews, 15);
    // 古いデータでも、未設定の項目は補完する
    assert.equal(cfg.luminaPhotos, 100);
    assert.equal(cfg.luminaSuperhost, true);
    assert.deepEqual(cfg.luminaAmenities, ["Wifi", "Hot tub"]);
    const last = await getLuminaSpecLastFetch(db);
    assert.equal(last?.rating, 4.9);
    assert.equal(last?.reviews, 10);
    assert.equal(last?.dataDate, "2026-09-28");
    assert.equal(last?.keptNewer, true);
  });

  it("AirROI の方が新しい (レビュー数が多い) なら上書きする", async () => {
    const db = await setup({ rating: 4.9, reviews: 10 });
    serveListing({ rating_overall: 4.93, num_reviews: 15 });
    const r = await refreshLuminaSpecs(db, await getSyncConfig(db));
    assert.match(r.message, /自動取得しました/);
    const cfg = await getSyncConfig(db);
    assert.equal(cfg.luminaRating, 4.93);
    assert.equal(cfg.luminaReviews, 15);
    assert.equal((await getLuminaSpecLastFetch(db))?.keptNewer, false);
  });

  it("未設定なら取得値で埋める", async () => {
    const db = await setup({ rating: null, reviews: null });
    serveListing({ rating_overall: 4.9, num_reviews: 10 });
    await refreshLuminaSpecs(db, await getSyncConfig(db));
    const cfg = await getSyncConfig(db);
    assert.equal(cfg.luminaRating, 4.9);
    assert.equal(cfg.luminaReviews, 10);
  });

  it("レビュー数が同じなら、評価は保存済み (手入力の小数2桁) を優先する", async () => {
    const db = await setup({ rating: 4.93, reviews: 15 });
    serveListing({ rating_overall: 4.9, num_reviews: 15 });
    await refreshLuminaSpecs(db, await getSyncConfig(db));
    const cfg = await getSyncConfig(db);
    assert.equal(cfg.luminaRating, 4.93);
    assert.equal(cfg.luminaReviews, 15);
    assert.equal(cfg.luminaPhotos, 100, "同じ時点のデータなので他の項目は更新する");
  });

  it("AirROI にレビュー数が無ければ新旧を判断できないため、保存済みの値は上書きしない", async () => {
    const db = await setup({ rating: 4.93, reviews: 15 });
    serveListing({ rating_overall: 4.7 });
    await refreshLuminaSpecs(db, await getSyncConfig(db));
    const cfg = await getSyncConfig(db);
    assert.equal(cfg.luminaRating, 4.93);
    assert.equal(cfg.luminaReviews, 15);
  });

  it("データ時点の項目が無ければ null、記録が無ければ getLuminaSpecLastFetch は null", async () => {
    const db = await setup({ rating: null, reviews: null });
    assert.equal(await getLuminaSpecLastFetch(db), null);
    serveListing({ rating_overall: 4.9, num_reviews: 10 });
    await refreshLuminaSpecs(db, await getSyncConfig(db));
    assert.equal((await getLuminaSpecLastFetch(db))?.dataDate, null);
  });
});
