import { PgClient } from "./pg.js";
import type { Env } from "./types.js";

/**
 * データクライアントの共通インターフェース（PgClient が満たす）。
 * 各ハンドラは getDb(env) を使う。
 */
export interface Db {
  getItem<T>(tableName: string, key: Record<string, unknown>): Promise<T | undefined>;
  putItem(tableName: string, item: Record<string, unknown>, conditionExpression?: string): Promise<void>;
  deleteItem(tableName: string, key: Record<string, unknown>): Promise<void>;
  query<T>(params: {
    tableName: string;
    indexName?: string;
    keyConditionExpression: string;
    expressionAttributeValues: Record<string, unknown>;
    scanIndexForward?: boolean;
    limit?: number;
  }): Promise<T[]>;
  scanAll<T>(tableName: string): Promise<T[]>;
  createTable(body: Record<string, unknown>): Promise<{ table: string; created: boolean }>;
}

/** データクライアント(PostgreSQL)を返す。 */
export function getDb(env: Env): Db {
  return new PgClient(env);
}
