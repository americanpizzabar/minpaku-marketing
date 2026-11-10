/**
 * データ層: pipeline.ts (CompSet カレンダー取得の上限管理 / 推奨価格・アラートの保存 / 通知 / 保持期間)。
 * 外部 API・Webhook は globalThis.fetch のモックで代替する。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { freshDb, seedRealistic, type SeedResult } from "./data-fixtures.test";
import { addDaysStr } from "./holidays";
import { refreshCompsetCalendars, runPricingPipeline, sendAlertWebhook } from "./pipeline";
import { savePricingConfig } from "./config-store";
import { DEFAULT_PRICING_CONFIG } from "./config";

const realFetch = globalThis.fetch;
const env = { key: process.env.AIRROI_API_KEY, hook: process.env.ALERT_WEBHOOK_URL };
const realError = console.error;
const realLog = console.log;

interface Call {
  url: string;
  body: string | null;
}
let calls: Call[] = [];
let webhookOk = true;

/** AirROI の rates と Webhook をまとめてモック */
function installFetch(opts: { ratesStatus?: number } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
    if (url.includes("/listings/future/rates")) {
      if (opts.ratesStatus && opts.ratesStatus !== 200) return new Response("err", { status: opts.ratesStatus });
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const rates = [];
      for (let i = 0; i <= 140; i++) rates.push({ date: addDaysStr(today, i), rate: 100000, available: i % 2 === 0, min_nights: 1 });
      return new Response(JSON.stringify({ rates }), { status: 200 });
    }
    if (url.startsWith("https://hooks.example.invalid")) {
      return new Response("ok", { status: webhookOk ? 200 : 500 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const ratesCalls = () => calls.filter((c) => c.url.includes("/listings/future/rates"));
const hookCalls = () => calls.filter((c) => c.url.startsWith("https://hooks.example.invalid"));

beforeEach(() => {
  calls = [];
  webhookOk = true;
  process.env.AIRROI_API_KEY = "test-key";
  delete process.env.ALERT_WEBHOOK_URL;
  console.error = () => {};
  console.log = () => {};
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [
    ["AIRROI_API_KEY", env.key],
    ["ALERT_WEBHOOK_URL", env.hook],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  console.error = realError;
  console.log = realLog;
});

async function scalar(db: Client, sql: string, args: (string | number)[] = []): Promise<unknown> {
  const r = await db.execute({ sql, args });
  return r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
}

describe("refreshCompsetCalendars", () => {
  it("上限 = min(maxCalls, dailyRatesCalls, 50)、取得件数と費用・sync_logs・日次カウンタ", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db, { dailyRatesCalls: 5 });
    const r = await refreshCompsetCalendars(db, { maxCalls: 3, staleDays: 1 });
    assert.equal(r.refreshed, 3);
    assert.equal(r.costUsd, 0.3);
    assert.equal(r.skipped, 8, "対象 11件のうち 3件のみ取得");
    assert.equal(ratesCalls().length, 3);
    // 古い順 (未取得 → 20日前 → 昨日)
    assert.match(ratesCalls()[0].url, new RegExp(`id=${seed.none.slice(7)}&`));
    assert.match(ratesCalls()[1].url, new RegExp(`id=${seed.stale.slice(7)}&`));
    assert.equal(await scalar(db, "SELECT value FROM sync_state WHERE key = ?", [`pricing:refresh_calls:${seed.today}`]), "3");
    const log = await db.execute("SELECT * FROM sync_logs WHERE sync_type = 'pricing_compset'");
    assert.equal(log.rows.length, 1);
    assert.equal(Number(log.rows[0].api_calls_count), 3);
    assert.equal(log.rows[0].status, "PARTIAL");
    assert.ok(Number(log.rows[0].records_fetched) > 0);
    // スナップショットが今日付けで保存されている
    assert.equal(
      Number(await scalar(db, "SELECT COUNT(DISTINCT property_id) FROM calendar_snapshots WHERE snapshot_date = ?", [seed.today])),
      3,
    );

    // 同日2回目: 日次上限 5 の残り 2件まで
    calls = [];
    const r2 = await refreshCompsetCalendars(db, { maxCalls: 10, staleDays: 1 });
    assert.equal(r2.refreshed, 2);
    assert.equal(ratesCalls().length, 2);
    assert.equal(await scalar(db, "SELECT value FROM sync_state WHERE key = ?", [`pricing:refresh_calls:${seed.today}`]), "5");

    // 3回目: 上限到達 → API を呼ばない
    calls = [];
    const r3 = await refreshCompsetCalendars(db, { maxCalls: 10, staleDays: 1 });
    assert.equal(r3.refreshed, 0);
    assert.equal(r3.costUsd, 0);
    assert.ok(r3.skipped > 0);
    assert.equal(ratesCalls().length, 0);
  });

  it("ids が与えられたら積集合だけ (CompSet 外・今日取得済みは取得しない)", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const r = await refreshCompsetCalendars(db, {
      maxCalls: 20,
      staleDays: 1,
      ids: [seed.hotel, seed.far, seed.stale, "airroi_100", seed.failed],
    });
    assert.equal(r.refreshed, 2);
    assert.equal(r.skipped, 0);
    const ids = ratesCalls().map((c) => /id=(\d+)&/.exec(c.url)?.[1]);
    assert.deepEqual(ids, [seed.stale.slice(7), "100"]);
    // 同じ ids で再実行 → 今日試行済みなので 0 件
    calls = [];
    const again = await refreshCompsetCalendars(db, { maxCalls: 20, staleDays: 1, ids: [seed.stale, "airroi_100"] });
    assert.deepEqual(again, { refreshed: 0, costUsd: 0, skipped: 0 });
    assert.equal(ratesCalls().length, 0);
  });

  it("maxCalls 0 / dailyRatesCalls 0 なら API を呼ばない", async () => {
    const db = await freshDb();
    await seedRealistic(db, { dailyRatesCalls: 0 });
    const r = await refreshCompsetCalendars(db, { maxCalls: 20, staleDays: 1 });
    assert.equal(r.refreshed, 0);
    assert.equal(r.costUsd, 0);
    assert.equal(ratesCalls().length, 0);

    const db2 = await freshDb();
    await seedRealistic(db2);
    const r2 = await refreshCompsetCalendars(db2, { maxCalls: 0, staleDays: 1 });
    assert.equal(r2.refreshed, 0);
    assert.equal(ratesCalls().length, 0);
    const r3 = await refreshCompsetCalendars(db2, { maxCalls: Number.NaN, staleDays: 1 });
    assert.equal(r3.refreshed, 0);
    assert.equal(ratesCalls().length, 0);
  });

  it("1回あたり最大 50件", async () => {
    const db = await freshDb();
    await seedRealistic(db, { dailyRatesCalls: 500 });
    // CompSet を大きくする: 条件を満たす物件を 60件追加 (未取得)
    const stmts = [];
    for (let i = 0; i < 60; i++) {
      stmts.push({
        sql: `INSERT INTO properties (id, airroi_id, title, area, latitude, longitude, max_guests, rating, reviews_count, l90d_avg_rate, details_json)
              VALUES (?, ?, 'v', '山中湖村', ?, 138.90478, 8, 4.9, 20, 110000, ?)`,
        args: [`airroi_9${i}`, `9${i}`, 35.42038 + 0.0005 * i, JSON.stringify({ listing_info: { room_type: "entire_home" } })],
      });
    }
    await db.batch(stmts, "write");
    const r = await refreshCompsetCalendars(db, { maxCalls: 1000, staleDays: 1 });
    assert.equal(r.refreshed, 50);
    assert.equal(r.costUsd, 5);
    assert.equal(ratesCalls().length, 50);
  });

  it("取得に失敗しても費用は計上し (API は呼ばれている)、ログは FAILED", async () => {
    const db = await freshDb();
    await seedRealistic(db);
    installFetch({ ratesStatus: 500 });
    const r = await refreshCompsetCalendars(db, { maxCalls: 2, staleDays: 1 });
    assert.equal(r.refreshed, 2);
    assert.equal(r.costUsd, 0.2);
    const log = await db.execute("SELECT status, error_message FROM sync_logs WHERE sync_type = 'pricing_compset'");
    assert.equal(log.rows[0].status, "FAILED");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM calendar_snapshots WHERE snapshot_date = date('now', '+9 hours')")), 0);
  });

  it("AIRROI_API_KEY が無ければ呼ばず、取得試行日も進めない", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    delete process.env.AIRROI_API_KEY;
    const before = await scalar(db, "SELECT rates_synced_at FROM properties WHERE id = ?", [seed.stale]);
    const r = await refreshCompsetCalendars(db, { maxCalls: 2, staleDays: 1 });
    assert.equal(r.refreshed, 0);
    assert.equal(r.costUsd, 0);
    assert.equal(ratesCalls().length, 0);
    assert.equal(await scalar(db, "SELECT rates_synced_at FROM properties WHERE id = ?", [seed.stale]), before);
    assert.equal(await scalar(db, "SELECT value FROM sync_state WHERE key = ?", [`pricing:refresh_calls:${seed.today}`]), undefined);
  });

  it("7日より古い日次カウンタを掃除する", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    await db.execute({
      sql: "INSERT INTO sync_state (key, value) VALUES (?, '3'), (?, '4')",
      args: [`pricing:refresh_calls:${addDaysStr(seed.today, -8)}`, `pricing:refresh_calls:${addDaysStr(seed.today, -7)}`],
    });
    await refreshCompsetCalendars(db, { maxCalls: 1, staleDays: 1 });
    const keys = (await db.execute("SELECT key FROM sync_state WHERE key LIKE 'pricing:refresh_calls:%' ORDER BY key")).rows.map(
      (r) => String(r.key),
    );
    assert.deepEqual(keys, [`pricing:refresh_calls:${addDaysStr(seed.today, -7)}`, `pricing:refresh_calls:${seed.today}`]);
  });
});

