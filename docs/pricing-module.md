# ダイナミックプライシング・モジュール 設計書

仕様の原文は [pricing-spec.md](./pricing-spec.md)。本書はその実装設計と、仕様の数式を実データに当てはめるために
追加した判断 (実データ検証・設計レビューの結果に基づく) をまとめる。型と各関数の厳密な仕様は
`src/lib/pricing/*.ts` の JSDoc が正 (このドキュメントと食い違う場合は JSDoc を優先)。

## 実データ検証・設計レビューから決めた設計判断

| 事実 | 設計への反映 |
|---|---|
| 仕様の厳格条件で CompSet は **5件** (ADR±30%が唯一効く制約。±40%で10件、±50%で15件) | 半径は仕様上限 7km を既定。`minSize` (既定8) を下回ると ADR帯→定員→評価/レビュー の順に段階的に緩和し、内容を必ず表示 |
| 5件だと占有率が 0/20/40/…% の6段階しか取らず、1件の予約で α の閾値をまたぐ | 同区分・近いリードタイムの日の情報を借りる empirical Bayes 縮小推定 + 80%信用区間 |
| AirROI の将来カレンダーは「予約済」と「ホストのブロック」を区別しない | 物件ごとの過去12ヶ月の 予約日/(予約日+ブロック日) でブロック分を除外推定 = 仕様の「有効競合総室数」 |
| CompSet 候補のカレンダー最終取得が数ヶ月前のものが多い / 取得失敗でも rates_synced_at は進む | 鮮度は「最終取得成功日 (daily_metrics.fetched_at の最大)」で判定。直前の日ほど新しい観測を要求 (lead-aware)。取得失敗を繰り返す物件は再取得しない |
| 当日に近づけば自然に埋まる。5件だと1件の予約で +20pt | Pace は予約曲線から期待される通常の積み増しを差し引いた「超過ペース」。急増は新規予約2件以上も必須 |
| 祝日リストが2026年分のみ (60日先は2027年) | 年に依存しないアルゴリズムで祝日・振替休日・国民の休日を計算 |
| 一棟貸しかどうかは `details_json.listing_info.room_type == "entire_home"` で判定できる | 既存の property_type (個室も "house") ではなく room_type を使う |
| 自社 (Lumina) は AirROI 未収録 → 予約状況も現在価格も取れない。現在価格はどの日も基準価格 ¥110,000 の代替値 | 予約状況は iCal 取り込み + 手動指定。現在価格は「Airbnb で設定中の価格 (平日/週末)」を設定で入力。未入力なら乖離率・値上げ/値下げ判定・関連アラートは出さず、シミュレーションは「固定シーズン料金 (仮定)」と比較 |
| 自社基準価格 ¥110,000 は品質同等の周辺物件の参照ADR最高値 (¥96,148) を上回る | 想定平均単価の市場内順位を算出して表示。シミュレーションの参照価格は自社の品質プレミアムを保った市場連動価格 |
| シミュレーションの結果は弾力性の仮定で符号まで変わる。一定弾力性モデルの「損益分岐の弾力性」は売上 ∝ P^(1+ε) のため価格・日によらず常に −1 で情報が無く、値下げ日では有利な向きも逆 | 需要モデルに依存しない「損益分岐の予約数変化」(値上げ日: 何%予約が減っても売上維持 / 値下げ日: 何%増えれば元が取れる) を主表示にし、弾力性3シナリオは仮定の幅として併記。成約確率はその日の競合の残り在庫で条件付け (埋まっている日ほど高い)。予約曲線は年末年始などピーク期間の夜を除外 |
| 本番の初期状態 (新鮮な競合カレンダーが1件だけ) で、ルールのみの推奨と AirROI の実価格を比べて「−19.5% 値下げ」を出していた。KPI の平均占有率も1物件の 0%/100% を平均していた | 競合データ不足の日 (rules_only) は値上げ/値下げ判定・アラート・β(Pace)・要注意日を出さない。KPI 占有率・直近14日実績は有効物件数が minUnitsForSignal 以上の日だけで算出 |
| 自社の予約状況が未連携の日は空室と仮定して推奨を出す | 画面では「不明」と表示し、週末残室アラートは medium (「自社が空室なら」) に。反映一覧にも注意を表示 |
| 利用者は API 費用に敏感 ($27.60/月で問題視) | CompSet の自動取得は既定オフ (オンにすると月額目安を表示)。「今すぐ取得」は確認ダイアログに表示した件数・費用と実際の取得を一致させる。1日あたり上限・同日再取得なし・同一オリジン以外からの POST 拒否。並行実行 (cron の二重配信・ボタン同時押し) でも上限を超えないよう、日次枠は条件付き UPSERT で原子的に確保して未使用分を差し戻し、物件は「今日未試行なら」の条件付き UPDATE で確保してから取得 |
| CompSet が minUnitsForSignal 未満だと、カレンダーを取得しても競合連動にならない | 「競合データなし」の案内を原因別に出し、CompSet が小さい場合は有料の取得ボタンを出さず条件の見直しを促す |
| 直前の未稼働値下げ (最大−25%) は、競合が満室の夜でも基準価格を下回る | 直前値下げは競合の逼迫度に応じて縮小 (占有率が中位帯未満なら仕様どおり満額) |

