export type EventSourceConfig = {
  id: string;
  name: string;
  url: string;
  area: string;
  type: "html" | "rss";
};

export type UserProfile = {
  profileId: string;
  childAge: number;
  interests: string[];
  area: string;
  notificationLeadDays: number;
  createdAt: string;
  updatedAt: string;
};

export type RawEventCandidate = {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  url: string;
  area: string;
  snippet: string;
  publishedAt: string;
};

export type EventRecord = {
  eventId: string;
  eventType: "event";
  title: string;
  summary: string;
  url: string;
  area: string;
  sourceId: string;
  sourceName: string;
  publishedAt: string;
  eventDate?: string;
  targetAgeMin?: number;
  targetAgeMax?: number;
  interests: string[];
  createdAt: string;
};

export type PushSubscriptionRecord = {
  profileId: string;
  endpointHash: string;
  subscription: {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  createdAt: string;
  updatedAt: string;
};
