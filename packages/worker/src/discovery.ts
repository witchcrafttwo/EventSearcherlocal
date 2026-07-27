import { AwsClient } from "aws4fetch";
import type { Env, RawEventCandidate } from "./types.js";

/**
 * Amazon Bedrock AgentCore の Web Search（MCPツール）を使って、
 * 地域名から子ども向けイベントの候補URLを「発見」する。
 *
 * 認証は Gateway のインバウンド認証=IAM を使い、IAMキーで SigV4署名して呼ぶ。
 * （Cognito/OAuth は不要。Bedrock呼び出しと同じIAMキーを再利用する）
 *
 * 設計方針（利用規約への配慮）:
 *   検索結果そのものを大量に保存するのではなく、URL発見の入口として使う。
 *   実体は各URLを自前で取得（fetchPageText）し、Bedrockで要約して保存する。
 *   保存・表示時は必ず出典URLを残す（acceptable use 準拠）。
 */

type WebSearchResult = {
  text?: string;
  url?: string;
  title?: string;
  publishedDate?: string;
};

export function isDiscoveryEnabled(env: Env): boolean {
  return Boolean(
    env.AGENTCORE_GATEWAY_URL && env.WEB_SEARCH_TOOL_NAME && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
  );
}

/** AgentCore Gateway の MCP エンドポイントを IAM(SigV4) 署名で呼ぶ */
export async function webSearch(env: Env, query: string, maxResults: number): Promise<WebSearchResult[]> {
  const gatewayUrl = env.AGENTCORE_GATEWAY_URL!.replace(/\/$/, "");
  const endpoint = `${gatewayUrl}/mcp`;

  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: regionFromGatewayUrl(gatewayUrl),
    service: "bedrock-agentcore"
  });

  const response = await client.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "events-web-search",
      method: "tools/call",
      params: {
        name: env.WEB_SEARCH_TOOL_NAME,
        arguments: { query: query.slice(0, 200), maxResults }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`AgentCore web search failed: ${response.status} ${await response.text()}`);
  }

  const rpc = (await response.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  };
  if (rpc.error) throw new Error(`MCP error: ${rpc.error.message ?? "unknown"}`);

  const textPart = rpc.result?.content?.find((part) => part.type === "text")?.text ?? "{}";
  const parsed = JSON.parse(textPart) as { results?: WebSearchResult[] };
  return parsed.results ?? [];
}

/** 設定された地域ごとに検索し、候補（取得・要約前の素材）を返す */
export async function discoverCandidates(env: Env): Promise<RawEventCandidate[]> {
  const areas = parseAreas(env.SEARCH_AREAS);
  const maxResults = clampInt(env.SEARCH_MAX_RESULTS, 1, 25, 10);

  const searches = await Promise.allSettled(
    areas.map((area) => webSearch(env, `${area} 子ども イベント`, maxResults).then((results) => ({ area, results })))
  );

  const seen = new Set<string>();
  const candidates: RawEventCandidate[] = [];

  for (const search of searches) {
    if (search.status !== "fulfilled") continue;
    const { area, results } = search.value;

    for (const result of results) {
      if (!result.url || seen.has(result.url)) continue;
      seen.add(result.url);

      // 本文取得は ingest 側の hydrate でまとめて行う（二重取得を避ける）
      candidates.push({
        sourceId: "agentcore-web-search",
        sourceName: result.title || area,
        sourceUrl: result.url,
        title: (result.title || area).slice(0, 120),
        url: result.url,
        area,
        snippet: (result.text || result.title || "").slice(0, 900),
        publishedAt: normalizeDate(result.publishedDate)
      });
    }
  }

  return candidates;
}

/** Gateway URL のホスト名からリージョンを抽出（例: ...bedrock-agentcore.us-east-1.amazonaws.com） */
function regionFromGatewayUrl(gatewayUrl: string): string {
  const match = gatewayUrl.match(/bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com/i);
  return match?.[1] ?? "us-east-1";
}

function parseAreas(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // カンマ区切りも許容
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(Math.trunc(numeric), min), max);
}

function normalizeDate(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