## 価格の式

```
P_raw = P_base × (1+δ) × (1+α) × (1+β) × (1+γ)
P     = clamp(round(P_raw, roundTo), Floor(区分), Ceiling(区分))
```
δ は仕様の「日別属性ごとの市場需給係数」のうち曜日属性 (週末/特定連休プレミアム)。既定は CompSet の同一物件内の
週末/平日・連休/平日 価格比から自動測定 (週末 0〜50%、連休 0〜150%。測定不能時は設定値 15% / 30%)。
α/β は区分 (平日・週末) 別のパラメータで、仕様 3.3 の表の範囲を線形補間で連続化 (境界で範囲の下端、極値で上端)。

## ファイルと担当

| ファイル | 担当 | 内容 |
|---|---|---|
| `src/lib/pricing/types.ts` `config.ts` | 契約 (変更不可) | 全型・API 契約・既定値と検証 |
| `holidays.ts` `compset.ts` `metrics.ts` (+ `*.test.ts`), `src/lib/dates.ts` | market-analytics | 祝日・区分、CompSet、指標 |
| `engine.ts` `simulate.ts` `alerts.ts` `compute.ts` `csv.ts` (+ `*.test.ts`) | pricing-engine | 係数・推奨・シミュレーション・アラート・統合・エクスポート |
| `config-store.ts` `load.ts` `demo.ts` `ical.ts` `pipeline.ts` `index.ts` (+ `*.test.ts`), `src/lib/sync-config.ts` (新規), `src/lib/db.ts`, `src/lib/airroi.ts`, `src/app/api/pricing/route.ts`, `src/app/api/cron/*`, `vercel.json`, `package.json` | data-ops | DB・取得・パイプライン・API・定期実行 |
| `src/app/pricing/page.tsx`, `src/components/pricing/*`, `src/components/Sidebar.tsx` | ui | 画面 |

`src/lib/dates.ts`: `isHoliday(d)` を `isJpHoliday(d) || 日曜` にする (2026年限定リストと 12/31 を廃止)。
`matchesDayType` の意味 (既存画面の 平日=月〜木) は変えない。プライシングは `classifyNight` のみを使う。

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
  comp_adr REAL, remaining_units INTEGER, pace_index REAL, pace_raw REAL, new_bookings INTEGER, spike INTEGER,
  base_price REAL, delta REAL, alpha REAL, beta REAL, gamma REAL,
  raw_price REAL, floor_price REAL, ceiling_price REAL, recommended_price REAL, clamped_by TEXT,
  current_price REAL, current_price_source TEXT, own_status TEXT, change_pct REAL, action TEXT, signal TEXT,
  PRIMARY KEY (generated_date, target_date)
);

CREATE TABLE IF NOT EXISTS pricing_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_date TEXT NOT NULL, target_date TEXT NOT NULL, kind TEXT NOT NULL,
  severity TEXT NOT NULL, message TEXT NOT NULL, notified_at TEXT,   -- 'skipped' = 送らず破棄
  UNIQUE (generated_date, target_date, kind)
);

