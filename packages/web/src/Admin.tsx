import { AlertTriangle, BarChart3, CalendarX, ChevronDown, ChevronRight, Eraser, Eye, Link2, ListChecks, LogIn, Pencil, Plus, RefreshCw, Save, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { addSource, clearEvents, clearExpired, deleteEvent, deleteSource, editEvent, getExpired, getStats, getToken, listSourceEvents, listSources, previewSource, reenrichEvent, runIngest, setSourceCategory, setSourceEnabled, setSourceImages, setSourceNote, setToken, type EventEditPatch, type PreviewCandidate, type Source, type SourceEvent, type Stats } from "./adminApi";

const CATEGORIES = ["祭り・伝統", "音楽・ライブ", "スポーツ", "自然・アウトドア", "アート・展示", "グルメ・マルシェ", "ワークショップ", "文化・講演", "デパート・モール", "その他"];

export function Admin() {
  const [token, setTokenState] = useState(getToken());
  const [authed, setAuthed] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [newArea, setNewArea] = useState("");
  const [status, setStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openEvents, setOpenEvents] = useState<SourceEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventFilter, setEventFilter] = useState("");
  const [eventCatFilter, setEventCatFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EventEditPatch>({});
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewList, setPreviewList] = useState<PreviewCandidate[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  useEffect(() => {
    if (getToken()) void tryLoad();
  }, []);

  async function tryLoad() {
    await run("読み込みました。", async () => {
      setSources(await listSources());
      setAuthed(true);
      void getStats().then(setStats).catch(() => setStats(null));
    });
  }

  async function refreshStats() {
    try {
      setStats(await getStats());
    } catch {
      /* 無視 */
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setToken(token.trim());
    await tryLoad();
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newUrl.trim()) return;
    await run("情報源を追加しました。", async () => {
      const created = await addSource({ url: newUrl.trim(), area: newArea.trim() || undefined });
      setSources((current) => [...current.filter((s) => s.id !== created.id), created]);
      setNewUrl("");
      setNewArea("");
    });
  }

  async function handleDelete(id: string) {
    await run("削除しました。", async () => {
      await deleteSource(id);
      setSources((current) => current.filter((s) => s.id !== id));
      await refreshStats();
    });
  }

  async function handleToggle(source: Source) {
    const next = source.enabled === false;
    // 楽観的に更新
    setSources((current) => current.map((s) => (s.id === source.id ? { ...s, enabled: next } : s)));
    try {
      await setSourceEnabled(source.id, next);
      setStatus(`「${source.name}」を${next ? "表示" : "非表示"}にしました。`);
    } catch (error) {
      // 失敗したら戻す
      setSources((current) => current.map((s) => (s.id === source.id ? { ...s, enabled: !next } : s)));
      setStatus(error instanceof Error ? error.message : "更新に失敗しました。");
    }
  }

  async function handleClear() {
    if (!window.confirm("保存済みのイベントを全て削除します。よろしいですか？（登録サイトは消えません）")) return;
    await run("全イベントを削除しました。収集し直してください。", async () => {
      const result = await clearEvents();
      setStatus(`${result.deleted}件のイベントを削除しました。`);
      await refreshStats();
    });
  }

  async function handleCategoryChange(source: Source, forceCategory: string) {
    const prev = source.forceCategory;
    setSources((current) => current.map((s) => (s.id === source.id ? { ...s, forceCategory: forceCategory || undefined } : s)));
    try {
      await setSourceCategory(source.id, forceCategory);
      if (forceCategory) {
        setStatus(`「${source.name}」のカテゴリを「${forceCategory}」に固定しました（表示に即反映されます）。`);
      } else {
        setStatus(`「${source.name}」のカテゴリ固定を解除しました。`);
      }
    } catch (error) {
      setSources((current) => current.map((s) => (s.id === source.id ? { ...s, forceCategory: prev } : s)));
      setStatus(error instanceof Error ? error.message : "更新に失敗しました。");
    }
  }

  async function handleToggleImages(source: Source) {
    const next = source.showImages === false; // 現在OFFなら次はON
    setSources((current) => current.map((s) => (s.id === source.id ? { ...s, showImages: next } : s)));
    try {
      await setSourceImages(source.id, next);
      setStatus(`「${source.name}」の画像表示を${next ? "ON" : "OFF"}にしました（表示に即反映）。`);
    } catch (error) {
      setSources((current) => current.map((s) => (s.id === source.id ? { ...s, showImages: !next } : s)));
      setStatus(error instanceof Error ? error.message : "更新に失敗しました。");
    }
  }

  async function handleNoteSave(source: Source, note: string) {
    if ((source.note ?? "") === note.trim()) return; // 変更なしなら何もしない
    const prev = source.note;
    setSources((current) => current.map((s) => (s.id === source.id ? { ...s, note: note.trim() || undefined } : s)));
    try {
      await setSourceNote(source.id, note);
      setStatus(`「${source.name}」のメモを保存しました。`);
    } catch (error) {
      setSources((current) => current.map((s) => (s.id === source.id ? { ...s, note: prev } : s)));
      setStatus(error instanceof Error ? error.message : "メモの保存に失敗しました。");
    }
  }

  async function toggleEvents(source: Source) {
    if (openId === source.id) {
      setOpenId(null);
      setOpenEvents([]);
      return;
    }
    setOpenId(source.id);
    setOpenEvents([]);
    setLoadingEvents(true);
    try {
      setOpenEvents(await listSourceEvents(source.id));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "収集データの取得に失敗しました。");
      setOpenId(null);
    } finally {
      setLoadingEvents(false);
    }
  }

  async function handleDeleteEvent(event: SourceEvent) {
    if (!window.confirm(`このイベントを削除します。よろしいですか？\n\n${event.title}`)) return;
    setOpenEvents((current) => current.filter((e) => e.eventId !== event.eventId)); // 楽観的に消す
    try {
      await deleteEvent(event.eventId);
      setStatus(`イベント「${event.title}」を削除しました。`);
      await refreshStats();
    } catch (error) {
      setOpenEvents((current) => [event, ...current]); // 失敗したら戻す
      setStatus(error instanceof Error ? error.message : "イベントの削除に失敗しました。");
    }
  }

  function startEdit(ev: SourceEvent) {
    setEditingId(ev.eventId);
    setEditDraft({
      title: ev.title,
      summary: ev.summary,
      category: ev.category,
      area: ev.area,
      venue: ev.venue,
      address: ev.address,
      eventDate: ev.eventDate,
      eventEndDate: ev.eventEndDate
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({});
  }

  async function saveEdit(ev: SourceEvent) {
    try {
      const updated = await editEvent(ev.eventId, editDraft);
      setOpenEvents((current) => current.map((e) => (e.eventId === ev.eventId ? { ...e, ...updated } : e)));
      setStatus(`イベント「${updated.title}」を更新しました。`);
      cancelEdit();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "更新に失敗しました。");
    }
  }

  async function handleReenrich(ev: SourceEvent) {
    setStatus(`「${ev.title}」をAIで要約し直しています…`);
    try {
      const updated = await reenrichEvent(ev.eventId);
      setOpenEvents((current) => current.map((e) => (e.eventId === ev.eventId ? { ...e, ...updated } : e)));
      setStatus(`「${updated.title}」をAIで要約し直しました。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "AI要約のやり直しに失敗しました。");
    }
  }

  async function handleClearExpired() {
    const input = window.prompt("何日より前に終了したイベントを削除しますか？（0=今日より前。日付が取れないものは削除しません）", "0");
    if (input === null) return;
    const days = Math.max(Number(input) || 0, 0);
    setIsBusy(true);
    try {
      const preview = await getExpired(days);
      if (preview.count === 0) {
        setStatus("削除対象の終了済みイベントはありませんでした。");
        return;
      }
      if (!window.confirm(`終了済みイベント ${preview.count}件（全${preview.total}件中）を削除します。よろしいですか？`)) return;
      const result = await clearExpired(days);
      setStatus(`終了済みイベント ${result.deleted}件を削除しました。`);
      await refreshStats();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "処理に失敗しました。");
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePreview(source: Source) {
    if (previewId === source.id) {
      setPreviewId(null);
      setPreviewList([]);
      return;
    }
    setPreviewId(source.id);
    setPreviewList([]);
    setPreviewLoading(true);
    try {
      const result = await previewSource(source.id);
      setPreviewList(result.candidates);
      setStatus(`「${source.name}」の試し取得: 候補 ${result.found}件（保存はしていません）。`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "試し取得に失敗しました。");
      setPreviewId(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleClearOne(source: Source) {
    if (!window.confirm(`「${source.name}」で収集したイベントを削除します。よろしいですか？（サイト登録は残ります）`)) return;
    await run(`「${source.name}」のイベントを削除しました。`, async () => {
      const result = await clearEvents(source.id);
      setStatus(`「${source.name}」のイベント ${result.deleted}件を削除しました。`);
      await refreshStats();
    });
  }

  async function handleIngestOne(source: Source) {
    setIsBusy(true);
    setStatus(`「${source.name}」を収集中…（時間がかかる場合があります）`);
    try {
      const result = await runIngest(source.id);
      setStatus(`「${source.name}」収集完了: ${result.saved}件を新規/更新（候補${result.candidates}件）。`);
      await refreshStats();
    } catch (error) {
      setStatus(`「${source.name}」の収集でエラー: ${error instanceof Error ? error.message : "失敗"}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleIngest() {
    setIsBusy(true);
    setStatus("収集を開始します…");
    try {
      let totalSaved = 0;
      const targets = sources; // 収集は全ソース（表示ON/OFFは検索側で制御）
      for (let i = 0; i < targets.length; i++) {
        const source = targets[i];
        setStatus(`収集中 (${i + 1}/${targets.length}): ${source.name} …`);
        try {
          const result = await runIngest(source.id);
          totalSaved += result.saved;
        } catch (error) {
          setStatus(`「${source.name}」の収集でエラー: ${error instanceof Error ? error.message : "失敗"}（続行します）`);
        }
      }
      setStatus(`収集完了: 合計 ${totalSaved}件を新規/更新しました。`);
      await refreshStats();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "処理に失敗しました。");
    } finally {
      setIsBusy(false);
    }
  }

  async function run(doneMessage: string, task: () => Promise<void>) {
    setIsBusy(true);
    setStatus("処理中です。");
    try {
      await task();
      setStatus(doneMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "処理に失敗しました。");
    } finally {
      setIsBusy(false);
    }
  }

  if (!authed) {
    return (
      <main className="appShell">
        <section className="workspace">
          <div className="toolbar">
            <div>
              <p className="eyebrow">管理者</p>
              <h1>管理者ログイン</h1>
            </div>
          </div>
          <form className="sourcePanel" onSubmit={handleLogin}>
            <p className="hint">管理者トークンを入力してください。</p>
            <div className="sourceForm">
              <input
                type="password"
                value={token}
                placeholder="ADMIN_TOKEN"
                onChange={(event) => setTokenState(event.target.value)}
              />
              <button className="primaryButton" type="submit" disabled={isBusy}>
                <LogIn size={18} />
                ログイン
              </button>
            </div>
            {status && <p className="status">{status}</p>}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="appShell">
      <section className="workspace">
        <div className="toolbar">
          <div>
            <p className="eyebrow">管理者</p>
            <h1>情報源の管理</h1>
          </div>
          <button className="iconButton" type="button" title="再読み込み" onClick={() => void tryLoad()} disabled={isBusy}>
            <RefreshCw size={20} />
          </button>
        </div>

        <section className="sourcePanel">
          <div className="panelHeader split">
            <div className="panelHeaderTitle">
              <Link2 size={20} />
              <h2>情報源URL</h2>
            </div>
            <button className="primaryButton" type="button" onClick={() => void handleIngest()} disabled={isBusy || sources.length === 0}>
              <Sparkles size={18} />
              今すぐ収集
            </button>
          </div>
          {stats && (
            <div className="statsBlock">
              <p className="hint">
                保存イベント総数: <strong>{stats.total}件</strong>
                {stats.unmatched > 0 && `（うち未分類 ${stats.unmatched}件）`}
                {(stats.byCategory || stats.byArea) && (
                  <button className="linkButton" type="button" onClick={() => setShowBreakdown((v) => !v)}>
                    <BarChart3 size={14} /> 内訳を{showBreakdown ? "隠す" : "見る"}
                  </button>
                )}
              </p>
              {showBreakdown && (
                <div className="breakdown">
                  {stats.byCategory && (
                    <div>
                      <span className="breakdownTitle">カテゴリ別</span>
                      {Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <span key={k} className="breakdownTag">{k} {v}</span>
                      ))}
                    </div>
                  )}
                  {stats.byArea && (
                    <div>
                      <span className="breakdownTitle">エリア別</span>
                      {Object.entries(stats.byArea).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                        <span key={k} className="breakdownTag">{k} {v}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <p className="hint">イベント情報のあるページやRSSのURLを登録すると、AIが各イベントの内容から開催地(市区町村)を自動判別して要約します。エリアは通常入力不要です。 チェックを外すと、そのサイトのイベントは検索結果に表示されません（データは残ります）。</p>
          <div className="dangerRow">
            <button className="dangerButton" type="button" onClick={() => void handleClearExpired()} disabled={isBusy}>
              <CalendarX size={16} />
              終了済みイベントを削除
            </button>
            <button className="dangerButton" type="button" onClick={() => void handleClear()} disabled={isBusy}>
              <Trash2 size={16} />
              全イベント削除（古いデータの一掃）
            </button>
          </div>

          <form className="sourceForm" onSubmit={handleAdd}>
            <input type="url" value={newUrl} placeholder="https://example.jp/events" onChange={(e) => setNewUrl(e.target.value)} required />
            <input value={newArea} placeholder="エリア（任意・自動判別できない時の予備）" onChange={(e) => setNewArea(e.target.value)} />
            <button className="secondaryButton" type="submit" disabled={isBusy}>
              <Plus size={18} />
              追加
            </button>
          </form>

          <ul className="sourceList">
            {sources.map((source) => (
              <li key={source.id} className={source.enabled === false ? "sourceDisabled" : ""}>
                <div className="sourceRow">
                <label className="sourceToggle" title={source.enabled === false ? "非表示（検索結果に出さない）" : "表示（検索結果に出す）"}>
                  <input
                    type="checkbox"
                    checked={source.enabled !== false}
                    onChange={() => void handleToggle(source)}
                    disabled={isBusy}
                  />
                </label>
                <div className="sourceInfo">
                  <span className="sourceName">{source.name}</span>
                  <a href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
                  <span className="sourceTag">{source.area || "エリア自動判定"} / {source.type.toUpperCase()}{stats ? ` / ${stats.counts[source.id] ?? 0}件` : ""}</span>
                  <span className={healthClass(source)}>
                    {healthWarn(source) && <AlertTriangle size={12} />}
                    {healthLabel(source)}
                  </span>
                  <label className="sourceCategory">
                    カテゴリ固定:
                    <select
                      value={source.forceCategory ?? ""}
                      onChange={(e) => void handleCategoryChange(source, e.target.value)}
                      disabled={isBusy}
                    >
                      <option value="">AI自動判定</option>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label className="sourceImageToggle" title="このサイトのイベント画像を表示するか（著作権対策でOFFにできます）">
                    <input
                      type="checkbox"
                      checked={source.showImages !== false}
                      onChange={() => void handleToggleImages(source)}
                      disabled={isBusy}
                    />
                    <span>画像を表示{source.showImages === false ? "（OFF）" : ""}</span>
                  </label>
                  <textarea
                    className="sourceNote"
                    defaultValue={source.note ?? ""}
                    placeholder="メモ（規約の要点・許諾状況など）"
                    rows={2}
                    onBlur={(e) => void handleNoteSave(source, e.target.value)}
                    disabled={isBusy}
                  />
                </div>
                <button className="iconButton" type="button" title="収集したデータを見る" onClick={() => void toggleEvents(source)} disabled={isBusy}>
                  {openId === source.id ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                  <ListChecks size={18} />
                </button>
                <button className="iconButton" type="button" title="試し取得（保存せず候補を確認）" onClick={() => void handlePreview(source)} disabled={isBusy}>
                  <Eye size={18} />
                </button>
                <button className="iconButton" type="button" title="このサイトだけ収集" onClick={() => void handleIngestOne(source)} disabled={isBusy}>
                  <Sparkles size={18} />
                </button>
                <button className="iconButton" type="button" title="このサイトのイベントを削除（登録は残す）" onClick={() => void handleClearOne(source)} disabled={isBusy}>
                  <Eraser size={18} />
                </button>
                <button className="iconButton" type="button" title="サイト登録を削除" onClick={() => void handleDelete(source.id)} disabled={isBusy}>
                  <Trash2 size={18} />
                </button>
                </div>
                {previewId === source.id && (
                  <div className="sourceEvents">
                    {previewLoading ? (
                      <p className="hint">試し取得中…（保存はしません）</p>
                    ) : previewList.length === 0 ? (
                      <p className="hint">候補が見つかりませんでした。スクレイパーがこのサイト構造に対応できていない可能性があります。</p>
                    ) : (
                      <>
                        <p className="hint">試し取得の候補 {previewList.length}件（保存していません。実際の収集ではこの中からAIがイベントを判定します）</p>
                        <ul className="eventList">
                          {previewList.map((cand) => (
                            <li key={cand.url}>
                              <div className="eventInfo">
                                <span className="eventTitle">{cand.title}</span>
                                <a href={cand.url} target="_blank" rel="noreferrer">{cand.url}</a>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                {openId === source.id && (
                  <div className="sourceEvents">
                    {loadingEvents ? (
                      <p className="hint">読み込み中…</p>
                    ) : openEvents.length === 0 ? (
                      <p className="hint">このサイトから収集したイベントはありません。</p>
                    ) : (() => {
                        const shown = openEvents.filter((e) => {
                          const kw = eventFilter.trim().toLowerCase();
                          const kwHit = !kw || e.title.toLowerCase().includes(kw) || (e.summary ?? "").toLowerCase().includes(kw);
                          const catHit = !eventCatFilter || (e.category ?? "") === eventCatFilter;
                          return kwHit && catHit;
                        });
                        return (
                          <>
                            <div className="eventFilterRow">
                              <input
                                type="search"
                                placeholder="キーワードで絞り込み"
                                value={eventFilter}
                                onChange={(e) => setEventFilter(e.target.value)}
                              />
                              <select value={eventCatFilter} onChange={(e) => setEventCatFilter(e.target.value)}>
                                <option value="">全カテゴリ</option>
                                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                            <p className="hint">収集済み {openEvents.length}件中 {shown.length}件を表示（個別に編集・AI要約し直し・削除できます）</p>
                            <ul className="eventList">
                              {shown.map((ev) => (
                                <li key={ev.eventId}>
                                  {editingId === ev.eventId ? (
                                    <div className="eventEdit">
                                      <input
                                        placeholder="タイトル"
                                        value={editDraft.title ?? ""}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
                                      />
                                      <textarea
                                        placeholder="要約"
                                        rows={2}
                                        value={editDraft.summary ?? ""}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, summary: e.target.value }))}
                                      />
                                      <div className="eventEditRow">
                                        <select
                                          value={editDraft.category ?? ""}
                                          onChange={(e) => setEditDraft((d) => ({ ...d, category: e.target.value }))}
                                        >
                                          <option value="">カテゴリなし</option>
                                          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                                        </select>
                                        <input
                                          placeholder="エリア"
                                          value={editDraft.area ?? ""}
                                          onChange={(e) => setEditDraft((d) => ({ ...d, area: e.target.value }))}
                                        />
                                      </div>
                                      <input
                                        placeholder="会場名"
                                        value={editDraft.venue ?? ""}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, venue: e.target.value }))}
                                      />
                                      <input
                                        placeholder="住所（保存すると地図の位置を取り直します）"
                                        value={editDraft.address ?? ""}
                                        onChange={(e) => setEditDraft((d) => ({ ...d, address: e.target.value }))}
                                      />
                                      <div className="eventEditRow">
                                        <input
                                          type="date"
                                          value={toDateInput(editDraft.eventDate)}
                                          onChange={(e) => setEditDraft((d) => ({ ...d, eventDate: e.target.value }))}
                                        />
                                        <span>〜</span>
                                        <input
                                          type="date"
                                          value={toDateInput(editDraft.eventEndDate)}
                                          onChange={(e) => setEditDraft((d) => ({ ...d, eventEndDate: e.target.value }))}
                                        />
                                      </div>
                                      <div className="eventEditActions">
                                        <button className="secondaryButton" type="button" onClick={() => void saveEdit(ev)}>
                                          <Save size={14} /> 保存
                                        </button>
                                        <button className="ghostButton" type="button" onClick={cancelEdit}>
                                          <X size={14} /> キャンセル
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <>
                                      {ev.imageUrl && (
                                        <a href={ev.imageUrl} target="_blank" rel="noreferrer" className="eventThumb" title="画像を開く">
                                          <img src={ev.imageUrl} alt="" loading="lazy" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }} />
                                        </a>
                                      )}
                                      <div className="eventInfo">
                                        <span className="eventTitle">{ev.title}</span>
                                        <span className="eventMeta">
                                          {[ev.category, ev.area, ev.venue, ev.eventDate].filter(Boolean).join(" / ") || "詳細なし"}
                                        </span>
                                        <a href={ev.url} target="_blank" rel="noreferrer">{ev.url}</a>
                                      </div>
                                      <div className="eventActions">
                                        <button className="iconButton" type="button" title="編集" onClick={() => startEdit(ev)} disabled={isBusy}>
                                          <Pencil size={16} />
                                        </button>
                                        <button className="iconButton" type="button" title="AIで要約し直す" onClick={() => void handleReenrich(ev)} disabled={isBusy}>
                                          <Wand2 size={16} />
                                        </button>
                                        <button className="iconButton" type="button" title="このイベントを削除" onClick={() => void handleDeleteEvent(ev)} disabled={isBusy}>
                                          <Trash2 size={16} />
                                        </button>
                                      </div>
                                    </>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </>
                        );
                      })()}
                  </div>
                )}
              </li>
            ))}
            {sources.length === 0 && <li className="sourceEmpty">まだ情報源がありません。URLを追加してください。</li>}
          </ul>

          {status && <p className="status">{status}</p>}
        </section>
      </section>
    </main>
  );
}

/** 収集ヘルス表示ラベル（最終収集日時と直近件数） */
function healthLabel(source: Source): string {
  if (!source.lastIngestAt) return "未収集";
  const when = new Date(source.lastIngestAt);
  const whenText = Number.isNaN(when.getTime())
    ? source.lastIngestAt
    : new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(when);
  const cand = source.lastCandidates ?? 0;
  return `最終収集 ${whenText}・候補${cand}件`;
}

/** 直近収集で候補0件（スクレイパー故障の疑い）なら警告 */
function healthWarn(source: Source): boolean {
  return Boolean(source.lastIngestAt) && (source.lastCandidates ?? 0) === 0;
}

function healthClass(source: Source): string {
  return healthWarn(source) ? "sourceHealth warn" : "sourceHealth";
}

/** ISO日時/日付文字列を <input type="date"> 用の YYYY-MM-DD に変換 */
function toDateInput(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
