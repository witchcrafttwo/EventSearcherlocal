import { XMLParser } from "fast-xml-parser";
import type { EventSourceConfig, RawEventCandidate } from "./types.js";

// イベントらしさの加点に使うキーワード（必須ではない）
const EVENT_WORDS = [
  "イベント", "講座", "体験", "ワークショップ", "展示", "まつり", "祭", "親子", "子ども", "こども",
  "大会", "フェスティバル", "フェア", "花火", "教室", "コンサート", "募集", "開催", "マルシェ", "市場"
];

// ナビ/定型リンクとして除外する語（部分一致）
const NAV_DENY = [
  "ホーム", "トップ", "サイトマップ", "お問い合わせ", "問い合わせ", "プライバシー", "個人情報", "著作権",
  "免責", "アクセシビリティ", "ログイン", "会員", "検索", "メニュー", "menu", "home", "english", "language",
  "次へ", "前へ", "もっと見る", "一覧を見る", "一覧", "カテゴリ", "タグ", "rss", "facebook", "twitter", "instagram",
  "youtube", "line", "広告", "採用", "求人", "リンク集", "よくある質問",
  "について", "アクセス", "ブログ", "スタッフ", "ポリシー", "物産リスト", "物産情報", "マップ", "当サイト", "運営"
];

// URLパスに含まれると除外するセグメント（アーカイブ/カテゴリ/一覧系）
const PATH_DENY = [
  "about", "policy", "sitemap", "contact", "login", "staffblog", "spot_map", "spot_list", "access",
  "privacy", "category", "tag", "author", "archive", "page", "search", "feed", "spot", "genre", "keyword",
  "list", "feature", "course", "photo", "favorite", "mypage", "gallery", "ranking", "event_cat", "pickup"
];

// これらの語を含むリンクは「イベント一覧ページ」とみなし、1階層深く辿る
const LISTING_HINTS = ["イベント", "行事", "催し", "まつり", "祭", "スケジュール", "event", "schedule", "calendar", "moyoshi"];

export async function fetchCandidates(sources: EventSourceConfig[]): Promise<RawEventCandidate[]> {
  const batches = await Promise.allSettled(sources.map((source) => fetchSource(source)));
  return batches.flatMap((batch) => (batch.status === "fulfilled" ? batch.value : []));
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "prefecture-events-ai/0.1" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.text();
}

async function fetchSource(source: EventSourceConfig): Promise<RawEventCandidate[]> {
  const body = await fetchHtml(source.url);
  if (source.type === "rss") return parseRss(source, body);

  // 1階層目の候補
  const topCandidates = parseHtml(source, body);

  // ページネーション: 同じ一覧の2ページ目以降も読み込む（最大数ページ）
  const pageUrls = findPaginationUrls(body, source.url);
  const pageBatches = await Promise.allSettled(
    pageUrls.map((url) => fetchHtml(url).then((html) => parseHtml(source, html)))
  );
  const pagedCandidates = pageBatches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));

  // 「イベント一覧」らしきリンクを見つけ、その先(2階層目)も収集する
  const deepUrls = findListingLinks(body, source.url).slice(0, 3);
  const deepBatches = await Promise.allSettled(
    deepUrls.map((url) => fetchHtml(url).then((html) => parseHtml({ ...source, url }, html)))
  );
  const deepCandidates = deepBatches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));

  // 統合・重複排除。深掘り元の一覧ページURL自体は候補から除外
  const deepUrlSet = new Set(deepUrls.map((u) => u.replace(/\/$/, "")));
  const seen = new Set<string>();
  const combined: RawEventCandidate[] = [];
  for (const candidate of [...topCandidates, ...pagedCandidates, ...deepCandidates]) {
    const key = candidate.url.replace(/\/$/, "");
    if (deepUrlSet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(candidate);
  }
  return combined.slice(0, 80);
}

/**
 * 一覧ページのページネーションURLを検出し、2ページ目以降のURLを返す。
 * WordPress系の `/xxx/page/N/` と、クエリ形式 `?paged=N` / `?page=N` に対応。
 * 最大ページ数から生成し、暴走を防ぐため上限を設ける。
 */
