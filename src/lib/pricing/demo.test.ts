/**
 * demo.ts (Turso 未設定時の PricingInputs) の現実性と決定性。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePricingDashboard } from "./compute";
import { DEFAULT_PRICING_CONFIG, normalizePricingConfig } from "./config";
import { findNonFinite } from "./data-fixtures.test";
import { buildDemoPricingInputs } from "./demo";
import { addDaysStr, diffDays } from "./holidays";

const TODAYS = ["2026-11-10", "2026-12-26", "2027-04-20", "2027-08-02"];
const cfg = normalizePricingConfig(DEFAULT_PRICING_CONFIG);

describe("buildDemoPricingInputs", () => {
  for (const today of TODAYS) {
    it(`${today}: 過去日の行は泊まる直前 (fetchedAt ∈ [d−3, d]) に取得した状態、未来日は最終取得日の状態`, () => {
      const inputs = buildDemoPricingInputs(today, cfg);
      const synced = new Map(inputs.candidates.map((c) => [c.id, c.ratesSyncedAt]));
      assert.ok(inputs.calendar.length > 0);
      for (const r of inputs.calendar) {
        const last = synced.get(r.propertyId);
        assert.ok(last, "ratesSyncedAt のある物件のみ");
        assert.ok(r.fetchedAt <= last!, "最終取得日より後の取得は無い");
        if (r.date < today) {
          const age = diffDays(r.fetchedAt, r.date);
          assert.ok(age >= 0 && age <= 3, `${r.propertyId} ${r.date} fetchedAt=${r.fetchedAt}`);
        } else {
          assert.equal(r.fetchedAt, last);
        }
        assert.ok(r.available || r.price === 0);
        assert.ok(r.date >= addDaysStr(today, -14) && r.date <= addDaysStr(today, cfg.horizonDays + 7));
      }
      // 各物件の最新の fetchedAt は ratesSyncedAt と一致 (loadCandidates の MAX(fetched_at) と同じ意味)
      const maxFetched = new Map<string, string>();
      for (const r of inputs.calendar) {
        if ((maxFetched.get(r.propertyId) ?? "") < r.fetchedAt) maxFetched.set(r.propertyId, r.fetchedAt);
      }
      for (const [id, m] of maxFetched) assert.equal(m, synced.get(id));
    });

    it(`${today}: 直近14日の実績は多数の物件から算出される (1件の古い物件の 0%/100% にならない)`, () => {
      const d = computePricingDashboard(buildDemoPricingInputs(today, cfg));
      assert.equal(d.past.length, 14);
      for (const p of d.past) {
        assert.ok(p.units >= 5, `${p.date} units=${p.units}`);
        assert.ok(p.occ !== null);
      }
      const extremes = d.past.filter((p) => p.occ === 0 || p.occ === 100).length;
      assert.ok(extremes <= 3, `0%/100% の日が多すぎる: ${extremes}`);
      assert.equal(d.days.length, 61);
      assert.deepEqual(findNonFinite(d), []);
    });
  }

  it("決定的 (同じ today なら同じ結果)、JSDoc の構成どおり", () => {
    const a = buildDemoPricingInputs("2026-11-10", cfg);
    const b = buildDemoPricingInputs("2026-11-10", cfg);
    assert.deepEqual(a, b);
    assert.equal(a.dataSource, "demo");
    assert.equal(a.candidates.length, 30);
    assert.equal(a.lumina.priceSource, "demo");
    assert.equal(a.config.ownPriceWeekday, 110000);
    assert.equal(a.config.ownPriceWeekend, 125000);
    const d = computePricingDashboard(a);
    const statuses = d.compset.members.map((m) => m.calendarStatus).sort();
    assert.deepEqual(statuses, [
      "failed",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "fresh",
      "none",
      "stale",
    ]);
    // stale 物件 (today−20 取得) の行は未来日のみ・fetchedAt = today−20
    const stale = d.compset.members.find((m) => m.calendarStatus === "stale")!;
    const rows = a.calendar.filter((r) => r.propertyId === stale.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.date >= "2026-11-10" && r.fetchedAt === addDaysStr("2026-11-10", -20)));
    // スナップショット: fresh は today−8 と today−1、stale は today−20
    const snapDates = [...new Set(a.snapshots.map((s) => s.snapshotDate))].sort();
    assert.deepEqual(snapDates, ["2026-10-21", "2026-11-02", "2026-11-09"]);
    // 自社: [today−14, today+horizon]、手動
    assert.equal(a.own.length, cfg.horizonDays + 15);
    assert.ok(a.own.every((o) => o.statusSource === "manual" && o.apiPrice === null));
    assert.equal(a.own.filter((o) => o.status === "blocked").length, 2);
  });
});
