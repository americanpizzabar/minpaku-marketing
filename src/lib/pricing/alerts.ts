/**
 * アラート判定 (仕様 6章「アラート通知」+ 価格アクション)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 *
 * ルール (days は lead 0..horizon。A = cfg.alpha[night.type]):
 * - weekend_low_inventory (仕様6章「週末で競合残室が3室以下」):
 *     night.type=weekend かつ market.dataQuality == "ok" かつ market.remaining < market.units
 *     かつ market.remainingEst != null かつ remainingEst <= cfg.alerts.weekendRemainingMax
 *     かつ (market.occ ?? 0) >= A.midOcc
 *     severity: 自社が vacant なら "high"、それ以外 "info"
 *     message 例: "11/21(土) 週末の競合 7件中 5件が予約済・残り2室（推定）。強気設定の好機"
 * - weekday_spike (仕様6章「直近7日で平日稼働率が跳ねた日」):
 *     night.type=weekday かつ market.pace != null かつ pace >= cfg.alerts.weekdaySpikePt
 *     かつ (market.newBookings ?? 0) >= cfg.spike.minNewBookings → severity "high"。
 *     message に 超過 +Xpt/7日 と新規予約件数
 * - spike: market.spike かつ同日に weekday_spike を出していない → severity "medium"
 * - raise_opportunity: 自社 vacant かつ own.statusSource != "none" かつ pricing.action == "raise"
 *     かつ market.occ != null かつ occ >= A.midOcc → "medium"。message: "現在¥110,000 → 推奨¥127,000（+15%）"
 * - discount_needed: 自社 vacant かつ own.statusSource != "none" かつ pricing.action == "lower" かつ lead <= 14 → "medium"
 * - own_status_unlinked: 将来日すべての own.statusSource が "none" のとき1件だけ (date = days[0].date, "info"):
 *     "自社の予約状況が未連携のため、値上げ/値下げアラートは停止中です（iCal連携または手動入力で有効になります）"
 * (action raise/lower は現在価格が実値の日しか出ないので、仮定価格では raise/discount アラートは出ない)
 * 並び順: severity (high → medium → info)、同 severity 内は日付昇順。
 * 日付表示は formatJpDate。金額は "¥" + 3桁区切り。
 */
import type { DayRecommendation, PricingAlert, PricingConfig } from "./types";

const SEVERITY_RANK: Record<PricingAlert["severity"], number> = { high: 0, medium: 1, info: 2 };

function fmt1(x: number): string {
  return String(Math.round(x * 10) / 10);
}

function signedPct(x: number): string {
  const r = Math.round(x * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${fmt1(Math.abs(r))}%`;
}

export function deriveAlerts(days: DayRecommendation[], cfg: PricingConfig): PricingAlert[] {
  const out: PricingAlert[] = [];
  for (const d of days) {
    const A = cfg.alpha[d.night.type];
    const m = d.market;
    const label = formatJpDate(d.date);
    const vacant = d.own.status === "vacant";
    const linked = d.own.statusSource !== "none";

    if (
      d.night.type === "weekend" &&
      m.dataQuality === "ok" &&
      m.remaining < m.units &&
      m.remainingEst != null &&
      m.remainingEst <= cfg.alerts.weekendRemainingMax &&
      (m.occ ?? 0) >= A.midOcc
    ) {
      out.push({
        date: d.date,
        kind: "weekend_low_inventory",
        severity: vacant ? "high" : "info",
        message:
          `${label} 週末の競合 ${m.units}件中 ${m.unavailable}件が予約済・残り${m.remainingEst}室（推定）。` +
          (vacant ? "強気設定の好機" : `自社は${d.own.status === "booked" ? "予約済" : "ブロック中"}`),
      });
    }

    let weekdaySpike = false;
    if (
      d.night.type === "weekday" &&
      m.pace != null &&
      m.pace >= cfg.alerts.weekdaySpikePt &&
      (m.newBookings ?? 0) >= cfg.spike.minNewBookings
    ) {
      weekdaySpike = true;
      out.push({
        date: d.date,
        kind: "weekday_spike",
        severity: "high",
        message: `${label} 平日の競合予約が急増: 通常ペースを +${fmt1(m.pace)}pt/7日 上回る（新規予約${m.newBookings ?? 0}件）`,
      });
    }

    if (m.spike && !weekdaySpike) {
      out.push({
        date: d.date,
        kind: "spike",
        severity: "medium",
        message: `${label} 競合の予約が急増（超過 +${fmt1(m.pace ?? 0)}pt/7日・新規予約${m.newBookings ?? 0}件）`,
      });
    }

    const cur = d.own.currentPrice;
    const change = d.pricing.changePct;
    const priceText =
      cur != null && change != null
        ? `現在${formatYen(cur)} → 推奨${formatYen(d.pricing.recommended)}（${signedPct(change)}）`
        : `推奨${formatYen(d.pricing.recommended)}`;

    if (vacant && linked && d.pricing.action === "raise" && m.occ != null && m.occ >= A.midOcc) {
      out.push({ date: d.date, kind: "raise_opportunity", severity: "medium", message: `${label} 値上げ余地: ${priceText}` });
    }
    if (vacant && linked && d.pricing.action === "lower" && d.lead <= 14) {
      out.push({ date: d.date, kind: "discount_needed", severity: "medium", message: `${label} 値下げ検討: ${priceText}` });
    }
  }

  if (days.length > 0 && days.every((d) => d.own.statusSource === "none")) {
    out.push({
      date: days[0].date,
      kind: "own_status_unlinked",
      severity: "info",
      message: "自社の予約状況が未連携のため、値上げ/値下げアラートは停止中です（iCal連携または手動入力で有効になります）",
    });
  }

  // severity → 日付の順 (同じ日付内は判定順を保つ安定ソート)
  return out
    .map((a, i) => ({ a, i }))
    .sort(
      (x, y) =>
        SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] ||
        (x.a.date < y.a.date ? -1 : x.a.date > y.a.date ? 1 : 0) ||
        x.i - y.i,
    )
    .map((x) => x.a);
}

/** 金額 → "¥110,000" (整数に丸めて3桁区切り。ロケールに依存しない) */
export function formatYen(n: number): string {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  const s = String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v < 0 ? "−" : ""}¥${s}`;
}

/** "YYYY-MM-DD" → "M/D(曜)" */
export function formatJpDate(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const w = "日月火水木金土"[d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${w})`;
}
