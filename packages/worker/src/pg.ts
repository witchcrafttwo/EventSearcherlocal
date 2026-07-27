import pg from "pg";
import type { Env } from "./types.js";

/**
 * PostgreSQL 版のデータクライアント。DynamoClient と同じインターフェースを持ち、
 * getDb() 経由で差し替えできる。各テーブルは汎用スキーマ
 *   ("pk" text primary key, "data" jsonb not null)
 * を持ち、DynamoDB のアイテム(JSON)をそのまま data に格納する。
 * 複合キー(subscriptions)は pk を区切り文字で連結して1本化する。
 */

const { Pool } = pg;

// 接続プールは接続文字列ごとに使い回す（毎リクエストで new PgClient されるため）。
const pools = new Map<string, pg.Pool>();

function getPool(env: Env): pg.Pool {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL が未設定です。PostgreSQL 接続文字列を設定してください。");
  }
  let pool = pools.get(connectionString);
  if (!pool) {
    const useSsl = env.DB_SSL === "true" || /[?&]sslmode=require/.test(connectionString);
    pool = new Pool({
      connectionString,
      ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {})
    });
    pool.on("error", (error) => console.error("pg pool error", error));
    pools.set(connectionString, pool);
  }
  return pool;
}

// 複合キーを1つの pk 文字列に連結するときの区切り（データに現れない制御文字）。
const PK_SEPARATOR = "\u0001";

export class PgClient {
  private readonly pool: pg.Pool;
  /** テーブル名 → 主キー列名（DynamoのKeySchema相当）。env のテーブル名から構築。 */
  private readonly pkColumns: Record<string, string[]>;

  constructor(env: Env) {
    this.pool = getPool(env);
    this.pkColumns = {
      [env.PROFILES_TABLE]: ["profileId"],
      [env.EVENTS_TABLE]: ["eventId"],
      [env.SUBSCRIPTIONS_TABLE]: ["profileId", "endpointHash"],
      [env.SOURCES_TABLE]: ["id"]
    };
  }

  /** テーブルの主キー列を返す（未登録なら単一の "id" と推定）。 */
  private keyColumns(tableName: string): string[] {
    return this.pkColumns[tableName] ?? ["id"];
  }

  /** キー/アイテムのオブジェクトから pk 文字列を作る。 */
  private pkValue(tableName: string, source: Record<string, unknown>): string {
    const cols = this.keyColumns(tableName);
    const parts = cols.map((col) => {
      const value = source[col];
      if (value === undefined || value === null) {
        throw new Error(`主キー列 "${col}" が ${tableName} のアイテムにありません`);
      }
      return String(value);
    });
    return parts.join(PK_SEPARATOR);
  }

  async getItem<T>(tableName: string, key: Record<string, unknown>): Promise<T | undefined> {
    const result = await this.pool.query<{ data: T }>(
      `SELECT data FROM ${ident(tableName)} WHERE pk = $1`,
      [this.pkValue(tableName, key)]
    );
    return result.rows[0]?.data;
  }

  async putItem(tableName: string, item: Record<string, unknown>, conditionExpression?: string): Promise<void> {
    const pk = this.pkValue(tableName, item);
    // conditionExpression(attribute_not_exists)が指定された場合は「無ければ挿入」＝上書き禁止。
    // 未指定は upsert（DynamoのPutItemと同じ全上書き）。
    const onConflict = conditionExpression
      ? "ON CONFLICT (pk) DO NOTHING"
      : "ON CONFLICT (pk) DO UPDATE SET data = EXCLUDED.data";
    await this.pool.query(
      `INSERT INTO ${ident(tableName)} (pk, data) VALUES ($1, $2::jsonb) ${onConflict}`,
      [pk, JSON.stringify(item)]
    );
  }

  async deleteItem(tableName: string, key: Record<string, unknown>): Promise<void> {
    await this.pool.query(`DELETE FROM ${ident(tableName)} WHERE pk = $1`, [this.pkValue(tableName, key)]);
  }

  /**
   * events の publishedAtIndex 相当。keyConditionExpression は "attr = :name" 形式のみ対応。
   * scanIndexForward=false のとき publishedAt 降順、それ以外は昇順。
   */
  async query<T>(params: {
    tableName: string;
    indexName?: string;
    keyConditionExpression: string;
    expressionAttributeValues: Record<string, unknown>;
    scanIndexForward?: boolean;
    limit?: number;
  }): Promise<T[]> {
    const match = /(\w+)\s*=\s*:(\w+)/.exec(params.keyConditionExpression);
    if (!match) {
      throw new Error(`未対応の keyConditionExpression: ${params.keyConditionExpression}`);
    }
    const attr = match[1];
    const valueKey = `:${match[2]}`;
    const value = params.expressionAttributeValues[valueKey];
    const direction = params.scanIndexForward === false ? "DESC" : "ASC";
    const clauses: string[] = [`data->>'${attr}' = $1`];
    const values: unknown[] = [String(value)];
    let sql = `SELECT data FROM ${ident(params.tableName)} WHERE ${clauses.join(" AND ")} ORDER BY data->>'publishedAt' ${direction}`;
    if (params.limit) {
      values.push(params.limit);
      sql += ` LIMIT $${values.length}`;
    }
    const result = await this.pool.query<{ data: T }>(sql, values);
    return result.rows.map((row) => row.data);
  }

  async scanAll<T>(tableName: string): Promise<T[]> {
    const result = await this.pool.query<{ data: T }>(`SELECT data FROM ${ident(tableName)}`);
    return result.rows.map((row) => row.data);
  }

  /**
   * テーブル作成。Dynamoの CreateTable 引数(TableName 等)を受けるが、
   * Postgres では汎用スキーマを作るだけ。events は絞り込み/並び替え用の式インデックスも作る。
   */
  async createTable(body: Record<string, unknown>): Promise<{ table: string; created: boolean }> {
    const table = String(body.TableName);
    const existed = await this.pool.query<{ reg: string | null }>("SELECT to_regclass($1) AS reg", [`public.${table}`]);
    const alreadyExists = existed.rows[0]?.reg != null;

    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${ident(table)} (pk text PRIMARY KEY, data jsonb NOT NULL)`
    );

    // events は eventType 絞り込み + publishedAt 並び替えを高速化する式インデックスを付与。
    if (Array.isArray(body.GlobalSecondaryIndexes)) {
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS ${ident(`${table}_type_published_idx`)} ` +
          `ON ${ident(table)} ((data->>'eventType'), (data->>'publishedAt') DESC)`
      );
    }

    return { table, created: !alreadyExists };
  }
}

/** SQL 識別子を安全に二重引用符でクォートする（テーブル名にハイフンが含まれるため必須）。 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