/** 週末 3夜 (lead >= 3) を CompSet ほぼ満室にして weekend_low_inventory を出す。自社はその日を手動で空室に */
async function forceWeekendAlerts(db: Client, seed: SeedResult): Promise<string[]> {
  const r = await runPricingPipeline(db, { notify: false });
  const weekends = r.dashboard.days.filter((d) => d.night.type === "weekend" && d.lead >= 3).map((d) => d.date);
  const picked = weekends.slice(0, 3);
  for (const date of picked) {
    await db.execute({
      sql: `UPDATE daily_metrics SET is_available = 0, price_jpy = 0
            WHERE target_date = ? AND property_id IN (${seed.fresh.map(() => "?").join(",")}) AND property_id <> 'airroi_100'`,
      args: [date, ...seed.fresh],
    });
    await db.execute({
      sql: `INSERT INTO lumina_bookings (target_date, status, source) VALUES (?, 'vacant', 'manual')
            ON CONFLICT(target_date) DO UPDATE SET status='vacant', source='manual'`,
      args: [date],
    });
  }
  return picked;
}

describe("runPricingPipeline", () => {
  it("今日の推奨価格を保存 (再実行で置き換え)・アラートを記録し、解消した未通知アラートを消す", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const today = seed.today;
    // 以前の実行で保存された「今日」の行 (今回の範囲外の日付) と、解消したアラート
    await db.execute({
      sql: "INSERT INTO pricing_recommendations (generated_date, target_date, recommended_price) VALUES (?, ?, 1)",
      args: [today, addDaysStr(today, 200)],
    });
    await db.execute({
      sql: `INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message, notified_at) VALUES
            (?, ?, 'weekend_low_inventory', 'high', '解消済み・未通知', NULL),
            (?, ?, 'weekday_spike', 'high', '解消済み・通知済み', '2026-01-01 00:00:00')`,
      args: [today, addDaysStr(today, 1), today, addDaysStr(today, 2)],
    });

    const r = await runPricingPipeline(db, { notify: false });
    assert.equal(r.saved, 61);
    assert.equal(r.dashboard.dataSource, "turso");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_recommendations WHERE generated_date = ?", [today])), 61);
    const rec = await db.execute({
      sql: "SELECT * FROM pricing_recommendations WHERE generated_date = ? AND target_date = ?",
      args: [today, today],
    });
    const d0 = r.dashboard.days[0];
    assert.equal(Number(rec.rows[0].recommended_price), d0.pricing.recommended);
    assert.equal(rec.rows[0].day_type, d0.night.type);
    assert.equal(rec.rows[0].action, d0.pricing.action);
    assert.equal(Number(rec.rows[0].lead_days), 0);

    const alerts = await db.execute({ sql: "SELECT * FROM pricing_alerts WHERE generated_date = ?", args: [today] });
    const msgs = alerts.rows.map((a) => String(a.message));
    assert.ok(!msgs.includes("解消済み・未通知"), "解消した未通知アラートは削除");
    assert.ok(msgs.includes("解消済み・通知済み"), "通知済みは残す");
    assert.equal(alerts.rows.length, r.alerts + 1);

    // 再実行しても重複しない
    const r2 = await runPricingPipeline(db, { notify: false });
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_recommendations WHERE generated_date = ?", [today])), 61);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_alerts WHERE generated_date = ?", [today])), r2.alerts + 1);
    assert.equal(hookCalls().length, 0);
  });

  it("通知: 今日の weekend_low_inventory / weekday_spike だけ、通知済みと同じ状況は送らず、古い未通知は skipped", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const today = seed.today;
    const [w1, w2, w3] = await forceWeekendAlerts(db, seed);
    assert.ok(w3, "週末が3夜以上ある");
    // 前日までに通知済み: w1 は同じ severity (high) → 再送しない / w2 は info → high に上がったので送る
    await db.execute({
      sql: `INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message, notified_at) VALUES
            (?, ?, 'weekend_low_inventory', 'high', 'prev w1', '2026-01-01 22:00:00'),
            (?, ?, 'weekend_low_inventory', 'info', 'prev w2', '2026-01-01 22:00:00'),
            (?, ?, 'weekend_low_inventory', 'high', 'prev w3 skipped', 'skipped'),
            (?, ?, 'weekday_spike', 'high', '古い未通知', NULL)`,
      args: [
        addDaysStr(today, -1), w1,
        addDaysStr(today, -2), w2,
        addDaysStr(today, -1), w3,
        addDaysStr(today, -1), addDaysStr(today, 3),
      ],
    });
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.invalid/x";

    const r = await runPricingPipeline(db, { notify: true });
    const todays = await db.execute({
      sql: "SELECT target_date, kind, severity, notified_at, message FROM pricing_alerts WHERE generated_date = ? ORDER BY target_date",
      args: [today],
    });
    const wkd = todays.rows.filter((a) => a.kind === "weekend_low_inventory");
    for (const w of [w1, w2, w3]) {
      const row = wkd.find((a) => a.target_date === w);
      assert.ok(row, `${w} の週末アラートが記録されている`);
      assert.equal(row!.severity, "high");
    }
    assert.equal(hookCalls().length, 1);
    const body = JSON.parse(hookCalls()[0].body!);
    assert.equal(body.text, body.content);
    assert.ok(body.text.startsWith("【Lumina Fuji 価格アラート】"));

    const notifiedDates = todays.rows.filter((a) => a.notified_at !== null).map((a) => `${a.target_date}|${a.kind}`);
    assert.ok(!notifiedDates.includes(`${w1}|weekend_low_inventory`), "同じ severity で通知済み → 送らない");
    assert.ok(notifiedDates.includes(`${w2}|weekend_low_inventory`), "severity 上昇 → 送る");
    assert.ok(notifiedDates.includes(`${w3}|weekend_low_inventory`), "skipped は通知済み扱いしない");
    // 通知対象は2種類のみ
    assert.ok(
      todays.rows
        .filter((a) => a.notified_at !== null)
        .every((a) => a.kind === "weekend_low_inventory" || a.kind === "weekday_spike"),
    );
    assert.equal(r.notified, notifiedDates.length);
    const w1row = wkd.find((a) => a.target_date === w1)!;
    assert.ok(!body.text.includes(String(w1row.message)));
    // 古い未通知は skipped
    assert.equal(await scalar(db, "SELECT notified_at FROM pricing_alerts WHERE message = '古い未通知'"), "skipped");

    // 同日に再実行: 既に通知済みの行は送らない (変更もしない)
    calls = [];
    const again = await runPricingPipeline(db, { notify: true });
    assert.equal(again.notified, 0);
    assert.equal(hookCalls().length, 0);
    const sentAfter = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM pricing_alerts WHERE generated_date = ? AND notified_at IS NOT NULL AND notified_at <> 'skipped'",
      args: [today],
    });
    assert.equal(Number(sentAfter.rows[0].c), notifiedDates.length);
  });

  it("Webhook 失敗・未設定なら notified_at を付けない (次回再送できる)", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    await forceWeekendAlerts(db, seed);
    const r0 = await runPricingPipeline(db, { notify: true }); // 未設定
    assert.equal(r0.notified, 0);
    assert.equal(hookCalls().length, 0);
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.invalid/x";
    webhookOk = false;
    const r1 = await runPricingPipeline(db, { notify: true });
    assert.equal(r1.notified, 0);
    assert.equal(hookCalls().length, 1);
    assert.equal(
      Number(await scalar(db, "SELECT COUNT(*) FROM pricing_alerts WHERE notified_at IS NOT NULL", [])),
      2,
      "フィクスチャの既存2行のみ",
    );
    webhookOk = true;
    const r2 = await runPricingPipeline(db, { notify: true });
    assert.ok(r2.notified > 0);
  });

  it("120日より古いスナップショット・推奨・アラートを削除する", async () => {
    const db = await freshDb();
    const seed = await seedRealistic(db);
    const old = addDaysStr(seed.today, -121);
    const keep = addDaysStr(seed.today, -120);
    for (const d of [old, keep]) {
      await db.execute({
        sql: "INSERT INTO calendar_snapshots (snapshot_date, property_id, target_date, is_available, price_jpy) VALUES (?, 'airroi_100', ?, 1, 1)",
        args: [d, d],
      });
      await db.execute({ sql: "INSERT INTO pricing_recommendations (generated_date, target_date) VALUES (?, ?)", args: [d, d] });
      await db.execute({
        sql: "INSERT INTO pricing_alerts (generated_date, target_date, kind, severity, message) VALUES (?, ?, 'spike', 'medium', 'x')",
        args: [d, d],
      });
    }
    const snapsBefore = Number(await scalar(db, "SELECT COUNT(*) FROM calendar_snapshots"));
    await runPricingPipeline(db, { notify: false });
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM calendar_snapshots WHERE snapshot_date < ?", [keep])), 0);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM calendar_snapshots WHERE snapshot_date = ?", [keep])), 1);
    // フィクスチャの 130日前の行 (31件) と 121日前の 1件が消える
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM calendar_snapshots")), snapsBefore - 32);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_recommendations WHERE generated_date = ?", [old])), 0);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_recommendations WHERE generated_date = ?", [keep])), 1);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_alerts WHERE generated_date = ?", [old])), 0);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM pricing_alerts WHERE generated_date = ?", [keep])), 1);
  });

  it("iCal が設定されていれば取り込み、失敗しても続行する", async () => {
    const db = await freshDb();
    await seedRealistic(db);
    await savePricingConfig(db, { ...DEFAULT_PRICING_CONFIG, icalUrl: "https://www.airbnb.com/calendar/ical/1.ics?s=x" });
    // fetch モックは iCal URL で例外 → 取り込み失敗を記録して続行
    const r = await runPricingPipeline(db, { notify: false });
    assert.equal(r.saved, 61);
    const status = JSON.parse(String(await scalar(db, "SELECT value FROM sync_state WHERE key = 'pricing:ical_last_import'")));
    assert.equal(status.ok, false);
    assert.ok(calls.some((c) => c.url.startsWith("https://www.airbnb.com/calendar/ical/")));
  });

  it("db が null (デモ) なら何も書かず通知もしない", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.invalid/x";
    const r = await runPricingPipeline(null, { notify: true });
    assert.equal(r.saved, 0);
    assert.equal(r.notified, 0);
    assert.equal(r.dashboard.dataSource, "demo");
    assert.equal(calls.length, 0);
  });
});

describe("sendAlertWebhook", () => {
  it("未設定・0件なら送らず false、最大20件", async () => {
    assert.equal(await sendAlertWebhook([{ date: "2026-01-01", kind: "spike", severity: "high", message: "x" }]), false);
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example.invalid/x";
    assert.equal(await sendAlertWebhook([]), false);
    const many = Array.from({ length: 25 }, (_, i) => ({
      date: "2026-01-01",
      kind: "spike" as const,
      severity: "high" as const,
      message: `m${i}`,
    }));
    assert.equal(await sendAlertWebhook(many), true);
    const body = JSON.parse(hookCalls()[0].body!);
    assert.equal(body.text.split("\n").length, 21);
  });
});
