# ダイナミックプライシング・モジュール 設計書

仕様の原文は [pricing-spec.md](./pricing-spec.md)。本書はその実装設計と、仕様の数式を実データに当てはめるために
追加した判断 (実データ検証の結果に基づく) をまとめる。型と各関数の厳密な仕様は `src/lib/pricing/*.ts` の
JSDoc が正 (このドキュメントと食い違う場合は JSDoc を優先)。

## 実データ検証から決めた設計判断

| 事実 (2026-11 本番データ) | 設計への反映 |
|---|---|
| 仕様の厳格条件で CompSet は **5件** (ADR±30%が唯一効く制約。±40%で10件、±50%で15件) | `minSize` (既定8) を下回ると段階的に緩和し、緩和内容を必ず画面に明示。占有率は少数サンプル補正 (縮小推定) を適用 |
| 5件だと占有率が 0/20/40/…% の6段階しか取らず、1件の予約で α の閾値をまたぐ | 同区分・近いリードタイムの日の情報を借りる empirical Bayes 縮小推定 + 80%信用区間を表示 |
| AirROI の将来カレンダーは「予約済」と「ホストのブロック」を区別しない | 物件ごとの過去12ヶ月の 予約日/(予約日+ブロック日) でブロック分を除外推定 = 仕様の「有効競合総室数」 |
| CompSet 候補のカレンダー最終取得が数ヶ月前のものが多い | `freshnessDays` (既定10日) より古いカレンダーは使わない。未取得/古い件数と更新費用を画面に表示 |
| 祝日リストが2026年分のみ (60日先は2027年) | 年に依存しないアルゴリズムで祝日・振替休日・国民の休日を計算 |
| 一棟貸しかどうかは `details_json.listing_info.room_type == "entire_home"` で判定できる | 既存の property_type (個室も "house") ではなく room_type を使う |
| 自社 (Lumina) は AirROI 未収録で予約状況が取れない | Airbnb の iCal エクスポート URL の取り込み + 手動の予約済/ブロック指定 |
| 自社基準価格 ¥110,000 は品質同等の周辺物件の参照ADR最高値 (¥96,148) を上回る | 「基準価格の市場内パーセンタイル」を算出して警告表示 |
| 利用者は API 費用に敏感 ($27.60/月で問題視) | CompSet カレンダー取得は「件数×$0.10」を事前表示。通常の手動更新の上限 (dailyRatesCalls) の内側で優先取得 |

## 価格の式

```
P_raw = P_base × (1+δ) × (1+α) × (1+β) × (1+γ)
P     = clamp(round(P_raw, roundTo), Floor(区分), Ceiling(区分))
```
δ は仕様の「日別属性ごとの市場需給係数」のうち曜日属性 (週末プレミアム)。既定は競合の週末/平日 中央価格比から自動測定
(0〜50%、測定不能時は設定値15%)。α/β/γ は仕様 3.3 の表の範囲を線形補間で連続化 (境界で範囲の下端、極値で上端)。

## ファイルと担当

| ファイル | 担当 | 内容 |
|---|---|---|
| `src/lib/pricing/types.ts` | 契約 (変更不可) | 全型・API 契約 |
| `src/lib/pricing/config.ts` | 契約 (実装済み) | 既定値・検証・マスク |
| `holidays.ts` `compset.ts` `metrics.ts` (+ `*.test.ts`), `src/lib/dates.ts` | market-analytics | 祝日・区分、CompSet、指標 |
| `engine.ts` `simulate.ts` `alerts.ts` `compute.ts` `csv.ts` (+ `*.test.ts`) | pricing-engine | 係数・推奨・シミュレーション・アラート・統合・CSV |
| `config-store.ts` `load.ts` `demo.ts` `ical.ts` `pipeline.ts` `index.ts` (+ `*.test.ts`), `src/lib/db.ts`, `src/lib/airroi.ts`, `src/app/api/pricing/route.ts`, `src/app/api/cron/*`, `vercel.json`, `package.json` | data-ops | DB・取得・パイプライン・API・定期実行 |
| `src/app/pricing/page.tsx`, `src/components/pricing/*`, `src/components/Sidebar.tsx` | ui | 画面 |

## DBスキーマ (仕様5章)

`src/lib/db.ts` の `SCHEMA_SQL` に追加 (すべて CREATE … IF NOT EXISTS):

