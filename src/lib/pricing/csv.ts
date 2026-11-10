/**
 * 推奨価格のエクスポート (仕様 4.1「推奨価格を一括適用 (CSV / OTA連携用フォーマット)」)。
 * 純関数 (クライアントコンポーネントからも import して Blob ダウンロード・画面表示に使う)。
 * 注意: Airbnb には価格の CSV 一括取込機能が無い。CSV は表計算・チャネルマネージャ取込用、
 * toPriceRanges は Airbnb のカレンダーで「期間を選んで価格を入力」する手作業を最小にするための一覧。
 *
 * 【担当: pricing-engine】このファイルは契約スタブ。シグネチャを変えずに実装すること。
 */
import type { PricingDashboard } from "./types";

/**
 * 分析用の詳細CSV (UTF-8 BOM 付き, 改行 \r\n, 値にカンマ/改行/引用符があればダブルクォートでエスケープ)。
 * ヘッダ: 日付,曜日,区分,区分理由,リードタイム,自社状況,現在価格,現在価格の出所,推奨価格,乖離率(推奨までの変更率%),
 *        アクション,算出根拠,競合占有率(%),補正前占有率(%),競合有効室数,競合残室数,競合中央価格,Pace超過(pt/7日),
 *        δ曜日(%),α占有率(%),β Pace(%),γリードタイム(%),算出価格(丸め前),下限,上限,ガードレール
 * 係数は % 表記 (0.15 → 15.0)。null は空欄。算出根拠 = signal を日本語 (競合連動/一部連動/ルールのみ)。
 */
export function toDetailCsv(d: PricingDashboard): string {
  void d;
  throw new Error("not implemented");
}

/**
 * 汎用の価格CSV (チャネルマネージャ等への取込用。UTF-8, BOM なし, 改行 \n)。
 * ヘッダ: date,price,currency,day_type,min_nights
 * 行: 自社が vacant の将来日のみ、price = 推奨価格 (整数), currency = JPY, day_type = weekday/weekend, min_nights = 空欄
 */
export function toPriceCsv(d: PricingDashboard): string {
  void d;
  throw new Error("not implemented");
}

/**
 * 自社が vacant の将来日を日付順に並べ、連続する日 (翌日が vacant かつ同じ推奨価格) を1区間にまとめる。
 * 戻り値の label 例: "11/14(金)〜11/15(土) ¥127,000（2泊）"、単日は "11/18(水) ¥98,000"
 */
export function toPriceRanges(
  d: PricingDashboard,
): { from: string; to: string; price: number; nights: number; label: string }[] {
  void d;
  throw new Error("not implemented");
}
