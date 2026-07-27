import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import { sha256Hex } from "./crypto.js";
import { DynamoClient } from "./dynamo.js";
import { isDiscoveryEnabled, webSearch } from "./discovery.js";
import { debugEnrich, enrichCandidate } from "./event-ai.js";
import { clearEvents, clearEventsForSource, previewIngest, runIngest, runScheduledIngest } from "./ingest.js";
import { chat } from "./llm.js";
import { matchesProfile } from "./matching.js";
import { buildAiText, fetchPageData, fetchPageText } from "./page.js";
import { setupTables } from "./setup.js";
import { fetchCandidates } from "./source-fetcher.js";
import { buildGeoQuery, geocode } from "./geocode.js";
import { addSource, deleteSource, listSources, loadAllSources, updateSource } from "./sources.js";
import type { Env, EventRecord, EventSourceConfig, PushSubscriptionRecord, RawEventCandidate, UserProfile } from "./types.js";

const app = new Hono<{ Bindings: Env }>();
export { app };

app.use("*", cors());

// 管理系API(/admin/*, /sources*)はトークン保護。ADMIN_TOKEN未設定なら素通り(ローカル開発用)。
const adminAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const token = c.env.ADMIN_TOKEN;
  if (token && c.req.header("authorization") !== `Bearer ${token}`) {
    return c.json({ message: "unauthorized" }, 401);
  }
  await next();
};
app.use("/admin/*", adminAuth);
app.use("/sources", adminAuth);
app.use("/sources/*", adminAuth);

app.get("/health", (c) => c.json({ ok: true }));
app.get("/version", (c) => c.json({ version: "readtime-category-v2" }));

// Web Push 用の公開鍵をフロントへ渡す（購読時に applicationServerKey として使用）
app.get("/vapid-public-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? "" }));

app.post("/profiles", async (c) => {
  const body = await c.req.json<Partial<UserProfile>>();
  return c.json(await upsertProfile(c.env, body));
});

app.get("/profiles/:profileId/events", async (c) => {
  return c.json(await listEventsForProfile(c.env, c.req.param("profileId")));
});

// エリアで検索（市を選んでイベント一覧を取得）。?area=松山市 、未指定なら全件
app.get("/events", async (c) => {
  const area = (c.req.query("area") ?? "").trim();
  const ddb = new DynamoClient(c.env);
  // 全イベントをスキャンして取得する。以前は publishedAt(=収集時刻) の新しい順200件→100件に
  // 絞っていたため、先に収集したサイト(例: エミフル)のイベントが後の収集分に押し出されて
  // 消えていた。件数制限を撤廃し、全件を新しい順で返す。
  const events = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const allSources = await loadAllSources(c.env);
  const disabled = buildDisabledMatcherFrom(allSources);
  const applyForced = buildForcedCategory(allSources);
  const imagesHidden = buildImageHiddenMatcher(allSources);
  const filtered = events
    .filter((e) => e.eventType === "event")
    .filter((e) => !disabled(e)) // OFFのサイトは表示しない
    .filter((e) => {
      if (!area) return true;
      const ea = (e.area ?? "").trim();
      return ea !== "" && (ea.includes(area) || area.includes(ea));
    })
    .map((e) => {
      const forced = applyForced(e); // 固定カテゴリのサイトは表示時に上書き
      const withCategory = forced ? { ...e, category: forced } : e;
      // 画像OFFのサイトは表示時に画像URLを落とす（著作権対策・DBは書き換えない）
      if (imagesHidden(e)) {
        const { imageUrl, ...rest } = withCategory;
        return rest as EventRecord;
      }
      return withCategory;
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")); // 新しい順
  return c.json({ events: filtered });
});

// エリア選択肢: 表示対象(ON)のイベントから重複なしのエリア一覧を返す
app.get("/areas", async (c) => {
  const ddb = new DynamoClient(c.env);
  const events = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const disabled = await buildDisabledMatcher(c.env);
  const areas = [
    ...new Set(
      events
        .filter((e) => !disabled(e))
        .map((e) => (e.area ?? "").trim())
        .filter(Boolean)
    )
  ].sort();
  return c.json({ areas });
});

app.post("/profiles/:profileId/subscriptions", async (c) => {
  const subscription = await c.req.json<PushSubscriptionRecord["subscription"]>();
  return c.json(await saveSubscription(c.env, c.req.param("profileId"), subscription));
});

// スクレイピング+AI要約の動作確認用（DB不要）。?limit=件数 で要約する件数を指定。
app.get("/admin/scrape-test", async (c) => {
  const candidates = await fetchCandidates(await loadAllSources(c.env));
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 3), 1), 10);
  const sample = [];
  for (const candidate of candidates.slice(0, limit)) {
    const enriched = await enrichCandidate(c.env, candidate);
    if (enriched) sample.push(enriched);
  }
  return c.json({ found: candidates.length, titles: candidates.map((x) => x.title).slice(0, 30), sample });
});

