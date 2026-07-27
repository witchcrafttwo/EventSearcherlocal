import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { EventItem } from "./api";
import { coordFor, EHIME_CENTER, jitter } from "./geo";

type Props = { events: EventItem[] };

const eventPin = L.divIcon({
  className: "mapPinWrap",
  html: '<span class="mapPin"></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10]
});

const mefPin = L.divIcon({
  className: "mapMeWrap",
  html: '<span class="mapMe"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

function formatDate(ev: EventItem): string {
  if (!ev.eventDate) return "日程調整中";
  const fmt = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric" }).format(d);
  };
  const start = fmt(ev.eventDate);
  if (ev.eventEndDate && ev.eventEndDate !== ev.eventDate) return `${start}〜${fmt(ev.eventEndDate)}`;
  return start;
}

/** イベント1件のポップアップDOMを作る（XSS防止のためテキストはtextContentで設定） */
function popupContent(ev: EventItem): HTMLElement {
  const box = document.createElement("div");
  box.className = "mapPopup";

  if (ev.category) {
    const cat = document.createElement("span");
    cat.className = "mapPopupCat";
    cat.textContent = ev.category;
    box.appendChild(cat);
  }

  const title = document.createElement("strong");
  title.textContent = ev.title;
  box.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "mapPopupMeta";
  meta.textContent = `${ev.area || "地域不明"}・${formatDate(ev)}`;
  box.appendChild(meta);

  if (ev.venue) {
    const venue = document.createElement("div");
    venue.className = "mapPopupVenue";
    venue.textContent = `📍 ${ev.venue}`;
    box.appendChild(venue);
  }

  const link = document.createElement("a");
  link.href = ev.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "詳細 →";
  box.appendChild(link);

  return box;
}

export function EventsMap({ events }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const locatedRef = useRef(false);

  // 地図の初期化（マウント時に一度）
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { scrollWheelZoom: true }).setView(EHIME_CENTER, 9);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
    map.addLayer(cluster);
    mapRef.current = map;
    clusterRef.current = cluster;

    // レイアウト確定後にサイズ再計算
    setTimeout(() => map.invalidateSize(), 100);

    // 現在地を取得して中心化（許可された場合のみ）
    if (!locatedRef.current && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          locatedRef.current = true;
          const here: [number, number] = [pos.coords.latitude, pos.coords.longitude];
          map.setView(here, 11);
          L.marker(here, { icon: mefPin, title: "現在地" }).addTo(map).bindPopup("現在地");
        },
        () => {
          /* 拒否/失敗時は愛媛中心のまま */
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
      );
    }

    return () => {
      map.remove();
      mapRef.current = null;
      clusterRef.current = null;
    };
  }, []);

  // イベント（絞り込み結果）が変わるたびにピンを貼り直す
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    cluster.clearLayers();
    for (const ev of events) {
      const precise = typeof ev.lat === "number" && typeof ev.lng === "number";
      const base: [number, number] | null = precise ? [ev.lat as number, ev.lng as number] : coordFor(ev.area);
      if (!base) continue; // 座標が引けないものはスキップ
      // 会場座標があればそのまま、市中心フォールバック時のみ微小ジッターで重なりを回避
      const [jLat, jLng] = precise ? [0, 0] : jitter(ev.eventId);
      const marker = L.marker([base[0] + jLat, base[1] + jLng], { icon: eventPin, title: ev.title });
      marker.bindPopup(() => popupContent(ev), { minWidth: 200 });
      cluster.addLayer(marker);
    }
  }, [events]);

  const plotted = events.filter((e) => (typeof e.lat === "number" && typeof e.lng === "number") || coordFor(e.area)).length;
  const skipped = events.length - plotted;

  return (
    <div className="mapWrap">
      <div ref={containerRef} className="eventsMap" />
      {skipped > 0 && (
        <p className="mapNote">地図に表示: {plotted}件（開催地が特定できない {skipped}件は非表示）</p>
      )}
    </div>
  );
}
