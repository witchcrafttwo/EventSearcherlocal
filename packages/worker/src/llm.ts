import { converse } from "./bedrock.js";
import type { Env } from "./types.js";

/**
 * AIプロバイダの切替口。
 *   AI_PROVIDER=bedrock           → AWS Bedrock(Converse, SigV4)
 *   AI_PROVIDER=openai            → OpenAI互換API(GLM / DeepSeek / OpenAI / Gemini互換 など)
 * OpenAI互換は LLM_BASE_URL / LLM_API_KEY / LLM_MODEL で設定する。
 */
export async function chat(env: Env, prompt: string): Promise<string> {
  const provider = (env.AI_PROVIDER ?? "bedrock").toLowerCase();
  if (provider === "openai" || provider === "glm" || provider === "openai-compatible") {
    return chatOpenAiCompatible(env, prompt);
  }
  return converse(env, prompt);
}

async function chatOpenAiCompatible(env: Env, prompt: string): Promise<string> {
  const baseUrl = (env.LLM_BASE_URL ?? "").replace(/\/$/, "");
  if (!baseUrl) throw new Error("LLM_BASE_URL is required for AI_PROVIDER=openai");
  if (!env.LLM_API_KEY) throw new Error("LLM_API_KEY is required for AI_PROVIDER=openai");
  if (!env.LLM_MODEL) throw new Error("LLM_MODEL is required for AI_PROVIDER=openai");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LLM_API_KEY}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: env.LLM_MODEL,
      temperature: 0.1,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`LLM chat failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? "";
}