app.post("/admin/ingest", async (c) => {
  const force = c.req.query("force") === "true";
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
  const sourceId = c.req.query("sourceId") || undefined;
  // 時間予算はクエリ maxMs で指定（例: ?maxMs=50000）。未指定なら無制限（ローカル収集用）。
  // 注意: Vercel(60秒制限)で使う場合は必ず maxMs を付けること。収集はローカルCLI(npm run ingest)推奨。
  const maxMsParam = Number(c.req.query("maxMs"));
  const maxMs = Number.isFinite(maxMsParam) && maxMsParam > 0 ? maxMsParam : undefined;
  return c.json(await runIngest(c.env, { force, limit, sourceId, maxMs }));
});

// eventsを削除。?sourceId=X で特定サイトのみ、指定なしで全件。
app.post("/admin/clear-events", async (c) => {
  const sourceId = c.req.query("sourceId");
  if (sourceId) {
    const source = (await loadAllSources(c.env)).find((s) => s.id === sourceId);
    if (!source) return c.json({ deleted: 0, message: "source not found" }, 404);
    return c.json(await clearEventsForSource(c.env, source));
  }
  return c.json(await clearEvents(c.env));
});

// 指定ソースが収集したイベント一覧（管理画面の確認用）。sourceId一致 or URLホスト一致で対象判定。
app.get("/admin/source-events", async (c) => {
  const sourceId = c.req.query("sourceId");
  if (!sourceId) return c.json({ message: "sourceId query required" }, 400);
  const source = (await loadAllSources(c.env)).find((s) => s.id === sourceId);
  if (!source) return c.json({ events: [], message: "source not found" }, 404);
  const ddb = new DynamoClient(c.env);
  const host = hostOf(source.url);
  const all = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const events = all
    .filter((e) => e.eventType === "event")
    .filter((e) => e.sourceId === source.id || (host !== "" && hostOf(e.url) === host))
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return c.json({ events });
});

// 単一イベントの削除（管理画面の個別削除用）
app.delete("/admin/events/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  const ddb = new DynamoClient(c.env);
  await ddb.deleteItem(c.env.EVENTS_TABLE, { eventId });
  return c.json({ ok: true, deleted: eventId });
});

