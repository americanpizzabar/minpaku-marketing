/**
 * 設定 API (/api/settings) 経由の自物件スペック取得。TURSO_DATABASE_URL=":memory:" で getDb() をインメモリ DB にし、
 * AirROI はモック (listing 111 = ★4.71・52件、listing 222 = ★4.93・15件)。
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN, key: process.env.AIRROI_API_KEY };
const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;

type RouteModule = typeof import("../../app/api/settings/route");
let route: RouteModule;

const LISTINGS: Record<string, { rating: number; reviews: number; photos: number; superhost: boolean }> = {
  "111": { rating: 4.71, reviews: 52, photos: 30, superhost: false },
  "222": { rating: 4.93, reviews: 15, photos: 100, superhost: true },
};

before(async () => {
  process.env.TURSO_DATABASE_URL = ":memory:";
  delete process.env.TURSO_AUTH_TOKEN;
  route = await import("../../app/api/settings/route");
});

after(() => {
  for (const [k, v] of [
    ["TURSO_DATABASE_URL", saved.url],
    ["TURSO_AUTH_TOKEN", saved.token],
    ["AIRROI_API_KEY", saved.key],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  process.env.AIRROI_API_KEY = "test-key";
  console.error = () => {};
  console.log = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname.endsWith("/listings/future/rates")) return new Response(JSON.stringify({ rates: [] }), { status: 200 });
    const l = LISTINGS[id];
    if (url.pathname.endsWith("/listings") && l) {
      return new Response(
        JSON.stringify({
          results: [
            {
              listing_info: { listing_name: `L${id}`, photos_count: l.photos, superhost: l.superhost, amenities: ["Wifi"] },
              ratings: { rating_overall: l.rating, num_reviews: l.reviews },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realError;
  console.log = realLog;
});

function post(body: unknown) {
  return route.POST(
    new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("/api/settings: 自物件スペック", () => {
  it("リスティングIDを別の物件に変えたら、レビュー数が少なくても新しい物件の値で上書きし、保存の応答に結果を含める", async () => {
    const r1 = await (await post({ luminaListingId: "111" })).json();
    assert.equal(r1.saved, true);
    assert.equal(r1.config.luminaRating, 4.71);
    assert.equal(r1.config.luminaReviews, 52);
    assert.equal(r1.luminaSpecsLastFetch?.listingId, "111");

    // 設定画面は保存時にフォーム全体 (前の物件の評価・レビュー数を含む) を送る
    const r2 = await (
      await post({ ...r1.config, luminaListingId: "222", luminaRating: 4.71, luminaReviews: 52 })
    ).json();
    assert.equal(r2.saved, true);
    assert.equal(r2.config.luminaRating, 4.93);
    assert.equal(r2.config.luminaReviews, 15);
    assert.equal(r2.config.luminaPhotos, 100);
    assert.match(r2.specsMessage ?? "", /自動取得しました/);
    assert.equal(r2.luminaSpecsLastFetch?.listingId, "222");

    // その後ボタンで取り直しても、同じ物件・同じ件数なので変わらない (古いという誤った案内も出ない)
    const r3 = await (await post({ action: "fetchLuminaSpecs" })).json();
    assert.equal(r3.saved, true);
    assert.doesNotMatch(r3.message, /古い可能性/);
    assert.equal(r3.config.luminaReviews, 15);
  });

  it("同じ物件で手入力した新しい評価・レビュー数は、ボタンで取り直しても古い AirROI の値に戻らない", async () => {
    await post({ luminaListingId: "222" });
    const saved = await (await post({ luminaRating: 4.95, luminaReviews: 20 })).json();
    assert.equal(saved.config.luminaReviews, 20);
    const r = await (await post({ action: "fetchLuminaSpecs" })).json();
    assert.match(r.message, /より古い可能性があるため、評価・レビュー数は上書きしませんでした/);
    assert.equal(r.config.luminaRating, 4.95);
    assert.equal(r.config.luminaReviews, 20);
    const g = await (await route.GET(new NextRequest("http://localhost/api/settings"))).json();
    assert.equal(g.luminaSpecsLastFetch?.keptReason, "older");
    assert.equal(g.luminaSpecsLastFetch?.reviews, 15);
  });
});