CREATE TABLE IF NOT EXISTS lumina_bookings (
  target_date TEXT PRIMARY KEY, status TEXT NOT NULL,  -- 'booked' | 'blocked' | 'vacant' (vacant は manual のみ)
  source TEXT NOT NULL,                                -- 'manual' | 'ical'
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
注: lumina_bookings は日付が主キーのため、同じ日に manual と ical は共存しない。manual が優先 (ical の取り込みは
manual 行のある日を上書きしない)。手動指定の解除 = その日の manual 行を削除 (次回の iCal 取り込みで ical 行が入る。
解除時に直前の iCal 結果は失われるので、解除後に iCal を再取り込みする)。

一度きりのバックフィル (`sync_state` の `migration:snapshot-backfill` で管理, 成功後にフラグを立てる):
```sql
INSERT OR IGNORE INTO calendar_snapshots (snapshot_date, property_id, target_date, is_available, price_jpy)
SELECT date(fetched_at,'+9 hours'), property_id, target_date, is_available,
       CASE WHEN is_available THEN price_jpy ELSE 0 END
FROM daily_metrics
WHERE date(fetched_at,'+9 hours') >= date('now','+9 hours','-120 days')
  AND target_date BETWEEN date(fetched_at,'+9 hours') AND date(fetched_at,'+9 hours','+134 days');
```
`ensureSchema` は既存どおり各リクエストで呼ばれるため、プロセス内メモ化 (1回だけ) を追加する。

## 取得・スナップショット (airroi.ts)

- `SyncConfig` / `getSyncConfig` / `saveSyncConfig` と関連既定値を **新しい葉モジュール `src/lib/sync-config.ts`** へ移す
  (`@libsql/client` の型以外を import しない)。airroi.ts は再エクスポートして既存の import を壊さない。
- `refreshRatesForProperty`: 取得成功時、取得したカレンダーのうち `target_date ∈ [today, today+134]` を
  `snapshot_date = today(JST)` で calendar_snapshots に INSERT OR REPLACE (同日に再取得したら最新で上書き)。
  上書き前の旧状態の退避はしない (バックフィルと毎回の保存で足りる)。
- `syncStep` には CompSet 取得を **追加しない** (費用の経路を増やさない。CompSet は下記の定期実行と専用ボタンのみ)。

## パイプラインと定期実行 (仕様6章)

- `vercel.json`: 日次同期を `0 17 * * *` (JST 02:00) に変更。アラート用に `/api/cron/pricing-alerts` を `0 22 * * *` (JST 07:00) で追加
  (Hobby プランでも日次2本は可)。
- `/api/cron/daily-sync` (CRON_SECRET の Bearer 検証は既存どおり):
  1. 既存の `runChunkedSync('cron_daily')` (例外は捕捉して結果に含める。自動同期オフなら SKIPPED)
  2. DB があれば `ensureSchema` → pricing 設定の `compsetAutoRefresh` が true なら
     `refreshCompsetCalendars(db, { maxCalls: compsetRefreshMax, staleDays: compsetRefreshDays, deadline: 開始+250秒 })`
     (自動同期の設定とは独立。関数の上限 300 秒内に 3 まで終えるよう取得を打ち切る)
  3. `runPricingPipeline(db, { notify: false })` (費用ゼロのため常に実行)
  各段の例外は捕捉して JSON に含め、HTTP ステータスは同期の結果のみで決める。デモモードは pricing を `{ skipped: "demo" }`。
- `/api/cron/pricing-alerts`: 同じ Bearer 検証 → `ensureSchema` → `runPricingPipeline(db, { notify: true })`。
- 通知先は環境変数 `ALERT_WEBHOOK_URL` (Slack/Discord の Incoming Webhook)。未設定ならアプリ内表示のみ (画面にその旨を表示)。
  送信前に対象行を一時値 (`sending:…`) で確保し、送れなければ未通知に戻す (並行実行で二重送信しない・次回再送できる)。
- Bearer の比較は `src/lib/cron-auth.ts` (Vercel が送る生の値と、空白・引用符を除いた値の両方を受け付ける)。
- `runPricingPipeline(db: Client | null, opts)` / `loadPricingInputs(db = getDb())` は DB を引数で受ける (テストで差し替え。null はデモ)。

### 運用上の注意 (セキュリティ)

- アプリ全体の認証は `middleware.ts` の Basic 認証 (環境変数 `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`) のみで、未設定だと
  既存の `/api/sync` `/api/settings` を含め誰でも操作できる。`/api/pricing` の POST は同一オリジン判定で他サイトからの
  リクエストは拒否するが、これは認証ではない。本番では Basic 認証の環境変数と `CRON_SECRET` の設定を推奨。
  Basic 認証を有効にしても、`/api/pricing` は `CRON_SECRET` と一致する Bearer なら middleware を通す (リモート操作用)。
- iCal URL は Airbnb の公式ドメインの完全一致のみ許可し、リダイレクトは Airbnb の iCal URL への転送だけ最大3回追う。本文は 2MB まで。
- API のエラー応答に DB のエラー文を含めない (サーバーログにのみ出力)。

## API (`/api/pricing`)

`types.ts` 末尾の `PricingApiRequest` / `PricingApiResponse` が契約。GET は `getPricingDashboard()`。
- POST は同一オリジン (`Sec-Fetch-Site: same-origin`、または `Origin` のホスト = `Host`) か `Authorization: Bearer CRON_SECRET`
  のときのみ。それ以外 403。デモモード (DB 未設定) は `{ ok:false, message:"デモモードのため…" }` (HTTP 400)。
- `saveConfig`: `mergeEditedPricingConfig(現在値, config)` を保存。icalUrl が渡されて `isAllowedIcalUrl` を満たさない場合は
  保存せず `{ ok:false, message:"Airbnb のカレンダーエクスポート URL（https://www.airbnb.…/calendar/ical/…）を入力してください" }`。
- `refreshCompset { ids }`: `refreshCompsetCalendars(db, { ids, maxCalls: config.compsetRefreshMax, staleDays: 1 })`。
  応答の message に「{refreshed}件を取得しました（約${costUsd}）」、日次上限で取得しなかった分があればその旨。
- `setOwnStatus { date, status }`: date が today−14〜today+horizon の範囲のみ。`lumina_bookings` に source='manual' で UPSERT
  (status は booked/blocked/vacant)。message に結果の状態。
- `clearOwnStatus { date }`: その日の manual 行を削除。message に「手動指定を解除しました（次回のiCal取り込みで反映）」等。
- `importIcal`: `importIcalToDb` を実行し件数を返す。
- `persist`: `runPricingPipeline(db, { notify: false })`。

## 画面 (`/pricing`, ナビ「💹 価格最適化」)

主に **スマートフォン (幅 390px)** で閲覧される。既存ページ (`src/app/lab/page.tsx`) と同じ骨組み (Sidebar + main) と
トーン (slate/indigo, rounded-xl, text-xs〜sm)。上から順に:

1. **状態バナー** (`status.mode` 別、最上部):
   - `no_market_data`: 黄枠「競合データ未取得のため、現在の推奨は『曜日・直前ルールのみ』です。競合カレンダーを取得
     （{refreshPlan.count}件・約${costUsd}）すると競合連動になります」+ 取得ボタンをその場に
   - `demo`: 灰枠「デモデータを表示中（実際の予約・競合データではありません）」。POST 系ボタンはすべて無効化
   - `partial`: 小さな注記「一部の日は競合データ不足のためルールのみで算出」
2. **データ状況バー**: CompSet {members}件 (厳格 {strictCount}件 / 緩和あり)、カレンダー新鮮 {fresh}/{members}、
   最新スナップショット日、Pace (算出済み / {paceAvailableFrom} から)、自社予約の出所 (iCal/手動/未連携)、
   自社価格の出所 (実価格/入力値/仮定)、通知 (毎朝7:00に通知 / 通知なし)、自動取得 (オン: 約$X/月 / オフ)。
   ボタン「競合カレンダーを取得（{count}件・約${costUsd}）」: count=0 またはデモでは非表示。押下時の confirm に
   「{count}件 × $0.10 = 約${costUsd}（約¥{round(costUsd×150)}）を AirROI に支払います。実行しますか？」。
   応答の実件数・実費用をそのまま表示。「iCal取り込み」(iCal 設定時のみ)。warnings を黄色の注意枠で列挙。
   ※「推奨価格を保存」ボタンは置かない (定期実行が毎日保存する。Airbnb への反映と誤解されるため)。
3. **アラート**: severity 別の色 (high=赤, medium=橙, info=灰)。日付タップで該当日を選択 (詳細を開く)。
4. **サマリーKPIカード** (スマホでも2列):
   平日平均競合占有率 vs 週末平均競合占有率 (並べた2本のバー) / 想定売上シミュレーション (主表示 = 損益分岐の予約数変化
   「値上げ N日（平均 +x%）: 予約が y% 減っても売上は同等以上」「値下げ M日: 予約が z% 以上増えれば売上増」、
   その下に弾力性 低・中・高 の試算 (%) と中シナリオの金額。弾力性は仮定である旨を明記)
   / 要注意日 (Spike Dates) バッジ一覧 / 平均推奨価格 平日・週末 / 値上げ余地・値下げ検討の日数 / 直近14日の実績占有率。
5. **60日ビュー (メイン)**: 画面幅で切り替える。
   - **md 未満 (スマホ)**: 月カレンダー形式 (7列 × 週の行、各セル ~50px)。セル = 日付・推奨価格 `¥127k`・
     背景色 = 競合占有率 (白→黄→橙→赤。dataQuality low は斜線、none は「—」)・自社状況の点 (予約済=緑, ブロック=灰)・
     spike は ⚡・`night.tag` (連休/祝前/金/土/祝) の小さな文字。rules_only の価格は細字。タップで詳細をボトムシートで開く。
   - **md 以上**: 横スクロールのタイムライン (左端の行ラベルを sticky、列幅 ~56px、列 = M/D + 曜 + tag。土=青, 日・祝=赤)。行:
     - 行1 自社: 状況チップ (予約済=緑, 空室=白, ブロック=灰) / 現在価格 (assumed は灰色+「仮」) / 推奨価格
       (signal=market は太字、rules_only は細字+「ルール」) / 乖離率 = changePct (`+15%↑` 赤系, `−8%↓` 青系, null は「—」)
     - 行2 区分: 平日/週末 タグ + `night.tag`
     - 行3 競合予約率: 0〜100% のグラデーション + % 表示 (low は斜線、none は「—」)
     - 行4 競合残室 & 中央価格: `空{remaining}/{units}` と `¥xxk` (units=0 は「—」)
     - 補助行 Pace: `+12` (超過 pt/7日)、spike は ⚡
   - **日別詳細** (パネル/ボトムシート): 推奨価格の内訳 (P_base → ×(1+δ) → ×(1+α) → ×(1+β) → ×(1+γ) → ガードレール
     → 推奨) を各 reason 付きで、占有率 (補正前/ブロック補正/縮小推定 + 80%区間)、有効室数、Pace (生・期待・超過)、
     その日の競合一覧 (market.listings を compset.members と結合: 予約不可の物件名 / 空きの物件名と価格)、`night.reason`、
     自社の状況切替 (予約済 / ブロック / 空室 を手動指定 → setOwnStatus。manual のときだけ「手動指定を解除」→ clearOwnStatus)。
6. **平日 vs 週末 ディープダイブ**: 左右 2 つのチャート (スマホは縦積み)。散布図 (points) + 折れ線 (fitted)、
   50%/80% の参照線、「50%到達: X日前 / 80%到達: Y日前」。**X 軸はリードタイムで左=60日前 → 右=当日**
   (右に行くほど埋まる)。その下に 60 日の価格推移 (推奨・現在・競合中央価格の折れ線、週末の列を薄く塗る)。
7. **直近14日の実績**: 小さな帯 (日付・区分・実績占有率・競合中央価格・自社状況・直前7日の積み増し)。
8. **推奨価格の反映**: Airbnb には価格の CSV 取込機能が無いことを明記。`toPriceRanges` の一覧
   (「11/14(金)〜11/15(土) ¥127,000（2泊）」) をコピーボタン付きで表示 (Airbnb アプリで期間を選んで入力する用)。
   ダウンロード: 「詳細CSV（分析用）」「価格CSV（表計算・チャネルマネージャ取込用）」(Blob、ファイル名に日付)。
9. **CompSet 一覧**: 距離・定員・参照ADR・評価・レビュー・カレンダー状況 (新鮮/古い/未取得/取得失敗)・厳格/緩和バッジ・
   Airbnb リンク。自社の市場内順位 (basePricePercentile / basePriceAboveAll)。
10. **エンジン設定** (折りたたみ): Airbnb で設定中の価格 (平日/週末)、基準価格 (空=設定画面の値)、週末/連休プレミアム
    (自動/固定と値)、下限・上限、丸め、CompSet 条件 (半径・ADR帯・定員・評価・レビュー・最小件数・一棟貸しのみ)、
    鮮度日数、ブロック補正、縮小推定の強さ、α/β (平日・週末タブ) と γ のパラメータ、CompSet 自動取得 (オン/オフ・周期・
    上限件数。月額目安 = min(件数, 上限) × $0.10 × 30/周期 をその場で計算表示)、弾力性シナリオ、iCal URL (マスク表示)、
    アラート閾値、特定連休。保存は saveConfig → router.refresh()。
11. **算出方法と限界** (`<details>`): 上記の設計判断、各係数の定義、縮小推定・ブロック補正・超過Pace・予約曲線・
    シミュレーションの前提 (弾力性は仮定であり実測ではないこと)、Airbnb に CSV 取込が無いこと。

数値表示: 価格は `¥110,000` (狭いセルは `¥110k`)、% は小数1桁まで。
