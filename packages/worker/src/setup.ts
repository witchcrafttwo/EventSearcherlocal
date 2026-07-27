import { DynamoClient } from "./dynamo.js";
import type { Env } from "./types.js";

/**
 * 初期セットアップ: wrangler.toml の名前で DynamoDB テーブルを3つ作る。
 * スキーマは packages/infra の CDK 定義と一致させている。
 * 必要な権限: dynamodb:CreateTable, dynamodb:DescribeTable
 */
export async function setupTables(env: Env): Promise<{ results: Array<{ table: string; created: boolean }> }> {
  const ddb = new DynamoClient(env);

  const profiles = await ddb.createTable({
    TableName: env.PROFILES_TABLE,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "profileId", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "profileId", KeyType: "HASH" }]
  });

  const events = await ddb.createTable({
    TableName: env.EVENTS_TABLE,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "eventId", AttributeType: "S" },
      { AttributeName: "eventType", AttributeType: "S" },
      { AttributeName: "publishedAt", AttributeType: "S" }
    ],
    KeySchema: [{ AttributeName: "eventId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "publishedAtIndex",
        KeySchema: [
          { AttributeName: "eventType", KeyType: "HASH" },
          { AttributeName: "publishedAt", KeyType: "RANGE" }
        ],
        Projection: { ProjectionType: "ALL" }
      }
    ]
  });

  const subscriptions = await ddb.createTable({
    TableName: env.SUBSCRIPTIONS_TABLE,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "profileId", AttributeType: "S" },
      { AttributeName: "endpointHash", AttributeType: "S" }
    ],
    KeySchema: [
      { AttributeName: "profileId", KeyType: "HASH" },
      { AttributeName: "endpointHash", KeyType: "RANGE" }
    ]
  });

  const sources = await ddb.createTable({
    TableName: env.SOURCES_TABLE,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }]
  });

  return { results: [profiles, events, subscriptions, sources] };
}
