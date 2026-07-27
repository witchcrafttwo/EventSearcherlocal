# Requirements Document

## Introduction

えひめイベントナビの本番フロントをVercelからAWS Amplify Hostingへ移行する。将来的な自宅サーバー移行を前提に、アプリケーション本体をAmplify固有機能へ強く依存させず、既存のHono API、DynamoDB、Bedrock GLM-5、ローカル収集CLIを継続利用できる構成とする。

## Glossary

- **Amplify Hosting**: Viteで生成したフロント成果物を配信するAWSのホスティングサービス。
- **Hono API**: `packages/worker`にある、AWS Lambdaと自宅Nodeサーバーの両方から実行する共通API。
- **ローカル収集CLI**: 開発者PCから時間制限なしで既存DynamoDBへイベントを保存する`npm run ingest`。
- **環境固有アダプター**: Lambda、Vercel、Nodeサーバーなどの実行環境と共通Hono APIを接続する薄いエントリ。

## Requirements

### Requirement 1: Amplify Hostingへのフロント移行
**User Story:** 運用者として、Vite製SPAをAmplifyで安定して公開したい。

#### Acceptance Criteria
1. WHEN mainブランチへ対象変更が反映されたとき THEN システム SHALL `packages/web`をビルドしてAmplify Hostingへ配信する。
2. WHEN 利用者がSPA内の任意URLへ直接アクセスしたとき THEN システム SHALL `index.html`へフォールバックする。
3. THE SYSTEM SHALL PWA、Service Worker、地図、カレンダー、通知設定画面を現行どおり提供する。

### Requirement 2: 移植可能なAPI構成
**User Story:** 開発者として、当面はAWS上でAPIを運用し、将来は自宅サーバーへ容易に移したい。

#### Acceptance Criteria
1. THE SYSTEM SHALL 既存Honoアプリケーションのルートと業務処理を環境固有アダプターから分離する。
2. WHEN AWSで運用するとき THEN システム SHALL API GatewayとNode.js LambdaからHono APIを実行する。
3. WHEN 自宅サーバーへ移行するとき THEN システム SHALL 既存Nodeサーバーエントリから同じHono APIを実行できる。
4. THE SYSTEM SHALL フロントのAPI接続先を`VITE_API_BASE_URL`で切り替え可能にする。

### Requirement 3: 既存AWSデータとAIの継続利用
**User Story:** 運用者として、既存イベントデータを失わず移行したい。

#### Acceptance Criteria
1. THE SYSTEM SHALL 既存のProfiles、Events、Subscriptions、Sources各DynamoDBテーブルを継続利用する。
2. THE SYSTEM SHALL Bedrock GLM-5を直列実行し、モデルや処理順を変更しない。
3. WHEN LambdaがAWSサービスへアクセスするとき THEN システム SHALL長期アクセスキーではなくIAM実行ロールを使用する。
4. THE SYSTEM SHALL VAPID秘密鍵、管理トークンその他の秘密値をフロント成果物へ含めない。

### Requirement 4: 収集運用の維持
**User Story:** 運用者として、時間制限を受けずローカルPCからイベントを収集したい。

#### Acceptance Criteria
1. THE SYSTEM SHALL `npm run ingest`、`--force`、`--source`によるローカルCLI収集を維持する。
2. THE SYSTEM SHALL Amplify Hostingに収集処理を実行させない。
3. WHEN ローカルCLIが既存DynamoDBへ保存したとき THEN システム SHALL Amplify上の利用者画面へ同じデータを表示する。

### Requirement 5: 安全な段階移行
**User Story:** 運用者として、停止や機能欠落を避けながらVercelから移行したい。

#### Acceptance Criteria
1. THE SYSTEM SHALL Amplify版の検証完了までVercel固有設定を削除しない。
2. BEFORE 本番DNSまたは公開URLを切り替える THE SYSTEM SHALL 公開API、管理API、POST/PATCH、Web Push、SPA遷移、地図を検証する。
3. IF Amplify版で重大な問題が発生した THEN システム SHALL Vercel版へ戻せる状態を維持する。
4. WHEN 移行が完了したとき THEN システム SHALL 構築手順、環境変数名、IAM権限、将来の自宅サーバー切替手順を文書化する。
