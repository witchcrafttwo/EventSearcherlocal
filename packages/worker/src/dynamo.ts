import { AwsClient } from "aws4fetch";
import type { Env } from "./types.js";

/**
 * Cloudflare Workers から DynamoDB の低レベルJSON API（DynamoDB_20120810.*）を
 * SigV4署名付きで呼び出す薄いクライアント。
 * AWS SDK v3 は重く Workers との相性も悪いため aws4fetch を利用する。
 */
export class DynamoClient {
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(env: Env) {
    this.client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: "dynamodb"
    });
    this.endpoint = `https://dynamodb.${env.AWS_REGION}.amazonaws.com/`;
  }

  private async call<T>(target: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.client.fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `DynamoDB_20120810.${target}`
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DynamoDB ${target} failed: ${response.status} ${text}`);
    }
    return (await response.json()) as T;
  }

  async getItem<T>(tableName: string, key: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.call<{ Item?: Record<string, AttributeValue> }>("GetItem", {
      TableName: tableName,
      Key: marshall(key)
    });
    return result.Item ? (unmarshall(result.Item) as T) : undefined;
  }

  async putItem(tableName: string, item: Record<string, unknown>, conditionExpression?: string): Promise<void> {
    await this.call("PutItem", {
      TableName: tableName,
      Item: marshall(item),
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {})
    });
  }

  async deleteItem(tableName: string, key: Record<string, unknown>): Promise<void> {
    await this.call("DeleteItem", { TableName: tableName, Key: marshall(key) });
  }

  async query<T>(params: {
    tableName: string;
    indexName?: string;
    keyConditionExpression: string;
    expressionAttributeValues: Record<string, unknown>;
    scanIndexForward?: boolean;
    limit?: number;
  }): Promise<T[]> {
    const result = await this.call<{ Items?: Record<string, AttributeValue>[] }>("Query", {
      TableName: params.tableName,
      ...(params.indexName ? { IndexName: params.indexName } : {}),
      KeyConditionExpression: params.keyConditionExpression,
      ExpressionAttributeValues: marshall(params.expressionAttributeValues),
      ScanIndexForward: params.scanIndexForward ?? true,
      ...(params.limit ? { Limit: params.limit } : {})
    });
    return (result.Items ?? []).map((item) => unmarshall(item) as T);
  }

  async scanAll<T>(tableName: string): Promise<T[]> {
    const items: T[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.call<{
        Items?: Record<string, AttributeValue>[];
        LastEvaluatedKey?: Record<string, AttributeValue>;
      }>("Scan", {
        TableName: tableName,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {})
      });
      for (const item of result.Items ?? []) items.push(unmarshall(item) as T);
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  /** テーブル作成（初期セットアップ用）。既に存在する場合は created:false を返す */
  async createTable(body: Record<string, unknown>): Promise<{ table: string; created: boolean }> {
    const table = String(body.TableName);
    try {
      await this.call("CreateTable", body);
      return { table, created: true };
    } catch (error) {
      if (String(error).includes("ResourceInUseException")) return { table, created: false };
      throw error;
    }
  }
}

// --- AttributeValue marshalling ----------------------------------------------

type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { L: AttributeValue[] }
  | { M: Record<string, AttributeValue> };

export function marshall(value: Record<string, unknown>): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue; // removeUndefinedValues 相当
    result[key] = toAttributeValue(raw);
  }
  return result;
}

function toAttributeValue(value: unknown): AttributeValue {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(toAttributeValue) };
  if (typeof value === "object") return { M: marshall(value as Record<string, unknown>) };
  return { S: String(value) };
}

export function unmarshall(item: Record<string, AttributeValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    result[key] = fromAttributeValue(value);
  }
  return result;
}

function fromAttributeValue(value: AttributeValue): unknown {
  if ("S" in value) return value.S;
  if ("N" in value) return Number(value.N);
  if ("BOOL" in value) return value.BOOL;
  if ("NULL" in value) return null;
  if ("L" in value) return value.L.map(fromAttributeValue);
  if ("M" in value) return unmarshall(value.M);
  return undefined;
}
