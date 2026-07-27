import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { ddb, requiredEnv } from "./db.js";
import { matchesProfile } from "./matching.js";
import type { EventRecord, PushSubscriptionRecord, UserProfile } from "./types.js";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "content-type": "application/json"
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    if (event.requestContext.http.method === "OPTIONS") return json(204, {});

    const method = event.requestContext.http.method;
    const routeKey = event.routeKey;

    if (method === "POST" && routeKey === "POST /profiles") {
      return json(200, await upsertProfile(parseJson(event.body) as Partial<UserProfile>));
    }

    if (method === "GET" && routeKey === "GET /profiles/{profileId}/events") {
      return json(200, await listEventsForProfile(event.pathParameters?.profileId ?? ""));
    }

    if (method === "POST" && routeKey === "POST /profiles/{profileId}/subscriptions") {
      return json(200, await saveSubscription(event.pathParameters?.profileId ?? "", parseJson(event.body)));
    }

    return json(404, { message: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json(500, { message });
  }
}

async function upsertProfile(input: Partial<UserProfile>): Promise<{ profile: UserProfile }> {
  const now = new Date().toISOString();
  const profile: UserProfile = {
    profileId: input.profileId || randomUUID(),
    childAge: clampNumber(input.childAge, 0, 18),
    interests: normalizeStringArray(input.interests),
    area: String(input.area ?? "").trim() || "県内",
    notificationLeadDays: clampNumber(input.notificationLeadDays ?? 45, 1, 180),
    createdAt: input.createdAt || now,
    updatedAt: now
  };

  await ddb.send(
    new PutCommand({
      TableName: requiredEnv("PROFILES_TABLE"),
      Item: profile
    })
  );

  return { profile };
}

async function listEventsForProfile(profileId: string): Promise<{ events: EventRecord[] }> {
  const profileResponse = await ddb.send(
    new GetCommand({
      TableName: requiredEnv("PROFILES_TABLE"),
      Key: { profileId }
    })
  );
  const profile = profileResponse.Item as UserProfile | undefined;
  if (!profile) return { events: [] };

  const eventsResponse = await ddb.send(
    new QueryCommand({
      TableName: requiredEnv("EVENTS_TABLE"),
      IndexName: "publishedAtIndex",
      KeyConditionExpression: "eventType = :eventType",
      ExpressionAttributeValues: { ":eventType": "event" },
      ScanIndexForward: false,
      Limit: 100
    })
  );

  const events = (eventsResponse.Items as EventRecord[] | undefined ?? [])
    .filter((item) => matchesProfile(item, profile))
    .slice(0, 50);

  return { events };
}

async function saveSubscription(profileId: string, body: unknown): Promise<{ ok: true }> {
  if (!profileId) throw new Error("profileId is required");
  const subscription = body as PushSubscriptionRecord["subscription"];
  if (!subscription?.endpoint || !subscription.keys?.auth || !subscription.keys?.p256dh) {
    throw new Error("Invalid push subscription");
  }

  const now = new Date().toISOString();
  const record: PushSubscriptionRecord = {
    profileId,
    endpointHash: createHash("sha256").update(subscription.endpoint).digest("hex"),
    subscription,
    createdAt: now,
    updatedAt: now
  };

  await ddb.send(
    new PutCommand({
      TableName: requiredEnv("SUBSCRIPTIONS_TABLE"),
      Item: record
    })
  );

  return { ok: true };
}

function parseJson(body: string | undefined): unknown {
  return body ? JSON.parse(body) : {};
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [];
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}
