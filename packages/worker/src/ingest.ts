import { sha256Hex } from "./crypto.js";
import { discoverCandidates, isDiscoveryEnabled } from "./discovery.js";
import { DynamoClient } from "./dynamo.js";
import { enrichCandidate } from "./event-ai.js";
import { buildGeoQuery, geocode } from "./geocode.js";
import { buildAiText, fetchPageData } from "./page.js";
import { fetchCandidates } from "./source-fetcher.js";
import { loadAllSources, recordIngestResult } from "./sources.js";
import type { Env, EventRecord, EventSourceConfig, PushSubscriptionRecord, RawEventCandidate, UserProfile } from "./types.js";

export async function runIngest(
  env: Env,
  options: { force?: boolean; limit?: number; sourceId?: string; maxMs?: number } = {}
): Promise<{ saved: number; notified: number; candidates: number }> {
  const { force = false, limit = Number.POSITIVE_INFINITY, sourceId, maxMs = Number.POSITIVE_INFINITY } = options;
  const startedAt = Date.now();
  const ddb = new DynamoClient(env);

  // AgentCore Web Search が設定済みなら自動発見、未設定なら登録済みURL(+環境変数)から収集
  let candidates: RawEventCandidate[];
  if (isDiscoveryEnabled(env)) {
    candidates = await discoverCandidates(env);
  } else {
    const allSources = await loadAllSources(env);
    const sources = sourceId ? allSources.filter((s) => s.id === sourceId) : allSources;
    candidates = await fetchCandidates(sources);
  }

  const profiles = await ddb.scanAll<UserProfile>(env.PROFILES_TABLE);
  const subscriptions = await ddb.scanAll<PushSubscriptionRecord>(env.SUBSCRIPTIONS_TABLE);

  // sourceId → 固定カテゴリ（管理画面で設定したサイトのみ）
  const forceCategoryById = new Map<string, string>();
  if (!isDiscoveryEnabled(env)) {
    for (const s of await loadAllSources(env)) {
      if (s.forceCategory) forceCategoryById.set(s.id, s.forceCategory);
    }
  }

  const newEvents: EventRecord[] = [];
  for (const candidate of candidates) {
    if (newEvents.length >= limit) break;
    // 時間予算を超えたら打ち切る（Vercelの60秒制限対策）。次回の収集で続きを処理する。
    if (Date.now() - startedAt > maxMs) break;
    const eventId = await createEventId(candidate.sourceId, candidate.url, candidate.title);
    if (!force) {
      const exists = await ddb.getItem<EventRecord>(env.EVENTS_TABLE, { eventId });
      if (exists) continue;
    }

    const hydrated = await hydrate(candidate);
    const enriched = await enrichCandidate(env, hydrated);
    if (!enriched) continue; // 一覧/索引ページなどはスキップ
    // 管理画面で固定カテゴリが設定されたサイトのみ上書き（未設定はAIの判定のまま）
    const forced = forceCategoryById.get(candidate.sourceId);
    if (forced) enriched.category = forced;
    // 住所/会場名からジオコーディングして正確な座標を付与（失敗時は市中心にフォールバック）
    const geoQuery = buildGeoQuery(enriched);
    const coords = geoQuery ? await geocode(geoQuery) : null;
    const event: EventRecord = {
      ...enriched,
      imageUrl: hydrated.imageUrl,
      ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      eventId,
      eventType: "event",
      createdAt: new Date().toISOString()
    };

    // force時は上書き、通常時は重複防止の条件付き
    await ddb.putItem(env.EVENTS_TABLE, event, force ? undefined : "attribute_not_exists(eventId)");
    newEvents.push(event);
  }

  const notified = await notifyMatches(env, newEvents, profiles, subscriptions);
  // ヘルスチェック記録（サイト単位の収集時のみ。候補0が続くとスクレイパー故障の目印になる）
  if (sourceId && !isDiscoveryEnabled(env)) {
    await recordIngestResult(env, sourceId, { candidates: candidates.length, saved: newEvents.length }).catch(() => undefined);
  }
  return { saved: newEvents.length, notified, candidates: candidates.length };
}

/** eventsテーブルを空にする（再収集前のリセット用） */
export async function clearEvents(env: Env): Promise<{ deleted: number }> {
  const ddb = new DynamoClient(env);
  const events = await ddb.scanAll<EventRecord>(env.EVENTS_TABLE);
  return deleteEventsInBatches(env, ddb, events);
}

/** 指定サイト（ソース）のイベントだけ削除。sourceId一致 or URLホスト一致で対象判定。 */
export async function clearEventsForSource(env: Env, source: EventSourceConfig): Promise<{ deleted: number }> {
  const ddb = new DynamoClient(env);
  const events = await ddb.scanAll<EventRecord>(env.EVENTS_TABLE);
  const host = hostOf(source.url);
  const targets = events.filter((ev) => ev.sourceId === source.id || (host !== "" && hostOf(ev.url) === host));
  return deleteEventsInBatches(env, ddb, targets);
}

