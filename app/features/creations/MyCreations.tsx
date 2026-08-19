"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { factoryModes } from "../factory/mock-data";
import type { Draft, FactoryMode } from "../factory/types";
import { favoriteMocks } from "./mock-data";
import type { Favorite, MyCreationsProps } from "./types";
import baseStyles from "./creations.module.css";
import enhancementStyles from "./creations-enhancements.module.css";

// A selector in a CSS Module exports every local class it references. Merging
// the objects with object spread therefore dropped the base class whenever an
// enhancement rule mentioned that class (for example `.tabs button`). Keep
// both generated class names so base layout and enhancement rules apply.
const styles = Object.fromEntries(
  [...new Set([...Object.keys(baseStyles), ...Object.keys(enhancementStyles)])].map((key) => [
    key,
    [baseStyles[key], enhancementStyles[key]].filter(Boolean).join(" "),
  ]),
) as typeof baseStyles & typeof enhancementStyles;
const modeName = (mode: FactoryMode) => factoryModes.find((item) => item.id === mode)?.name ?? mode;
type Drawer = { type: "favorite"; item: Favorite; view: string } | { type: "draft"; item: Draft; view: string } | null;

function FavoriteVideoPreview({ item, playing, onPlayingChange }: { item: Favorite; playing: boolean; onPlayingChange: (playing: boolean) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hovering = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [item.previewUrl]);

  const showFirstFrame = (video: HTMLVideoElement) => {
    video.pause();
    const duration = Number.isFinite(video.duration) ? video.duration : item.previewDuration ?? 0;
    video.currentTime = Math.min(0.05, Math.max(0, duration > 0 ? duration / 100 : 0.05));
    onPlayingChange(false);
  };
  const start = () => {
    hovering.current = true;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    void video.play().then(() => { if (hovering.current) onPlayingChange(true); }).catch(() => undefined);
  };
  const stop = () => {
    hovering.current = false;
    const video = videoRef.current;
    if (video) showFirstFrame(video);
  };

  return <div className={`${styles.preview} ${styles[item.tone]} ${playing ? styles.previewPlaying : ""}`} onMouseEnter={start} onMouseLeave={stop}>
    <span>{item.kind}</span>
    {item.previewUrl && !failed ? <video
      ref={videoRef}
      src={item.previewUrl}
      muted
      playsInline
      loop
      preload="auto"
      aria-label={`${item.title}，悬停静音播放`}
      onLoadedData={(event) => { if (hovering.current) start(); else showFirstFrame(event.currentTarget); }}
      onCanPlay={() => { if (hovering.current) start(); }}
      onError={() => { setFailed(true); onPlayingChange(false); }}
    /> : <><button type="button" disabled aria-label={`暂无可播放文件：${item.title}`}>▶</button><em>未连接预览文件</em></>}
  </div>;
}

function DraftVideoThumbnail({ draft }: { draft: Draft }) {
  const sources = [...new Set([draft.outputUrl, draft.thumbnailUrl].filter((value): value is string => Boolean(value)))];
  const [sourceIndex, setSourceIndex] = useState(0);
  const hovering = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const source = sources[sourceIndex];
  if (!source) return <span>暂无预览</span>;
  const showFirstFrame = (video: HTMLVideoElement) => {
    const firstFrame = Math.min(0.05, Math.max(0, (video.duration || 0.1) / 10));
    if (Number.isFinite(firstFrame)) video.currentTime = firstFrame;
    video.pause();
  };
  return <video
    key={source}
    ref={videoRef}
    src={source}
    muted
    playsInline
    loop
    preload="auto"
    aria-label={`${draft.title} 成片视频缩略图，悬停静音预览`}
    onLoadedData={(event) => { showFirstFrame(event.currentTarget); if (hovering.current) void event.currentTarget.play().catch(() => undefined); }}
    onCanPlay={(event) => { if (hovering.current) void event.currentTarget.play().catch(() => undefined); }}
    onMouseEnter={(event) => { const video = event.currentTarget; hovering.current = true; video.muted = true; void video.play().catch(() => { video.load(); }); }}
    onMouseLeave={(event) => { hovering.current = false; showFirstFrame(event.currentTarget); }}
    onError={() => { if (sourceIndex + 1 < sources.length) setSourceIndex((index) => index + 1); }}
  />;
}