function findPaginationUrls(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const basePath = base.pathname.replace(/\/$/, "");
  const pathPattern = new RegExp(`^${escapeRegExp(basePath)}/page/(\\d+)/?$`, "i");

  let scheme: "path" | "paged" | "page" | null = null;
  let maxPage = 1;

  const anchorPattern = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let parsed: URL;
    try {
      parsed = new URL(absolutizeUrl(href, baseUrl));
    } catch {
      continue;
    }
    if (parsed.host !== base.host) continue;

    const pathHit = parsed.pathname.match(pathPattern);
    if (pathHit) {
      scheme ??= "path";
      maxPage = Math.max(maxPage, Number(pathHit[1]));
      continue;
    }
    if (parsed.pathname.replace(/\/$/, "") === basePath) {
      const paged = parsed.searchParams.get("paged");
      const page = parsed.searchParams.get("page");
      if (paged && /^\d+$/.test(paged)) {
        scheme ??= "paged";
        maxPage = Math.max(maxPage, Number(paged));
      } else if (page && /^\d+$/.test(page)) {
        scheme ??= "page";
        maxPage = Math.max(maxPage, Number(page));
      }
    }
  }

  if (!scheme || maxPage < 2) return [];
  const cap = Math.min(maxPage, 6); // 最大6ページまで
  const urls: string[] = [];
  for (let n = 2; n <= cap; n++) {
    if (scheme === "path") {
      urls.push(`${base.origin}${basePath}/page/${n}/`);
    } else {
      const u = new URL(baseUrl);
      u.searchParams.set(scheme, String(n));
      urls.push(u.toString());
    }
  }
  return urls;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 年アーカイブ「一覧ページ」判定。パス末尾が /YYYY か /YYYY/MM で終わるものだけ除外し、
 * /YYYY/MM/記事.html のような個別記事は残す（エミフル等は年フォルダ配下に記事を置く）。
 */
function isYearArchivePath(path: string): boolean {
  return /\/(19|20)\d{2}(\/\d{1,2})?\/?$/.test(path);
}

/** ページ内から「イベント一覧」ページへのリンクURLを抽出（1階層深掘り用） */
function findListingLinks(html: string, baseUrl: string): string[] {
  let sourceHost = "";
  let sourcePath = "";
  try {
    const parsedBase = new URL(baseUrl);
    sourceHost = parsedBase.host;
    sourcePath = parsedBase.pathname.replace(/\/$/, "");
  } catch {
    sourceHost = "";
    sourcePath = "";
  }
  const baseKey = baseUrl.replace(/\/$/, "");
  const found = new Set<string>();
  const anchorPattern = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    const text = normalizeWhitespace(stripTags(match[2]));
    const url = absolutizeUrl(href, baseUrl);
    let host = "";
    let path = "";
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname.toLowerCase();
    } catch {
      continue;
    }
    if (sourceHost && host !== sourceHost) continue;
    if (url.replace(/\/$/, "") === baseKey) continue;
    if (isYearArchivePath(path)) continue;
    // 現在の一覧ページ配下（＝個別詳細ページ）は「別の一覧」ではないので辿らない。
    // これをしないと /event/ 配下の詳細URLが深掘り対象として候補から除外されてしまう。
    const trimmedPath = path.replace(/\/$/, "");
    if (sourcePath && trimmedPath.startsWith(`${sourcePath.toLowerCase()}/`)) continue;
    // ヒントはリンクテキスト、またはパス末尾セグメント（一覧インデックス）でのみ判定する。
    const lastSeg = trimmedPath.split("/").pop() ?? "";
    const textHit = LISTING_HINTS.some((hint) => text.toLowerCase().includes(hint.toLowerCase()));
    const pathHit = LISTING_HINTS.some((hint) => lastSeg === hint.toLowerCase());
    if (!textHit && !pathHit) continue;
    found.add(url);
  }
  return [...found];
}

function parseRss(source: EventSourceConfig, xml: string): RawEventCandidate[] {
  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xml);
  const items = normalizeArray(doc?.rss?.channel?.item ?? doc?.feed?.entry ?? []);

  return items
    .slice(0, 30)
    .map((item: Record<string, unknown>) => {
      const title = asText(item.title);
      const linkObject = item.link && typeof item.link === "object" ? (item.link as Record<string, unknown>) : undefined;
      const link = asText(linkObject?.["@_href"] ?? item.link);
      const snippet = asText(item.description ?? item.summary ?? item.content);
      const publishedAt = asText(item.pubDate ?? item.published ?? item.updated) || new Date().toISOString();

      return {
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        title,
        url: absolutizeUrl(link, source.url),
        area: source.area,
        snippet: stripTags(snippet).slice(0, 900),
        publishedAt: normalizeDate(publishedAt)
      };
    })
    .filter((candidate) => candidate.title && candidate.url);
}