```sql
CREATE TABLE IF NOT EXISTS calendar_snapshots (
  snapshot_date TEXT NOT NULL,      -- 取得日 (JST)
  property_id   TEXT NOT NULL,
  target_date   TEXT NOT NULL,
  is_available  INTEGER NOT NULL,
  price_jpy     REAL NOT NULL,      -- 0 = 価格なし
  PRIMARY KEY (property_id, snapshot_date, target_date)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_target ON calendar_snapshots(target_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_date ON calendar_snapshots(snapshot_date);

CREATE TABLE IF NOT EXISTS pricing_recommendations (
  generated_date TEXT NOT NULL, target_date TEXT NOT NULL,
  lead_days INTEGER, day_type TEXT, day_type_reason TEXT,
  comp_units INTEGER, comp_occ REAL, comp_occ_adj REAL, comp_occ_raw REAL,
  comp_adr REAL, remaining_units INTEGER, pace_index REAL, new_bookings INTEGER, spike INTEGER,
  base_price REAL, delta REAL, alpha REAL, beta REAL, gamma REAL,
  raw_price REAL, floor_price REAL, ceiling_price REAL, recommended_price REAL, clamped_by TEXT,
  current_price REAL, own_status TEXT, deviation_pct REAL, action TEXT,
  PRIMARY KEY (generated_date, target_date)
);

CREATE TABLE IF NOT EXISTS pricing_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_date TEXT NOT NULL, target_date TEXT NOT NULL, kind TEXT NOT NULL,
  severity TEXT NOT NULL, message TEXT NOT NULL, notified_at TEXT,
  UNIQUE (generated_date, target_date, kind)
);

CREATE TABLE IF NOT EXISTS lumina_bookings (
  target_date TEXT PRIMARY KEY, status TEXT NOT NULL,  -- 'booked' | 'blocked'
  source TEXT NOT NULL,                                -- 'manual' | 'ical'
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

一度きりのバックフィル (`sync_state` の `migration:snapshot-backfill` で管理): 既存の daily_metrics を
`snapshot_date = date(fetched_at,'+9 hours')` として calendar_snapshots に INSERT OR IGNORE
(`target_date >= date(fetched_at,'+9 hours')` の行のみ)。過去に取得したカレンダーを予約曲線の観測として活かす。

## 取得・スナップショット (airroi.ts)

`refreshRatesForProperty` を拡張:
1. 上書き前に、その物件の既存 daily_metrics を **取得時点の状態** として calendar_snapshots に INSERT OR IGNORE
   (`snapshot_date = date(fetched_at,'+9 hours')`, `target_date >= その日`)。
2. 新しく取得したカレンダーのうち `target_date ∈ [today, today+75]` を `snapshot_date = today(JST)` で
   INSERT OR REPLACE (同日に再取得したら最新で上書き)。

`syncStep` に CompSet 優先取得を追加 (料金カレンダー更新の前):
- `selectCompsetRefreshTargets(db, { limit: min(capRemaining, config.compsetRefreshMax) })` の物件を
  `refreshRatesForProperty` で取得し、ratesCalls / capRemaining / ratesRefreshed に計上。
- 通常の手動更新 (skipCatalog) でも実行する (上限 dailyRatesCalls の内側なので「最大約$4」の約束は守られる)。
- 例外は握りつぶして同期全体を止めない。

## パイプラインと定期実行 (仕様6章)

- `vercel.json`: 日次同期を `0 17 * * *` (JST 02:00) に変更。アラート用に `/api/cron/pricing-alerts` を `0 22 * * *` (JST 07:00) で追加。
- `/api/cron/daily-sync`: 既存の同期 (自動同期オフなら SKIPPED) の **後に必ず** `runPricingPipeline(db, { notify: false })`
  を実行 (推奨価格の保存は API 費用ゼロのため自動同期の設定に関係なく行う)。応答 JSON に pricing 結果を含める。
- `/api/cron/pricing-alerts`: CRON_SECRET (Bearer) 検証の上 `runPricingPipeline(db, { notify: true })`。
- 通知先は環境変数 `ALERT_WEBHOOK_URL` (Slack/Discord の Incoming Webhook)。未設定ならアプリ内表示のみ。

## API (`/api/pricing`)

`types.ts` 末尾の `PricingApiRequest` / `PricingApiResponse` が契約。GET は `getPricingDashboard()`。
デモモード (DB 未設定) では GET のみ動作し、POST は `{ ok:false, message:"デモモードのため…" }` (HTTP 400)。
`refreshCompset` は `refreshCompsetCalendars(db, { maxCalls: config.compsetRefreshMax, staleDays: 1 })`。
`setOwnStatus` は date が今日−14〜今日+horizon の範囲のみ受け付け、"vacant" は manual 行の削除、
それ以外は `lumina_bookings` に source='manual' で UPSERT。

## 画面 (`/pricing`, ナビ「💹 価格最適化」)

スマートフォン (幅 390px) で主に閲覧される。横に広い要素は `overflow-x-auto` の中で横スクロール、それ以外は縦積み。
既存ページ (`src/app/lab/page.tsx`) と同じ骨組み (Sidebar + main) とトーン (slate/indigo, rounded-xl, text-xs〜sm)。

上から順に:
1. **ヘッダ + データ状況バー**: CompSet 件数 (厳格 n件 / 緩和の有無)、カレンダー新鮮 n/N 件、最新スナップショット日、
   Pace の可否、自社データの出所。ボタン「CompSetカレンダーを更新（約$X）」(押下前に confirm で件数と費用を表示)、
   「iCal取り込み」(iCal 設定時のみ)、「推奨価格を保存」。warnings を黄色の注意枠で列挙。
2. **アラート**: severity 別の色 (high=赤, medium=橙, info=灰)。日付クリックでタイムラインの該当列へスクロール・選択。
3. **サマリーKPIカード** (2列×n, スマホでも2列):
   平日平均競合占有率 vs 週末平均競合占有率 (並べた2本のバー) / 想定売上シミュレーション (推奨追従 vs 現行、差額と %、
   感応度 低〜高 のレンジ) / 要注意日 (Spike Dates) バッジ一覧 / 平均推奨価格 平日・週末 / 値上げ余地・値下げ検討の日数 /
   直近14日の実績占有率 (平日・週末)。
4. **60日タイムライン・ヒートマップ** (メインビュー): 横スクロール、左端に行ラベルを sticky。列 = 日付 (M/D + 曜、
   土=青, 日・祝=赤)。各列幅 ~52px。行:
   - 行1 自社: ステータスチップ (予約済=緑, 空室=白, ブロック=灰) / 現在価格 / 推奨価格 (太字) / 乖離率
     (値上げ余地=赤系「↑」, 値下げ検討=青系「↓」, 適正=灰)
   - 行2 区分: 平日/週末 タグ (週末は理由を title 属性で)
   - 行3 競合予約率: 0〜100% を白→黄→橙→赤のグラデーションで塗った セル + % 表示。dataQuality が low は斜線/薄く、none は「—」
   - 行4 競合残室数 & 平均価格 (残室 n / ¥xxk)
   - (補助行) Pace: ↑+12 のような表示、spike の日は⚡バッジ
   列クリックで **日別詳細パネル** を開く: 推奨価格の内訳 (P_base → ×(1+δ) → ×(1+α) → ×(1+β) → ×(1+γ) → ガードレール
   → 推奨) を各 reason 付きで表示、占有率 (補正前/ブロック補正/縮小推定 + 80%区間)、有効室数、Pace、
   自社ステータスの手動切替ボタン (予約済 / ブロック / 空室に戻す → setOwnStatus)。
5. **平日 vs 週末 ディープダイブ**: 左右 2 つのチャート (スマホでは縦積み)。散布図 (points: lead × occ) と
   折れ線 (fitted)、50%/80% の参照線、「50%到達: X日前 / 80%到達: Y日前」の注記。X 軸はリードタイム (日前) で
   右ほど遠い未来でも左ほど遠い未来でもよいが「日前」と明記。
   その下に 60 日の価格推移 (推奨価格・現在価格・競合中央価格の折れ線、週末の列を薄く塗る)。
6. **直近14日の実績**: 小さな帯 (日付・区分・実績占有率・競合中央価格・自社状況・直前7日の積み増し)。
7. **エクスポート**: 「詳細CSV」「OTA用CSV」ボタン (csv.ts を client で使い Blob ダウンロード、ファイル名に日付)。
8. **CompSet 一覧**: 距離・定員・参照ADR・評価・レビュー・カレンダー鮮度・厳格/緩和バッジ・Airbnb リンク。基準価格の
   市場内パーセンタイル。
9. **エンジン設定** (折りたたみ): 基準価格 (空=設定画面の値)、週末プレミアム (自動/固定と値)、下限・上限、丸め、
   CompSet 条件 (半径・ADR帯・定員・評価・レビュー・最小件数・一棟貸しのみ)、鮮度日数、ブロック補正、縮小推定の強さ、
   α/β/γ のパラメータ、CompSet 更新周期・上限件数 (月額目安 = 件数 × $0.10 × 30/周期 を表示)、弾力性シナリオ、
   iCal URL (マスク表示)、アラート閾値、特定連休。保存は saveConfig → router.refresh()。
10. **算出方法と限界** (`<details>`): 上記の設計判断、各係数の定義、縮小推定・ブロック補正・予約曲線・
    シミュレーションの前提 (弾力性は仮定であり実測ではないこと)。

数値表示: 価格は `¥110,000` (スペースの無い所は `¥110k`)、% は小数1桁まで。
