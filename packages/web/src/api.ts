export type Profile = {
  profileId?: string;
  childAge: number;
  interests: string[];
  area: string;
  notificationLeadDays: number;
};

export type EventItem = {
  eventId: string;
  title: string;
  summary: string;
  url: string;
  area: string;
  category?: string;
  imageUrl?: string;
  sourceName: string;
  publishedAt: string;
  createdAt?: string;
  eventDate?: string;
  eventEndDate?: string;
  venue?: string;
  address?: string;
  lat?: number;
  lng?: number;
  targetAgeMin?: number;
  targetAgeMax?: number;
  interests: string[];
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export function hasApiConfig(): boolean {
  return true;
}

export async function saveProfile(profile: Profile): Promise<Profile & { profileId: string }> {
  const response = await fetch(`${apiPrefix()}/profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(profile)
  });
  if (!response.ok) throw new Error("プロフィールを保存できませんでした");
  const body = await response.json() as { profile: Profile & { profileId: string } };
  return body.profile;
}

export async function fetchEvents(profileId: string): Promise<EventItem[]> {
  const response = await fetch(`${apiPrefix()}/profiles/${encodeURIComponent(profileId)}/events`);
  if (!response.ok) throw new Error("イベント一覧を取得できませんでした");
  const body = await response.json() as { events: EventItem[] };
  return body.events;
}

export async function fetchAreas(): Promise<string[]> {
  const response = await fetch(`${apiPrefix()}/areas`);
  if (!response.ok) return [];
  const body = await response.json() as { areas: string[] };
  return body.areas;
}

export async function searchEvents(area: string): Promise<EventItem[]> {
  const query = area ? `?area=${encodeURIComponent(area)}` : "";
  const response = await fetch(`${apiPrefix()}/events${query}`);
  if (!response.ok) throw new Error("イベントを検索できませんでした");
  const body = await response.json() as { events: EventItem[] };
  return body.events;
}

export async function savePushSubscription(profileId: string, subscription: PushSubscriptionJSON): Promise<void> {
  const response = await fetch(`${apiPrefix()}/profiles/${encodeURIComponent(profileId)}/subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription)
  });
  if (!response.ok) throw new Error("通知登録に失敗しました");
}

export async function getVapidPublicKey(): Promise<string> {
  const response = await fetch(`${apiPrefix()}/vapid-public-key`);
  if (!response.ok) return "";
  const body = (await response.json()) as { publicKey: string };
  return body.publicKey ?? "";
}

function apiPrefix(): string {
  return apiBaseUrl ? apiBaseUrl.replace(/\/$/, "") : "";
}
