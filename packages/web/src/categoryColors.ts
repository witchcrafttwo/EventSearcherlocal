// カテゴリごとの色。カレンダーの色バー・グループ見出し・バッジで共通利用する。
export const CATEGORY_COLORS: Record<string, string> = {
  "祭り・伝統": "#dc2626",
  "音楽・ライブ": "#7c3aed",
  "スポーツ": "#2563eb",
  "自然・アウトドア": "#16a34a",
  "アート・展示": "#db2777",
  "グルメ・マルシェ": "#d97706",
  "ワークショップ": "#4f46e5",
  "文化・講演": "#0d9488",
  "デパート・モール": "#ea580c",
  "その他": "#64748b"
};

export function categoryColor(category: string | undefined): string {
  return CATEGORY_COLORS[(category ?? "").trim()] ?? "#64748b";
}
