import { AwsClient } from "aws4fetch";
import type { Env } from "./types.js";

/**
 * Bedrock Runtime の Converse API を HTTP で直接呼び出す。
 * 認証は Bedrock API キー（AWS_BEARER_TOKEN_BEDROCK）を優先し、Authorization: Bearer で送る。
 * API キーが未設定なら、従来どおり IAM キー（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY）で SigV4 署名する。
 */
export async function converse(env: Env, prompt: string): Promise<string> {
  const region = env.BEDROCK_REGION || env.AWS_REGION;
  const modelId = env.BEDROCK_MODEL_ID;
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;

  const body = JSON.stringify({
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 800, temperature: 0.1 }
  });
  const signal = AbortSignal.timeout(30000);

  const apiKey = env.AWS_BEARER_TOKEN_BEDROCK?.trim();
  const response = apiKey
    ? await fetchWithRetry(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal,
        body
      })
    : await new AwsClient({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        region,
        service: "bedrock"
      }).fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body
      });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bedrock converse failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  return result.output?.message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

/**
 * API キー経路にも aws4fetch と同じ再試行をかける
 * （429 / 5xx のとき最大10回、50ms から倍々のランダム待ち）。
 */
async function fetchWithRetry(url: string, init: RequestInit, retries = 10, initRetryMs = 50): Promise<Response> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, init);
    if (i >= retries || (res.status < 500 && res.status !== 429)) return res;
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, Math.random() * initRetryMs * 2 ** i));
  }
}
