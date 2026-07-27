import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import type { EventItem } from "./api";
import { categoryColor } from "./categoryColors";

type Props = {
  month: Date; // 表示中の月（1日）
  events: EventItem[];
  selectedDay: string | null; // "YYYY-MM-DD"
  onPrev: () => void;
  onNext: () => void;
  onPickDay: (day: string | null) => void;
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type DayInfo = { count: number; categories: string[] };

/** 各日のイベント件数と、その日に含まれるカテゴリ一覧を集計（開催期間の各日に反映） */
function infoByDay(events: EventItem[], monthStart: Date, monthEnd: Date): Record<string, DayInfo> {
  const map: Record<string, { count: number; cats: Set<string> }> = {};
  for (const e of events) {
    if (!e.eventDate) continue;
    const start = new Date(e.eventDate);
    if (Number.isNaN(start.getTime())) continue;
    const end = e.eventEndDate ? new Date(e.eventEndDate) : start;
    const from = start < monthStart ? new Date(monthStart) : new Date(start);
    const to = (Number.isNaN(end.getTime()) ? start : end) > monthEnd ? new Date(monthEnd) : new Date(Number.isNaN(end.getTime()) ? start : end);
    const cat = (e.category ?? "").trim() || "その他";
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const key = ymd(d);
      const cur = map[key] ?? { count: 0, cats: new Set<string>() };
      cur.count += 1;
      cur.cats.add(cat);
      map[key] = cur;
    }
  }
  const result: Record<string, DayInfo> = {};
  for (const [k, v] of Object.entries(map)) result[k] = { count: v.count, categories: [...v.cats] };
  return result;
}

export function EventCalendar({ month, events, selectedDay, onPrev, onNext, onPickDay }: Props) {
  const { cells, info, todayStr } = useMemo(() => {
    const year = month.getFullYear();
    const mon = month.getMonth();
    const monthStart = new Date(year, mon, 1);
    const monthEnd = new Date(year, mon + 1, 0);
    const info = infoByDay(events, monthStart, monthEnd);
    const leading = monthStart.getDay(); // 先頭の空白（日曜始まり）
    const total = monthEnd.getDate();
    const cells: Array<{ day: number; key: string } | null> = [];
    for (let i = 0; i < leading; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push({ day: d, key: ymd(new Date(year, mon, d)) });
    return { cells, info, todayStr: ymd(new Date()) };
  }, [month, events]);

  const label = `${month.getFullYear()}年${month.getMonth() + 1}月`;

  return (
    <div className="calendar">
      <div className="calHeader">
        <button type="button" className="calNav" onClick={onPrev} aria-label="前の月"><ChevronLeft size={18} /></button>
        <span className="calLabel">{label}</span>
        <button type="button" className="calNav" onClick={onNext} aria-label="次の月"><ChevronRight size={18} /></button>
      </div>
      <div className="calGrid calWeekdays">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={i === 0 ? "calWd sun" : i === 6 ? "calWd sat" : "calWd"}>{w}</div>
        ))}
      </div>
      <div className="calGrid">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`b${i}`} className="calCell empty" />;
          const dayInfo = info[cell.key];
          const count = dayInfo?.count ?? 0;
          const cats = dayInfo?.categories ?? [];
          const isToday = cell.key === todayStr;
          const isSelected = cell.key === selectedDay;
          const dow = i % 7;
          const cls = [
            "calCell",
            count > 0 ? "has" : "",
            isToday ? "today" : "",
            isSelected ? "selected" : "",
            dow === 0 ? "sun" : dow === 6 ? "sat" : ""
          ].join(" ").trim();
          return (
            <button
              key={cell.key}
              type="button"
              className={cls}
              onClick={() => onPickDay(isSelected ? null : cell.key)}
              disabled={count === 0}
              aria-label={`${cell.day}日 イベント${count}件`}
            >
              <span className="calDay">{cell.day}</span>
              {cats.length > 0 && (
                <span className="calCats">
                  {cats.slice(0, 3).map((c) => (
                    <span
                      key={c}
                      className="calCat"
                      style={{ background: `${categoryColor(c)}22`, color: categoryColor(c) }}
                    >
                      {c}
                    </span>
                  ))}
                  {cats.length > 3 && <span className="calCatMore">＋{cats.length - 3}</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