async function deleteEventsInBatches(env: Env, ddb: DynamoClient, events: EventRecord[]): Promise<{ deleted: number }> {
  const BATCH = 25;
  for (let i = 0; i < events.length; i += BATCH) {
    const slice = events.slice(i, i + BATCH);
    await Promise.all(slice.map((event) => ddb.deleteItem(env.EVENTS_TABLE, { eventId: event.eventId })));
  }
  return { deleted: events.length };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * 定期収集(Cron)用。登録ソースを1つずつ順番に処理する。
 * 1サイトでエラーが出ても止めず、各ソースの新規処理には上限を付けて1回の実行を軽く保つ。
 */
export async function runScheduledIngest(env: Env, perSourceLimit = Number.POSITIVE_INFINITY): Promise<void> {
  if (isDiscoveryEnabled(env)) {
    await runIngest(env).catch((error) => console.error("scheduled ingest (discovery) failed", error));
    return;
  }

  const sources = await loadAllSources(env);
  for (const source of sources) {
    try {
      const result = await runIngest(env, { sourceId: source.id, limit: perSourceLimit });
      console.log(`ingest ${source.name}: saved ${result.saved}/${result.candidates}`);
    } catch (error) {
      console.error(`scheduled ingest failed for ${source.name}`, error);
    }
  }
}

async function notifyMatches(
  env: Env,
  events: EventRecord[],
  profiles: UserProfile[],
  subscriptions: PushSubscriptionRecord[]
): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || events.length === 0 || subscriptions.length === 0) return 0;

  // web-push は Node ライブラリ。変数指定の動的importにして、Node(Vercel)以外(wrangler等)の
  // バンドル/実行時に巻き込まれないようにする（未導入・非対応環境では送信をスキップ）。
  let webpush: any;
  try {
    const moduleName = "web-push";
    webpush = (await import(moduleName)).default ?? (await import(moduleName));
    webpush.setVapidDetails(
      env.VAPID_SUBJECT || "mailto:noreply@example.com",
      env.VAPID_PUBLIC_KEY,
      env.VAPID_PRIVATE_KEY
    );
  } catch {
    return 0; // web-push が使えない環境では送信しない
  }

  const ddb = new DynamoClient(env);
  const profileById = new Map(profiles.map((p) => [p.profileId, p]));
  let sent = 0;
  for (const sub of subscriptions) {
    const profile = profileById.get(sub.profileId);
    const matched = events.filter((event) => matchesForNotification(event, profile));
    if (matched.length === 0) continue;
    const first = matched[0];
    const payload = JSON.stringify({
      title: "えひめイベントナビ",
      body: matched.length === 1 ? first.title : `「${first.title}」など新着イベント${matched.length}件`,
      url: "/"
    });
    try {
      await webpush.sendNotification(
        { endpoint: sub.subscription.endpoint, keys: sub.subscription.keys },
        payload
      );
      sent++;
    } catch (error: any) {
      // 404/410 は購読が失効しているので削除（掃除）
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await ddb
          .deleteItem(env.SUBSCRIPTIONS_TABLE, { profileId: sub.profileId, endpointHash: sub.endpointHash })
          .catch(() => undefined);
      }
    }
  }
  return sent;
}

/** 通知用のマッチ判定: エリア（部分一致）＋カテゴリ（選択したものに含まれるか）。未設定は全件対象。 */
function matchesForNotification(event: EventRecord, profile?: UserProfile): boolean {
  if (!profile) return true;
  const area = (profile.area ?? "").trim();
  const eventArea = (event.area ?? "").trim();
  if (area && eventArea && !(eventArea.includes(area) || area.includes(eventArea))) return false;
  const categories = profile.interests ?? [];
  if (categories.length > 0) {
    if (!event.category || !categories.includes(event.category)) return false;
  }
  return true;
}

function createEventId(sourceId: string, url: string, title: string): Promise<string> {
  return sha256Hex(`${sourceId}:${url}:${title}`);
}

/** 候補の詳細ページを取得し、本文テキストを snippet に、代表画像を imageUrl に詰める */
async function hydrate(candidate: RawEventCandidate): Promise<RawEventCandidate> {
  const { text, imageUrl } = await fetchPageData(candidate.url);
  return {
    ...candidate,
    snippet: text ? buildAiText(text) : candidate.snippet,
    imageUrl: imageUrl ?? candidate.imageUrl
  };
}

/**
 * DynamoDB を使わず「取得→AI要約」だけ実行して結果を返す動作確認用。
 * テーブル未作成でもスクレイピング＋Bedrockの動きを確認できる。
 */
export async function previewIngest(env: Env, limit: number): Promise<{ count: number; events: Array<Omit<EventRecord, "eventId" | "eventType" | "createdAt">> }> {
  const allSources = isDiscoveryEnabled(env) ? [] : await loadAllSources(env);
  const forceCategoryById = new Map<string, string>();
  for (const s of allSources) {
    if (s.forceCategory) forceCategoryById.set(s.id, s.forceCategory);
  }

  const candidates = isDiscoveryEnabled(env)
    ? await discoverCandidates(env)
    : await fetchCandidates(allSources);

  const targets = candidates.slice(0, limit);
  const events = [];
  for (const candidate of targets) {
    const enriched = await enrichCandidate(env, await hydrate(candidate));
    if (enriched) {
      const forced = forceCategoryById.get(candidate.sourceId);
      if (forced) enriched.category = forced;
      events.push(enriched);
    }
  }
  return { count: candidates.length, events };
}
