import { AwsClient } from "aws4fetch";
import type { Env } from "./types.js";

/**
 * Bedrock Runtime の Converse API を SigV4署名付きHTTPで呼び出す。
 * AWS SDK の ConverseCommand と等価のリクエストを Workers から直接送る。
 */
export async function converse(env: Env, prompt: string): Promise<string> {
  const region = env.BEDROCK_REGION || env.AWS_REGION;
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region,
    service: "bedrock"
  });

  const modelId = env.BEDROCK_MODEL_ID;
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;

  const response = await client.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 800, temperature: 0.1 }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Bedrock converse failed: ${response.status} ${text}`);
  }

  const body = (await response.json()) as {
    output?: { message?: { content?: Array<{ text?: string }> } };
  };
  return body.output?.message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
}
