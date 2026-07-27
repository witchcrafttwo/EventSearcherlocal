import express from "express";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ddb, requiredEnv } from "../../infra/lambda/db.js";
import { handler as ingestEvents } from "../../infra/lambda/ingest-worker.js";
import { matchesProfile } from "../../infra/lambda/matching.js";
import type { EventRecord, PushSubscriptionRecord, UserProfile } from "../../infra/lambda/types.js";

decodeBase64Environment("EVENT_SOURCES_JSON");

const app = express();
const port = Number(process.env.PORT ?? 3000);
const webDistDir = resolve(process.env.WEB_DIST_DIR ?? join(process.cwd(), "packages/web/dist"));

app.use(express.json({ limit: "1mb" }));

// 管理系API(/admin/*)はトークン保護。ADMIN_TOKEN未設定なら素通り(ローカル開発用)。
// worker(Hono)側と同じ ADMIN_TOKEN / Bearer 方式に合わせている。
const adminAuth: express.RequestHandler = (request, response, next) => {
  const token = process.env.ADMIN_TOKEN;
  if (token && request.headers.authorization !== `Bearer ${token}`) {
    response.status(401).json({ message: "unauthorized" });
    return;
  }
  next();
};
app.use("/admin", adminAuth);

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/profiles", async (request, response, next) => {
  try {
    response.json(await upsertProfile(request.body as Partial<UserProfile>));
  } catch (error) {
    next(error);
  }
});

app.get("/profiles/:profileId/events", async (request, response, next) => {
  try {
    response.json(await listEventsForProfile(request.params.profileId));
  } catch (error) {
    next(error);
  }
});

app.post("/profiles/:profileId/subscriptions", async (request, response, next) => {
  try {
    response.json(await saveSubscription(request.params.profileId, request.body));
  } catch (error) {
    next(error);
  }
});

app.post("/admin/ingest", async (_request, response, next) => {
  try {
    response.json(await ingestEvents());
  } catch (error) {
    next(error);
  }
});

if (existsSync(webDistDir)) {
  app.use(express.static(webDistDir));
  app.get("*", (_request, response) => {
    response.sendFile(join(webDistDir, "index.html"));
  });
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ message });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`prefecture-events-ai server listening on ${port}`);
  scheduleIngest();
});

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

  const events = ((eventsResponse.Items as EventRecord[] | undefined) ?? [])
    .filter((item) => matchesProfile(item, profile))
    .slice(0, 50);

  return { events };
}

async function saveSubscription(profileId: string, subscription: PushSubscriptionRecord["subscription"]): Promise<{ ok: true }> {
  if (!profileId) throw new Error("profileId is required");
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

function scheduleIngest(): void {
  const minutes = clampNumber(process.env.INGEST_INTERVAL_MINUTES ?? 360, 5, 1440);
  setInterval(() => {
    void ingestEvents().catch((error) => {
      console.error("scheduled ingest failed", error);
    });
  }, minutes * 60 * 1000);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12) : [];
}

function clampNumber(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function decodeBase64Environment(name: string): void {
  const encoded = process.env[`${name}_BASE64`];
  if (!process.env[name] && encoded) {
    process.env[name] = Buffer.from(encoded, "base64").toString("utf8");
  }
}
