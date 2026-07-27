import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import cron from "node-cron";
import { existsSync } from "node:fs";
import { app } from "./index.js";
import { runScheduledIngest } from "./ingest.js";
import { setupTables } from "./setup.js";
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
// APIは /api 配下のみにマウントする。本番フロント(dist)は VITE_API_BASE_URL=/api で
// ビルドされ /api/* を叩くため、Vercel(api/index.ts が /api を剥がす)と同じ構成に揃える。
// ルート直下にはマウントしない: SPA のクライアントルート(例 /admin)が API の
// /admin/* と衝突して 401 になり、管理画面の HTML が返らなくなるのを防ぐため。
root.route("/api", app);

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

// 起動時に PostgreSQL のテーブルを用意する（CREATE TABLE IF NOT EXISTS なので冪等）。
// 新しいDBを指しても、初回起動でテーブルが自動作成される。失敗しても起動は続ける。
async function ensureTables(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.warn("[server] DATABASE_URL 未設定のためテーブル自動作成をスキップ");
    return;
  }
  try {
    const { results } = await setupTables(env);
    const created = results.filter((r) => r.created).map((r) => r.table);
    console.log(
      created.length > 0
        ? `[server] tables created: ${created.join(", ")}`
        : "[server] tables ready (already exist)"
    );
  } catch (error) {
    console.error("[server] table setup failed", error);
  }
}

serve(
  {
    fetch: (request: Request) => root.fetch(request, env, execCtx),
    port
  },
  (info) => {
    console.log(`[server] listening on http://0.0.0.0:${info.port}`);
    void ensureTables();
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
