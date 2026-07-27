import { chat } from "./llm.js";
import type { Env, EventRecord, RawEventCandidate } from "./types.js";

type AiEvent = {
  title?: string;
  summary?: string;
  area?: string;
  category?: string;
  isEvent?: boolean;
  eventDate?: string;
  eventEndDate?: string;
  venue?: string;
  address?: string;
  targetAgeMin?: number;
  targetAgeMax?: number;
  interests?: string[];
};

const CATEGORIES = ["祭り・伝統", "音楽・ライブ", "スポーツ", "自然・アウトドア", "アート・展示", "グルメ・マルシェ", "ワークショップ", "文化・講演", "デパート・モール", "その他"];

type EnrichedEvent = Omit<EventRecord, "eventId" | "eventType" | "createdAt">;

export async function enrichCandidate(env: Env, candidate: RawEventCandidate): Promise<EnrichedEvent | null> {
  const fallback = fallbackEvent(candidate);
  const prompt = buildPrompt(candidate);

  // パース失敗は単発で起きるので最大2回試す
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await chat(env, prompt);
      const parsed = JSON.parse(extractJson(text)) as AiEvent;
      if (parsed.isEvent === false) return null; // 一覧/検索/索引ページはスキップ
      // 文字化け検出: AIの出力が元ページにない文字ばかりなら再試行
      if (isGarbled(`${parsed.title ?? ""} ${parsed.summary ?? ""}`, `${candidate.title} ${candidate.snippet}`)) {
        continue;
      }
      return mergeParsedEvent(parsed, fallback);
    } catch {
      // 次の試行へ。最後まで失敗したらフォールバック
    }
  }
  return fallback;
}

/**
 * 文字化け判定。要約に含まれる漢字・かなのうち、元テキストに存在しない文字が
 * 過半数を占める場合は「化け」とみなす（正常な要約は原文の文字を再利用するため）。
 */
function isGarbled(aiText: string, sourceText: string): boolean {
  const cjk = (s: string): string[] => s.match(/[\u3040-\u30ff\u4e00-\u9faf]/g) ?? [];
  const aiChars = cjk(aiText);
  if (aiChars.length < 6) return false; // 短すぎる場合は判定しない
  const sourceSet = new Set(cjk(sourceText));
  if (sourceSet.size === 0) return false;
  const absent = aiChars.filter((c) => !sourceSet.has(c)).length;
  return absent / aiChars.length > 0.5;
}

function mergeParsedEvent(parsed: AiEvent, fallback: EnrichedEvent): EnrichedEvent {
  return {
    ...fallback,
    title: parsed.title?.trim() || fallback.title,
    summary: parsed.summary?.trim() || fallback.summary,
    area: parsed.area?.trim() || fallback.area,
    category: normalizeCategory(parsed.category),
    eventDate: normalizeDate(parsed.eventDate) ?? fallback.eventDate,
    eventEndDate: normalizeDate(parsed.eventEndDate) ?? fallback.eventEndDate,
    venue: parsed.venue?.trim() || fallback.venue,
    address: parsed.address?.trim() || fallback.address,
    targetAgeMin: parsed.targetAgeMin ?? fallback.targetAgeMin,
    targetAgeMax: parsed.targetAgeMax ?? fallback.targetAgeMax,
    interests: normalizeInterests(parsed.interests ?? fallback.interests)
  };
}

function buildPrompt(candidate: RawEventCandidate): string {
  const today = jstToday();
  return [
    "以下の地域イベント候補を、子ども向けレジャー通知アプリ用にJSONだけで整理してください。",
    "不明な項目は省略し、誇張せず、本文にない情報は作らないでください。",
    `今日の日付は ${today} (日本時間) です。`,
    "areaは開催地の市区町村名(例: 四国中央市)。本文の住所・会場・開催地の記載から特定すること。",
    "県名しか分からない場合や不明な場合はareaを空文字にすること。県庁所在地(松山市など)を推測で入れてはいけない。",
    "重要: 出力はJSONオブジェクトのみ。マークダウン記号(```)・前置き・説明文は一切付けないこと。",
    "",
    "JSON schema:",
    '{"title":"string","summary":"string","area":"string","category":"string","isEvent":boolean,"eventDate":"YYYY-MM-DD","eventEndDate":"YYYY-MM-DD","venue":"string","address":"string","targetAgeMin":number,"targetAgeMax":number,"interests":["string"]}',
    "",
    "venue: 開催会場の名称（例: 松山市総合コミュニティセンター、エミフルMASAKI）。本文から抽出し、無ければ空文字。",
    "address: 会場の住所（できるだけ番地まで。例: 愛媛県松山市○○町1-2-3）。本文から抽出し、無ければ空文字。推測で作らない。",
    "isEvent: 内容が個別の「イベント・催し・行事」ならtrue。一覧ページ・検索ページ・カテゴリ・索引・施設案内・組織案内・電話帳・アクセス案内など、単一イベントでないものはfalse。",
    `category: 次から最も近いものを1つ選ぶ: ${CATEGORIES.join(" / ")}`,
    "「デパート・モール」はデパート・百貨店・ショッピングモール・商業施設で開催される催事（物産展・セール・館内イベント等）に使う。",
    "",
    "日付(eventDate / eventEndDate)のルール（厳守）:",
    "- ページに書かれている開催年月日をそのまま使う。年が明記されていればその年を使い、勝手に今年や来年へ変更しない。",
    "- 期間イベント(例: 4月29日〜5月6日)は eventDate=開始日, eventEndDate=終了日 の両方を入れる。単日なら eventEndDate は省略。",
    "- 年の記載がなく月日だけの場合のみ、今日以降で最も近い年を推定する。過去の月日を無理に未来の年へ動かさないこと。",
    "- 開催日がページから全く読み取れない場合は eventDate を省略する（推測で埋めない）。",
    "- 出力する日付は必ず YYYY-MM-DD 形式にすること。",
    "",
    `source: ${candidate.sourceName}`,
    `areaHint: ${candidate.area}`,
    `title: ${candidate.title}`,
    `url: ${candidate.url}`,
    `snippet: ${candidate.snippet}`
  ].join("\n");
}

/** 日本時間の今日(YYYY-MM-DD) */
function jstToday(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function fallbackEvent(candidate: RawEventCandidate): EnrichedEvent {
  return {
    title: candidate.title,
    summary: (candidate.snippet || candidate.title).slice(0, 300),
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

/** AIが返したカテゴリを既定リストに正規化。合わなければ「その他」 */
function normalizeCategory(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (CATEGORIES.includes(v)) return v;
  const hit = CATEGORIES.find((c) => v.includes(c) || c.includes(v));
  return hit ?? "その他";
}

/** AIが返した日付を YYYY-MM-DD に正規化。妥当な日付でなければ undefined（＝日付なし扱い）。 */
function normalizeDate(value: string | undefined): string | undefined {
  const m = (value ?? "").trim().match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return undefined;
  return iso;
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object in model response");
  return text.slice(start, end + 1);
}

/** デバッグ用: 生のモデル出力とパース可否を返す（try/catchで握りつぶさない） */
export async function debugEnrich(env: Env, candidate: RawEventCandidate): Promise<{
  promptChars: number;
  raw: string;
  parsedOk: boolean;
  parseError?: string;
}> {
  const prompt = buildPrompt(candidate);
  const raw = await chat(env, prompt);
  try {
    JSON.parse(extractJson(raw));
    return { promptChars: prompt.length, raw, parsedOk: true };
  } catch (error) {
    return { promptChars: prompt.length, raw, parsedOk: false, parseError: error instanceof Error ? error.message : String(error) };
  }
}