// 単一イベントの手動編集（AIの誤りを直す用）。渡されたフィールドだけ上書きする。
app.patch("/admin/events/:eventId", async (c) => {
  const eventId = c.req.param("eventId");
  const body = await c.req.json<Partial<Pick<EventRecord, "title" | "summary" | "category" | "area" | "eventDate" | "eventEndDate" | "venue" | "address">>>();
  const ddb = new DynamoClient(c.env);
  const existing = await ddb.getItem<EventRecord>(c.env.EVENTS_TABLE, { eventId });
  if (!existing) return c.json({ message: "event not found" }, 404);
  const updated: EventRecord = { ...existing };
  for (const key of ["title", "summary", "category", "area", "eventDate", "eventEndDate", "venue", "address"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    const trimmed = String(value).trim();
    if (trimmed) (updated[key] as string) = trimmed;
    else if (key === "eventDate" || key === "eventEndDate" || key === "category" || key === "venue" || key === "address") delete updated[key]; // 任意項目は空でクリア可
  }
  // 住所/会場を編集したら座標を取り直す（失敗時は既存のまま）
  const geoQuery = buildGeoQuery(updated);
  if (geoQuery && (body.address !== undefined || body.venue !== undefined || body.area !== undefined)) {
    const coords = await geocode(geoQuery);
    if (coords) {
      updated.lat = coords.lat;
      updated.lng = coords.lng;
    }
  }
  await ddb.putItem(c.env.EVENTS_TABLE, updated);
  return c.json({ event: updated });
});

// 単一イベントをAIで要約し直す（元ページを取得して再enrich）。誤要約の修正用。
app.post("/admin/events/:eventId/reenrich", async (c) => {
  const eventId = c.req.param("eventId");
  const ddb = new DynamoClient(c.env);
  const existing = await ddb.getItem<EventRecord>(c.env.EVENTS_TABLE, { eventId });
  if (!existing) return c.json({ message: "event not found" }, 404);
  const { text, imageUrl } = await fetchPageData(existing.url);
  const candidate: RawEventCandidate = {
    sourceId: existing.sourceId,
    sourceName: existing.sourceName,
    sourceUrl: existing.url,
    title: existing.title,
    url: existing.url,
    area: existing.area,
    snippet: text ? buildAiText(text) : existing.summary,
    publishedAt: existing.publishedAt,
    imageUrl: imageUrl ?? existing.imageUrl
  };
  const enriched = await enrichCandidate(c.env, candidate);
  if (!enriched) return c.json({ message: "AI要約に失敗しました" }, 422);
  const geoQuery = buildGeoQuery(enriched);
  const coords = geoQuery ? await geocode(geoQuery) : null;
  const updated: EventRecord = {
    ...existing,
    ...enriched,
    eventId,
    eventType: "event",
    imageUrl: imageUrl ?? existing.imageUrl,
    ...(coords ? { lat: coords.lat, lng: coords.lng } : {})
  };
  await ddb.putItem(c.env.EVENTS_TABLE, updated);
  return c.json({ event: updated });
});

// 終了済みイベントの確認（プレビュー）。?days=0 なら「今日より前」。cutoff より前の終了日のものを数える。
app.get("/admin/expired-events", async (c) => {
  const days = Math.max(Number(c.req.query("days")) || 0, 0);
  const ddb = new DynamoClient(c.env);
  const events = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const expired = events.filter((e) => e.eventType === "event").filter((e) => isExpired(e, days));
  return c.json({
    count: expired.length,
    total: events.length,
    days,
    sample: expired.slice(0, 20).map((e) => ({ eventId: e.eventId, title: e.title, eventDate: e.eventDate, eventEndDate: e.eventEndDate }))
  });
});

// 終了済みイベントの一括削除。日付が取れないものは安全のため削除しない。
app.post("/admin/clear-expired", async (c) => {
  const days = Math.max(Number(c.req.query("days")) || 0, 0);
  const ddb = new DynamoClient(c.env);
  const events = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const expired = events.filter((e) => e.eventType === "event").filter((e) => isExpired(e, days));
  const BATCH = 25;
  for (let i = 0; i < expired.length; i += BATCH) {
    await Promise.all(expired.slice(i, i + BATCH).map((e) => ddb.deleteItem(c.env.EVENTS_TABLE, { eventId: e.eventId })));
  }
  return c.json({ deleted: expired.length });
});

// サイトの試し取得（dry-run）。AIを使わず候補URL/タイトルだけ返すので速い。保存しない。
app.get("/admin/preview-source", async (c) => {
  const sourceId = c.req.query("sourceId");
  if (!sourceId) return c.json({ message: "sourceId query required" }, 400);
  const source = (await loadAllSources(c.env)).find((s) => s.id === sourceId);
  if (!source) return c.json({ found: 0, candidates: [], message: "source not found" }, 404);
  const candidates = await fetchCandidates([source]);
  return c.json({
    found: candidates.length,
    candidates: candidates.slice(0, 60).map((x) => ({ title: x.title, url: x.url }))
  });
});

// Vercel Cron 用の定期収集トリガ（GET）。CRON_SECRET を設定した場合は Bearer 一致を要求。
// Vercel は CRON_SECRET を設定すると Authorization: Bearer <CRON_SECRET> を自動付与する。
app.get("/cron/ingest", async (c) => {
  const secret = c.env.CRON_SECRET;
  if (secret && c.req.header("authorization") !== `Bearer ${secret}`) {
    return c.json({ message: "unauthorized" }, 401);
  }
  c.executionCtx.waitUntil(
    runScheduledIngest(c.env).catch((error) => console.error("cron ingest failed", error))
  );
  return c.json({ ok: true, started: true });
});

// 初期セットアップ: DynamoDBテーブルを3つ作成（冪等）
app.post("/admin/setup-tables", async (c) => {
  return c.json(await setupTables(c.env));
});

// 情報源URLの管理（フロントのパネルから操作）
app.get("/sources", async (c) => {
  return c.json({ sources: await listSources(c.env) });
});

// ingestが実際に使う最終ソース一覧（ファイル+DB+env のマージ結果、AI無し）
app.get("/admin/sources-all", async (c) => {
  return c.json({ sources: await loadAllSources(c.env) });
});

// 統計: 保存イベント総数と、ソースごとの件数（管理画面表示用）
app.get("/admin/stats", async (c) => {
  const ddb = new DynamoClient(c.env);
  const events = await ddb.scanAll<EventRecord>(c.env.EVENTS_TABLE);
  const sources = await loadAllSources(c.env);
  const hostToId = new Map<string, string>();
  for (const s of sources) {
    const h = hostOf(s.url);
    if (h) hostToId.set(h, s.id);
  }
  const ids = new Set(sources.map((s) => s.id));
  const counts: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byArea: Record<string, number> = {};
  let unmatched = 0;
  for (const ev of events) {
    const id = ids.has(ev.sourceId) ? ev.sourceId : hostToId.get(hostOf(ev.url));
    if (id) counts[id] = (counts[id] ?? 0) + 1;
    else unmatched++;
    const cat = (ev.category ?? "").trim() || "未分類";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const area = (ev.area ?? "").trim() || "エリア不明";
    byArea[area] = (byArea[area] ?? 0) + 1;
  }
  return c.json({ total: events.length, counts, unmatched, byCategory, byArea });
});

app.post("/sources", async (c) => {
  const body = await c.req.json<{ url?: string; name?: string; area?: string; type?: string }>();
  return c.json({ source: await addSource(c.env, body) });
});

app.delete("/sources/:id", async (c) => {
  return c.json(await deleteSource(c.env, c.req.param("id")));
});

// ソースの属性更新（ON/OFF・固定カテゴリ）。固定カテゴリは表示時に動的適用するのでここは保存のみ（高速）。
app.patch("/sources/:id", async (c) => {
  const body = await c.req.json<{ enabled?: boolean; forceCategory?: string; showImages?: boolean; note?: string }>();
  const source = await updateSource(c.env, c.req.param("id"), body);
  return c.json({ source });
});

// DB不要の動作確認: 取得→AI要約 の結果だけ返す。?limit=3
app.get("/admin/ingest-preview", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 3, 1), 10);
  return c.json(await previewIngest(c.env, limit));
});

