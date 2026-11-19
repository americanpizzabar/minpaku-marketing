import { NextRequest, NextResponse } from "next/server";
import { isAirRoiConfigured, refreshLuminaRates } from "@/lib/airroi";
import { hasCronBearer } from "@/lib/cron-auth";
import { publicErrorMessage } from "@/lib/errors";
import { toDateStr, todayJst } from "@/lib/dates";
import { ensureSchema, getDb } from "@/lib/db";
import { getPricingDashboard } from "@/lib/pricing";
import { isAllowedIcalUrl, maskPricingConfig, mergeEditedPricingConfig } from "@/lib/pricing/config";
import { getPricingConfig, savePricingConfig } from "@/lib/pricing/config-store";
import { addDaysStr } from "@/lib/pricing/holidays";
import { importIcalToDb } from "@/lib/pricing/ical";
import { refreshCompsetCalendars, runPricingPipeline } from "@/lib/pricing/pipeline";
import { COST_PER_RATES_CALL, getSyncConfig } from "@/lib/sync-config";
import type { OwnStatus, PricingApiResponse } from "@/lib/pricing/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ICAL_URL_ERROR =
  "Airbnb のカレンダーエクスポート URL（https://www.airbnb.…/calendar/ical/…）を入力してください";
const STATUS_LABEL: Record<OwnStatus, string> = { booked: "予約済", blocked: "ブロック", vacant: "空室" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;


function reply(body: PricingApiResponse, status = 200) {
  return NextResponse.json(body, { status });
}

/** "YYYY-MM-DD" → "M/D" */
function md(date: string): string {
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

function isValidDate(date: unknown): date is string {
  if (typeof date !== "string" || !DATE_RE.test(date)) return false;
  const d = new Date(date + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** 同一オリジン (Sec-Fetch-Site / Origin のホスト = Host) または CRON_SECRET の Bearer のみ許可 */
function isAuthorized(request: NextRequest): boolean {
  if (hasCronBearer(request.headers.get("authorization"))) return true;
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

/** /pricing 画面のデータ (PricingDashboard) */
export async function GET() {
  try {
    const dashboard = await getPricingDashboard();
    return NextResponse.json(dashboard);
  } catch (err) {
    // DB のエラー文 (SQL やホスト名を含みうる) は返さずサーバーログにだけ残す
    console.error("GET /api/pricing failed:", err);
    return NextResponse.json({ error: "価格データの読み込みに失敗しました（詳細はサーバーログ）" }, { status: 500 });
  }
}

/** 設定保存・CompSet 取得・自社状況の手動指定・iCal 取り込み・保存 (types.ts の PricingApiRequest) */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return reply({ ok: false, message: "このリクエストは許可されていません" }, 403);
  }
  const db = getDb();
  if (!db) {
    return reply({ ok: false, message: "デモモードのため実行できません（データベース未設定）" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return reply({ ok: false, message: "リクエストの形式が正しくありません" }, 400);
  }

  try {
    await ensureSchema(db);
    const today = toDateStr(todayJst());

    switch (body.action) {
      case "saveConfig": {
        const edited =
          body.config !== null && typeof body.config === "object" && !Array.isArray(body.config)
            ? (body.config as Record<string, unknown>)
            : {};
        const ical = edited.icalUrl;
        if (typeof ical === "string" && ical.trim() !== "" && ical !== "(設定済み)" && !isAllowedIcalUrl(ical.trim())) {
          return reply({ ok: false, message: ICAL_URL_ERROR }, 400);
        }
        const current = await getPricingConfig(db);
        const next = mergeEditedPricingConfig(current, edited);
        await savePricingConfig(db, next);
        return reply({ ok: true, message: "設定を保存しました", config: maskPricingConfig(next) });
      }

      case "refreshCompset": {
        const ids = Array.isArray(body.ids)
          ? body.ids.filter((v): v is string => typeof v === "string").slice(0, 200)
          : [];
        if (ids.length === 0) {
          return reply({ ok: false, message: "取得対象がありません", refreshed: 0, costUsd: 0 }, 400);
        }
        const config = await getPricingConfig(db);
        const r = await refreshCompsetCalendars(db, { ids, maxCalls: config.compsetRefreshMax, staleDays: 1 });
        let message = `${r.refreshed}件を取得しました（約$${r.costUsd.toFixed(2)}）`;
        if (r.skipped > 0) {
          message += `。${r.skipped}件は1回・1日あたりの取得上限のため取得しませんでした`;
        }
        return reply({ ok: true, message, refreshed: r.refreshed, costUsd: r.costUsd });
      }

      case "setOwnStatus": {
        const date = body.date;
        const status = body.status;
        if (!isValidDate(date)) return reply({ ok: false, message: "日付の形式が正しくありません" }, 400);
        if (status !== "booked" && status !== "blocked" && status !== "vacant") {
          return reply({ ok: false, message: "状態の指定が正しくありません" }, 400);
        }
        const config = await getPricingConfig(db);
        const from = addDaysStr(today, -14);
        const to = addDaysStr(today, config.horizonDays);
        if (date < from || date > to) {
          return reply({ ok: false, message: `指定できるのは ${md(from)}〜${md(to)} の日付です` }, 400);
        }
        await db.execute({
          sql: `INSERT INTO lumina_bookings (target_date, status, source, updated_at)
                VALUES (?, ?, 'manual', CURRENT_TIMESTAMP)
                ON CONFLICT(target_date) DO UPDATE SET
                  status=excluded.status, source='manual', updated_at=CURRENT_TIMESTAMP`,
          args: [date, status],
        });
        return reply({ ok: true, message: `${md(date)} を「${STATUS_LABEL[status]}」に手動指定しました` });
      }

      case "clearOwnStatus": {
        const date = body.date;
        if (!isValidDate(date)) return reply({ ok: false, message: "日付の形式が正しくありません" }, 400);
        const res = await db.execute({
          sql: "DELETE FROM lumina_bookings WHERE target_date = ? AND source = 'manual'",
          args: [date],
        });
        const message =
          res.rowsAffected > 0
            ? `${md(date)} の手動指定を解除しました（現在は未指定。次回のiCal取り込みで反映）`
            : `${md(date)} に手動指定はありません（状態は変わりません）`;
        return reply({ ok: true, message });
      }

      case "importIcal": {
        const config = await getPricingConfig(db);
        if (!config.icalUrl) return reply({ ok: false, message: "iCal URL が設定されていません" }, 400);
        try {
          const r = await importIcalToDb(db, config.icalUrl, today, config.horizonDays);
          return reply({
            ok: true,
            message: `iCalから${r.imported}日分を取り込みました（予約済${r.booked}日・ブロック${r.blocked}日）`,
            imported: r.imported,
          });
        } catch (err) {
          console.error("importIcal failed:", err);
          const message = publicErrorMessage(err, "内部エラー（詳細はサーバーログ）");
          return reply({ ok: false, message: `iCal取り込みに失敗しました: ${message}`, imported: 0 }, 502);
        }
      }

      case "persist": {
        const r = await runPricingPipeline(db, { notify: false });
        return reply({
          ok: true,
          message: `推奨価格${r.saved}日分とアラート${r.alerts}件を保存しました`,
          saved: r.saved,
          alerts: r.alerts,
        });
      }

      case "refreshOwnCalendar": {
        // 自社カレンダー (価格・予約状況) を AirROI から取得する ($0.10/回。404 等の失敗でも課金される)
        const sync = await getSyncConfig(db);
        if (!sync.luminaListingId) {
          return reply({ ok: false, message: "自物件のAirbnbリスティングIDが未設定です（設定画面で入力してください）", costUsd: 0 }, 400);
        }
        if (!isAirRoiConfigured()) {
          return reply({ ok: false, message: "AirROI の APIキーが未設定のため取得できません", costUsd: 0 }, 400);
        }
        const r = await refreshLuminaRates(db, sync);
        const costUsd = r.usedApi ? COST_PER_RATES_CALL : 0;
        if (r.ok) {
          return reply({
            ok: true,
            message:
              `自社カレンダーをAirROIから取得しました（${r.records}日分: 掲載価格あり${r.pricedDays}日・予約済/ブロック${r.bookedDays}日、` +
              `約$${costUsd.toFixed(2)}）`,
            refreshed: r.records,
            costUsd,
            ownCalendarFetchedAt: r.fetchedAt,
          });
        }
        const keep = "これまでにAirROIで取得した実データはそのまま使います";
        const code = r.httpStatus ?? Number(/AirROI API Error: (\d{3})/.exec(r.error ?? "")?.[1] ?? NaN);
        let message: string;
        if (r.failure === "network") {
          // 応答を受け取れていない (DNS・TLS・切断等)。送信後に切断された場合だけ課金されうる
          message =
            "AirROIに接続できませんでした（通信エラー）。課金されていない可能性が高いですが、" +
            `送信後に切断された場合は課金されることがあります。${keep}`;
        } else if (r.failure === "empty") {
          message = `AirROIが空のカレンダーを返しました。API呼び出し1回分（約$${costUsd.toFixed(2)}）は消費されます。${keep}`;
        } else if (r.failure === "parse") {
          message = `AirROIから応答はありましたが内容を読み取れませんでした。API呼び出し1回分（約$${costUsd.toFixed(2)}）は消費されます。${keep}`;
        } else if (Number.isFinite(code)) {
          const reason =
            code === 404
              ? "AirROIにこの物件のカレンダーが見つかりませんでした（404）"
              : `AirROIがエラーを返しました（${code}）`;
          message = `${reason}。API呼び出し1回分（約$${costUsd.toFixed(2)}）は消費されます。${keep}`;
        } else {
          message = r.usedApi
            ? `AirROIからの取得に失敗しました。API呼び出し1回分（約$${costUsd.toFixed(2)}）は消費されます。${keep}`
            : `AirROIからの取得に失敗しました（AirROIへの呼び出しは行っていません）。${keep}`;
        }
        return reply({ ok: false, message, refreshed: 0, costUsd }, 502);
      }

      default:
        return reply({ ok: false, message: "不明な操作です" }, 400);
    }
  } catch (err) {
    console.error("POST /api/pricing failed:", err);
    // 自前の日本語エラーはそのまま見せ、DB 等の内部エラー文は返さない
    const message = publicErrorMessage(err, "");
    return reply({ ok: false, message: message ? `処理に失敗しました: ${message}` : "処理に失敗しました（詳細はサーバーログ）" }, 500);
  }
}
