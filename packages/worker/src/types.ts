export type EventSourceConfig = {
  id: string;
  name: string;
  url: string;
  area: string;
  type: "html" | "rss";
  enabled?: boolean;
  forceCategory?: string; // 設定するとこのサイトのイベントは全てこのカテゴリに固定
  showImages?: boolean; // false にすると、このサイトのイベント画像を表示しない（著作権対策）。未設定は表示。
  note?: string; // 管理者用メモ（規約の要点など）。ユーザー画面には表示しない。
  lastIngestAt?: string; // 最終収集日時（ヘルスチェック用）
  lastCandidates?: number; // 直近収集での候補件数（0が続くとスクレイパー故障の疑い）
  lastSaved?: number; // 直近収集での新規保存件数
};

export type UserProfile = {
  profileId: string;
  childAge: number;
  interests: string[];
  area: string;
  notificationLeadDays: number;
  createdAt: string;
  updatedAt: string;
};

export type RawEventCandidate = {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  url: string;
  area: string;
  snippet: string;
  publishedAt: string;
  imageUrl?: string;
};

export type EventRecord = {
  eventId: string;
  eventType: "event";
  title: string;
  summary: string;
  url: string;
  area: string;
  sourceId: string;
  sourceName: string;
  publishedAt: string;
  eventDate?: string;
  eventEndDate?: string;
  category?: string;
  imageUrl?: string;
  venue?: string; // 会場名（AIが本文から抽出）
  address?: string; // 住所（AIが本文から抽出）
  lat?: number; // 住所/会場からジオコーディングした緯度（マップの正確なピン用）
  lng?: number; // 経度
  targetAgeMin?: number;
  targetAgeMax?: number;
  interests: string[];
  createdAt: string;
};

export type PushSubscriptionRecord = {
  profileId: string;
  endpointHash: string;
  subscription: {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  createdAt: string;
  updatedAt: string;
};

/** Cloudflare Workers の環境バインディング（wrangler.toml の vars / secrets） */
export type Env = {
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  PROFILES_TABLE: string;
  EVENTS_TABLE: string;
  SUBSCRIPTIONS_TABLE: string;
  SOURCES_TABLE: string;
  AI_PROVIDER?: string;
  BEDROCK_MODEL_ID: string;
  BEDROCK_REGION?: string; // Bedrock呼び出し専用リージョン（未指定ならAWS_REGION）
  // --- OpenAI互換の外部LLM（GLM / DeepSeek / OpenAI など）。AI_PROVIDER=openai のとき使用 ---
  LLM_BASE_URL?: string; // 例: https://api.z.ai/api/paas/v4
  LLM_API_KEY?: string; // secret
  LLM_MODEL?: string; // 例: glm-4.6
  EVENT_SOURCES_JSON?: string;
  INGEST_INTERVAL_MINUTES?: string;
  // --- AgentCore Web Search（自動発見 / IAM署名で呼ぶ）---
  AGENTCORE_GATEWAY_URL?: string; // 例: https://xxxx.gateway.bedrock-agentcore.us-east-1.amazonaws.com
  WEB_SEARCH_TOOL_NAME?: string; // tools/list で確認した名前。例: events-search___WebSearch
  SEARCH_AREAS?: string; // JSON配列。例: ["新潟県","新潟市"]
  SEARCH_MAX_RESULTS?: string; // 1-25
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ADMIN_TOKEN?: string; // secret。管理系API(/admin/*, /sources*)の認証トークン
  CRON_SECRET?: string; // Vercel Cron 用。設定すると /cron/ingest が Bearer 一致を要求
};