// デバッグ: 単一URLをスクレイプして候補(AI無し)を返す。?url=...
app.get("/admin/scrape-url", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ message: "url query required" }, 400);
  const type = /\.(xml|rss)(\?|$)|\/(feed|rss)\b/i.test(url) ? "rss" : "html";
  const candidates = await fetchCandidates([{ id: "debug", name: "debug", url, area: "", type }]);
  return c.json({
    found: candidates.length,
    candidates: candidates.slice(0, 40).map((x) => ({ title: x.title, url: x.url }))
  });
});
// デバッグ: 先頭候補の生AI出力を返す（フォールバック原因の特定用）
app.get("/admin/ai-debug", async (c) => {
  const url = c.req.query("url");
  if (url) {
    const text = await fetchPageText(url);
    const candidate = { sourceId: "debug", sourceName: "debug", sourceUrl: url, title: "debug", url, area: "", snippet: buildAiText(text), publishedAt: new Date().toISOString() };
    return c.json(await debugEnrich(c.env, candidate));
  }
  const candidates = await fetchCandidates(await loadAllSources(c.env));
  if (candidates.length === 0) return c.json({ message: "no candidates" });
  const hydrated = await hydrateForDebug(candidates[0]);
  return c.json(await debugEnrich(c.env, hydrated));
});

// Bedrock接続の動作確認用。?q=... で任意プロンプトを送れる。
app.get("/admin/ai-test", async (c) => {
  const prompt = c.req.query("q") ?? "こんにちは。接続テストです。10文字以内で挨拶を返してください。";
  const text = await chat(c.env, prompt);
  return c.json({ provider: c.env.AI_PROVIDER ?? "bedrock", model: c.env.AI_PROVIDER === "openai" ? c.env.LLM_MODEL : c.env.BEDROCK_MODEL_ID, text });
});

// AgentCore Web Search の動作確認用。?q=検索語 で検索結果を返す。
app.get("/admin/search-test", async (c) => {
  if (!isDiscoveryEnabled(c.env)) {
    return c.json({ enabled: false, message: "AgentCore Web Search の設定が未完了です" });
  }
  const query = c.req.query("q") ?? "新潟県 子ども イベント";
  const results = await webSearch(c.env, query, 5);
  return c.json({ enabled: true, query, results });
});

app.onError((error, c) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  return c.json({ message }, 500);
});

export default {
  fetch: app.fetch,
  // Cron Triggers（wrangler.toml の crons）で定期ingestを実行（1ソースずつ）
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduledIngest(env).catch((error) => {
        console.error("scheduled ingest failed", error);
      })
    );
  }
};

