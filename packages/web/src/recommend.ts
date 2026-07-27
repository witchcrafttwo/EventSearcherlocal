import type { EventItem } from "./api";

// 閲覧履歴・ブックマークから「好み」を推定し、おすすめイベントを算出する（すべてローカル）。
// 履歴タブ表示のため、イベント全体を保存する。
const VIEW_KEY = "events-ai-views";
const MAX_VIEWS = 120;

type ViewRecord = { event: EventItem; ts: number };

function loadViewRecords(): ViewRecord[] {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ViewRecord[];
    // 旧フォーマット（eventを持たない）や壊れた要素は除外
    return Array.isArray(parsed) ? parsed.filter((v) => v && typeof v === "object" && v.event && v.event.eventId) : [];
  } catch {
    return [];
  }
}

/** イベントを閲覧したことを記録（詳細クリック時などに呼ぶ）。同一は最新へ寄せ、最大件数で打ち切り。 */
export function recordView(event: EventItem): void {
  const list = loadViewRecords().filter((v) => v.event.eventId !== event.eventId);
  list.unshift({ event, ts: Date.now() });
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(list.slice(0, MAX_VIEWS)));
  } catch {
    /* 保存失敗は無視 */
  }
}

/** 閲覧したイベントを新しい順で返す（履歴タブ用） */
export function loadViewedEvents(): EventItem[] {
  return loadViewRecords().map((v) => v.event);
}

/** 閲覧履歴を全消去 */
export function clearViews(): void {
  try {
    localStorage.removeItem(VIEW_KEY);
  } catch {
    /* 無視 */
  }
}

export function viewCount(): number {
  return loadViewRecords().length;
}

type Preferences = {
  category: Record<string, number>;
  area: Record<string, number>;
  hasSignal: boolean;
};

/** ブックマーク(強い好み)＋閲覧履歴(弱い好み)から、カテゴリ・エリアの重みを作る。 */
export function buildPreferences(bookmarks: EventItem[]): Preferences {
  const category: Record<string, number> = {};
  const area: Record<string, number> = {};
  const add = (map: Record<string, number>, key: string | undefined, weight: number) => {
    const k = (key ?? "").trim();
    if (k) map[k] = (map[k] ?? 0) + weight;
  };

  // ブックマーク: 強い好み
  for (const b of bookmarks) {
    add(category, b.category, 3);
    add(area, b.area, 2);
  }
  // 閲覧履歴: 弱い好み
  for (const v of loadViewRecords()) {
    add(category, v.event.category, 1);
    add(area, v.event.area, 0.5);
  }

  const hasSignal = Object.keys(category).length > 0 || Object.keys(area).length > 0;
  return { category, area, hasSignal };
}

/**
 * おすすめイベントを算出。
 * - 好みのカテゴリ/エリアに一致するほど高スコア
 * - 既にブックマーク済みは除外（発見性のため）
 * - 終了済み（開催日が過去）は除外。日付不明は残す
 * - スコア0以下は出さない
 */
export function recommend(
  events: EventItem[],
  preferences: Preferences,
  bookmarkedIds: Set<string>,
  limit = 8
): EventItem[] {
  if (!preferences.hasSignal) return [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const scored = events
    .filter((e) => !bookmarkedIds.has(e.eventId))
    .filter((e) => {
      const end = e.eventEndDate ?? e.eventDate;
      if (!end) return true;
      const d = new Date(end);
      return Number.isNaN(d.getTime()) || d >= startOfToday;
    })
    .map((e) => {
      const catScore = preferences.category[(e.category ?? "").trim()] ?? 0;
      const areaScore = preferences.area[(e.area ?? "").trim()] ?? 0;
      return { event: e, score: catScore + areaScore * 0.5 };
    })
    .filter((x) => x.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同点は開催日が近い順
    const da = a.event.eventDate ? new Date(a.event.eventDate).getTime() : Infinity;
    const db = b.event.eventDate ? new Date(b.event.eventDate).getTime() : Infinity;
    return da - db;
  });

  return scored.slice(0, limit).map((x) => x.event);
}
