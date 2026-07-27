import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import OpenAI from "openai";
import type { EventRecord, RawEventCandidate } from "./types.js";

const bedrockClient = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});
const secretsClient = new SecretsManagerClient({});
let openaiClient: OpenAI | undefined;

type AiEvent = {
  title?: string;
  summary?: string;
  eventDate?: string;
  targetAgeMin?: number;
  targetAgeMax?: number;
  interests?: string[];
};

export async function enrichCandidate(candidate: RawEventCandidate): Promise<Omit<EventRecord, "eventId" | "eventType" | "createdAt">> {
  const fallback = fallbackEvent(candidate);

  try {
    if ((process.env.AI_PROVIDER ?? "bedrock").toLowerCase() === "openai") {
      return await enrichCandidateWithOpenAi(candidate, fallback);
    }

    if ((process.env.AI_LANGUAGE ?? "typescript").toLowerCase() === "python") {
      return await enrichCandidateWithPython(candidate, fallback);
    }

    const response = await bedrockClient.send(
      new ConverseCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        messages: [
          {
            role: "user",
            content: [{ text: buildPrompt(candidate) }]
          }
        ],
        inferenceConfig: {
          maxTokens: 800,
          temperature: 0.1
        }
      })
    );
    const text = response.output?.message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
    const parsed = JSON.parse(extractJson(text)) as AiEvent;

    return {
      ...fallback,
      title: parsed.title?.trim() || fallback.title,
      summary: parsed.summary?.trim() || fallback.summary,
      eventDate: parsed.eventDate || fallback.eventDate,
      targetAgeMin: parsed.targetAgeMin ?? fallback.targetAgeMin,
      targetAgeMax: parsed.targetAgeMax ?? fallback.targetAgeMax,
      interests: normalizeInterests(parsed.interests ?? fallback.interests)
    };
  } catch {
    return fallback;
  }
}

async function enrichCandidateWithOpenAi(
  candidate: RawEventCandidate,
  fallback: Omit<EventRecord, "eventId" | "eventType" | "createdAt">
): Promise<Omit<EventRecord, "eventId" | "eventType" | "createdAt">> {
  openaiClient ??= new OpenAI({ apiKey: await getOpenAiApiKey() });
  const response = await openaiClient.responses.create({
    model: process.env.OPENAI_MODEL ?? "gpt-5.5",
    input: buildPrompt(candidate)
  });
  const parsed = JSON.parse(extractJson(response.output_text)) as AiEvent;
  return mergeParsedEvent(parsed, fallback);
}

async function getOpenAiApiKey(): Promise<string> {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const secretName = process.env.OPENAI_API_KEY_SECRET_NAME;
  if (!secretName) throw new Error("OPENAI_API_KEY_SECRET_NAME is required when AI_PROVIDER=openai");

  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!response.SecretString) throw new Error("OpenAI API key secret has no string value");
  return response.SecretString;
}

async function enrichCandidateWithPython(
  candidate: RawEventCandidate,
  fallback: Omit<EventRecord, "eventId" | "eventType" | "createdAt">
): Promise<Omit<EventRecord, "eventId" | "eventType" | "createdAt">> {
  const functionName = process.env.PYTHON_AI_FUNCTION_NAME;
  if (!functionName) throw new Error("PYTHON_AI_FUNCTION_NAME is required when AI_LANGUAGE=python");

  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(candidate))
    })
  );

  if (response.FunctionError) {
    throw new Error(`Python AI Lambda failed: ${response.FunctionError}`);
  }

  const text = response.Payload ? Buffer.from(response.Payload).toString("utf8") : "{}";
  const parsed = JSON.parse(text) as AiEvent;
  return mergeParsedEvent(parsed, fallback);
}

function mergeParsedEvent(
  parsed: AiEvent,
  fallback: Omit<EventRecord, "eventId" | "eventType" | "createdAt">
): Omit<EventRecord, "eventId" | "eventType" | "createdAt"> {
  return {
    ...fallback,
    title: parsed.title?.trim() || fallback.title,
    summary: parsed.summary?.trim() || fallback.summary,
    eventDate: parsed.eventDate || fallback.eventDate,
    targetAgeMin: parsed.targetAgeMin ?? fallback.targetAgeMin,
    targetAgeMax: parsed.targetAgeMax ?? fallback.targetAgeMax,
    interests: normalizeInterests(parsed.interests ?? fallback.interests)
  };
}

function buildPrompt(candidate: RawEventCandidate): string {
  return [
    "以下の地域イベント候補を、子ども向けレジャー通知アプリ用にJSONだけで整理してください。",
    "不明な項目は省略し、誇張せず、本文にない情報は作らないでください。",
    "",
    "JSON schema:",
    '{"title":"string","summary":"string","eventDate":"YYYY-MM-DD","targetAgeMin":number,"targetAgeMax":number,"interests":["string"]}',
    "",
    `source: ${candidate.sourceName}`,
    `area: ${candidate.area}`,
    `title: ${candidate.title}`,
    `url: ${candidate.url}`,
    `snippet: ${candidate.snippet}`
  ].join("\n");
}

function fallbackEvent(candidate: RawEventCandidate): Omit<EventRecord, "eventId" | "eventType" | "createdAt"> {
  return {
    title: candidate.title,
    summary: candidate.snippet || candidate.title,
    url: candidate.url,
    area: candidate.area,
    sourceId: candidate.sourceId,
    sourceName: candidate.sourceName,
    publishedAt: candidate.publishedAt,
    interests: inferInterests(`${candidate.title} ${candidate.snippet}`)
  };
}

function inferInterests(text: string): string[] {
  const mapping: Array<[string, string[]]> = [
    ["工作", ["工作", "ものづくり", "ワークショップ"]],
    ["自然", ["自然", "公園", "森", "虫", "星", "観察"]],
    ["科学", ["科学", "実験", "ロボット", "プログラミング"]],
    ["音楽", ["音楽", "コンサート", "演奏"]],
    ["スポーツ", ["スポーツ", "運動", "サッカー", "野球"]],
    ["読書", ["図書館", "絵本", "読み聞かせ"]],
    ["アート", ["美術", "アート", "展示", "絵"]]
  ];
  const hits = mapping.filter(([, words]) => words.some((word) => text.includes(word))).map(([interest]) => interest);
  return hits.length ? hits : ["イベント"];
}

function normalizeInterests(values: string[]): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean).slice(0, 8);
  return normalized.length ? normalized : ["イベント"];
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object in model response");
  return text.slice(start, end + 1);
}