async function upsertProfile(env: Env, input: Partial<UserProfile>): Promise<{ profile: UserProfile }> {
  const now = new Date().toISOString();
  const profile: UserProfile = {
    profileId: input.profileId || crypto.randomUUID(),
    childAge: clampNumber(input.childAge, 0, 18),
    interests: normalizeStringArray(input.interests),
    area: String(input.area ?? "").trim(),
    notificationLeadDays: clampNumber(input.notificationLeadDays ?? 45, 1, 180),
    createdAt: input.createdAt || now,
    updatedAt: now
  };

  const ddb = new DynamoClient(env);
  await ddb.putItem(env.PROFILES_TABLE, profile);
  return { profile };
}

async function listEventsForProfile(env: Env, profileId: string): Promise<{ events: EventRecord[] }> {
  const ddb = new DynamoClient(env);
  const profile = await ddb.getItem<UserProfile>(env.PROFILES_TABLE, { profileId });
  if (!profile) return { events: [] };

  const events = await ddb.query<EventRecord>({
    tableName: env.EVENTS_TABLE,
    indexName: "publishedAtIndex",
    keyConditionExpression: "eventType = :eventType",
    expressionAttributeValues: { ":eventType": "event" },
    scanIndexForward: false,
    limit: 100
  });

  return {
    events: events.filter((item) => matchesProfile(item, profile)).slice(0, 50)
  };
}

async function saveSubscription(
  env: Env,
  profileId: string,
  subscription: PushSubscriptionRecord["subscription"]
): Promise<{ ok: true }> {
  if (!profileId) throw new Error("profileId is required");
  if (!subscription?.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) {
    throw new Error("Invalid push subscription");
  }

  const now = new Date().toISOString();
  const record: PushSubscriptionRecord = {
    profileId,
    endpointHash: await sha256Hex(subscription.endpoint),
    subscription,
    createdAt: now,
    updatedAt: now
  };

  const ddb = new DynamoClient(env);
  await ddb.putItem(env.SUBSCRIPTIONS_TABLE, record);
  return { ok: true };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [];
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

/** OFFソース判定: sourceId一致 or URLのホスト名一致で非表示にする（過去データのid不一致にも対応） */
async function buildDisabledMatcher(env: Env): Promise<(event: EventRecord) => boolean> {
  return buildDisabledMatcherFrom(await loadAllSources(env));
}

/** 既に取得済みのソース一覧からOFF判定を作る */
function buildDisabledMatcherFrom(sources: EventSourceConfig[]): (event: EventRecord) => boolean {
  const disabled = sources.filter((s) => s.enabled === false);
  const ids = new Set(disabled.map((s) => s.id));
  const hosts = new Set(disabled.map((s) => hostOf(s.url)).filter(Boolean));
  return (event) => ids.has(event.sourceId) || hosts.has(hostOf(event.url));
}

/** 画像非表示(showImages===false)のサイトに一致するか判定（表示時に画像を落とす用） */
function buildImageHiddenMatcher(sources: EventSourceConfig[]): (event: EventRecord) => boolean {
  const hidden = sources.filter((s) => s.showImages === false);
  const ids = new Set(hidden.map((s) => s.id));
  const hosts = new Set(hidden.map((s) => hostOf(s.url)).filter(Boolean));
  return (event) => ids.has(event.sourceId) || hosts.has(hostOf(event.url));
}

/** 固定カテゴリのサイトに一致したら、そのカテゴリを返す（表示時に上書き用） */
function buildForcedCategory(sources: EventSourceConfig[]): (event: EventRecord) => string | undefined {
  const forced = sources.filter((s) => s.forceCategory);
  const byId = new Map(forced.map((s) => [s.id, s.forceCategory as string]));
  const byHost = new Map(forced.map((s): [string, string] => [hostOf(s.url), s.forceCategory as string]).filter(([h]) => h));
  return (event) => byId.get(event.sourceId) ?? byHost.get(hostOf(event.url));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * イベントが「終了済み」か判定する。終了日(なければ開催日)が、今日から days 日前より前なら終了。
 * 日付が無い/パースできないものは false（＝安全のため削除対象にしない）。
 */
function isExpired(event: EventRecord, days: number): boolean {
  const raw = event.eventEndDate ?? event.eventDate;
  if (!raw) return false;
  const end = new Date(raw);
  if (Number.isNaN(end.getTime())) return false;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  return end < cutoff;
}

async function hydrateForDebug(candidate: RawEventCandidate): Promise<RawEventCandidate> {
  const text = await fetchPageText(candidate.url);
  return text ? { ...candidate, snippet: buildAiText(text) } : candidate;
}
