/**
 * 推奨価格のエクスポート (仕様 4.1「推奨価格を一括適用 (CSV / OTA連携用フォーマット)」)。
 * 純関数 (クライアントコンポーネントからも import して Blob ダウンロードに使う)。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { PricingDashboard } from "./types";

/**
 * 分析用の詳細CSV (UTF-8 BOM 付き, 改行 \r\n, 値にカンマ/改行/引用符があればダブルクォートでエスケープ)。
 * ヘッダ: 日付,曜日,区分,区分理由,リードタイム,自社状況,現在価格,推奨価格,乖離率(%),アクション,
 *        競合占有率(%),補正前占有率(%),競合有効室数,競合残室数,競合中央価格,Pace(pt/7日),
 *        δ週末(%),α占有率(%),β Pace(%),γリードタイム(%),算出価格(丸め前),下限,上限,ガードレール
 * 係数は % 表記 (0.15 → 15.0)。null は空欄。
 */
export function toDetailCsv(d: PricingDashboard): string {
  void d;
  throw new Error("not implemented");
}

/**
 * OTA/チャネルマネージャへの一括反映用 (UTF-8, BOM なし, 改行 \n)。
 * ヘッダ: date,price,currency
 * 行: 自社が vacant の将来日のみ、price = 推奨価格 (整数), currency = JPY
 */
export function toOtaCsv(d: PricingDashboard): string {
  void d;
  throw new Error("not implemented");
}
