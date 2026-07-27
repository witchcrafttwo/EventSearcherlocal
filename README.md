# えひめイベントナビ（prefecture-events-ai）

愛媛県内20市町のイベント情報を **スクレイピング → AI（Bedrock GLM-5）で要約・分類 → DynamoDB保存 → React製PWAで表示** するWebアプリのモノレポリポジトリです。

- 本番: Vercel で稼働（`https://event-searcher-server.vercel.app`）
- ユーザー画面（`/`）と管理画面（`/admin`）を提供

---

## 主な機能

### ユーザー画面（`/`）
- 市町 × カテゴリ（複数選択）でイベントを検索
- **日付で絞り込み**（今日 / 今週末 / 今月 / 期間指定）
- 開催日/新着で並び替え、終了イベントの非表示
- **イベント詳細モーダル**（カードをタップで拡大表示。詳しい説明＋会場のミニ地図＋元ページ/地図アプリへのリンク）
- **カレンダー表示**（月表示・日ごとにカテゴリを色分け表示。日をタップするとカテゴリ別に展開）
- **地図表示**（現在地を中心に、イベントを地図ピンで表示。クラスタリング＋地域/カテゴリで絞り込み）
- **ブックマーク**（localStorage保存）と **閲覧履歴**（タブで確認・消去可）
- 新着イベントの **NEW** タグ（収集から7日以内）
- **Web Push 通知**（選んだ地域・カテゴリの新着をお知らせ）
- **あなたにおすすめ**（ブックマーク・閲覧履歴からカテゴリ/エリアの好みを推定して提案。すべてローカルで完結）
- **文字サイズ変更（小・中・大）** と **トップへ戻るボタン**（ユーザビリティ配慮、設定はlocalStorage保存）
- スマホ最適化（タブ横スクロール・1カラム・全画面モーダル等）、テーマカラーは愛媛(みかん)のオレンジ系

### 管理画面（`/admin`、`ADMIN_TOKEN` で保護）
- 情報源（URL）の登録・削除・表示ON/OFF
- サイトごとの **固定カテゴリ** / **画像表示ON/OFF**（著作権対策）/ **メモ**
- 収集ヘルスチェック（最終収集日時・候補件数、0件が続くと警告）
- 試し取得（保存せず候補を確認）
- 収集データの一覧・検索・**個別編集/AI要約やり直し/個別削除**
- 統計（総数・カテゴリ別/エリア別内訳）
- 終了済みイベントの一括削除、サイト単位/全件の削除

---

## アーキテクチャ

```
[登録サイト] → スクレイパー(Hono) → Bedrock GLM-5(要約/分類/日付/会場・住所抽出)
     → 住所をジオコーディング(OSM Nominatim) → DynamoDB
     → API(/events 等) → React PWA(一覧/カレンダー/地図/詳細)
              ↑ 収集はローカルCLI(npm run ingest) または Cron(Vercel/node-cron)
```

- AWS SDK を使わず **aws4fetch（SigV4署名）** で DynamoDB / Bedrock を直接呼び出し、軽量化
- AI は **Amazon Bedrock 上の GLM-5**（`zai.glm-5`, ap-northeast-1）。並列化はしない（GLM-5が並列に弱いため直列処理）
- AIが会場名・住所も抽出し、**OpenStreetMap Nominatim** でジオコーディングして緯度経度を保存（地図の会場ピン用）

## 技術スタック

| 層 | 使用技術 |
|---|---|
| フロント | TypeScript / React 18 / Vite / lucide-react（PWA・Service Worker） |
| API | TypeScript / Hono |
| AI | Amazon Bedrock（GLM-5 / `zai.glm-5`） |
| DB | Amazon DynamoDB（ap-northeast-1） |
| 地図 | Leaflet + OpenStreetMap / leaflet.markercluster |
| ジオコーディング | OpenStreetMap Nominatim（無料・キー不要） |
| 通知 | Web Push（web-push + VAPID） |
| スクレイピング | fast-xml-parser / 正規表現ベース |
| ホスティング | Vercel（本番）/ 自宅サーバー等（Node）に移行可能 |
| IaC | AWS CDK（DynamoDBテーブル定義） |