/**
 * Workers では cheerio が重く不安定なため、正規表現ベースで <a> を抽出する。
 * サイト構造の違いに強くするため「イベント語必須」はやめ、
 * 「同一ドメインの内部コンテンツリンク」で「ナビ定型を除外」する方式にする。
 * イベント語を含むリンクは優先的に前へ並べる。
 */
function parseHtml(source: EventSourceConfig, html: string): RawEventCandidate[] {
  const plainText = stripTags(html);
  const seen = new Set<string>();
  const scored: Array<{ candidate: RawEventCandidate; score: number }> = [];

  let sourceHost = "";
  try {
    sourceHost = new URL(source.url).host;
  } catch {
    sourceHost = "";
  }

  const anchorPattern = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;

    const rawTitle = normalizeWhitespace(stripTags(match[2]));

    // 年アーカイブ(例:「2011年」)やページ番号だけのリンクを除外
    const compact = rawTitle.replace(/\s/g, "");
    if (/^(19|20)\d{2}年?$/.test(compact)) continue;
    if (/^\d{1,3}$/.test(compact)) continue;

    const lower = rawTitle.toLowerCase();
    if (rawTitle.length >= 5 && NAV_DENY.some((word) => lower.includes(word.toLowerCase()))) continue;

    const url = absolutizeUrl(href, source.url).split("#")[0];
    // 絞り込み/ページング系クエリは除外（個別IDクエリ ?a=75 等は許可）
    const queryIndex = url.indexOf("?");
    if (queryIndex !== -1) {
      const query = url.slice(queryIndex + 1);
      if (query.includes("[]")) continue; // 配列フィルタ（例: category_m[]=）
      if (/(^|&)(category|area|genre|tag|keyword|search|sort|month|page|cat|kw|list)\b/i.test(query)) continue;
    }
    let path = "";
    let host = "";
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      continue;
    }
    // 外部リンク・トップページは除外（詳細ページを狙う）
    if (sourceHost && host !== sourceHost) continue;
    if (path === "/" || path === "") continue;
    if (url.replace(/\/$/, "") === source.url.replace(/\/$/, "")) continue; // 自ページへのリンク
    if (PATH_DENY.some((seg) => path.toLowerCase().includes(seg))) continue;
    if (isYearArchivePath(path)) continue; // 年アーカイブ一覧URL（例: /2011/ , /2026/03/）。記事(/2026/07/075930.html)は残す
    if (seen.has(url)) continue;

    // テキストが短い場合はURLスラッグから仮タイトルを作る（実タイトルはAIが付け直す）
    // ※同じURLを指す「画像リンク(テキスト無)」と「テキストリンク」が並ぶサイトがあるため、
    //   タイトルが確定してから seen に登録する（先に登録すると後続のテキストリンクが弾かれる）。
    let title = rawTitle.slice(0, 120);
    if (title.length < 5) {
      const slug = slugTitle(path);
      if (!slug) continue; // スラッグからも作れなければ除外（seen には登録しない）
      title = slug;
    }
    seen.add(url);
    const hasEventWord = EVENT_WORDS.some((word) => rawTitle.includes(word));

    scored.push({
      score: hasEventWord ? 1 : 0,
      candidate: {
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: source.url,
        title,
        url,
        area: source.area,
        snippet: snippetAround(plainText, title),
        publishedAt: new Date().toISOString()
      }
    });
  }

  // イベント語を含むものを優先し、最大40件
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((entry) => entry.candidate);
}

function snippetAround(plainText: string, title: string): string {
  const index = plainText.indexOf(title);
  if (index === -1) return title;
  const start = Math.max(0, index - 100);
  return plainText.slice(start, start + 900);
}

function normalizeArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") return [value as Record<string, unknown>];
  return [];
}

function asText(value: unknown): string {
  if (typeof value === "string") return normalizeWhitespace(value);
  if (value && typeof value === "object" && "#text" in value) return asText((value as { "#text": unknown })["#text"]);
  return "";
}

function stripTags(value: string): string {
  return normalizeWhitespace(value.replace(/<[^>]+>/g, " "));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** URLの末尾スラッグから仮タイトルを作る。汎用的すぎる/数字だけの場合は空を返す */
function slugTitle(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  let slug = "";
  try {
    slug = decodeURIComponent(last);
  } catch {
    slug = last;
  }
  slug = slug.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_]+/g, " ").trim();
  const generic = ["event", "events", "index", "top", "home", "news", "list", "detail"];
  if (slug.length < 3) return "";
  if (/^\d+$/.test(slug)) return "";
  if (generic.includes(slug.toLowerCase())) return "";
  return slug.slice(0, 120);
}

function absolutizeUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function normalizeDate(value: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}
