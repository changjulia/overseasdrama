"use client";

import { useCallback, useEffect, useState } from "react";
import InspirationWorkspace from "./features/inspiration";
import DramaLibraryWorkspace from "./features/library";
import {
  FactoryWorkspace,
  initialDrafts,
  type Draft,
  type FactoryMode,
  type FactorySourceContext,
} from "./features/factory";
import {
  MyCreations,
  favoriteMocks,
  type Favorite,
} from "./features/creations";
import OperationsWorkspace from "./features/operations";
import { initialTasks } from "./features/operations/OperationsWorkspace";
import type { PipelineTask } from "./features/operations/types";
import { usePersistentState } from "./hooks/usePersistentState";
import { listPocketBaseAnalysisTasks } from "./lib/pocketbase-analysis-store";

type Workspace = "inspiration" | "library" | "factory" | "creations" | "sources" | "tasks" | "team";

const navItems: Array<{
  id: Workspace;
  icon: string;
  label: string;
  count?: string;
}> = [
  { id: "inspiration", icon: "✦", label: "灵感大屏", count: "128" },
  { id: "library", icon: "▣", label: "剧库", count: "36" },
  { id: "factory", icon: "⇄", label: "内容工厂" },
  { id: "creations", icon: "♡", label: "我的创作" },
  { id: "sources", icon: "◈", label: "数据源管理", count: "4" },
  { id: "tasks", icon: "◫", label: "任务中心", count: "8" },
  { id: "team", icon: "⚙", label: "团队与权限" },
];

