/**
 * computePricingDashboard の統合テスト (holidays / compset / metrics の実装に依存する)。
 * 数値の正解ではなく構造上の不変条件を確認する。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePricingDashboard } from "./compute";
import { DEFAULT_PRICING_CONFIG } from "./config";
import { addDaysStr } from "./holidays";
import type { CalendarRow, CandidateProperty, PricingConfig, PricingInputs, SnapshotRow } from "./types";

const TODAY = "2026-11-10";
const LAT = 35.42038;
const LNG = 138.90478;

function candidate(i: number, extra: Partial<CandidateProperty> = {}): CandidateProperty {
  return {
    id: `airroi_${1000 + i}`,
    title: `Villa ${i}`,
    url: null,
    area: "山中湖",
    lat: LAT + 0.005 * (i + 1),
    lng: LNG + 0.004 * (i + 1),
    roomType: "entire_home",
    listingType: "Entire villa",
    propertyType: "villa",
    maxGuests: 8,
    rating: 4.9,
    reviews: 30,
    adrRef: 100000 + i * 5000,
    reservedShare: 0.8,
    ratesSyncedAt: addDaysStr(TODAY, -1),
    lastAttemptAt: addDaysStr(TODAY, -1),
    ...extra,
  };
}

/** 決定的な疑似乱数 (mulberry32) */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildInputs(overrides: Partial<PricingInputs> = {}, cfg: PricingConfig = DEFAULT_PRICING_CONFIG): PricingInputs {
  const rand = rng(42);
  const candidates = overrides.candidates ?? Array.from({ length: 10 }, (_, i) => candidate(i));
  const calendar: CalendarRow[] = [];
  const snapshots: SnapshotRow[] = [];
  for (const c of candidates) {
    // カレンダー行・スナップショットは最終取得成功日 (ratesSyncedAt) 時点のもの
    const fetched = c.ratesSyncedAt;
    if (!fetched) continue;
    for (let off = -14; off <= cfg.horizonDays + 7; off++) {
      const date = addDaysStr(TODAY, off);
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      const weekend = dow === 5 || dow === 6;
      const lead = Math.max(0, off);
      const pBooked = (weekend ? 0.6 : 0.3) * Math.exp(-lead / 40);
      const booked = rand() < pBooked;
      const price = booked ? 0 : Math.round((c.adrRef ?? 100000) * (weekend ? 1.2 : 1) * (0.9 + rand() * 0.2));
      calendar.push({ propertyId: c.id, date, available: !booked, price, fetchedAt: fetched });
      if (date >= fetched) {
        snapshots.push({ snapshotDate: fetched, propertyId: c.id, date, available: !booked, price });
        const earlier = booked && rand() < 0.4 ? true : !booked;
        snapshots.push({
          snapshotDate: addDaysStr(fetched, -7),
          propertyId: c.id,
          date,
          available: earlier,
          price: earlier ? price || 100000 : 0,
        });
      }
    }
  }
  return {
    today: TODAY,
    dataSource: "turso",
    lumina: { lat: LAT, lng: LNG, basePrice: 110000, listingId: null, priceSource: "manual", maxGuests: 8 },
    candidates,
    calendar,
    snapshots,
    own: [],
    config: cfg,
    icalConfigured: false,
    icalLastImport: null,
    alertChannel: "none",
    lastNotifiedAt: null,
    ...overrides,
  };
}