---

## モノレポ構成

```
packages/
  web/     … React + Vite フロント（ユーザー画面 + 管理画面）
  worker/  … Hono製API（本体）。Vercel用エントリ(api/index.ts)と
             Node自宅サーバー用(src/server.ts, node-cron+静的配信)を含む
  infra/   … AWS CDK（DynamoDBテーブルのプロビジョニング）
  server/  … 初期プロトタイプ（Express + AWS SDK版・現在は未使用）
api/
  index.ts … Vercel用エントリ（req/resを手動でHonoのRequestに変換）
vercel.json … /api/* → API、それ以外 → SPA(index.html) のルーティング
```

DynamoDB テーブル（すべて ap-northeast-1）:
- `PROFILES_TABLE`（profileId）
- `EVENTS_TABLE`（eventId、GSI: `publishedAtIndex` = eventType×publishedAt。イベントは要約・カテゴリ・開催日・**会場名/住所/緯度経度**・画像URL等を保持）
- `SUBSCRIPTIONS_TABLE`（profileId × endpointHash）
- `SOURCES_TABLE`（id。表示ON/OFF・固定カテゴリ・画像ON/OFF・メモ・収集ヘルス情報）

---

## 環境変数

`packages/worker/.dev.vars`（ローカル）や Vercel の Environment Variables に設定します。