function resolveFactoryMode(mode: string): FactoryMode {
  if (mode.includes("解说")) return "episode-narration";
  if (mode.includes("外搭")) return "external-hook";
  return "episode-splice";
}

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace>("inspiration");
  const [factoryMode, setFactoryMode] = useState<FactoryMode>("episode-splice");
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [factorySource, setFactorySource] = useState<FactorySourceContext | null>(null);
  const [factoryDramaSource, setFactoryDramaSource] = useState<FactorySourceContext | null>(null);
  const [factoryHookSource, setFactoryHookSource] = useState<FactorySourceContext | null>(null);
  const [drafts, setDrafts] = usePersistentState<Draft[]>("lumina:drafts", initialDrafts);
  const [favorites, setFavorites] = usePersistentState<Favorite[]>("lumina:favorites", favoriteMocks);
  const [tasks, setTasks, tasksReady] = usePersistentState<PipelineTask[]>("lumina:tasks", initialTasks);
  const [toast, setToast] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!tasksReady) return;
    setTasks((current) => current.filter((task) => !/^TASK-08(?:17|18|19|20|21)$/.test(task.id)));
    setDrafts((current) => current.filter((draft) => Boolean(draft.sourceContext)));
    setFavorites((current) => current.filter((favorite) => Boolean(favorite.previewUrl || favorite.analysis)));
  }, [setDrafts, setFavorites, setTasks, tasksReady]);

  useEffect(() => {
    if (!tasksReady) return;
    const controller = new AbortController();
    const sync = async () => {
      try { setTasks(await listPocketBaseAnalysisTasks(controller.signal)); }
      catch (error) { if (!controller.signal.aborted) console.error("PocketBase task sync failed", error); }
    };
    void sync();
    const timer = window.setInterval(sync, 3000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [setTasks, tasksReady]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  };

  const createParsingTask = useCallback((task: { id:string; title:string; status:"处理中"|"排队中"; progress:number; cost:string }) => {
    if (!tasksReady) return;
    setTasks((current) => current.some((item) => item.id === task.id) ? current : [{...task,category:"剧集解析",owner:"系统",createdAt:"刚刚"}, ...current]);
  }, [setTasks, tasksReady]);

  const openFactory = (mode: FactoryMode, draft: Draft | null = null, source: FactorySourceContext | null = null) => {
    setFactoryMode(mode);
    setEditingDraft(draft);
    if (draft) {
      const draftDrama = draft.sourceContext?.kind === "library" ? draft.sourceContext : null;
      const draftHook = draft.hookSourceContext ?? (draft.sourceContext && draft.sourceContext.kind !== "library" ? draft.sourceContext : null);
      setFactoryDramaSource(draftDrama);
      setFactoryHookSource(draftHook);
      setFactorySource(draft.sourceContext ?? null);
    } else if (source?.kind === "library") {
      setFactoryDramaSource(source);
      setFactorySource(source);
    } else if (source) {
      setFactoryHookSource(source);
      if (mode !== "external-hook") setFactorySource(source);
    } else if (mode !== "external-hook") {
      setFactorySource(null);
    }
    setWorkspace("factory");
  };

  const saveDraft = (draft: Draft) => {
    setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
    notify("制作草稿已自动保存至「我的草稿」");
  };

  const reuseDraft = (draft: Draft) => {
    const copy = {
      ...draft,
      id: `${draft.id}-copy-${Date.now()}`,
      title: `${draft.title} · 复用版`,
      updatedAt: "刚刚",
      autoSaved: true,
      progress: 0,
    };
    setDrafts((current) => [copy, ...current]);
    openFactory(copy.mode, copy);
    notify("已复制为新草稿，可继续编辑");
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div>L</div>
          <span><b>Lumina</b><small>短剧智能工作台</small></span>
        </div>
        <nav>
          <p>内容工作台</p>
          {navItems.map((item, index) => (
            <div key={item.id} className="nav-entry">
            {index === 4 && <p className="nav-group">运营与系统</p>}
            <button
              className={workspace === item.id ? "active" : ""}
              onClick={() => item.id === "factory" ? openFactory("episode-splice") : setWorkspace(item.id)}
            >
              <i className={`nav-icon${item.id === "factory" ? " factory-icon" : ""}`}>{item.icon}</i>
              <span>{item.label}</span>
              {(item.count || item.id === "creations" || item.id === "tasks") && (
                <em>{item.id === "creations" ? drafts.length : item.id === "tasks" ? tasks.length : item.id === "library" ? "" : item.count}</em>
              )}
            </button>
            </div>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="sync"><span><i /> 数据同步正常</span><small>最后更新 2 分钟前</small></div>
          <div className="profile"><div>陈</div><span><b>陈佳</b><small>内容负责人</small></span><button type="button" aria-label="打开账户菜单" aria-expanded={profileOpen} onClick={() => setProfileOpen((value) => !value)}>{profileOpen ? "⌃" : "⌄"}</button>{profileOpen && <div className="profile-menu"><button type="button" onClick={() => { setProfileOpen(false); setWorkspace("team"); }}>团队与权限</button><button type="button" onClick={() => { setProfileOpen(false); notify("个人偏好设置将在账号系统接入后开放"); }}>个人偏好</button></div>}</div>
        </div>
      </aside>

      <main className="content">
        {workspace === "inspiration" && (
          <InspirationWorkspace
            onOpenFactory={(materialId) => openFactory("external-hook", null, { kind: "inspiration", id: materialId, title: `灵感素材 ${materialId}`, description: "已从灵感大屏带入，保留素材实例与钩子分析关联。" })}
            onFavoriteChange={(materialId, favorite) => {
              if (favorite) setFavorites((current) => current.some(item=>item.id===materialId) ? current : [{id:materialId,title:"来自灵感大屏的收藏素材",kind:"广告实例",hook:"已保存完整钩子分析，可进入内容工厂复用。",language:"英语",theme:"市场跑量",source:"灵感大屏",savedAt:"刚刚",tone:"blue"},...current]);
              else setFavorites((current) => current.filter(item=>item.id!==materialId));
              notify(favorite ? "已收藏素材并同步至「我的创作」" : "已取消收藏");
            }}
          />
        )}
        <div hidden={workspace !== "library"}>
          <DramaLibraryWorkspace
            onImportDrama={() => notify("已打开短剧导入任务")}
            onCreateParsingTask={createParsingTask}
            onOpenProductionRecord={(title) => { setWorkspace("creations"); notify(`已打开「${title}」对应的创作记录`); }}
            onEnterFactory={({ dramaId, mode, sourceId, title, cn, genre, language, episodes, freeEpisodes, availableEpisodes, episodeMedia, highlightCandidates }) => openFactory(resolveFactoryMode(mode), null, { kind: "library", id: sourceId ? `${dramaId}-${sourceId}` : String(dramaId), title, dramaTitle: title, dramaCn: cn, genre, language, episodes, freeEpisodes, availableEpisodes, episodeMedia, highlightCandidates, description: sourceId ? `${cn} · ${genre} · 已带入可投放区间 ${sourceId}` : `${cn} · ${genre} · 共 ${episodes} 集 · 已连接 ${availableEpisodes.length} 集真实片源` })}
          />
        </div>
        {workspace === "factory" && (
          <FactoryWorkspace
            key={`${factoryMode}-${editingDraft?.id ?? "new"}-${factoryDramaSource?.id ?? factorySource?.id ?? "direct"}-${factoryHookSource?.id ?? "no-hook"}`}
            initialMode={factoryMode}
            editingDraft={editingDraft}
            sourceContext={factorySource}
            dramaSourceContext={factoryDramaSource}
            hookSourceContext={factoryHookSource}
            onChooseDrama={() => setWorkspace("library")}
            onChooseHook={() => setWorkspace(favorites.length ? "creations" : "inspiration")}
            onDraftAutoSave={saveDraft}
            onOpenDrafts={() => setWorkspace("creations")}
            onNotify={notify}
          />
        )}
        {workspace === "creations" && (
          <MyCreations
            drafts={drafts}
            favorites={favorites}
            onContinueEdit={(draft) => openFactory(draft.mode, draft)}
            onReuseDraft={reuseDraft}
            onUseFavorite={(favorite, mode) => openFactory(mode, null, { kind: "favorite", id: favorite.id, title: favorite.title, description: favorite.hook, language: favorite.language })}
            onOpenInspiration={() => setWorkspace("inspiration")}
            onRemoveFavorite={(id) => setFavorites((current) => current.filter((item) => item.id !== id))}
            onDraftChange={(draft) => setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)])}
            onRemoveDraft={(id) => setDrafts((current) => current.filter((item) => item.id !== id))}
            onNotify={notify}
          />
        )}
        {workspace === "sources" && <OperationsWorkspace section="sources" tasks={tasks} onTasksChange={setTasks} onNotify={notify}/>}
        {workspace === "tasks" && <OperationsWorkspace section="tasks" tasks={tasks} onTasksChange={setTasks} onNotify={notify}/>}
        {workspace === "team" && <OperationsWorkspace section="team" tasks={tasks} onTasksChange={setTasks} onNotify={notify}/>}
      </main>
      {toast && <div className="toast"><i>✓</i>{toast}</div>}
    </div>
  );
}
