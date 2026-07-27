import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import webpush from "web-push";
import { ddb, requiredEnv } from "./db.js";
import { enrichCandidate } from "./event-ai.js";
import { matchesProfile } from "./matching.js";
import { fetchCandidates } from "./source-fetcher.js";
import type { EventRecord, EventSourceConfig, PushSubscriptionRecord, UserProfile } from "./types.js";

export async function handler(): Promise<{ saved: number; notified: number }> {
  const sources = parseSources(process.env.EVENT_SOURCES_JSON ?? "[]");
  const candidates = await fetchCandidates(sources);
  const profiles = await scanAll<UserProfile>(requiredEnv("PROFILES_TABLE"));
  const subscriptions = await scanAll<PushSubscriptionRecord>(requiredEnv("SUBSCRIPTIONS_TABLE"));

  const newEvents: EventRecord[] = [];
  for (const candidate of candidates) {
    const eventId = createEventId(candidate.sourceId, candidate.url, candidate.title);
    const exists = await ddb.send(
      new GetCommand({
        TableName: requiredEnv("EVENTS_TABLE"),
        Key: { eventId }
      })
    );
    if (exists.Item) continue;

    const enriched = await enrichCandidate(candidate);
    const event: EventRecord = {
      ...enriched,
      eventId,
      eventType: "event",
      createdAt: new Date().toISOString()
    };

    await ddb.send(
      new PutCommand({
        TableName: requiredEnv("EVENTS_TABLE"),
        Item: event,
        ConditionExpression: "attribute_not_exists(eventId)"
      })
    );
    newEvents.push(event);
  }

  const notified = await notifyMatches(newEvents, profiles, subscriptions);
  return { saved: newEvents.length, notified };
}

function parseSources(value: string): EventSourceConfig[] {
  const parsed = JSON.parse(value) as EventSourceConfig[];
  return parsed.filter((source) => source.id && source.url && source.type);
}

async function scanAll<T>(tableName: string): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await ddb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    items.push(...((response.Items as T[] | undefined) ?? []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function notifyMatches(events: EventRecord[], profiles: UserProfile[], subscriptions: PushSubscriptionRecord[]): Promise<number> {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey || events.length === 0) return 0;

  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", publicKey, privateKey);

  let count = 0;
  for (const profile of profiles) {
    const matched = events.find((event) => matchesProfile(event, profile));
    if (!matched) continue;

    const profileSubscriptions = subscriptions.filter((subscription) => subscription.profileId === profile.profileId);
    for (const subscription of profileSubscriptions) {
      try {
        await webpush.sendNotification(
          subscription.subscription,
          JSON.stringify({
            title: "条件に合う新着イベントがあります",
            body: `${matched.title} - ${matched.area}`,
            url: `/?profileId=${encodeURIComponent(profile.profileId)}`
          })
        );
        count += 1;
      } catch {
        // Subscription cleanup can be added after operational logging is wired.
      }
    }
  }
  return count;
}

function createEventId(sourceId: string, url: string, title: string): string {
  return createHash("sha256").update(`${sourceId}:${url}:${title}`).digest("hex");
}
