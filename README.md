# Lumina Fuji 競合分析・価格戦略Webアプリ

「Lumina Fuji Residence Yamanakako」のADR（客室単価）と稼働率の最大化を目的とした、山中湖・富士吉田・河口湖周辺エリアの競合分析・ダイナミックプライシング支援ダッシュボードです。

## 技術スタック

- **フロント/バックエンド**: Next.js (App Router) / TypeScript / Tailwind CSS / Recharts
- **データベース**: Turso DB (LibSQL / Edge SQLite)
- **データソース**: AirROI API（民泊アナリティクスAPI）
- **スケジューラ**: Vercel Cron（毎日 18:00 UTC = JST 深夜3時に自動同期）

## 主な機能

- **検索・フィルタリング**: エリア / 施設形態 / 価格帯 / 収容人数 / 寝室数 / 分析期間（過去30・90日、今後30・60・90日 Pacing）/ 曜日タイプ（平日・休前日・祝日）
- **KPIカード**: ADR、稼働率、RevPAR、Pacing稼働率（今後30/60日）、1人当たり単価、Lumina Fuji差異
- **グラフ分析**: 価格×稼働率 散布図 / 日別価格・稼働トレンド / エリア平均・上位20%・下位20%とのベンチマーク比較 / 定員別単価分布
- **競合物件一覧**: 並び替え・検索・CSVダウンロード対応
- **自動データ同期**: Vercel CronによるAirROI API日次同期、`sync_logs`によるAPIコール数のコスト監視

## セットアップ

```bash
npm install
cp .env.example .env.local   # 各種キーを設定
npm run dev
```

**環境変数を設定しない場合、決定的に生成されたデモデータで全機能が動作します**（画面に「デモデータモード」と表示されます）。

### Turso DB を使う場合

スキーマは初回アクセス時に自動作成されるため、`db:migrate` の手動実行は不要です。

1. [Turso](https://turso.tech/) にサインアップ (GitHubログイン可) し、CLIをインストール

   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```

2. データベースを作成し、接続情報を取得 (リージョンは東京 `nrt` 推奨)

   ```bash
   turso db create lumina-fuji --location nrt
   turso db show lumina-fuji --url        # → TURSO_DATABASE_URL
   turso db tokens create lumina-fuji     # → TURSO_AUTH_TOKEN
   ```

   ※ CLIを使わない場合は [Tursoダッシュボード](https://app.turso.tech/) からもDB作成・トークン発行が可能です。

3. `.env.local` (ローカル) または Vercel の環境変数に `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を設定
4. (任意) 自社実績の初期データ投入: `npx tsx scripts/seed-lumina.ts`
5. AirROIの `AIRROI_API_KEY` を設定し、ダッシュボードの「データ手動更新」ボタンまたは `POST /api/sync` で初回同期

### Vercel へのデプロイ

1. リポジトリをVercelにインポート
2. 環境変数（`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` / `AIRROI_API_KEY` / `CRON_SECRET`）をプロジェクト設定に追加
3. `vercel.json` の cron 設定により `/api/cron/daily-sync` が毎日自動実行されます
4. 簡易アクセス制限が必要な場合は `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` を設定（Basic認証が有効になります）

## API エンドポイント

| メソッド | パス | 説明 |
| --- | --- | --- |
| `POST` | `/api/sync` | AirROI手動同期（サイドバーのボタンから呼び出し） |
| `GET` | `/api/cron/daily-sync` | Vercel Cron用の日次同期（`CRON_SECRET`で保護） |

## データベーススキーマ

`src/lib/db.ts` に定義（仕様書準拠）:

- `properties` — 競合施設マスター
- `daily_metrics` — 日次価格・空室データ（時系列）
- `area_monthly_summaries` — 月次エリア集計キャッシュ
- `lumina_fuji_metrics` — 自社の設定価格・稼働実績
- `sync_logs` — API同期ログ（コスト監視）

## アーキテクチャ

```
[ AirROI API ]
      │ (REST / JSON)
      ▼
[ Vercel API Routes / Cron ] ──(変換)──► [ Turso DB (Edge SQLite) ]
      │                                        │
      ▼                                        ▼
[ Next.js Server Components ] ◄──────── [ 集計クエリ / Analytics ]
      │
      ▼
[ ダッシュボード UI (Recharts / Tailwind) ]
```

ダッシュボード閲覧時はAirROI APIを直接呼び出さず、常にTurso DBの同期済みデータを参照することでAPIコスト（Pay-per-call）を最小化しています。
