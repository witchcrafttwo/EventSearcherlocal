import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import cron from "node-cron";
import { existsSync } from "node:fs";
import { app } from "./index.js";
import { runScheduledIngest } from "./ingest.js";
import type { Env } from "./types.js";

// Node では環境変数は process.env から渡す（Cloudflare の bindings 相当）
const env = process.env as unknown as Env;
const port = Number(process.env.PORT ?? 8787);

// ビルド済みフロント(web/dist)の場所。存在すれば同一サーバーで配信する。
// 既定は packages/web/dist（このファイルから見た相対）。WEB_DIST で上書き可能。
const WEB_DIST = process.env.WEB_DIST ?? "../web/dist";
const hasWeb = existsSync(WEB_DIST);

const root = new Hono();

// 1) API ルート（既存の Hono アプリをそのまま利用）
root.route("/", app);

// 2) フロント配信（dist がある場合のみ）。静的ファイル → 無ければ SPA フォールバックで index.html
if (hasWeb) {
  root.use("/*", serveStatic({ root: WEB_DIST }));
  root.get("*", serveStatic({ path: "index.html", root: WEB_DIST }));
  console.log(`[server] serving frontend from ${WEB_DIST}`);
} else {
  console.log(`[server] frontend not found at ${WEB_DIST} (API only)`);
}

// Cloudflare の ExecutionContext 相当のスタブ（waitUntil は即実行扱い）
const execCtx = {
  waitUntil(promise: Promise<unknown>) {
    void promise.catch((error) => console.error("waitUntil error", error));
  },
  passThroughOnException() {
    /* noop */
  }
} as unknown as ExecutionContext;

serve(
  {
    fetch: (request: Request) => root.fetch(request, env, execCtx),
    port
  },
  (info) => {
    console.log(`[server] listening on http://0.0.0.0:${info.port}`);
  }
);

// 定期収集（Cron）。既定は6時間ごと。CRON_SCHEDULE で上書き可能。DISABLE_CRON=1 で無効化。
const schedule = process.env.CRON_SCHEDULE ?? "0 */6 * * *";
if (process.env.DISABLE_CRON !== "1") {
  cron.schedule(schedule, () => {
    console.log(`[cron] scheduled ingest start (${new Date().toISOString()})`);
    runScheduledIngest(env)
      .then(() => console.log("[cron] scheduled ingest done"))
      .catch((error) => console.error("[cron] scheduled ingest failed", error));
  });
  console.log(`[server] cron enabled: ${schedule}`);
} else {
  console.log("[server] cron disabled (DISABLE_CRON=1)");
}
