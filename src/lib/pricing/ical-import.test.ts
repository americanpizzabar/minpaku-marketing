/**
 * データ層: ical.ts の importIcalToDb (lumina_bookings への取り込みと安全規則)。fetch はモック。
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "@libsql/client";
import { freshDb, jstToday } from "./data-fixtures.test";
import { addDaysStr } from "./holidays";
import { ICAL_LAST_IMPORT_KEY, importIcalToDb } from "./ical";
import { isAllowedIcalUrl } from "./config";

const URL_OK = "https://www.airbnb.com/calendar/ical/123.ics?s=abc";
const realFetch = globalThis.fetch;
let fetchCount = 0;

function ymd(d: string): string {
  return d.replaceAll("-", "");
}

function ics(events: [string, string, string][]): string {
  const body = events
    .map(
      ([s, e, summary]) =>
        `BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:${ymd(s)}\r\nDTEND;VALUE=DATE:${ymd(e)}\r\nSUMMARY:${summary}\r\nEND:VEVENT`,
    )
    .join("\r\n");
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

function serve(text: string, status = 200) {
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return new Response(text, { status });
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCount = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function bookings(db: Client) {
  const r = await db.execute("SELECT target_date, status, source FROM lumina_bookings ORDER BY target_date");
  return r.rows.map((x) => [String(x.target_date), String(x.status), String(x.source)]);
}

async function lastStatus(db: Client) {
  const r = await db.execute({ sql: "SELECT value FROM sync_state WHERE key = ?", args: [ICAL_LAST_IMPORT_KEY] });
  return JSON.parse(String(r.rows[0].value)) as { ok: boolean; imported: number; error: string | null };
}

describe("importIcalToDb", () => {
  it("予約・ブロックを日別に保存し、手動指定の日は上書きしない。再取り込みで iCal 行を置き換える", async () => {
    const db = await freshDb();
    const today = jstToday();
    await db.execute({
      sql: "INSERT INTO lumina_bookings (target_date, status, source) VALUES (?, 'vacant', 'manual')",
      args: [addDaysStr(today, 3)],
    });
    serve(
      ics([
        [addDaysStr(today, 2), addDaysStr(today, 5), "Reserved"],
        [addDaysStr(today, 10), addDaysStr(today, 12), "Airbnb (Not available)"],
        [addDaysStr(today, -5), addDaysStr(today, -2), "Reserved"], // 範囲外 (過去)
      ]),
    );
    const r = await importIcalToDb(db, URL_OK, today, 60);
    assert.deepEqual(r, { imported: 4, booked: 2, blocked: 2 });
    assert.deepEqual(await bookings(db), [
      [addDaysStr(today, 2), "booked", "ical"],
      [addDaysStr(today, 3), "vacant", "manual"],
      [addDaysStr(today, 4), "booked", "ical"],
      [addDaysStr(today, 10), "blocked", "ical"],
      [addDaysStr(today, 11), "blocked", "ical"],
    ]);
    assert.equal((await lastStatus(db)).ok, true);

    // 予約がキャンセルされた → 再取り込みで消える
    serve(ics([[addDaysStr(today, 10), addDaysStr(today, 11), "Reserved"]]));
    await importIcalToDb(db, URL_OK, today, 60);
    assert.deepEqual(await bookings(db), [
      [addDaysStr(today, 3), "vacant", "manual"],
      [addDaysStr(today, 10), "booked", "ical"],
    ]);
  });

  it("Airbnb 以外の URL は取得せず失敗を記録", async () => {
    const db = await freshDb();
    serve("BEGIN:VCALENDAR\r\nEND:VCALENDAR");
    await assert.rejects(importIcalToDb(db, "https://evil.example/calendar/ical/1.ics", jstToday(), 60));
    assert.equal(fetchCount, 0);
    const st = await lastStatus(db);
    assert.equal(st.ok, false);
    assert.ok(st.error);
  });

  it("URL の許可は Airbnb の公式ドメインの完全一致のみ", () => {
    for (const ok of [
      "https://www.airbnb.com/calendar/ical/1.ics?s=x",
      "https://airbnb.jp/calendar/ical/1.ics",
      "https://www.airbnb.co.uk/calendar/ical/1.ics",
      "https://www.airbnb.com.au/calendar/ical/1.ics",
    ]) {
      assert.equal(isAllowedIcalUrl(ok), true, ok);
    }
    for (const ng of [
      "https://airbnb.evil.com/calendar/ical/1.ics",
      "https://airbnb.localhost/calendar/ical/x",
      "https://airbnb.internal/calendar/ical/x",
      "https://www.airbnb.com.evil.io/calendar/ical/1.ics",
      "https://www.airbnb.com:8443/calendar/ical/1.ics",
      "https://user:pw@www.airbnb.com/calendar/ical/1.ics",
      "http://www.airbnb.com/calendar/ical/1.ics",
      "https://www.airbnb.com/users/show/1",
    ]) {
      assert.equal(isAllowedIcalUrl(ng), false, ng);
    }
  });

  it("リダイレクトは Airbnb の iCal URL への転送だけ追い、それ以外は取得しない", async () => {
    const db = await freshDb();
    const today = jstToday();
    const seen: string[] = [];
    const cal = ics([[addDaysStr(today, 3), addDaysStr(today, 5), "Reserved"]]);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      if (url.includes("/calendar/ical/1.ics")) {
        return new Response(null, { status: 302, headers: { location: "https://www.airbnb.jp/calendar/ical/2.ics" } });
      }
      if (url.includes("/calendar/ical/2.ics")) return new Response(cal, { status: 200 });
      if (url.includes("/calendar/ical/3.ics")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    await importIcalToDb(db, "https://www.airbnb.com/calendar/ical/1.ics", today, 60);
    assert.deepEqual(seen, ["https://www.airbnb.com/calendar/ical/1.ics", "https://www.airbnb.jp/calendar/ical/2.ics"]);
    assert.equal((await bookings(db)).length, 2);

    seen.length = 0;
    await assert.rejects(importIcalToDb(db, "https://www.airbnb.com/calendar/ical/3.ics", today, 60), /転送は追いません/);
    assert.deepEqual(seen, ["https://www.airbnb.com/calendar/ical/3.ics"], "許可外の転送先には接続しない");
    assert.equal((await bookings(db)).length, 2, "既存データは消さない");
  });

  it("2MB を超える応答は読み込まず失敗にする", async () => {
    const db = await freshDb();
    const big = "BEGIN:VCALENDAR\r\n" + "X".repeat(2 * 1024 * 1024 + 10);
    serve(big);
    await assert.rejects(importIcalToDb(db, URL_OK, jstToday(), 60), /大きすぎます/);
  });

  it("HTTP エラー・iCal でない本文・空の iCal (既存あり) では既存データを消さない", async () => {
    const db = await freshDb();
    const today = jstToday();
    serve(ics([[addDaysStr(today, 1), addDaysStr(today, 3), "Reserved"]]));
    await importIcalToDb(db, URL_OK, today, 60);
    const before = await bookings(db);
    assert.equal(before.length, 2);

    serve("nope", 500);
    await assert.rejects(importIcalToDb(db, URL_OK, today, 60), /HTTP 500/);
    serve("<html>login</html>");
    await assert.rejects(importIcalToDb(db, URL_OK, today, 60), /iCal形式/);
    serve(ics([]));
    await assert.rejects(importIcalToDb(db, URL_OK, today, 60), /iCalが空でした/);
    assert.deepEqual(await bookings(db), before);
    assert.equal((await lastStatus(db)).ok, false);
  });

  it("既存の iCal 行が無ければ空の iCal は成功 (0日)", async () => {
    const db = await freshDb();
    serve(ics([]));
    const r = await importIcalToDb(db, URL_OK, jstToday(), 60);
    assert.equal(r.imported, 0);
    assert.equal((await lastStatus(db)).ok, true);
  });
});