export function MyCreations({ drafts, favorites = favoriteMocks, initialTab = "favorites", onContinueEdit, onReuseDraft, onUseFavorite, onOpenInspiration, onRemoveFavorite, onDraftChange, onRemoveDraft, onNotify }: MyCreationsProps) {
  const [tab, setTab] = useState<"favorites" | "drafts">(initialTab);
  const [modeFilter, setModeFilter] = useState<"all" | FactoryMode>("all");
  const [qualityFilter, setQualityFilter] = useState("全部状态");
  const [query, setQuery] = useState("");
  const [localFavorites, setLocalFavorites] = useState(favorites);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [localDrafts, setLocalDrafts] = useState<Draft[]>(drafts);
  const [selectedModes, setSelectedModes] = useState<Record<string, FactoryMode>>({});
  const [playingFavorite, setPlayingFavorite] = useState<string | null>(null);

  useEffect(() => setLocalDrafts(drafts), [drafts]);
  useEffect(() => setLocalFavorites(favorites), [favorites]);
  useEffect(() => setTab(initialTab), [initialTab]);

  const visibleDrafts = useMemo(() => localDrafts.filter((draft) => {
    const modeOk = modeFilter === "all" || draft.mode === modeFilter;
    const qualityOk = qualityFilter === "全部状态" || (qualityFilter === "待审核" ? draft.productionStatus === "待审核" : qualityFilter === "已导出" ? draft.productionStatus === "已导出" : draft.qualityStatus === qualityFilter);
    const q = query.trim().toLowerCase();
    return modeOk && qualityOk && (!q || `${draft.title}${draft.drama}${draft.hook}${draft.language}`.toLowerCase().includes(q));
  }), [localDrafts, modeFilter, qualityFilter, query]);
  const visibleFavorites = useMemo(() => localFavorites.filter((item) => !query.trim() || `${item.title}${item.hook}${item.kind}${item.theme}`.toLowerCase().includes(query.trim().toLowerCase())), [localFavorites, query]);

  const reuse = (draft: Draft) => { const copy = { ...draft, id: `${draft.id}-copy-${Date.now()}`, title: `${draft.title} · 副本`, updatedAt: "刚刚", autoSaved: true, productionStatus: "编辑中" as const, version: (draft.version ?? 1) + 1 }; setLocalDrafts((items) => [copy, ...items]); onReuseDraft?.(copy); onNotify?.("已复制草稿，可在内容工厂继续复用"); };
  const applyFavorite = (favorite: Favorite, mode: FactoryMode) => { setOpenMenu(null); onUseFavorite?.(favorite, mode); onNotify?.(`已将「${favorite.title}」带入${modeName(mode)}`); };
  const removeFavorite = (item: Favorite) => { setLocalFavorites((items) => items.filter((x) => x.id !== item.id)); setOpenMenu(null); onRemoveFavorite?.(item.id); onNotify?.(`已取消收藏「${item.title}」`); };
  const updateDraft = (id: string, patch: Partial<Draft>, message: string) => {
    const current = localDrafts.find((draft) => draft.id === id);
    if (!current) return;
    const updated = { ...current, ...patch, updatedAt: "刚刚", autoSaved: true };
    setLocalDrafts((items) => items.map((draft) => draft.id === id ? updated : draft));
    onDraftChange?.(updated);
    setOpenMenu(null);
    onNotify?.(message);
  };

  return <section className={styles.creations} aria-label="我的创作">
    <header><div><span>MY CREATIONS</span><h1>我的创作</h1><p>管理可复用创意资产与内容工厂自动保存的全部生产版本。</p></div><div className={styles.saveState}><i>✓</i><span><b>自动保存已开启</b><small>{localDrafts.length} 个草稿已同步</small></span></div></header>
    <nav className={styles.tabs}><button type="button" className={tab === "favorites" ? styles.active : ""} onClick={() => setTab("favorites")}><i>01</i> 我的收藏 <em>{localFavorites.length}</em></button><button type="button" className={tab === "drafts" ? styles.active : ""} onClick={() => setTab("drafts")}><i>02</i> 我的草稿 <em>{localDrafts.length}</em></button></nav>
    <div className={styles.libraryTools}><label><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === "favorites" ? "搜索标题、主题、类型或钩子" : "搜索草稿、剧目、钩子或语种"}/>{query && <button onClick={() => setQuery("")}>×</button>}</label></div>

    {tab === "favorites" ? <>
      <div className={styles.sectionHead}><div><h2>收藏资产</h2><p>广告实例、钩子原型、高光、解说结构与过渡方法均可直接分析、匹配和投入生产。</p></div><button type="button" onClick={() => { onOpenInspiration?.(); onNotify?.("已进入灵感大屏，可继续收藏素材"); }}>＋ 从灵感大屏收藏</button></div>
      <div className={styles.favoriteGrid}>{visibleFavorites.map((item) => <article key={item.id}>
        <FavoriteVideoPreview item={item} playing={playingFavorite === item.id} onPlayingChange={(active) => setPlayingFavorite(active ? item.id : null)} />
        <div className={styles.favoriteBody}><div className={styles.tags}><span>{item.language}</span><span>{item.theme}</span></div><h3>{item.title}</h3><p>{item.hook}</p><dl><div><dt>来源</dt><dd>{item.source}</dd></div><div><dt>收藏</dt><dd>{item.savedAt}</dd></div></dl>
          <div className={styles.favoriteActionBar}>
            <button type="button" className={styles.analysisAction} disabled={!item.analysis} title={!item.analysis ? "该素材尚无真实分析结果" : undefined} onClick={() => { setDrawer({ type: "favorite", item, view: "完整分析" }); setOpenMenu(null); }}>查看分析</button>
            <div className={styles.createAction}><select aria-label={`选择「${item.title}」的创作模式`} value={selectedModes[item.id] ?? "external-hook"} onChange={(event) => { const next = event.target.value as FactoryMode; setSelectedModes((current) => ({ ...current, [item.id]: next })); onNotify?.(`已选择${modeName(next)}`); }}><option value="external-hook">外搭钩子</option><option value="episode-splice">剧集拼接</option><option value="episode-narration">剧集解说</option></select><button type="button" onClick={() => applyFavorite(item, selectedModes[item.id] ?? "external-hook")}>用于创作</button></div>
            <button type="button" className={`${styles.favoriteMore} ${openMenu === `favorite-${item.id}` ? styles.favoriteMoreActive : ""}`} aria-label={`更多操作：${item.title}`} aria-expanded={openMenu === `favorite-${item.id}`} onClick={() => setOpenMenu(openMenu === `favorite-${item.id}` ? null : `favorite-${item.id}`)}>•••</button>
            {openMenu === `favorite-${item.id}` && <div className={styles.favoriteMenu} role="menu"><button type="button" role="menuitem" onClick={() => { setDrawer({ type: "favorite", item, view: "同原型实例" }); setOpenMenu(null); }}>查看同原型实例</button><button type="button" role="menuitem" onClick={() => { setDrawer({ type: "favorite", item, view: "匹配我的剧" }); setOpenMenu(null); }}>匹配我的剧</button><button type="button" role="menuitem" className={styles.removeAction} onClick={() => removeFavorite(item)}>取消收藏</button></div>}
          </div>
        </div>
      </article>)}</div>
      {!visibleFavorites.length && <div className={styles.empty}>没有找到符合条件的收藏资产。</div>}
    </> : <>
      <div className={styles.sectionHead}><div><h2>自动保存的创作草稿</h2><p>按模式和生产状态筛选；继续编辑、复制复用或修改关键生产参数。</p></div><div className={styles.filters}><button className={modeFilter === "all" ? styles.selected : ""} onClick={() => setModeFilter("all")}>全部</button>{factoryModes.map((mode) => <button key={mode.id} className={modeFilter === mode.id ? styles.selected : ""} onClick={() => setModeFilter(mode.id)}>{mode.name}</button>)}<select value={qualityFilter} onChange={(e) => setQualityFilter(e.target.value)}><option>全部状态</option><option>可以直接生成</option><option>建议优化后生成</option><option>待审核</option><option>已导出</option></select></div></div>
      <div className={styles.draftTable}><div className={styles.tableHead}><span>草稿 / 剧目</span><span>模式与素材</span><span>输出规格</span><span>质检 / 生产状态</span><span>最近保存</span><span>操作</span></div>{visibleDrafts.map((draft) => <article key={draft.id}>
        <div className={styles.draftName}><i className={`${styles.draftThumb} ${styles[draft.thumbnailTone]}`}><DraftVideoThumbnail draft={draft}/><em>{draft.duration}</em></i><span><b>{draft.title}</b><small>{draft.drama}{draft.parentFactoryProjectId ? " · 历史副本" : " · 原始草稿"}</small></span></div>
        <div><b>{modeName(draft.mode)}</b><small>{draft.hook} · {draft.episodeRange}</small></div>
        <div><b>{draft.language} · {draft.ratio}</b><small>{draft.duration} · {draft.transition}</small></div>
        <div><span className={draft.qualityStatus === "可以直接生成" ? styles.pass : styles.review}>{draft.qualityStatus}</span><small>{draft.productionStatus ?? (draft.progress === 100 ? "待审核" : "编辑中")} · V{draft.version ?? 1}</small><i className={styles.progress}><em style={{width: `${draft.progress}%`}} /></i></div>
        <div><b>{draft.updatedAt}</b><small>{draft.autoSaved ? "✓ 已自动保存" : "等待同步"}</small></div>
        <div className={styles.rowActions}><button type="button" onClick={() => onContinueEdit?.(draft)}>继续编辑</button><button type="button" onClick={() => reuse(draft)}>复制复用</button><button className={styles.menuButton} onClick={() => setOpenMenu(openMenu === draft.id ? null : draft.id)}>•••</button>{openMenu === draft.id && <div className={styles.draftMenu}><button onClick={() => updateDraft(draft.id, { productionStatus: "待审核" }, "草稿已提交审核")}>提交审核</button>{draft.outputUrl ? <a href={draft.outputUrl} download={draft.outputName ?? `${draft.title}.mp4`} onClick={() => updateDraft(draft.id, { productionStatus: "已导出" }, "成片下载已开始")}>下载成片</a> : <button disabled title="尚未生成真实成片文件">暂无成片可导出</button>}<button onClick={() => setDrawer({ type: "draft", item: draft, view: "版本与参数" })}>查看版本与参数</button><button onClick={() => { setLocalDrafts((items) => items.filter((item) => item.id !== draft.id)); onRemoveDraft?.(draft.id); setOpenMenu(null); }}>删除草稿</button></div>}</div>
      </article>)}</div>
      {!visibleDrafts.length && <div className={styles.empty}>当前筛选条件下没有草稿；在内容工厂生成后会自动出现在这里。</div>}
    </>}

    {drawer && <div className={styles.drawerBackdrop} onClick={() => setDrawer(null)}><aside className={styles.drawer} onClick={(e) => e.stopPropagation()}><header><span>{drawer.type === "favorite" ? drawer.item.kind : modeName(drawer.item.mode)}</span><button onClick={() => setDrawer(null)}>×</button></header><h2>{drawer.item.title}</h2><p>{drawer.view}</p>{drawer.type === "favorite" ? <><div className={styles.analysisHero}><b>真实分析结果</b><span>{drawer.item.analysis?.summary}</span></div><dl>{drawer.item.analysis?.structure && <div><dt>结构</dt><dd>{drawer.item.analysis.structure}</dd></div>}{drawer.item.analysis?.evidence?.map((evidence) => <div key={evidence}><dt>证据</dt><dd>{evidence}</dd></div>)}</dl><div className={styles.drawerActions}><button onClick={() => applyFavorite(drawer.item, "episode-splice")}>剧集拼接</button><button onClick={() => applyFavorite(drawer.item, "episode-narration")}>剧集解说</button><button onClick={() => applyFavorite(drawer.item, "external-hook")}>外搭钩子</button></div></> : <><div className={styles.analysisHero}><b>{drawer.item.productionStatus ?? "编辑中"} · V{drawer.item.version ?? 1}</b><span>{drawer.item.qualityStatus} · {drawer.item.progress}%</span></div><dl><div><dt>版本来源</dt><dd>{drawer.item.parentFactoryProjectId ? `历史副本（父项目 ${drawer.item.parentFactoryProjectId}）` : "原始草稿"}</dd></div><div><dt>使用钩子</dt><dd>{drawer.item.hook || "未设置"}</dd></div><div><dt>真实片源</dt><dd>{drawer.item.selectedEpisodes?.length ? drawer.item.selectedEpisodes.map((episode) => `EP ${String(episode).padStart(2,"0")}`).join("、") : "未关联"}</dd></div><div><dt>过渡 / 规格</dt><dd>{drawer.item.transition || "未设置"} · {drawer.item.language} · {drawer.item.ratio}</dd></div><div><dt>自动保存</dt><dd>{drawer.item.updatedAt}</dd></div>{drawer.item.renderVersions?.map((render)=><div key={render.id}><dt>真实渲染 V{render.version}</dt><dd>{render.status}{render.outputUrl ? <> · <a href={render.outputUrl} target="_blank" rel="noreferrer">预览/下载</a></> : ""}</dd></div>)}</dl><div className={styles.drawerActions}><button onClick={() => onContinueEdit?.(drawer.item)}>继续编辑</button><button onClick={() => reuse(drawer.item)}>复制复用</button>{drawer.item.outputUrl && <a href={drawer.item.outputUrl} download={drawer.item.outputName}>下载成片</a>}</div></>}</aside></div>}
  </section>;
}

export default MyCreations;
