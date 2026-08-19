"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { listFactoryHistory } from "./lib/factory-production-store";
import { listPocketBaseDramas } from "./lib/pocketbase-drama-store";
import { listHookAssets } from "./lib/hook-asset-store";
import { createInspirationMaterialVideoUrl, listInspirationMaterials, type InspirationMaterial } from "./lib/inspiration-material-store";

type Workspace = "inspiration" | "library" | "factory" | "creations" | "sources" | "tasks";

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
];

function resolveFactoryMode(mode: string): FactoryMode {
  if (mode.includes("解说")) return "episode-narration";
  if (mode.includes("外搭")) return "external-hook";
  return "episode-splice";
}

function favoriteFromMaterial(material: InspirationMaterial): Favorite {
  const evidence = material.analysisV2?.evidence.slice(0, 3).map((item) => `${item.translation || item.text || item.kind}（${item.start.toFixed(2)}–${item.end.toFixed(2)} 秒）`);
  return {
    id: material.id, title: material.title, kind: "广告实例",
    hook: material.analysisV2?.content.summary || material.analysis || "该素材尚无可展示的分析摘要。",
    language: material.language || "语种待识别", theme: material.theme || "主题待识别",
    source: "灵感大屏", savedAt: "刚刚", tone: material.color === "cyan" ? "mint" : material.color,
    previewUrl: createInspirationMaterialVideoUrl(material) || undefined,
    previewDuration: material.media?.duration,
    analysis: material.analysisV2 ? {
      summary: material.analysisV2.content.summary || "分析完成，暂无摘要。",
      structure: material.analysisV2.creative.timeline.map((item) => item.label).filter(Boolean).join(" → ") || undefined,
      evidence,
    } : undefined,
  };
}

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace>("inspiration");
  const [creationsInitialTab, setCreationsInitialTab] = useState<"favorites" | "drafts">("favorites");
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
  const [accountNotifications,setAccountNotifications]=useState(true);
  const [accountAutoSave,setAccountAutoSave]=useState(true);
  const profileRef=useRef<HTMLDivElement>(null);

  useEffect(()=>{if(!profileOpen)return;const close=(event:MouseEvent)=>{if(!profileRef.current?.contains(event.target as Node))setProfileOpen(false)};const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setProfileOpen(false)};document.addEventListener("mousedown",close);document.addEventListener("keydown",escape);return()=>{document.removeEventListener("mousedown",close);document.removeEventListener("keydown",escape)}},[profileOpen]);

  useEffect(() => {
    if (!tasksReady) return;
    setTasks((current) => current.filter((task) => !/^TASK-08(?:17|18|19|20|21)$/.test(task.id)));
    setDrafts((current) => current.filter((draft) => Boolean(draft.sourceContext)));
    setFavorites((current) => current.filter((favorite) => Boolean(favorite.previewUrl || favorite.analysis)));
  }, [setDrafts, setFavorites, setTasks, tasksReady]);

  useEffect(() => {
    if (!tasksReady || !favorites.length) return;
    const controller = new AbortController();
    void listInspirationMaterials(controller.signal).then((materials) => {
      const byId = new Map(materials.map((material) => [material.id, material]));
      setFavorites((current) => {
        let changed = false;
        const next = current.map((favorite) => {
          const material = byId.get(favorite.id);
          if (!material) return favorite;
          const hydrated = favoriteFromMaterial(material);
          if (favorite.previewUrl === hydrated.previewUrl && favorite.title === hydrated.title && favorite.analysis?.summary === hydrated.analysis?.summary) return favorite;
          changed = true;
          return hydrated;
        });
        return changed ? next : current;
      });
    }).catch((error) => { if (!controller.signal.aborted) console.error("Favorite media hydration failed", error); });
    return () => controller.abort();
  }, [favorites.length, setFavorites, tasksReady]);

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

  useEffect(() => {
    if (!tasksReady) return;
    const controller = new AbortController();
    const syncHistory = async () => {
      try {
        const [history, dramas, hooks] = await Promise.all([listFactoryHistory(controller.signal), listPocketBaseDramas(), listHookAssets(controller.signal)]);
        const historicalDrafts: Draft[] = history.map((project) => {
          const drama = dramas.find((item) => item.recordId === project.drama);
          const hook = hooks.find((item) => item.id === project.hook);
          const render = project.latest_render;
          const validation = render?.validation && typeof render.validation === "object" ? render.validation as {schemaVersion?:string;passed?:boolean;technical?:{format?:{duration?:string}}} : undefined;
          const seconds = Number(validation?.technical?.format?.duration || 0) || project.timeline.reduce<number>((sum,item)=>sum+(item&&typeof item==="object"?Number((item as Record<string,unknown>).durationSeconds||0):0),0);
          const exported = project.review?.export && typeof project.review.export === "object" ? project.review.export as Record<string,unknown> : undefined;
          const storedQuality = project.quality_report && typeof project.quality_report === "object" ? project.quality_report as {schemaVersion?:string;status?:string;hardFailureCount?:number} : undefined;
          const selfQcCurrent = storedQuality?.schemaVersion === "factory-self-qc-v1";
          const renderQcCurrent = !render || validation?.schemaVersion === "factory-render-qc-v1";
          const qualityPassed = selfQcCurrent && renderQcCurrent && storedQuality?.hardFailureCount === 0 && validation?.passed !== false;
          const dramaSource: FactorySourceContext | null = drama ? {kind:"library",id:drama.recordId,title:drama.title,dramaTitle:drama.title,dramaCn:drama.cn,genre:drama.genre,language:drama.language,episodes:drama.totalEpisodes,freeEpisodes:drama.freeEpisodes,availableEpisodes:Object.keys(drama.episodeMedia).map(Number),episodeMedia:drama.episodeMedia,description:`${drama.cn} · ${drama.genre} · 历史生产片源`} : null;
          const hookSource: FactorySourceContext | null = hook ? {kind:"inspiration",id:hook.id,hookAssetId:hook.id,hookSourceClass:hook.sourceClass,hookMaterialId:hook.materialId,hookMediaUrl:hook.materialVideoUrl,hookStart:hook.start,hookEnd:hook.end,hookStartFrame:hook.startFrame,hookEndFrame:hook.endFrame,hookBoundaryStatus:hook.boundaryStatus,hookType:hook.hookType,themes:hook.themes,contentTags:hook.contentTags,relationships:hook.relationships,conflict:hook.conflict,emotion:hook.emotion,narrativePromise:hook.narrativePromise,informationGap:hook.informationGap,rightsStatus:hook.rightsStatus,title:hook.title,description:`${hook.materialTitle??"灵感大屏"} · ${hook.start.toFixed(2)}–${hook.end.toFixed(2)} 秒`} : null;
          return {id:`project-${project.id}`,title:project.title,mode:(project.mode==="external-hook"?"external-hook":project.mode==="episode-narration"?"episode-narration":"episode-splice"),drama:drama?.title??"历史剧目",hook:hook?.title??"历史钩子",episodeRange:project.selected_episodes.map((episode)=>`EP ${String(episode).padStart(2,"0")}`).join("、"),transition:String(project.transition.title||project.transition.type||"已保存过渡"),language:project.language||(drama?.language??"英语"),duration:seconds?`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,"0")}`:"未生成",ratio:project.ratio||"9:16",qualityStatus:qualityPassed&&project.status==="approved"?"可以直接生成":"建议优化后生成",updatedAt:project.updated?new Date(project.updated).toLocaleString("zh-CN"):"历史版本",autoSaved:true,thumbnailTone:"blue",thumbnailUrl:render?.preview_url||hook?.materialVideoUrl,progress:render?.progress??0,productionStatus:exported?"已导出":qualityPassed&&project.status==="approved"?"通过":render?.status==="succeeded"?"待审核":"编辑中",version:render?.version??project.version,sourceContext:dramaSource,hookSourceContext:hookSource,selectedEpisodes:project.selected_episodes,outputUrl:render?.output_url||undefined,outputName:typeof exported?.fileName==="string"?exported.fileName:undefined,factoryProjectId:project.id,parentFactoryProjectId:project.parent_project||undefined,factoryRenderId:render?.id,renderVersions:project.render_versions.map((item)=>({id:item.id,version:item.version,status:item.status,previewUrl:item.preview_url||undefined,outputUrl:item.output_url||undefined,created:item.created||undefined})),storyMatchId:project.story_match,isHistorySnapshot:true,factorySnapshot:{timeline:project.timeline,transition:project.transition,qualityReport:project.quality_report,review:project.review,projectStatus:project.status}};
        });
        setDrafts((current) => [...historicalDrafts, ...current.filter((draft) => !draft.factoryProjectId || !history.some((project) => project.id === draft.factoryProjectId))]);
      } catch (error) { if (!controller.signal.aborted) console.error("Factory history sync failed", error); }
    };
    void syncHistory();
    return () => controller.abort();
  }, [setDrafts, tasksReady, workspace]);

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
              onClick={() => {
                if (item.id === "factory") openFactory("episode-splice");
                else {
                  if (item.id === "creations") setCreationsInitialTab("favorites");
                  setWorkspace(item.id);
                }
              }}
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
          <div className="profile" ref={profileRef}><div>陈</div><span><b>陈佳</b><small>内容负责人</small></span><button type="button" aria-label={profileOpen?"收起个人账号面板":"展开个人账号面板"} aria-expanded={profileOpen} onClick={() => setProfileOpen((value) => !value)}>{profileOpen ? "⌃" : "⌄"}</button>{profileOpen&&<section className="account-panel" aria-label="个人账号面板"><header><div className="account-avatar">陈</div><div><h2>陈佳</h2><p>内容负责人 · Lumina 工作区</p><small>本地工作账号</small></div><span>正常</span></header><div className="account-summary"><div><b>{drafts.length}</b><small>创作草稿</small></div><div><b>{tasks.length}</b><small>处理任务</small></div><div><b>{favorites.length}</b><small>我的收藏</small></div></div><div className="account-section"><h3>账号与工作区</h3><button type="button" onClick={()=>notify("账号资料编辑将在身份系统接入后开放")}><span><b>账号资料</b><small>姓名、头像与联系方式</small></span><em>›</em></button><button type="button" onClick={()=>notify("当前工作区：Lumina 短剧智能工作台")}><span><b>当前工作区</b><small>Lumina · 内容负责人</small></span><em>›</em></button></div><div className="account-section"><h3>个人偏好</h3><label><span><b>任务通知</b><small>任务完成或异常时提醒</small></span><input type="checkbox" checked={accountNotifications} onChange={event=>{setAccountNotifications(event.target.checked);notify(event.target.checked?"任务通知已开启":"任务通知已关闭")}}/><i/></label><label><span><b>自动保存</b><small>编辑草稿时持续保存</small></span><input type="checkbox" checked={accountAutoSave} onChange={event=>{setAccountAutoSave(event.target.checked);notify(event.target.checked?"自动保存偏好已开启":"自动保存偏好已关闭")}}/><i/></label></div><div className="account-service"><i/><span><b>数据服务正常</b><small>PocketBase · 本地连接</small></span><em>在线</em></div><footer><button type="button" onClick={()=>notify("帮助中心将在文档服务接入后开放")}>帮助与反馈</button><button type="button" disabled title="尚未接入账号认证系统">退出登录</button></footer></section>}</div>
        </div>
      </aside>

      <main className="content">
        {workspace === "inspiration" && (
          <InspirationWorkspace
            onOpenFactory={(hook) => openFactory("external-hook", null, { kind: "inspiration", id: hook.id, hookAssetId: hook.id, hookSourceClass: hook.sourceClass, hookMaterialId: hook.materialId, hookMediaUrl: hook.materialVideoUrl, hookStart: hook.start, hookEnd: hook.end, hookStartFrame: hook.startFrame, hookEndFrame: hook.endFrame, hookBoundaryStatus: hook.boundaryStatus, hookType: hook.hookType, themes: hook.themes, contentTags: hook.contentTags, relationships: hook.relationships, conflict: hook.conflict, emotion: hook.emotion, narrativePromise: hook.narrativePromise, informationGap: hook.informationGap, rightsStatus: hook.rightsStatus, title: hook.title, description: `${hook.materialTitle ?? "灵感大屏"} · ${hook.start.toFixed(2)}–${hook.end.toFixed(2)} 秒 · ${hook.narrativePromise || hook.conflict || "片段级钩子"}` })}
            onFavoriteChange={(material, favorite) => {
              if (favorite) setFavorites((current) => [favoriteFromMaterial(material), ...current.filter(item=>item.id!==material.id)]);
              else setFavorites((current) => current.filter(item=>item.id!==material.id));
              notify(favorite ? "已收藏素材并同步至「我的创作」" : "已取消收藏");
            }}
          />
        )}
        <div hidden={workspace !== "library"}>
          <DramaLibraryWorkspace
            onImportDrama={() => notify("已打开短剧导入任务")}
            onCreateParsingTask={createParsingTask}
            onOpenProductionRecord={(title) => { setWorkspace("creations"); notify(`已打开「${title}」对应的创作记录`); }}
            onEnterFactory={({ dramaId, dramaRecordId, mode, sourceId, title, cn, genre, language, episodes, freeEpisodes, availableEpisodes, episodeMedia, highlightCandidates }) => openFactory(resolveFactoryMode(mode), null, { kind: "library", id: dramaRecordId ?? (sourceId ? `${dramaId}-${sourceId}` : String(dramaId)), title, dramaTitle: title, dramaCn: cn, genre, language, episodes, freeEpisodes, availableEpisodes, episodeMedia, highlightCandidates, description: sourceId ? `${cn} · ${genre} · 已带入可投放区间 ${sourceId}` : `${cn} · ${genre} · 共 ${episodes} 集 · 已连接 ${availableEpisodes.length} 集真实片源` })}
          />
        </div>
        {workspace === "factory" && (
          <FactoryWorkspace
            key={`${factoryMode}-${editingDraft?.id ?? "new"}-${factoryDramaSource?.id ?? factorySource?.id ?? "direct"}`}
            initialMode={factoryMode}
            editingDraft={editingDraft}
            sourceContext={factorySource}
            dramaSourceContext={factoryDramaSource}
            hookSourceContext={factoryHookSource}
            onModeChange={setFactoryMode}
            onChooseDrama={(source) => { setFactoryDramaSource(source); setFactorySource(source); notify(`已选择本剧正片：${source.dramaCn ?? source.title}`); }}
            onChooseHook={(source) => { setFactoryHookSource(source); notify(`已选择外搭钩子：${source.title}`); }}
            onDraftAutoSave={saveDraft}
            onOpenDrafts={() => { setCreationsInitialTab("drafts"); setWorkspace("creations"); }}
            onNotify={notify}
          />
        )}
        {workspace === "creations" && (
          <MyCreations
            drafts={drafts}
            favorites={favorites}
            initialTab={creationsInitialTab}
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
      </main>
      {toast && <div className="toast"><i>✓</i>{toast}</div>}
    </div>
  );
}