### 必須
| 変数 | 説明 |
|---|---|
| `AWS_REGION` | 例: `ap-northeast-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | DynamoDB/Bedrock 用のIAM認証（最小権限推奨） |
| `PROFILES_TABLE` / `EVENTS_TABLE` / `SUBSCRIPTIONS_TABLE` / `SOURCES_TABLE` | DynamoDBテーブル名 |
| `BEDROCK_MODEL_ID` | 例: `zai.glm-5` |

### 任意
| 変数 | 説明 |
|---|---|
| `BEDROCK_REGION` | Bedrock呼び出し専用リージョン（未指定なら `AWS_REGION`） |
| `ADMIN_TOKEN` | 管理系API(`/admin/*`, `/sources*`)の認証トークン。未設定だと素通り（ローカル用） |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push通知用（下記参照） |
| `CRON_SECRET` | Vercel Cron用。設定すると `/cron/ingest` が Bearer 一致を要求 |
| `EVENT_SOURCES_JSON` | 追加の情報源をJSON配列で指定 |
| `PORT` / `CRON_SCHEDULE` / `WEB_DIST` / `DISABLE_CRON` | 自宅サーバー(`server.ts`)用 |

> 注意: `.dev.vars` / `.env*` は Git 管理対象外（`.gitignore` 済み）。秘密情報をコミットしないこと。

---

## ローカル開発

前提: Node.js（18/20系）、npm。Windows(PowerShell)では `npm`/`npx` が実行ポリシーでブロックされる場合、`npm.cmd`/`npx.cmd` を使用。

```bash
npm install

# フロント（Vite, http://127.0.0.1:5173 など）
npm run web:dev

# API（Cloudflare Workers 互換のローカル: wrangler, http://127.0.0.1:8787）
npm --workspace @prefecture-events-ai/worker run dev

# もしくは Node版サーバー（API + 静的配信 + node-cron）
npm --workspace @prefecture-events-ai/worker run start   # tsx src/server.ts
```

- 動作確認: `GET /admin/scrape-url?url=...`（スクレイプ結果をAI無しで確認）
- ローカルは `ADMIN_TOKEN` 未設定なら管理APIは認証スキップ

### 型チェック / ビルド
```bash
npm run typecheck            # 全workspace
npm run build                # 全workspace
npm run build --workspace @prefecture-events-ai/web   # フロントのみ → packages/web/dist
```

### 収集（ローカルCLI・推奨）
Vercelの60秒制限を避けるため、**収集はローカルで時間無制限に実行**するのが基本です。DynamoDB はクラウド共有なので、ローカル収集の結果はそのまま本番サイトに反映されます。

```bash
# 全ソースを新規収集（時間制限なし）
npm run ingest
# 既存も上書き再収集（会場名/住所/座標の後付け等）
npm run ingest -- --force
# 特定サイトのみ
npm run ingest -- --source <sourceId>
```

- 認証情報は `packages/worker/.dev.vars`（または `.env`）から読み込みます。**Vercelと同じテーブル名・リージョン・AWSアカウント**を指していること。
- 管理画面（HTTP経由）の「今すぐ収集」は Vercel対策で `maxMs=50000`（50秒）cap。`/admin/ingest?maxMs=...` で調整可、未指定なら無制限。

---

## デプロイ

### A. Vercel（本番・現行）
- ルート `package.json` に `"type": "module"` 必須（ESM）
- `api/index.ts` が Vercel用エントリ。**Vercelが解析した `req.body` からRequestを再構築**して `app.fetch()` を呼ぶ（`getRequestListener` だとPOST/PATCHのボディ読み取りでハングするため）
- API は `/api` プレフィックスを除去してHonoのルート（`/events` 等）に渡す
- フロントは `VITE_API_BASE_URL=/api`（同一オリジン）
- 定期収集は **Vercel Cron**（`/api/cron/ingest`、無料プランは1日1回）
- 制約: 1リクエスト60秒。収集は `maxMs`（既定50秒）で打ち切り、再実行で続きを処理

### B. 自宅サーバー等（Node・移行時）
`packages/worker/src/server.ts` が API + フロント配信 + `node-cron` を1プロセスで担います。

1. フロントをビルド（`packages/web/dist` を生成）
   - **⚠ `VITE_API_BASE_URL` を空文字にして再ビルド**（自宅サーバーはAPIをルート直下にマウントするため。`/api` のままだと404）
2. `.env` を配置（上記の必須変数）
3. `npm --workspace @prefecture-events-ai/worker run start`（`tsx src/server.ts`）で起動。`web/dist` があれば自動配信
4. **HTTPS 必須**（Web Push / Service Worker / PWA のため）。Cloudflare Tunnel（ポート開放不要・推奨）またはリバースプロキシ(Caddy等)でTLSを付与
5. 常時起動は PM2 / systemd / NSSM(Windows) 等でプロセス常駐化
6. Vercelの60秒制限が無くなるので、`/admin/ingest` の `maxMs` を上げる/外すと一度に全件収集可能

---

## Web Push 通知のセットアップ

1. VAPID鍵を生成:
   ```bash
   node -e "console.log(require('web-push').generateVAPIDKeys())"
   ```
2. `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`(=`mailto:...`) を環境変数に設定
3. 再デプロイ後、ユーザー画面の「🔔 新着を通知で受け取る」で許可

- 通知は収集（Cron）で新着が保存されたタイミングでまとめて送信（リアルタイムではない）
- iOSはSafariでPWAを「ホーム画面に追加」した場合のみ通知可（iOS 16.4+）。Android Chrome/PCは対応

---

## 著作権への配慮

- 収集対象は robots.txt / 利用規約を個別確認のうえ選定。**自治体公式サイトを優先**
- 方針: **画像は原則表示しない・要約は短く・必ず元記事へリンク送客**
- 管理画面でサイトごとに画像ON/OFF・固定カテゴリ・規約メモを設定可能
- 規約が厳しいサイト（無断転載/要約禁止など）は画像OFF、または収集対象から除外

---

## ライセンス / 注意
- 本リポジトリは private プロジェクトです。
- 収集データの著作権は各情報源に帰属します。公開・二次利用の際は各サイトの利用規約を遵守してください。
