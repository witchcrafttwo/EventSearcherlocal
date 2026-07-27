const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export type Source = {
  id: string;
  name: string;
  url: string;
  area: string;
  type: "html" | "rss";
  enabled?: boolean;
  forceCategory?: string;
  showImages?: boolean;
  note?: string;
  lastIngestAt?: string;
  lastCandidates?: number;
  lastSaved?: number;
};

const TOKEN_KEY = "events-ai-admin-token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

function prefix(): string {
  return apiBaseUrl ? apiBaseUrl.replace(/\/$/, "") : "";
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${prefix()}${path}`, { ...init, headers });
  if (response.status === 401) throw new Error("認証に失敗しました。トークンを確認してください。");
  return response;
}

export async function listSources(): Promise<Source[]> {
  const response = await adminFetch("/admin/sources-all");
  if (!response.ok) throw new Error("情報源を取得できませんでした");
  const body = (await response.json()) as { sources: Source[] };
  return body.sources;
}

export type Stats = {
  total: number;
  counts: Record<string, number>;
  unmatched: number;
  byCategory?: Record<string, number>;
  byArea?: Record<string, number>;
};

export async function getStats(): Promise<Stats> {
  const response = await adminFetch("/admin/stats");
  if (!response.ok) throw new Error("統計を取得できませんでした");
  return (await response.json()) as Stats;
}

export async function addSource(input: { url: string; name?: string; area?: string }): Promise<Source> {
  const response = await adminFetch("/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "追加できませんでした");
  }
  return ((await response.json()) as { source: Source }).source;
}

export async function deleteSource(id: string): Promise<void> {
  const response = await adminFetch(`/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("削除できませんでした");
}

export async function setSourceEnabled(id: string, enabled: boolean): Promise<void> {
  const response = await adminFetch(`/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled })
  });
  if (!response.ok) throw new Error("ON/OFFの更新に失敗しました");
}

export async function setSourceCategory(id: string, forceCategory: string): Promise<void> {
  const response = await adminFetch(`/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ forceCategory })
  });
  if (!response.ok) throw new Error("カテゴリ設定の更新に失敗しました");
}

export async function setSourceImages(id: string, showImages: boolean): Promise<void> {
  const response = await adminFetch(`/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ showImages })
  });
  if (!response.ok) throw new Error("画像表示設定の更新に失敗しました");
}

export async function setSourceNote(id: string, note: string): Promise<void> {
  const response = await adminFetch(`/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note })
  });
  if (!response.ok) throw new Error("メモの更新に失敗しました");
}

export async function runIngest(sourceId?: string): Promise<{ saved: number; notified: number; candidates: number }> {
  // PC(自前サーバー)運用のため時間制限なし。maxMs を送らず全件収集する。
  // （Vercel運用時は60秒制限対策で maxMs=50000 を付けていた）
  const params = new URLSearchParams();
  if (sourceId) params.set("sourceId", sourceId);
  const query = params.toString();
  const response = await adminFetch(`/admin/ingest${query ? `?${query}` : ""}`, { method: "POST" });
  if (!response.ok) throw new Error("収集に失敗しました");
  return (await response.json()) as { saved: number; notified: number; candidates: number };
}

export async function clearEvents(sourceId?: string): Promise<{ deleted: number }> {
  const query = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "";
  const response = await adminFetch(`/admin/clear-events${query}`, { method: "POST" });
  if (!response.ok) throw new Error("削除に失敗しました");
  return (await response.json()) as { deleted: number };
}

export type SourceEvent = {
  eventId: string;
  title: string;
  url: string;
  area?: string;
  category?: string;
  summary?: string;
  eventDate?: string;
  eventEndDate?: string;
  venue?: string;
  address?: string;
  publishedAt?: string;
  createdAt?: string;
  imageUrl?: string;
};

export async function listSourceEvents(sourceId: string): Promise<SourceEvent[]> {
  const response = await adminFetch(`/admin/source-events?sourceId=${encodeURIComponent(sourceId)}`);
  if (!response.ok) throw new Error("収集データを取得できませんでした");
  return ((await response.json()) as { events: SourceEvent[] }).events;
}

export async function deleteEvent(eventId: string): Promise<void> {
  const response = await adminFetch(`/admin/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("イベントの削除に失敗しました");
}

export type EventEditPatch = Partial<Pick<SourceEvent, "title" | "summary" | "category" | "area" | "eventDate" | "eventEndDate" | "venue" | "address">>;

export async function editEvent(eventId: string, patch: EventEditPatch): Promise<SourceEvent> {
  const response = await adminFetch(`/admin/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error("イベントの更新に失敗しました");
  return ((await response.json()) as { event: SourceEvent }).event;
}

export async function reenrichEvent(eventId: string): Promise<SourceEvent> {
  const response = await adminFetch(`/admin/events/${encodeURIComponent(eventId)}/reenrich`, { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "AI要約のやり直しに失敗しました");
  }
  return ((await response.json()) as { event: SourceEvent }).event;
}

export type ExpiredPreview = {
  count: number;
  total: number;
  days: number;
  sample: Array<{ eventId: string; title: string; eventDate?: string; eventEndDate?: string }>;
};

export async function getExpired(days: number): Promise<ExpiredPreview> {
  const response = await adminFetch(`/admin/expired-events?days=${days}`);
  if (!response.ok) throw new Error("終了済みイベントの確認に失敗しました");
  return (await response.json()) as ExpiredPreview;
}

export async function clearExpired(days: number): Promise<{ deleted: number }> {
  const response = await adminFetch(`/admin/clear-expired?days=${days}`, { method: "POST" });
  if (!response.ok) throw new Error("終了済みイベントの削除に失敗しました");
  return (await response.json()) as { deleted: number };
}

export type PreviewCandidate = { title: string; url: string };

export async function previewSource(sourceId: string): Promise<{ found: number; candidates: PreviewCandidate[] }> {
  const response = await adminFetch(`/admin/preview-source?sourceId=${encodeURIComponent(sourceId)}`);
  if (!response.ok) throw new Error("試し取得に失敗しました");
  return (await response.json()) as { found: number; candidates: PreviewCandidate[] };
}
