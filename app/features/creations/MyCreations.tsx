"use client";

import { useMemo, useState } from "react";
import { factoryModes } from "../factory/mock-data";
import type { Draft, FactoryMode } from "../factory/types";
import { favoriteMocks } from "./mock-data";
import type { Favorite, MyCreationsProps } from "./types";
import baseStyles from "./creations.module.css";
import enhancementStyles from "./creations-enhancements.module.css";

const styles = { ...baseStyles, ...enhancementStyles };
const modeName = (mode: FactoryMode) => factoryModes.find((item) => item.id === mode)?.name ?? mode;
type Drawer = { type: "favorite"; item: Favorite; view: string } | { type: "draft"; item: Draft; view: string } | null;

export function MyCreations({ drafts, favorites = favoriteMocks, initialTab = "favorites", onContinueEdit, onReuseDraft, onUseFavorite, onRemoveFavorite, onNotify }: MyCreationsProps) {
  const [tab, setTab] = useState<"favorites" | "drafts">(initialTab);
  const [modeFilter, setModeFilter] = useState<"all" | FactoryMode>("all");
  const [qualityFilter, setQualityFilter] = useState("全部状态");
  const [query, setQuery] = useState("");
  const [localFavorites, setLocalFavorites] = useState(favorites);
  const [compare, setCompare] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [localDrafts, setLocalDrafts] = useState<Draft[]>(drafts);

  const visibleDrafts = useMemo(() => localDrafts.filter((draft) => {
    const modeOk = modeFilter === "all" || draft.mode === modeFilter;
    const qualityOk = qualityFilter === "全部状态" || (qualityFilter === "待审核" ? draft.productionStatus === "待审核" : qualityFilter === "已导出" ? draft.productionStatus === "已导出" : draft.qualityStatus === qualityFilter);
    const q = query.trim().toLowerCase();
    return modeOk && qualityOk && (!q || `${draft.title}${draft.drama}${draft.hook}${draft.language}`.toLowerCase().includes(q));
  }), [localDrafts, modeFilter, qualityFilter, query]);
  const visibleFavorites = useMemo(() => localFavorites.filter((item) => !query.trim() || `${item.title}${item.hook}${item.kind}${item.theme}`.toLowerCase().includes(query.trim().toLowerCase())), [localFavorites, query]);

  const reuse = (draft: Draft) => { const copy = { ...draft, id: `${draft.id}-copy-${Date.now()}`, title: `${draft.title} · 副本`, updatedAt: "刚刚", autoSaved: true, productionStatus: "编辑中" as const, version: (draft.version ?? 1) + 1 }; setLocalDrafts((items) => [copy, ...items]); onReuseDraft?.(copy); onNotify?.("已复制草稿，可在内容工厂继续复用"); };
  const applyFavorite = (favorite: Favorite, mode: FactoryMode) => { onUseFavorite?.(favorite, mode); onNotify?.(`已将「${favorite.title}」带入${modeName(mode)}`); };
  const removeFavorite = (item: Favorite) => { setLocalFavorites((items) => items.filter((x) => x.id !== item.id)); setCompare((items) => items.filter((id) => id !== item.id)); onRemoveFavorite?.(item.id); onNotify?.(`已取消收藏「${item.title}」`); };
  const updateDraft = (id: string, patch: Partial<Draft>, message: string) => { setLocalDrafts((items) => items.map((draft) => draft.id === id ? { ...draft, ...patch, updatedAt: "刚刚", autoSaved: true } : draft)); setOpenMenu(null); onNotify?.(message); };
  const toggleCompare = (item: Favorite) => { setCompare((items) => items.includes(item.id) ? items.filter((x) => x !== item.id) : items.length >= 4 ? items : [...items, item.id]); onNotify?.(compare.includes(item.id) ? "已移出对比" : "已加入对比"); };

  return <section className={styles.creations} aria-label="我的创作">
    <header><div><span>MY CREATIONS</span><h1>我的创作</h1><p>管理可复用创意资产与内容工厂自动保存的全部生产版本。</p></div><div className={styles.saveState}><i>✓</i><span><b>自动保存已开启</b><small>{localDrafts.length} 个草稿已同步</small></span></div></header>
    <nav className={styles.tabs}><button type="button" className={tab === "favorites" ? styles.active : ""} onClick={() => setTab("favorites")}><i>01</i> 我的收藏 <em>{localFavorites.length}</em></button><button type="button" className={tab === "drafts" ? styles.active : ""} onClick={() => setTab("drafts")}><i>02</i> 我的草稿 <em>{localDrafts.length}</em></button></nav>
    <div className={styles.libraryTools}><label><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === "favorites" ? "搜索标题、主题、类型或钩子" : "搜索草稿、剧目、钩子或语种"}/>{query && <button onClick={() => setQuery("")}>×</button>}</label>{tab === "favorites" && <div><span>对比栏 {compare.length}/4</span><button disabled={compare.length < 2} onClick={() => onNotify?.(`已打开 ${compare.length} 项创意资产对比`)}>开始对比</button><button disabled={!compare.length} onClick={() => setCompare([])}>清空</button></div>}</div>

    {tab === "favorites" ? <>
      <div className={styles.sectionHead}><div><h2>收藏资产</h2><p>广告实例、钩子原型、高光、解说结构与过渡方法均可直接分析、匹配和投入生产。</p></div><button type="button" onClick={() => onNotify?.("已打开灵感大屏收藏列表")}>＋ 从灵感大屏收藏</button></div>
      <div className={styles.favoriteGrid}>{visibleFavorites.map((item) => <article key={item.id} className={compare.includes(item.id) ? styles.comparing : ""}>
        <div className={`${styles.preview} ${styles[item.tone]}`}><span>{item.kind}</span><button type="button" aria-label="播放">▶</button><em>00:06</em><label><input type="checkbox" checked={compare.includes(item.id)} onChange={() => toggleCompare(item)}/> 对比</label></div>
        <div className={styles.favoriteBody}><div className={styles.tags}><span>{item.language}</span><span>{item.theme}</span></div><h3>{item.title}</h3><p>{item.hook}</p><dl><div><dt>来源</dt><dd>{item.source}</dd></div><div><dt>收藏</dt><dd>{item.savedAt}</dd></div></dl>
          <div className={styles.quickActions}><button onClick={() => setDrawer({ type: "favorite", item, view: "完整分析" })}>完整分析</button><button onClick={() => setDrawer({ type: "favorite", item, view: "同原型实例" })}>同原型</button><button onClick={() => setDrawer({ type: "favorite", item, view: "匹配我的剧" })}>匹配我的剧</button></div>
          <div className={styles.favoriteActions}><button onClick={() => applyFavorite(item, "episode-splice")}>用于剧集拼接</button><button onClick={() => applyFavorite(item, "episode-narration")}>复用解说结构</button><button onClick={() => applyFavorite(item, "external-hook")}>进入外搭模式</button><button type="button" className={styles.more} onClick={() => removeFavorite(item)}>取消收藏</button></div>
        </div>
      </article>)}</div>
      {!visibleFavorites.length && <div className={styles.empty}>没有找到符合条件的收藏资产。</div>}
    </> : <>
      <div className={styles.sectionHead}><div><h2>自动保存的创作草稿</h2><p>按模式和生产状态筛选；继续编辑、复制复用或修改关键生产参数。</p></div><div className={styles.filters}><button className={modeFilter === "all" ? styles.selected : ""} onClick={() => setModeFilter("all")}>全部</button>{factoryModes.map((mode) => <button key={mode.id} className={modeFilter === mode.id ? styles.selected : ""} onClick={() => setModeFilter(mode.id)}>{mode.name}</button>)}<select value={qualityFilter} onChange={(e) => setQualityFilter(e.target.value)}><option>全部状态</option><option>可以直接生成</option><option>建议优化后生成</option><option>待审核</option><option>已导出</option></select></div></div>
      <div className={styles.draftTable}><div className={styles.tableHead}><span>草稿 / 剧目</span><span>模式与素材</span><span>输出规格</span><span>质检 / 生产状态</span><span>最近保存</span><span>操作</span></div>{visibleDrafts.map((draft) => <article key={draft.id}>
        <div className={styles.draftName}><i className={`${styles.draftThumb} ${styles[draft.thumbnailTone]}`}>▶<em>{draft.duration}</em></i><span><b>{draft.title}</b><small>{draft.drama}</small></span></div>
        <div><b>{modeName(draft.mode)}</b><small>{draft.hook} · {draft.episodeRange}</small></div>
        <div><b>{draft.language} · {draft.ratio}</b><small>{draft.duration} · {draft.transition}</small></div>
        <div><span className={draft.qualityStatus === "可以直接生成" ? styles.pass : styles.review}>{draft.qualityStatus}</span><small>{draft.productionStatus ?? (draft.progress === 100 ? "待审核" : "编辑中")} · V{draft.version ?? 1}</small><i className={styles.progress}><em style={{width: `${draft.progress}%`}} /></i></div>
        <div><b>{draft.updatedAt}</b><small>{draft.autoSaved ? "✓ 已自动保存" : "等待同步"}</small></div>
        <div className={styles.rowActions}><button type="button" onClick={() => onContinueEdit?.(draft)}>继续编辑</button><button type="button" onClick={() => reuse(draft)}>复制复用</button><button className={styles.menuButton} onClick={() => setOpenMenu(openMenu === draft.id ? null : draft.id)}>•••</button>{openMenu === draft.id && <div className={styles.draftMenu}><button onClick={() => updateDraft(draft.id, { hook: "AI 推荐新钩子" }, "已更换钩子并创建新版本")}>更换钩子</button><button onClick={() => updateDraft(draft.id, { episodeRange: "EP 16–21" }, "已更换正片区间")}>更换正片区间</button><button onClick={() => updateDraft(draft.id, { language: draft.language === "英语" ? "德语" : "英语" }, "已生成新的语言版本")}>更换语言</button><button onClick={() => { for (let i = 1; i <= 3; i++) reuse({ ...draft, title: `${draft.title} · 变体 ${i}` }); setOpenMenu(null); }}>批量生成 3 个变体</button><button onClick={() => updateDraft(draft.id, { productionStatus: "待审核", progress: 100 }, "草稿已提交审核")}>提交审核</button><button onClick={() => updateDraft(draft.id, { productionStatus: "已导出", progress: 100 }, "已创建导出任务")}>导出成片</button><button onClick={() => setDrawer({ type: "draft", item: draft, view: "版本与参数" })}>查看版本与参数</button></div>}</div>
      </article>)}</div>
      {!visibleDrafts.length && <div className={styles.empty}>当前筛选条件下没有草稿；在内容工厂生成后会自动出现在这里。</div>}
    </>}

    {drawer && <div className={styles.drawerBackdrop} onClick={() => setDrawer(null)}><aside className={styles.drawer} onClick={(e) => e.stopPropagation()}><header><span>{drawer.type === "favorite" ? drawer.item.kind : modeName(drawer.item.mode)}</span><button onClick={() => setDrawer(null)}>×</button></header><h2>{drawer.item.title}</h2><p>{drawer.view}</p>{drawer.type === "favorite" ? <><div className={styles.analysisHero}><b>钩子综合评分 91</b><span>停滑 94 · 情绪 89 · 信息 86 · 音画 92</span></div><dl><div><dt>原型结构</dt><dd>强事件首帧 → 身份冲突台词 → 关系反转卡断</dd></div><div><dt>同原型表现</dt><dd>18 个实例 · 6 部剧 · 4 个语种</dd></div><div><dt>匹配剧目</dt><dd>Goodbye, My Billionaire Husband · 适配 93%</dd></div><div><dt>推荐用途</dt><dd>外搭钩子 / 高光前置 / 解说第一句</dd></div></dl><div className={styles.drawerActions}><button onClick={() => applyFavorite(drawer.item, "episode-splice")}>剧集拼接</button><button onClick={() => applyFavorite(drawer.item, "episode-narration")}>剧集解说</button><button onClick={() => applyFavorite(drawer.item, "external-hook")}>外搭钩子</button></div></> : <><div className={styles.analysisHero}><b>{drawer.item.productionStatus ?? "编辑中"} · V{drawer.item.version ?? 1}</b><span>{drawer.item.qualityStatus} · {drawer.item.progress}%</span></div><dl><div><dt>使用钩子</dt><dd>{drawer.item.hook}</dd></div><div><dt>正片区间</dt><dd>{drawer.item.episodeRange}</dd></div><div><dt>过渡 / 规格</dt><dd>{drawer.item.transition} · {drawer.item.language} · {drawer.item.ratio}</dd></div><div><dt>自动保存</dt><dd>{drawer.item.updatedAt} · 可恢复 3 个历史版本</dd></div></dl><div className={styles.drawerActions}><button onClick={() => onContinueEdit?.(drawer.item)}>继续编辑</button><button onClick={() => reuse(drawer.item)}>复制复用</button><button onClick={() => updateDraft(drawer.item.id, { productionStatus: "已导出" }, "已创建导出任务")}>导出</button></div></>}</aside></div>}
  </section>;
}

export default MyCreations;
