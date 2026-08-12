"use client";

import { useState } from "react";
import InspirationWorkspace from "./features/inspiration";
import DramaLibraryWorkspace from "./features/library";
import {
  FactoryWorkspace,
  initialDrafts,
  type Draft,
  type FactoryMode,
} from "./features/factory";
import {
  MyCreations,
  favoriteMocks,
  type Favorite,
} from "./features/creations";

type Workspace = "inspiration" | "library" | "factory" | "creations";

const navItems: Array<{
  id: Workspace;
  icon: string;
  label: string;
  count?: string;
}> = [
  { id: "inspiration", icon: "✦", label: "灵感大屏", count: "128" },
  { id: "library", icon: "▣", label: "剧库", count: "36" },
  { id: "factory", icon: "⌁", label: "内容工厂" },
  { id: "creations", icon: "♡", label: "我的创作" },
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
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);
  const [favorites, setFavorites] = useState<Favorite[]>(favoriteMocks);
  const [toast, setToast] = useState("");

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  };

  const openFactory = (mode: FactoryMode, draft: Draft | null = null) => {
    setFactoryMode(mode);
    setEditingDraft(draft);
    setWorkspace("factory");
  };

  const saveDraft = (draft: Draft) => {
    setDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
    notify("视频已生成，并自动保存至「我的草稿」");
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
          <span><b>Lumina</b><small>STORY INTELLIGENCE</small></span>
        </div>
        <nav>
          <p>内容工作台</p>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={workspace === item.id ? "active" : ""}
              onClick={() => setWorkspace(item.id)}
            >
              <i className="nav-icon">{item.icon}</i>
              <span>{item.label}</span>
              {(item.count || item.id === "creations") && (
                <em>{item.id === "creations" ? drafts.length : item.count}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <button onClick={() => notify("数据源管理即将开放")}><i className="nav-icon">◈</i><span>数据源管理</span></button>
          <button onClick={() => notify("团队与权限即将开放")}><i className="nav-icon">⚙</i><span>团队与权限</span></button>
          <div className="sync"><span><i /> 数据同步正常</span><small>最后更新 2 分钟前</small></div>
          <div className="profile"><div>JC</div><span><b>Julia Chen</b><small>Content Lead</small></span><button>⌄</button></div>
        </div>
      </aside>

      <main className="content">
        {workspace === "inspiration" && (
          <InspirationWorkspace
            onOpenFactory={() => openFactory("external-hook")}
            onFavoriteChange={(_, favorite) => notify(favorite ? "已收藏素材" : "已取消收藏")}
          />
        )}
        {workspace === "library" && (
          <DramaLibraryWorkspace
            onImportDrama={() => notify("已打开短剧导入任务")}
            onEnterFactory={({ mode }) => openFactory(resolveFactoryMode(mode))}
          />
        )}
        {workspace === "factory" && (
          <FactoryWorkspace
            key={`${factoryMode}-${editingDraft?.id ?? "new"}`}
            initialMode={factoryMode}
            editingDraft={editingDraft}
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
            onUseFavorite={(_, mode) => openFactory(mode)}
            onRemoveFavorite={(id) => setFavorites((current) => current.filter((item) => item.id !== id))}
            onNotify={notify}
          />
        )}
      </main>
      {toast && <div className="toast"><i>✓</i>{toast}</div>}
    </div>
  );
}
