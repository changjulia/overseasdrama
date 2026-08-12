"use client";

import { useMemo, useState } from "react";
import { factoryModes } from "../factory/mock-data";
import type { Draft, FactoryMode } from "../factory/types";
import { favoriteMocks } from "./mock-data";
import type { Favorite, MyCreationsProps } from "./types";
import styles from "./creations.module.css";

const modeName = (mode: FactoryMode) => factoryModes.find((item) => item.id === mode)?.name ?? mode;

export function MyCreations({ drafts, favorites = favoriteMocks, initialTab = "favorites", onContinueEdit, onReuseDraft, onUseFavorite, onRemoveFavorite, onNotify }: MyCreationsProps) {
  const [tab, setTab] = useState<"favorites" | "drafts">(initialTab);
  const [modeFilter, setModeFilter] = useState<"all" | FactoryMode>("all");
  const visibleDrafts = useMemo(() => modeFilter === "all" ? drafts : drafts.filter((draft) => draft.mode === modeFilter), [drafts, modeFilter]);

  const reuse = (draft: Draft) => {
    onReuseDraft?.({ ...draft, id: `${draft.id}-copy-${Date.now()}`, title: `${draft.title} · 副本`, updatedAt: "刚刚", autoSaved: true });
    onNotify?.("已复制草稿，可在内容工厂继续复用");
  };

  const applyFavorite = (favorite: Favorite, mode: FactoryMode) => {
    onUseFavorite?.(favorite, mode);
    onNotify?.(`已将「${favorite.title}」带入${modeName(mode)}`);
  };

  return <section className={styles.creations} aria-label="我的创作">
    <header><div><span>MY CREATIONS</span><h1>我的创作</h1><p>收藏可复用的外部创意资产，继续编辑内容工厂自动保存的视频草稿。</p></div><div className={styles.saveState}><i>✓</i><span><b>自动保存已开启</b><small>生成结果实时同步</small></span></div></header>
    <nav className={styles.tabs}><button type="button" className={tab === "favorites" ? styles.active : ""} onClick={() => setTab("favorites")}><i>01</i> 我的收藏 <em>{favorites.length}</em></button><button type="button" className={tab === "drafts" ? styles.active : ""} onClick={() => setTab("drafts")}><i>02</i> 我的草稿 <em>{drafts.length}</em></button></nav>

    {tab === "favorites" ? <>
      <div className={styles.sectionHead}><div><h2>收藏资产</h2><p>广告实例、钩子原型、高光、解说结构与过渡方法均可直接带入生产。</p></div><button type="button" onClick={() => onNotify?.("已打开灵感大屏收藏列表")}>＋ 从灵感大屏收藏</button></div>
      <div className={styles.favoriteGrid}>{favorites.map((item) => <article key={item.id}>
        <div className={`${styles.preview} ${styles[item.tone]}`}><span>{item.kind}</span><button type="button" aria-label="播放">▶</button><em>00:06</em></div>
        <div className={styles.favoriteBody}><div className={styles.tags}><span>{item.language}</span><span>{item.theme}</span></div><h3>{item.title}</h3><p>{item.hook}</p><dl><div><dt>来源</dt><dd>{item.source}</dd></div><div><dt>收藏</dt><dd>{item.savedAt}</dd></div></dl>
          <div className={styles.favoriteActions}><select aria-label="选择复用模式" defaultValue="external-hook" id={`mode-${item.id}`}><option value="external-hook">外搭钩子模式</option><option value="episode-splice">剧集拼接</option><option value="episode-narration">剧集解说</option></select><button type="button" onClick={() => { const input = document.getElementById(`mode-${item.id}`) as HTMLSelectElement; applyFavorite(item, input.value as FactoryMode); }}>复用创作 →</button><button type="button" className={styles.more} onClick={() => onRemoveFavorite?.(item.id)}>取消收藏</button></div>
        </div>
      </article>)}</div>
    </> : <>
      <div className={styles.sectionHead}><div><h2>自动保存的创作草稿</h2><p>按三种模式筛选；可继续编辑、复制版本和复用生产参数。</p></div><div className={styles.filters}><button className={modeFilter === "all" ? styles.selected : ""} onClick={() => setModeFilter("all")}>全部</button>{factoryModes.map((mode) => <button key={mode.id} className={modeFilter === mode.id ? styles.selected : ""} onClick={() => setModeFilter(mode.id)}>{mode.name}</button>)}</div></div>
      <div className={styles.draftTable}><div className={styles.tableHead}><span>草稿 / 剧目</span><span>模式与素材</span><span>输出规格</span><span>质检状态</span><span>最近保存</span><span>操作</span></div>{visibleDrafts.map((draft) => <article key={draft.id}>
        <div className={styles.draftName}><i className={`${styles.draftThumb} ${styles[draft.thumbnailTone]}`}>▶<em>{draft.duration}</em></i><span><b>{draft.title}</b><small>{draft.drama}</small></span></div>
        <div><b>{modeName(draft.mode)}</b><small>{draft.hook} · {draft.episodeRange}</small></div>
        <div><b>{draft.language} · {draft.ratio}</b><small>{draft.duration} · {draft.transition}</small></div>
        <div><span className={draft.qualityStatus === "可以直接生成" ? styles.pass : styles.review}>{draft.qualityStatus}</span><i className={styles.progress}><em style={{width: `${draft.progress}%`}} /></i></div>
        <div><b>{draft.updatedAt}</b><small>{draft.autoSaved ? "✓ 已自动保存" : "等待同步"}</small></div>
        <div className={styles.rowActions}><button type="button" onClick={() => onContinueEdit?.(draft)}>继续编辑</button><button type="button" onClick={() => reuse(draft)}>复制复用</button></div>
      </article>)}</div>
      {!visibleDrafts.length && <div className={styles.empty}>当前模式还没有草稿；在内容工厂生成后会自动出现在这里。</div>}
    </>}
  </section>;
}

export default MyCreations;
