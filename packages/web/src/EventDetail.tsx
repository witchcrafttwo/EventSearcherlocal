import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Bookmark, BookmarkCheck, CalendarDays, ExternalLink, MapPin, Navigation, X } from "lucide-react";
import type { EventItem } from "./api";
import { coordFor } from "./geo";

type Props = {
  event: EventItem;
  saved: boolean;
  onClose: () => void;
  onToggleBookmark: (event: EventItem) => void;
};

const pinIcon = L.divIcon({
  className: "mapPinWrap",
  html: '<span class="mapPin"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10]
});

function formatDate(ev: EventItem): string {
  if (!ev.eventDate) return "日程調整中";
  const fmt = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? v
      : new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(d);
  };
  const start = fmt(ev.eventDate);
  if (ev.eventEndDate && ev.eventEndDate !== ev.eventDate) return `${start} 〜 ${fmt(ev.eventEndDate)}`;
  return start;
}

export function EventDetail({ event, saved, onClose, onToggleBookmark }: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null);

  const precise = typeof event.lat === "number" && typeof event.lng === "number";
  const coords: [number, number] | null = precise ? [event.lat as number, event.lng as number] : coordFor(event.area);

  // Escで閉じる＋背面スクロールロック
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // ミニ地図
  useEffect(() => {
    if (!coords || !mapRef.current) return;
    const map = L.map(mapRef.current, { scrollWheelZoom: false, zoomControl: true }).setView(coords, precise ? 15 : 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(map);
    L.marker(coords, { icon: pinIcon }).addTo(map);
    setTimeout(() => map.invalidateSize(), 60);
    return () => {
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mapsUrl = event.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.address)}`
    : coords
      ? `https://www.google.com/maps/search/?api=1&query=${coords[0]},${coords[1]}`
      : null;

  return (
    <div className="detailOverlay" onClick={onClose} role="presentation">
      <div
        className="detailModal"
        role="dialog"
        aria-modal="true"
        aria-label={event.title}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="detailClose" type="button" onClick={onClose} aria-label="閉じる" title="閉じる">
          <X size={20} />
        </button>

        {event.imageUrl && (
          <div className="detailImage">
            <img src={event.imageUrl} alt="" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} />
          </div>
        )}

        <div className="detailBody">
          {event.category && <span className="detailCat">{event.category}</span>}
          <h2>{event.title}</h2>

          <div className="detailMeta">
            <span><CalendarDays size={15} />{formatDate(event)}</span>
            <span><MapPin size={15} />{event.venue || event.area || "地域不明"}</span>
          </div>
          {event.address && <p className="detailAddress">{event.address}</p>}

          <p className="detailSummary">{event.summary || "詳細情報はありません。元ページをご確認ください。"}</p>

          {coords ? (
            <div className="detailMap" ref={mapRef} />
          ) : (
            <p className="detailNoMap">この会場の地図情報はありません。</p>
          )}

          <div className="detailActions">
            <a className="detailPrimary" href={event.url} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> 元ページを開く
            </a>
            {mapsUrl && (
              <a className="detailGhost" href={mapsUrl} target="_blank" rel="noreferrer">
                <Navigation size={16} /> 地図アプリで開く
              </a>
            )}
            <button
              className={saved ? "detailGhost saved" : "detailGhost"}
              type="button"
              onClick={() => onToggleBookmark(event)}
            >
              {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
              {saved ? "ブックマーク済み" : "ブックマーク"}
            </button>
          </div>

          <p className="detailSource">出典: {event.sourceName}</p>
        </div>
      </div>
    </div>
  );
}
