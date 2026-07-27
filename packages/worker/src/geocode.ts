import type { EventRecord } from "./types.js";

/**
 * OpenStreetMap Nominatim で住所/会場名を緯度経度に変換する（無料・APIキー不要）。
 * 利用規約に配慮し、User-Agentを付け、1件ずつ（収集は直列なので自然に低頻度）呼ぶ。
 * 失敗時は null を返す（呼び出し側は市中心にフォールバック）。
 */
export async function geocode(query: string): Promise<{ lat: number; lng: number } | null> {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "prefecture-events-ai/0.1 (ehime event map)",
        accept: "application/json"
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const hit = data[0];
    if (!hit?.lat || !hit?.lon) return null;
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/** ジオコーディング用のクエリを組み立てる。住所優先、無ければ会場名＋エリア。愛媛県を補う。 */
export function buildGeoQuery(event: Pick<EventRecord, "address" | "venue" | "area">): string | undefined {
  const address = (event.address ?? "").trim();
  if (address) return /愛媛|Ehime/i.test(address) ? address : `愛媛県 ${address}`;
  const venue = (event.venue ?? "").trim();
  const area = (event.area ?? "").trim();
  if (venue) return `愛媛県 ${area} ${venue}`.replace(/\s+/g, " ").trim();
  return undefined; // 手がかりが無ければジオコーディングしない（市中心に任せる）
}
