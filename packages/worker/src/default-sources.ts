// 既定の情報源（旧 config/event-sources.json をTSモジュール化）。
// ESM環境でのJSONインポート属性問題を避けるためコード化している。
export type DefaultSource = {
  id?: string;
  name?: string;
  url: string;
  area?: string;
  type?: string;
  enabled?: boolean;
};

export const defaultSources: DefaultSource[] = [
  {
    name: "大洲市 イベント・行事",
    url: "https://www.city.ozu.ehime.jp/soshiki/list6-1.html",
    area: "大洲市",
    type: "html"
  }
];
