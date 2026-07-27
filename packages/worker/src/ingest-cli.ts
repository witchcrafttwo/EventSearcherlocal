// ローカル一括収集CLI（Vercelの60秒制限を回避するため、収集はこれでローカル実行する）。
// .dev.vars / .env から認証情報を読み、DynamoDB/Bedrock へ直接アクセスして全ソースを収集する。
// 使い方:
//   npm --workspace @prefecture-events-ai/worker run ingest            (新規のみ・全ソース)
//   npm --workspace @prefecture-events-ai/worker run ingest -- --force (既存も上書き再収集)
//   npm --workspace @prefecture-events-ai/worker run ingest -- --source <sourceId>
import dotenv from "dotenv";
// wrangler形式の .dev.vars と 通常の .env の両方を読み込む（先に読んだ方が優先）
dotenv.config({ path: ".dev.vars" });
dotenv.config();

import { loadAllSources } from "./sources.js";
import { runIngest } from "./ingest.js";
import type { Env } from "./types.js";

const env = process.env as unknown as Env;

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const force = hasArg("--force");
  const onlySource = argValue("--source");

  // 必須env確認
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "EVENTS_TABLE", "SOURCES_TABLE", "BEDROCK_MODEL_ID"]) {
    if (!process.env[key]) {
      console.error(`[ingest] 環境変数 ${key} が未設定です。packages/worker/.dev.vars を確認してください。`);
      process.exit(1);
    }
  }

  const all = await loadAllSources(env);
  const sources = onlySource ? all.filter((s) => s.id === onlySource) : all;
  if (sources.length === 0) {
    console.error("[ingest] 対象ソースが見つかりません。");
    process.exit(1);
  }

  console.log(`[ingest] ローカル収集を開始（時間制限なし / ${force ? "強制上書き" : "新規のみ"} / ${sources.length}ソース）`);
  const startedAt = Date.now();
  let totalSaved = 0;
  let totalCandidates = 0;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const t0 = Date.now();
    try {
      // maxMs/limit を指定しない = 無制限。1ソースずつ最後まで処理する。
      const result = await runIngest(env, { sourceId: s.id, force });
      totalSaved += result.saved;
      totalCandidates += result.candidates;
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[ingest] (${i + 1}/${sources.length}) ${s.name}: 新規${result.saved} / 候補${result.candidates} (${sec}s)`);
    } catch (error) {
      console.error(`[ingest] (${i + 1}/${sources.length}) ${s.name}: エラー`, error instanceof Error ? error.message : error);
    }
  }

  const min = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`[ingest] 完了: 合計 新規${totalSaved}件 / 候補${totalCandidates}件 (${min}分)`);
}

main().catch((error) => {
  console.error("[ingest] 失敗:", error);
  process.exit(1);
});
