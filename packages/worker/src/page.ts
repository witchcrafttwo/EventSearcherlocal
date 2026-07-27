/** 単一ページを取得してプレーンテキスト化（AI要約の材料にする） */
export async function fetchPageText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "prefecture-events-ai/0.1" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return "";
    const html = await response.text();
    return stripToText(html);
  } catch {
    return "";
  }
}

/** ページを1回取得して、本文テキストと代表画像URL(og:image等)を返す */
export async function fetchPageData(url: string): Promise<{ text: string; imageUrl?: string }> {
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "prefecture-events-ai/0.1" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return { text: "" };
    const html = await response.text();
    return { text: stripToText(html), imageUrl: extractImage(html, url) };
  } catch {
    return { text: "" };
  }
}

/** 代表画像URLを抽出: og:image → twitter:image → 本文中の最初の大きめ画像 */
export function extractImage(html: string, baseUrl: string): string | undefined {
  const meta = matchMeta(html, "og:image") || matchMeta(html, "twitter:image") || matchMeta(html, "og:image:url");
  if (meta) return absolutize(meta, baseUrl);
  const imgs = [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  const candidate = imgs.find(
    (src) => !/(logo|icon|sprite|banner|button|blank|spacer|loading|noimage)/i.test(src) && /\.(jpe?g|png|webp)(\?|$)/i.test(src)
  );
  return candidate ? absolutize(candidate, baseUrl) : undefined;
}

function matchMeta(html: string, property: string): string | undefined {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*\\bcontent=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`, "i")
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function absolutize(value: string, base: string): string {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

/** HTMLから本文っぽいテキストを抽出。ヘッダ/フッタ/ナビをある程度除去する */
export function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * AI要約に渡すテキストを組み立てる。
 * 先頭(タイトル/概要)に加えて、住所・会場・開催地など「場所」を示す箇所の周辺を必ず含める。
 * これにより、メニューが長いページでも開催地(市区町村)がAIに届く。
 */
export function buildAiText(fullText: string, maxChars = 5000): string {
  const head = fullText.slice(0, 3200);
  const keywords = ["開催日", "開催期間", "日時", "日程", "期間", "開催", "住所", "所在地", "会場", "開催場所", "開催地", "場所", "アクセス"];
  const parts: string[] = [head];
  let used = head.length;

  for (const keyword of keywords) {
    if (used >= maxChars) break;
    let from = 0;
    let idx = fullText.indexOf(keyword, from);
    while (idx !== -1 && used < maxChars) {
      if (idx >= 3200) {
        const chunk = fullText.slice(idx, idx + 160);
        parts.push(chunk);
        used += chunk.length;
      }
      from = idx + keyword.length;
      idx = fullText.indexOf(keyword, from);
    }
  }
  return parts.join(" … ").slice(0, maxChars);
}
