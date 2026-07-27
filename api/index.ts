import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../packages/worker/src/index.js";

// Node ランタイム。収集は最大60秒まで許可。
export const config = { maxDuration: 60 };

// Cloudflare の ExecutionContext 相当のスタブ（cron の waitUntil 用）
const execCtx = {
  waitUntil(promise: Promise<unknown>) {
    void Promise.resolve(promise).catch((error) => console.error("waitUntil error", error));
  },
  passThroughOnException() {
    /* noop */
  }
};

/**
 * Vercel(Node) 用ハンドラ。
 * getRequestListener はVercel上でボディ(POST/PATCH)のストリーム読み取りが返らず固まるため、
 * Vercelが解析済みの req.body を使って Web Request を組み直して Hono に渡す。
 */
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  try {
    const host = req.headers.host ?? "localhost";
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, `https://${host}`);
    // /api プレフィックスを除去（worker のルートは "/" 始まり）
    url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

    const method = (req.method ?? "GET").toUpperCase();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (key === "content-length" || key === "transfer-encoding") continue; // 再計算させる
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }

    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD" && req.body !== undefined && req.body !== null) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }

    const request = new Request(url.toString(), { method, headers, body });
    const response = await app.fetch(request, process.env as unknown as Record<string, string>, execCtx as never);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: error instanceof Error ? error.message : "Internal error" }));
  }
}
