// 愛媛県20市町のおおよその中心座標（会場ピンポイントではなく市町の中心）。
// イベントには緯度経度が無いため、開催地(area)からこの座標を引いてマップに表示する。
export const AREA_COORDS: Record<string, [number, number]> = {
  "松山市": [33.8392, 132.7657],
  "今治市": [34.0663, 132.9976],
  "宇和島市": [33.2235, 132.5606],
  "八幡浜市": [33.4627, 132.4231],
  "新居浜市": [33.9603, 133.2833],
  "西条市": [33.9192, 133.1810],
  "大洲市": [33.5061, 132.5447],
  "伊予市": [33.7570, 132.7040],
  "四国中央市": [33.9793, 133.5497],
  "西予市": [33.3625, 132.5107],
  "東温市": [33.7911, 132.8710],
  "上島町": [34.2560, 133.2030],
  "久万高原町": [33.6560, 132.9030],
  "松前町": [33.7893, 132.7110],
  "砥部町": [33.7480, 132.7910],
  "内子町": [33.5330, 132.6540],
  "伊方町": [33.4890, 132.3540],
  "松野町": [33.2260, 132.7060],
  "鬼北町": [33.2540, 132.6900],
  "愛南町": [32.9630, 132.5670]
};

// 中心のフォールバック（松山付近）
export const EHIME_CENTER: [number, number] = [33.8392, 132.7657];

/** エリア名から座標を引く。完全一致 → 部分一致の順。見つからなければ null。 */
export function coordFor(area: string | undefined): [number, number] | null {
  const a = (area ?? "").trim();
  if (!a) return null;
  if (AREA_COORDS[a]) return AREA_COORDS[a];
  for (const key of Object.keys(AREA_COORDS)) {
    if (a.includes(key) || key.includes(a)) return AREA_COORDS[key];
  }
  return null;
}

/** eventId から決定的な微小オフセットを作る（同じ市のイベントが完全に重ならないように） */
export function jitter(id: string): [number, number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const dLat = ((h % 1000) / 1000 - 0.5) * 0.012;
  const dLng = ((Math.floor(h / 1000) % 1000) / 1000 - 0.5) * 0.012;
  return [dLat, dLng];
}