function scanFinite(v: unknown, path: string, bad: string[]): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) bad.push(`${path}=${v}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => scanFinite(x, `${path}[${i}]`, bad));
  } else if (v instanceof Map) {
    for (const [k, x] of v) scanFinite(x, `${path}<${String(k)}>`, bad);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) scanFinite(x, `${path}.${k}`, bad);
  }
}

const NOW = "2026-11-10T00:00:00.000Z";

describe("computePricingDashboard (統合)", () => {
  it("horizon 60 → 61日 (lead 0..60, 連続した日付)", () => {
    const d = computePricingDashboard(buildInputs(), NOW);
    assert.equal(d.horizonDays, 60);
    assert.equal(d.days.length, 61);
    d.days.forEach((x, i) => {
      assert.equal(x.lead, i);
      assert.equal(x.date, addDaysStr(TODAY, i));
      assert.equal(x.night.date, x.date);
    });
    assert.equal(d.generatedAt, NOW);
    assert.equal(d.today, TODAY);
  });

  it("出力のどこにも NaN / Infinity が無い", () => {
    for (const inputs of [
      buildInputs(),
      buildInputs({ candidates: [], calendar: [], snapshots: [] }),
      buildInputs({ lumina: { lat: null, lng: null, basePrice: 0, listingId: null, priceSource: "manual", maxGuests: 8 } }),
    ]) {
      const bad: string[] = [];
      scanFinite(computePricingDashboard(inputs, NOW), "dashboard", bad);
      assert.deepEqual(bad, []);
    }
  });

  it("現在価格が仮定値なら乖離率 null・action hold・警告あり", () => {
    const d = computePricingDashboard(buildInputs(), NOW);
    for (const x of d.days) {
      assert.equal(x.own.currentPriceSource, "assumed");
      assert.equal(x.pricing.changePct, null);
      assert.equal(x.pricing.action, "hold");
    }
    assert.equal(d.status.ownPriceSource, "assumed");
    assert.ok(d.status.warnings.some((w) => w.includes("自社の現在価格が未入力")));
    assert.equal(d.kpis.raiseDays, 0);
    assert.equal(d.kpis.lowerDays, 0);
  });

  it("自社の予約状況が未連携なら ownStatusSource none と own_status_unlinked", () => {
    const d = computePricingDashboard(buildInputs(), NOW);
    assert.equal(d.status.ownStatusSource, "none");
    assert.ok(d.alerts.some((a) => a.kind === "own_status_unlinked" && a.date === TODAY));
    assert.ok(d.status.warnings.some((w) => w.includes("自社の予約状況が未連携")));
  });

  it("設定画面の現在価格 (manual) と api 価格の優先順位", () => {
    const cfg: PricingConfig = { ...DEFAULT_PRICING_CONFIG, ownPriceWeekday: 100000, ownPriceWeekend: 130000 };
    const apiDate = addDaysStr(TODAY, 5);
    const d = computePricingDashboard(
      buildInputs({ config: cfg, own: [{ date: apiDate, apiPrice: 123000, status: "vacant", statusSource: "api" }] }, cfg),
      NOW,
    );
    for (const x of d.days) {
      if (x.date === apiDate) {
        assert.equal(x.own.currentPriceSource, "api");
        assert.equal(x.own.currentPrice, 123000);
      } else {
        assert.equal(x.own.currentPriceSource, "manual");
        assert.equal(x.own.currentPrice, x.night.type === "weekend" ? 130000 : 100000);
      }
      assert.notEqual(x.pricing.changePct, null);
    }
    assert.equal(d.status.ownPriceSource, "manual");
    assert.equal(d.status.ownStatusSource, "mixed");
  });

  it("デモモード: mode demo、先頭の警告、refreshPlan は空", () => {
    const d = computePricingDashboard(buildInputs({ dataSource: "demo" }), NOW);
    assert.equal(d.status.mode, "demo");
    assert.equal(d.status.warnings[0], "デモデータを表示中です（実際の予約・競合データではありません）");
    assert.deepEqual(d.status.refreshPlan, { ids: [], count: 0, costUsd: 0 });
  });

  it("refreshPlan: 古いカレンダーの member を上限まで、cost = count × 0.1", () => {
    const stale = Array.from({ length: 10 }, (_, i) =>
      candidate(i, { ratesSyncedAt: addDaysStr(TODAY, -40 - i), lastAttemptAt: addDaysStr(TODAY, -40 - i) }),
    );
    const cfg: PricingConfig = { ...DEFAULT_PRICING_CONFIG, compsetRefreshMax: 3 };
    const d = computePricingDashboard(buildInputs({ candidates: stale, config: cfg }, cfg), NOW);
    const plan = d.status.refreshPlan;
    assert.ok(plan.count <= 3);
    assert.equal(plan.count, plan.ids.length);
    assert.equal(plan.costUsd, Math.round(plan.count * 0.1 * 100) / 100);
    assert.deepEqual(plan.ids, d.compset.needsRefreshIds.slice(0, 3));
    assert.equal(d.status.mode, "no_market_data");
    assert.ok(d.days.every((x) => x.pricing.signal === "rules_only"));
    assert.ok(d.status.warnings.some((w) => w.includes("曜日・直前ルールのみ")));
    assert.equal(
      d.status.autoRefreshMonthlyUsd,
      Math.round(((Math.min(d.compset.members.length, 3) * 0.1 * 30) / cfg.compsetRefreshDays) * 100) / 100,
    );
  });

  it("基準価格 0 でも例外を投げず、推奨は floor 以上で警告を出す", () => {
    const d = computePricingDashboard(
      buildInputs({ lumina: { lat: LAT, lng: LNG, basePrice: 0, listingId: null, priceSource: "manual", maxGuests: 8 } }),
      NOW,
    );
    assert.ok(d.status.warnings.some((w) => w.includes("自社基準価格が未設定")));
    for (const x of d.days) assert.ok(x.pricing.recommended >= x.pricing.floor);
  });

  it("KPI と config マスク", () => {
    const cfg: PricingConfig = { ...DEFAULT_PRICING_CONFIG, icalUrl: "https://www.airbnb.jp/calendar/ical/1.ics?s=secret" };
    const d = computePricingDashboard(buildInputs({ config: cfg }, cfg), NOW);
    assert.equal(d.config.icalUrl, "(設定済み)");
    assert.equal(d.kpis.weekdayDays + d.kpis.weekendDays <= 61, true);
    assert.deepEqual(
      d.kpis.spikeDates,
      d.days.filter((x) => x.market.spike).map((x) => x.date),
    );
    assert.equal(d.basePrices.weekday, 110000);
    assert.equal(d.past.length, 14);
    assert.equal(d.status.alertChannel, "none");
    assert.ok(d.status.warnings.includes("アラートは画面表示のみで、通知先（Slack/Discord等）は未設定です"));
  });

  it("新鮮なカレンダーが1物件だけ (本番の初期状態): KPI占有率は出さず、値上げ/値下げ判定・アラートも出さない", () => {
    // 1件だけ新鮮、残りは未取得 → 全日 dataQuality low/none = rules_only
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate(i, i === 0 ? {} : { ratesSyncedAt: null, lastAttemptAt: null }),
    );
    // 実価格 (AirROI) を推奨から大きく離して置く
    const own = Array.from({ length: 61 }, (_, i) => ({
      date: addDaysStr(TODAY, i),
      apiPrice: i % 2 === 0 ? 300000 : 40000,
      status: "vacant" as const,
      statusSource: "api" as const,
    }));
    const base = buildInputs({ candidates });
    const d = computePricingDashboard({ ...base, own, lumina: { ...base.lumina, priceSource: "api" } }, NOW);
    assert.ok(d.days.every((x) => x.pricing.signal === "rules_only"));
    assert.equal(d.status.mode, "no_market_data");
    assert.equal(d.kpis.weekdayOcc, null, "1物件の状態を市場の占有率として出さない");
    assert.equal(d.kpis.weekendOcc, null);
    assert.equal(d.kpis.raiseDays, 0);
    assert.equal(d.kpis.lowerDays, 0);
    assert.ok(d.days.some((x) => x.pricing.changePct !== null), "乖離率自体は参考値として残る");
    assert.ok(!d.alerts.some((a) => a.kind === "raise_opportunity" || a.kind === "discount_needed"));
  });
});
