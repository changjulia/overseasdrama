"use client";

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createInspirationMaterialVideoUrl,
  findInspirationMaterialByHash,
  getInspirationMaterialStats,
  getInspirationMaterial,
  hashInspirationVideo,
  listInspirationMaterialsPage,
  readVideoDuration,
  removeInspirationMaterial,
  retryInspirationMaterialAnalysis,
  saveInspirationMaterial,
  submitInspirationReview,
  type InspirationMaterial,
  type InspirationMaterialStats,
  type InspirationMaterialType,
  type MaterialTag,
} from "../../lib/inspiration-material-store";
import {
  listInspirationHookAssets,
  reviewHookBoundary,
  type HookAsset,
} from "../../lib/hook-asset-store";
import { isKnownOntologyTag } from "../../lib/ontology/normalization";
import { formatDurationZh, normalizeDurationCopy } from "../../lib/time-format";
import styles from "./InspirationWorkspace.module.css";

export type InspirationTab = "feed" | "prototypes" | "analysis" | "review";
export type InspirationWorkspaceProps = {
  initialTab?: InspirationTab;
  onOpenFactory?: (hook: HookAsset) => void;
  onFavoriteChange?: (material: InspirationMaterial, favorite: boolean) => void;
  onMaterialDeleted?: (materialId: string) => void;
  onAddMonitorSource?: () => void;
};
type Material = InspirationMaterial;

const done = (item: Material) => item.analysisStatus === "succeeded";
const duration = (seconds: number) => formatDurationZh(seconds);
const copy = (value: string) => normalizeDurationCopy(value);
const pct = (value: number) => Math.round(value <= 1 ? value * 100 : value);
const materialMatchesInboundRange = (
  item: Material,
  start: string,
  end: string,
) => {
  if (!start && !end) return true;
  if (!item.createdAt) return false;
  const created = new Date(item.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  if (start && created < new Date(`${start}T00:00:00`)) return false;
  if (end && created > new Date(`${end}T23:59:59.999`)) return false;
  return true;
};
const tierLabel = (tier?: MaterialTag) => {
  const hasMetricEvidence = (tier?.evidenceSources ?? []).some((source) =>
    /^(?:adx|performance|metrics|manual_review)$/i.test(source),
  );
  if (tier?.verification !== "verified" || !hasMetricEvidence)
    return "层级待定";
  const code = (tier?.code || tier?.label || "").toUpperCase();
  return (
    (
      {
        T0: "最高级素材",
        T1: "一级素材",
        T2: "二级素材",
        T3: "三级素材",
        TX: "层级待定",
      } as Record<string, string>
    )[code] || "层级待定"
  );
};
const cardConclusion = (item: Material, progress: number) => {
  if (item.analysisStatus === "running")
    return `${item.analysisStage || "正在处理"} · ${progress}%`;
  if (item.analysisStatus === "queued")
    return item.analysisStage || "等待素材 Worker";
  if (item.analysisStatus === "failed")
    return item.analysisError || "分析失败，请重新提交";
  if (item.analysisStatus === "succeeded") {
    const reviewRequired =
      ["needs_review", "待复核", "退回重分析"].includes(item.review) ||
      item.analysisV2?.review.reviewRequired === true;
    if (reviewRequired)
      return item.analysisV2?.content.summary
        ? `结果待复核：${copy(item.analysisV2.content.summary)}`
        : "分析任务已结束，但证据不足，结果待复核";
    return item.analysisV2?.content.summary
      ? copy(item.analysisV2.content.summary)
      : "分析已完成，暂无经验证的内容摘要";
  }
  if (item.formScriptScenes?.length)
    return copy(item.formScriptScenes[0].script);
  return "尚未开始分析";
};
const analysisLabelForPicker = (item: Material) =>
  item.analysisV2
    ? "分析完成"
    : item.analysisStatus === "running"
      ? "分析中"
      : item.analysisStatus === "queued"
        ? "排队中"
        : item.analysisStatus === "failed"
          ? "分析失败"
          : "未分析";

export function InspirationWorkspace({
  initialTab = "feed",
  onOpenFactory,
  onFavoriteChange,
  onMaterialDeleted,
  onAddMonitorSource,
}: InspirationWorkspaceProps) {
  const deepLinkHandled = useRef(false),
    detailRequests = useRef(new Set<string>());
  const [tab, setTab] = useState<InspirationTab>(initialTab),
    [materials, setMaterials] = useState<Material[]>([]),
    [hooks, setHooks] = useState<HookAsset[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [selectedHookId, setSelectedHookId] = useState(""),
    [query, setQuery] = useState(""),
    [type, setType] = useState("全部类型"),
    [language, setLanguage] = useState("全部语种"),
    [analysisFilter, setAnalysisFilter] = useState("全部分析状态"),
    [inboundStart, setInboundStart] = useState(""),
    [inboundEnd, setInboundEnd] = useState(""),
    [uploadOpen, setUploadOpen] = useState(false),
    [toast, setToast] = useState(""),
    [error, setError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [favorites, setFavorites] = useState<string[]>([]),
    [deletingId, setDeletingId] = useState(""),
    [openingId, setOpeningId] = useState("");
  const [loadedPages, setLoadedPages] = useState(1),
    [totalItems, setTotalItems] = useState(0),
    [totalPages, setTotalPages] = useState(1),
    [loadingMore, setLoadingMore] = useState(false),
    [stats, setStats] = useState<InspirationMaterialStats | null>(null);
  const refreshBusy = useRef(false);
  const mergeMaterials = (next: Material[], replace = false) =>
    setMaterials((current) => {
      const previous = new Map(current.map((item) => [item.id, item]));
      const merged = next.map((item) => {
        const existing = previous.get(item.id);
        return existing?.analysisV2 && !item.analysisV2
          ? { ...item, analysisV2: existing.analysisV2 }
          : item;
      });
      if (replace) return merged;
      const ids = new Set(merged.map((item) => item.id));
      return [...current.filter((item) => !ids.has(item.id)), ...merged];
    });
  const refresh = async (signal?: AbortSignal, includeHooks = false) => {
    if (refreshBusy.current) return materials;
    refreshBusy.current = true;
    try {
      const pages = await Promise.all(
        Array.from({ length: loadedPages }, (_, index) =>
          listInspirationMaterialsPage(index + 1, 24, signal),
        ),
      );
      const nextMaterials = pages.flatMap((value) => value.items);
      mergeMaterials(nextMaterials, true);
      setTotalItems(pages[0]?.totalItems ?? nextMaterials.length);
      setTotalPages(pages[0]?.totalPages ?? 1);
      const [nextHooks, nextStats] = await Promise.all([
        includeHooks
          ? listInspirationHookAssets(signal).catch(() => [])
          : Promise.resolve(null),
        getInspirationMaterialStats(signal).catch(() => null),
      ]);
      if (nextHooks) setHooks(nextHooks);
      if (nextStats) setStats(nextStats);
      setError("");
      return nextMaterials;
    } catch (reason) {
      if (!signal?.aborted)
        setError(reason instanceof Error ? reason.message : "素材读取失败");
      return undefined;
    } finally {
      refreshBusy.current = false;
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const tick = async (first = false) => {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(() => void tick(), 10000);
        return;
      }
      const next = await refresh(controller.signal, first);
      if (controller.signal.aborted) return;
      const active = next?.some(
        (item) =>
          item.analysisStatus === "queued" || item.analysisStatus === "running",
      );
      timer = window.setTimeout(() => void tick(), active ? 5000 : 30000);
    };
    void tick(true);
    const visible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [loadedPages]);
  const loadMore = async () => {
    if (loadingMore || loadedPages >= totalPages) return;
    setLoadingMore(true);
    try {
      const page = await listInspirationMaterialsPage(loadedPages + 1, 24);
      mergeMaterials(page.items);
      setLoadedPages(page.page);
      setTotalItems(page.totalItems);
      setTotalPages(page.totalPages);
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "下一页读取失败");
    } finally {
      setLoadingMore(false);
    }
  };
  useEffect(() => {
    const onScroll = () => {
      if (
        tab === "feed" &&
        !loadingMore &&
        loadedPages < totalPages &&
        window.innerHeight + window.scrollY >=
          document.documentElement.scrollHeight - 700
      )
        void loadMore();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [tab, loadingMore, loadedPages, totalPages]);
  const completed = materials.filter(done),
    selected =
      materials.find((v) => v.id === selectedId) ?? completed[0] ?? materials[0];
  const reviewItems = completed.filter(
    (v) =>
      ["needs_review", "待复核", "退回重分析"].includes(v.review) ||
      v.analysisV2?.review.reviewRequired === true,
  );
  const hookReviewItems = hooks.filter(
    (hook) =>
      hook.boundaryStatus !== "verified" || hook.reviewStatus !== "approved",
  );
  const prototypes = useMemo(() => {
    const groups = new Map<string, HookAsset[]>();
    for (const hook of hooks) {
      const key = hook.hookType || "待分类";
      groups.set(key, [...(groups.get(key) ?? []), hook]);
    }
    return [...groups].map(([label, items]) => ({ label, items }));
  }, [hooks]);
  const filtered = materials.filter(
    (item) =>
      (type === "全部类型" || item.type === type) &&
      (language === "全部语种" || item.language === language) &&
      (analysisFilter === "全部分析状态" ||
        item.analysisStatus === "succeeded") &&
      materialMatchesInboundRange(item, inboundStart, inboundEnd) &&
      (!query ||
        `${item.title} ${item.platform} ${item.theme}`
          .toLowerCase()
          .includes(query.toLowerCase())),
  );
  const counts = {
    feed: totalItems || materials.length,
    prototypes: hooks.length,
    analysis: materials.filter(
      (item) => done(item) || Boolean(item.formScriptScenes?.length),
    ).length,
    review: reviewItems.length + hookReviewItems.length,
  };
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };
  const selectAnalysis = (id: string) => {
    setSelectedId(id);
    setTab("analysis");
    setDetailError("");
    const existing = materials.find((item) => item.id === id);
    if (existing && existing.analysisStatus !== "succeeded") {
      setOpeningId("");
      detailRequests.current.delete(id);
      return;
    }
    if (existing?.analysisV2) {
      setOpeningId("");
      detailRequests.current.delete(id);
      return;
    }
    if (detailRequests.current.has(id)) return;
    detailRequests.current.add(id);
    setOpeningId(id);
    window.setTimeout(() => {
      void getInspirationMaterial(id)
        .then((detailed) => {
          if (!detailed.analysisV2 && detailed.analysisStatus !== "succeeded") {
            const fallback = completed.find((item) => item.analysisV2);
            setSelectedId(fallback?.id ?? "");
            const url = new URL(window.location.href);
            url.searchParams.delete("analysis");
            window.history.replaceState(
              null,
              "",
              `${url.pathname}${url.search}`,
            );
            flash("该素材尚未完成分析，已返回可用的分析结果");
            return;
          }
          if (!detailed.analysisV2)
            throw new Error("详情接口未返回 material-v2 结果");
          setMaterials((current) => {
            const exists = current.some((item) => item.id === id);
            return exists
              ? current.map((item) => (item.id === id ? detailed : item))
              : [detailed, ...current];
          });
        })
        .catch((reason) => {
          const message =
            reason instanceof Error ? reason.message : "分析结果读取失败";
          setDetailError(message);
          flash(message);
        })
        .finally(() => {
          detailRequests.current.delete(id);
          setOpeningId("");
        });
    }, 100);
  };
  const selectHookReview = (id: string) => {
    setSelectedHookId(id);
    setTab("review");
    const url = new URL(window.location.href);
    url.searchParams.set("reviewHook", id);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  };
  useEffect(() => {
    if (deepLinkHandled.current || !materials.length) return;
    const id = new URLSearchParams(window.location.search).get("analysis");
    if (!id) return;
    deepLinkHandled.current = true;
    selectAnalysis(id);
  }, [materials.length]);
  useEffect(() => {
    if (
      tab !== "analysis" ||
      !selected ||
      selected.analysisStatus !== "succeeded" ||
      selected.analysisV2 ||
      openingId ||
      detailError ||
      detailRequests.current.has(selected.id)
    )
      return;
    selectAnalysis(selected.id);
  }, [tab, selected?.id, selected?.analysisV2, openingId, detailError]);
  useEffect(() => {
    if (!hooks.length) return;
    const id = new URLSearchParams(window.location.search).get("reviewHook");
    if (id && hooks.some((hook) => hook.id === id)) {
      setSelectedHookId(id);
      setTab("review");
    }
  }, [hooks.length]);
  const open = async (item: Material) => {
    if (item.analysisStatus === "failed") {
      await retryInspirationMaterialAnalysis(item.id);
      flash("已重新加入分析队列");
      void refresh();
      return;
    }
    if (done(item) || item.formScriptScenes?.length) {
      await selectAnalysis(item.id);
      return;
    }
    flash(
      item.analysisStatus === "running"
        ? `${item.analysisStage || "正在分析"} · ${Math.round(item.analysisProgress ?? 0)}%`
        : "正在等待分析",
    );
  };
  const favorite = (id: string) => {
    const next = !favorites.includes(id);
    setFavorites((old) => (next ? [...old, id] : old.filter((v) => v !== id)));
    const material = materials.find((item) => item.id === id);
    if (material) onFavoriteChange?.(material, next);
  };
  const removeMaterial = async (item: Material) => {
    if (
      !window.confirm(
        `确定永久删除素材“${item.title}”吗？\n\n视频文件、分析结果和关联钩子将一并删除，此操作不可撤销。`,
      )
    )
      return;
    setDeletingId(item.id);
    try {
      await removeInspirationMaterial(item.id);
      setMaterials((current) =>
        current.filter((value) => value.id !== item.id),
      );
      setHooks((current) =>
        current.filter((value) => value.materialId !== item.id),
      );
      setFavorites((current) => current.filter((id) => id !== item.id));
      setSelectedId((current) => (current === item.id ? "" : current));
      onMaterialDeleted?.(item.id);
      flash("素材及关联分析已删除");
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "素材删除失败");
    } finally {
      setDeletingId("");
    }
  };
  return (
    <section className={styles.workspace} aria-label="灵感大屏工作区">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>市场素材情报中心</span>
          <h1>灵感大屏</h1>
          <p>独立分析外部买量成片，所有结论均来自当前素材证据。</p>
        </div>
        <div className={styles.headerActions}>
          {onAddMonitorSource && (
            <button className={styles.secondary} onClick={onAddMonitorSource}>
              ＋ 添加监测源
            </button>
          )}
          <button
            className={styles.primary}
            onClick={() => setUploadOpen(true)}
          >
            ＋ 买量素材入库
          </button>
        </div>
      </header>
      <nav className={styles.tabs}>
        {(
          [
            ["feed", "跑量素材"],
            ["prototypes", "钩子原型"],
            ["analysis", "素材分析"],
            ["review", "人工复核"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? styles.activeTab : ""}
            onClick={() => setTab(key)}
          >
            <span>{label}</span>
            <em>{counts[key]}</em>
          </button>
        ))}
      </nav>
      {tab === "feed" && (
        <>
          <div className={styles.stats}>
            {[
              ["素材总数", stats?.total ?? totalItems ?? materials.length],
              ["已完成分析", stats?.completed ?? completed.length],
              ["钩子原型", prototypes.length],
              [
                "长效素材",
                stats?.longRunning ?? materials.filter((v) => v.days >= 30).length,
              ],
              ["待人工复核", stats?.pendingReview ?? reviewItems.length],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className={styles.toolbar}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题、平台或题材"
            />
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option>全部类型</option>
              <option>未确定</option>
              <option>正片剧集拼接</option>
              <option>正片剧集解说</option>
              <option>外搭钩子＋本剧正片</option>
            </select>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option>全部语种</option>
              {[...new Set(materials.map((v) => v.language))].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
            <select
              aria-label="按分析状态筛选"
              value={analysisFilter}
              onChange={(e) => setAnalysisFilter(e.target.value)}
            >
              <option>全部分析状态</option>
              <option>仅看分析完成</option>
            </select>
            <div
              className={styles.inboundDateFilter}
              role="group"
              aria-label="按入库时间筛选"
            >
              <span>入库时间</span>
              <input
                aria-label="入库开始日期"
                type="date"
                value={inboundStart}
                max={inboundEnd || undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  setInboundStart(value);
                  if (inboundEnd && value > inboundEnd) setInboundEnd(value);
                }}
              />
              <i>至</i>
              <input
                aria-label="入库结束日期"
                type="date"
                value={inboundEnd}
                min={inboundStart || undefined}
                onChange={(e) => {
                  const value = e.target.value;
                  setInboundEnd(value);
                  if (inboundStart && value < inboundStart)
                    setInboundStart(value);
                }}
              />
              {(inboundStart || inboundEnd) && (
                <button
                  type="button"
                  onClick={() => {
                    setInboundStart("");
                    setInboundEnd("");
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>
          {error ? (
            <State title="素材加载失败" detail={error} />
          ) : filtered.length ? (
            <div className={styles.grid}>
              {filtered.map((item) => (
                <MaterialCard
                  key={item.id}
                  item={item}
                  favorite={favorites.includes(item.id)}
                  deleting={deletingId === item.id}
                  opening={openingId === item.id}
                  onFavorite={() => favorite(item.id)}
                  onDelete={() => void removeMaterial(item)}
                  onOpen={() => void open(item)}
                />
              ))}
            </div>
          ) : (
            <State
              title={materials.length ? "没有符合条件的素材" : "还没有买量素材"}
              detail={
                materials.length
                  ? "请调整筛选条件。"
                  : "使用右上角入口上传真实视频素材。"
              }
            />
          )}
        </>
      )}
      {tab === "prototypes" &&
        (prototypes.length ? (
          <HookPrototypePanel
            groups={prototypes}
            onFactory={(hook) => onOpenFactory?.(hook)}
            onReview={selectHookReview}
          />
        ) : (
          <State
            title="暂无钩子资产"
            detail="素材分析完成并定位到可复用片段后，钩子会按原型展示在这里。"
          />
        ))}
      {tab === "analysis" &&
        (openingId ? (
          <State
            title="正在读取分析详情"
            detail="页面已进入分析视图，请稍候。"
          />
        ) : detailError ? (
          <div className={styles.detailLoadError}>
            <State title="分析详情读取失败" detail={detailError} />
            <button
              className={styles.primary}
              onClick={() =>
                void selectAnalysis(selectedId || completed[0]?.id)
              }
            >
              重新读取
            </button>
          </div>
        ) : selected ? (
          <Analysis
            item={selected}
            all={materials}
            onSelect={(id) => void selectAnalysis(id)}
            onFactory={() => {
              const hook = hooks.find((v) => v.materialId === selected.id);
              if (hook) onOpenFactory?.(hook);
              else flash("该素材尚未生成片段级钩子资产");
            }}
          />
        ) : (
          <State
            title="暂无分析结果"
            detail={
              materials.length
                ? "素材完成 material-v2 真实分析后才会展示。"
                : "请先上传真实视频素材。"
            }
          />
        ))}
      {tab === "review" &&
        (selectedHookId || hookReviewItems.length ? (
          <HookReview
            hooks={hooks}
            selectedId={selectedHookId || hookReviewItems[0]?.id}
            onSelect={selectHookReview}
            onSaved={() => void refresh()}
            flash={flash}
          />
        ) : reviewItems.length ? (
          <Review
            items={reviewItems}
            onSaved={() => void refresh()}
            flash={flash}
          />
        ) : (
          <State
            title="暂无待复核项"
            detail="素材标签与钩子边界均已完成复核。"
          />
        ))}
      {uploadOpen && (
        <Upload
          onClose={() => setUploadOpen(false)}
          onSaved={(item) => {
            setMaterials((old) => [
              item,
              ...old.filter((v) => v.id !== item.id),
            ]);
            setUploadOpen(false);
            flash("素材已保存并进入分析队列");
            void refresh();
          }}
        />
      )}
      {toast && <div className={styles.toast}>✓ {toast}</div>}
    </section>
  );
}

const canonicalHookType = (hook: HookAsset) => {
  const raw = `${hook.hookType} ${hook.contentTags.join(" ")}`.toLowerCase();
  if (/cliff|suspense|悬念|危机/.test(raw)) return "悬念预告";
  if (/reveal|identity|身份|真相|揭/.test(raw)) return "身份揭示";
  if (/conflict|confront|outburst|冲突|对抗|争执/.test(raw)) return "强冲突";
  if (/emotion|breakdown|情感|情绪|虐/.test(raw)) return "情绪拉升";
  if (/decision|payoff|打脸|爽/.test(raw)) return "爽点兑现";
  if (/contrast|反差/.test(raw)) return "反差";
  return "信息差";
};
const hookAttribution = (hook: HookAsset) => {
  if (hook.sourceClass === "narration_opening") return "解说开场";
  if (
    hook.hookAssemblyType === "同剧外搭" ||
    hook.hookSourceStatus === "已确认同剧"
  )
    return "同剧高光前置";
  if (
    hook.hookAssemblyType === "跨剧外搭" ||
    hook.hookSourceStatus === "已确认外搭"
  )
    return "跨剧／外部外搭";
  if (
    hook.hookAssemblyType === "外搭来源待确认" ||
    ["疑似外搭", "来源未知"].includes(hook.hookSourceStatus)
  )
    return "外搭来源待确认";
  return "原生正片开场";
};
function HookPrototypePanel({
  groups,
  onFactory,
  onReview,
}: {
  groups: Array<{ label: string; items: HookAsset[] }>;
  onFactory: (hook: HookAsset) => void;
  onReview: (id: string) => void;
}) {
  const [sourceClass, setSourceClass] = useState("全部来源"),
    [attribution, setAttribution] = useState("全部归属"),
    [hookType, setHookType] = useState("全部类型"),
    [theme, setTheme] = useState("全部题材"),
    [relation, setRelation] = useState("全部关系"),
    [emotion, setEmotion] = useState("全部情绪"),
    [boundary, setBoundary] = useState("全部边界"),
    [advanced, setAdvanced] = useState(false);
  const all = groups.flatMap((group) => group.items);
  const ontologyValues = (dimension: string) =>
    [
      ...new Set(
        all.flatMap((hook) =>
          (hook.ontologyTags ?? [])
            .filter(
              (tag) => tag.dimension === dimension && isKnownOntologyTag(tag),
            )
            .map((tag) => tag.label),
        ),
      ),
    ].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const hookTypes = [...new Set(all.map(canonicalHookType))].sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  const themes = ontologyValues("theme"),
    relations = ontologyValues("relation"),
    emotions = ontologyValues("emotion");
  const hasOntology = (hook: HookAsset, dimension: string, label: string) =>
    label.startsWith("全部") ||
    (hook.ontologyTags ?? []).some(
      (tag) =>
        tag.dimension === dimension &&
        isKnownOntologyTag(tag) &&
        tag.label === label,
    );
  const visible = all.filter(
    (hook) =>
      (sourceClass === "全部来源" || hook.sourceClass === sourceClass) &&
      (attribution === "全部归属" || hookAttribution(hook) === attribution) &&
      (hookType === "全部类型" || canonicalHookType(hook) === hookType) &&
      hasOntology(hook, "theme", theme) &&
      hasOntology(hook, "relation", relation) &&
      hasOntology(hook, "emotion", emotion) &&
      (boundary === "全部边界" || hook.boundaryStatus === boundary),
  );
  const activeAdvanced = [
    relation !== "全部关系",
    emotion !== "全部情绪",
    boundary !== "全部边界",
  ].filter(Boolean).length;
  const reset = () => {
    setSourceClass("全部来源");
    setAttribution("全部归属");
    setHookType("全部类型");
    setTheme("全部题材");
    setRelation("全部关系");
    setEmotion("全部情绪");
    setBoundary("全部边界");
  };
  return (
    <div className={styles.hookPrototypePage}>
      <div className={styles.hookPrototypeToolbar}>
        <div>
          <h2>钩子原型库</h2>
          <p>按统一标签体系筛选从买量素材中定位的可复用方法。</p>
        </div>
        <div className={styles.prototypePrimaryFilters}>
          <label>
            <span>资产来源</span>
            <select
              value={sourceClass}
              onChange={(event) => setSourceClass(event.target.value)}
            >
              <option>全部来源</option>
              <option value="external_material">买量素材开场</option>
              <option value="narration_opening">解说开场</option>
            </select>
          </label>
          <label>
            <span>钩子归属</span>
            <select
              value={attribution}
              onChange={(event) => setAttribution(event.target.value)}
            >
              <option>全部归属</option>
              <option>同剧高光前置</option>
              <option>跨剧／外部外搭</option>
              <option>外搭来源待确认</option>
              <option>原生正片开场</option>
            </select>
          </label>
          <label>
            <span>钩子类型</span>
            <select
              value={hookType}
              onChange={(event) => setHookType(event.target.value)}
            >
              <option>全部类型</option>
              {hookTypes.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            <span>题材主题</span>
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              <option>全部题材</option>
              {themes.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={advanced ? styles.prototypeAdvancedActive : ""}
            onClick={() => setAdvanced((value) => !value)}
          >
            高级筛选{activeAdvanced ? ` · ${activeAdvanced}` : ""}
          </button>
        </div>
      </div>
      {advanced && (
        <div className={styles.prototypeAdvancedFilters}>
          <div>
            <label>
              <span>人物关系</span>
              <select
                value={relation}
                onChange={(event) => setRelation(event.target.value)}
              >
                <option>全部关系</option>
                {relations.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              <span>主导情绪</span>
              <select
                value={emotion}
                onChange={(event) => setEmotion(event.target.value)}
              >
                <option>全部情绪</option>
                {emotions.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              <span>边界状态</span>
              <select
                value={boundary}
                onChange={(event) => setBoundary(event.target.value)}
              >
                <option>全部边界</option>
                <option value="verified">边界已验证</option>
                <option value="unverified">边界待复核</option>
                <option value="rejected">边界已驳回</option>
              </select>
            </label>
          </div>
          <p>
            高级维度来自现有 relation、emotion
            标签；边界状态属于生产门禁，不新增内容标签。
          </p>
        </div>
      )}
      <div className={styles.prototypeResultBar}>
        <span>
          共 <b>{visible.length}</b> 个钩子实例 ·{" "}
          <b>{new Set(visible.map(canonicalHookType)).size}</b> 种原型
        </span>
        {visible.length !== all.length && (
          <button type="button" onClick={reset}>
            清除筛选
          </button>
        )}
      </div>
      <div className={styles.hookAssetGrid}>
        {visible.map((hook) => (
          <HookAssetCard
            key={hook.id}
            hook={hook}
            onFactory={() => onFactory(hook)}
            onReview={() => onReview(hook.id)}
          />
        ))}
      </div>
      {!visible.length && (
        <State
          title="没有符合筛选条件的钩子"
          detail="调整来源或主题标签后重试。"
        />
      )}
    </div>
  );
}

function HookAssetCard({
  hook,
  onFactory,
  onReview,
}: {
  hook: HookAsset;
  onFactory: () => void;
  onReview: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null),
    durationSeconds = Math.max(0, hook.end - hook.start),
    eligible =
      hook.sourceClass === "external_material" &&
      hook.boundaryStatus === "verified" &&
      ["已获授权可制作", "已获授权可投放"].includes(hook.rightsStatus);
  const startPreview = () => {
    const element = video.current;
    if (!element) return;
    element.dataset.hovering = "true";
    element.currentTime = hook.start;
    void element.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const element = video.current;
    if (!element) return;
    element.dataset.hovering = "false";
    element.pause();
    element.currentTime = hook.start;
  };
  const compactTags = [
    canonicalHookType(hook),
    ...["theme", "relation", "emotion"].flatMap((dimension) =>
      (hook.ontologyTags ?? [])
        .filter((tag) => tag.dimension === dimension && isKnownOntologyTag(tag))
        .slice(0, 1)
        .map((tag) => tag.label),
    ),
  ]
    .filter(
      (value, index, items) => Boolean(value) && items.indexOf(value) === index,
    )
    .slice(0, 4);
  return (
    <article className={styles.hookAssetCard}>
      <div
        className={styles.hookAssetPreview}
        onMouseEnter={startPreview}
        onMouseLeave={stopPreview}
      >
        {hook.materialVideoUrl ? (
          <video
            ref={video}
            src={`${hook.materialVideoUrl}#t=${hook.start},${hook.end}`}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              event.currentTarget.currentTime = hook.start;
            }}
            onCanPlay={(event) => {
              if (event.currentTarget.dataset.hovering === "true")
                void event.currentTarget.play().catch(() => undefined);
            }}
            onSeeking={(event) => {
              if (
                event.currentTarget.currentTime < hook.start ||
                event.currentTarget.currentTime > hook.end
              )
                event.currentTarget.currentTime = hook.start;
            }}
            onTimeUpdate={(event) => {
              if (event.currentTarget.currentTime >= hook.end) stopPreview();
            }}
          />
        ) : (
          <span>无可播放来源</span>
        )}
        <button type="button" onClick={startPreview}>
          ▶ 预览钩子 {duration(hook.start)}–{duration(hook.end)}
        </button>
      </div>
      <div className={styles.hookAssetBody}>
        <header>
          <span>{hookAttribution(hook)}</span>
          <em
            className={
              hook.boundaryStatus === "verified"
                ? styles.hookVerified
                : styles.hookNeedsReview
            }
          >
            {hook.boundaryStatus === "verified" ? "边界已验证" : "边界待复核"}
          </em>
        </header>
        <button
          type="button"
          className={styles.hookReviewLink}
          onClick={onReview}
        >
          <h3>{hook.title}</h3>
          <span>进入人工复核 →</span>
        </button>
        <p>
          {hook.materialTitle || "来源待补充"} · {duration(hook.start)}–
          {duration(hook.end)} · {duration(durationSeconds)}
        </p>
        <div className={styles.chips} aria-label="核心标签">
          {compactTags.map((item, index) => (
            <span key={`${item}-${index}`}>{item}</span>
          ))}
        </div>
        <dl>
          <div>
            <dt>核心矛盾</dt>
            <dd>{hook.conflict || "待分析"}</dd>
          </div>
          <div>
            <dt>叙事承诺</dt>
            <dd>{hook.narrativePromise || "待分析"}</dd>
          </div>
          <div>
            <dt>口播提炼</dt>
            <dd>{hook.spokenSummary || "无持续解说"}</dd>
          </div>
          <div>
            <dt>安全边界</dt>
            <dd>
              {hook.safeStart?.dialogueStatus ||
                hook.safeStart?.status ||
                "未验证"}{" "}
              →{" "}
              {hook.safeEnd?.dialogueStatus || hook.safeEnd?.status || "未验证"}
            </dd>
          </div>
        </dl>
        <footer>
          <small>{hook.rightsStatus}</small>
          <button
            type="button"
            disabled={!eligible}
            title={
              !eligible
                ? "仅允许边界已验证且授权可制作的外搭钩子进入该模式"
                : undefined
            }
            onClick={onFactory}
          >
            用此钩子创作 →
          </button>
        </footer>
      </div>
    </article>
  );
}

function MaterialCard({
  item,
  favorite,
  deleting,
  opening,
  onFavorite,
  onDelete,
  onOpen,
}: {
  item: Material;
  favorite: boolean;
  deleting: boolean;
  opening: boolean;
  onFavorite: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const url = createInspirationMaterialVideoUrl(item);
  const [previewing, setPreviewing] = useState(false),
    [previewFailed, setPreviewFailed] = useState(false),
    [posterFailed, setPosterFailed] = useState(false);
  const v2 = item.analysisV2,
    hook = v2?.creative.hook?.mechanisms[0]?.label,
    tLevel = v2?.creative.tLevel;
  const progress = Math.max(
      0,
      Math.min(100, Math.round(item.analysisProgress ?? 0)),
    ),
    status = item.analysisStatus ?? "idle";
  return (
    <>
      <article className={styles.card}>
        <div className={`${styles.cover} ${styles[item.color]}`}>
          {item.coverUrl && !posterFailed ? (
            <img
              className={styles.materialPoster}
              src={item.coverUrl}
              alt={`${item.title} 视频封面`}
              onError={() => setPosterFailed(true)}
            />
          ) : url ? (
            <video
              className={styles.materialPoster}
              src={`${url}#t=0.1`}
              muted
              playsInline
              preload="metadata"
              aria-label={`${item.title} 视频首帧`}
            />
          ) : (
            <div className={styles.coverPlaceholder} aria-label={`${item.title} 暂无封面`}>
              <b>{item.title.trim().slice(0, 1) || "影"}</b>
              <span>暂无封面</span>
            </div>
          )}
          {url && (
            <button
              type="button"
              onClick={() => {
                setPreviewFailed(false);
                setPreviewing(true);
              }}
              className={styles.previewButton}
              aria-label={`播放 ${item.title}`}
              title="在页面内播放原视频"
            >
              ▶
            </button>
          )}
          <span className={styles.source}>
            {item.source} · {item.platform}
          </span>
          <em>{item.media ? duration(item.media.duration) : "无片源"}</em>
          <button
            className={`${styles.favorite} ${favorite ? styles.favorited : ""}`}
            onClick={onFavorite}
          >
            {favorite ? "♥" : "♡"}
          </button>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.tags}>
            <span
              title={
                tLevel
                  ? `内部枚举：${tLevel.code || tLevel.label}`
                  : "尚未形成素材层级"
              }
            >
              {tierLabel(tLevel)}
            </span>
            {hook && <span>{hook}</span>}
            {!!item.formScriptScenes?.length && (
              <span>表单脚本 · {item.formScriptScenes.length}场</span>
            )}
            <span>{item.language}</span>
          </div>
          <h3>{item.title}</h3>
          <p title={cardConclusion(item, progress)}>
            {cardConclusion(item, progress)}
          </p>
          <div
            className={styles.materialProgress}
            data-status={status}
            role="progressbar"
            aria-label={`${item.title} 实时分析进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div>
              <span>
                {item.analysisStage ||
                  {
                    queued: "等待分析",
                    running: "正在分析",
                    succeeded: "分析完成",
                    failed: "分析失败",
                    idle: item.formScriptScenes?.length
                      ? "已载入表单脚本"
                      : "尚未分析",
                  }[status]}
              </span>
              <b>{progress}%</b>
            </div>
            <i>
              <em style={{ width: `${progress}%` }} />
            </i>
          </div>
          <div className={styles.cardFooter}>
            <span>{item.captured}</span>
            <div>
              <button
                className={styles.deleteAction}
                disabled={deleting || opening}
                onClick={onDelete}
              >
                {deleting ? "删除中…" : "删除"}
              </button>
              {done(item) ? (
                <a
                  className={styles.analysisLink}
                  href={`/?analysis=${encodeURIComponent(item.id)}`}
                >
                  进入分析 →
                </a>
              ) : item.formScriptScenes?.length ? (
                <button onClick={onOpen}>
                  查看脚本
                </button>
              ) : (
                <button disabled={opening} onClick={onOpen}>
                  {item.analysisStatus === "failed"
                    ? "重新分析"
                    : `${progress}%`}
                </button>
              )}
            </div>
          </div>
        </div>
      </article>
      {previewing && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={`播放 ${item.title}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewing(false);
          }}
        >
          <section className={styles.videoPreviewModal}>
            <header>
              <div>
                <b>{item.title}</b>
                <span>
                  {item.platform} ·{" "}
                  {item.media ? duration(item.media.duration) : "时长未知"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setPreviewing(false)}
                aria-label="关闭视频"
              >
                ×
              </button>
            </header>
            {url && !previewFailed ? (
              <video
                src={url}
                controls
                autoPlay
                playsInline
                preload="auto"
                onError={() => setPreviewFailed(true)}
              />
            ) : (
              <p>视频加载失败，请检查素材文件是否仍然存在。</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}

type EvidenceItem = NonNullable<Material["analysisV2"]>["evidence"][number];
const evidenceGroup = (kind: string) => {
  const value = kind.toLowerCase();
  if (value.includes("asr") || value.includes("transcript")) return "对白";
  if (value.includes("ocr") || value.includes("subtitle")) return "字幕";
  if (value.includes("scene") || value.includes("shot")) return "镜头";
  if (value.includes("audio") || value.includes("silence")) return "音频";
  return "画面";
};
const hasChinese = (value?: string) =>
  Boolean(
    value && /[\u4e00-\u9fff]/u.test(value) && !/[\u3040-\u30ff]/u.test(value),
  );
const evidenceMeaning = (item: EvidenceItem) => {
  if (hasChinese(item.observation)) return item.observation!;
  if (hasChinese(item.translation)) return item.translation!;
  if (hasChinese(item.text) && !/^(?:镜头|画面)\s*\d+$/u.test(item.text!))
    return item.text!;
  return "该时间点仅有技术定位信息，尚未形成可支撑剧情结论的事实证据。";
};
const evidenceClassLabel = (item: EvidenceItem) =>
  item.evidenceClass === "narrative"
    ? "关键剧情证据"
    : item.evidenceClass === "auxiliary"
      ? "辅助识别证据"
      : "技术定位点";
function EvidencePanel({
  items,
  videoUrl,
}: {
  items: EvidenceItem[];
  videoUrl?: string;
}) {
  const [group, setGroup] = useState("全部"),
    [expanded, setExpanded] = useState(false),
    groups = ["对白", "字幕", "画面", "镜头", "音频"],
    counts = new Map(
      groups.map((label) => [
        label,
        items.filter((item) => evidenceGroup(item.kind) === label).length,
      ]),
    ),
    filtered =
      group === "全部"
        ? items
        : items.filter((item) => evidenceGroup(item.kind) === group),
    visible = expanded ? filtered : filtered.slice(0, 12);
  const verificationLabel = (value?: string) =>
    value === "verified"
      ? "已验证"
      : value === "observed"
        ? "已识别"
        : value === "unverified" || value === "needs_review"
          ? "待确认"
          : value || "未标记";
  return (
    <>
      {items.length ? (
        <>
          <div className={styles.evidenceSummary}>
            <button
              className={group === "全部" ? styles.evidenceActive : ""}
              onClick={() => {
                setGroup("全部");
                setExpanded(false);
              }}
            >
              <b>{items.length}</b>
              <span>全部证据</span>
            </button>
            {groups
              .filter((label) => (counts.get(label) ?? 0) > 0)
              .map((label) => (
                <button
                  key={label}
                  className={group === label ? styles.evidenceActive : ""}
                  onClick={() => {
                    setGroup(label);
                    setExpanded(false);
                  }}
                >
                  <b>{counts.get(label)}</b>
                  <span>{label}</span>
                </button>
              ))}
          </div>
          {videoUrl ? (
            <div className={styles.evidenceNotice}>
              点击时间码可回看原片；关键证据只保留能够直接支撑剧情结论的事实。
            </div>
          ) : (
            <div className={styles.evidenceNotice}>
              当前素材没有可播放片源，仍可按时间码核对证据。
            </div>
          )}
          <div className={styles.evidenceTimeline}>
            {visible.map((item, index) => {
              const key = item.id ?? String(index),
                original =
                  item.sourceText ||
                  (item.text && !hasChinese(item.text) ? item.text : "");
              return (
                <article key={key}>
                  <div className={styles.evidenceMeta}>
                    <time>
                      {Math.abs(item.end - item.start) < 0.01
                        ? duration(item.start)
                        : `${duration(item.start)}–${duration(item.end)}`}
                    </time>
                    <i>{evidenceGroup(item.kind)}</i>
                  </div>
                  <div className={styles.evidenceCopy}>
                    <small>{evidenceClassLabel(item)}</small>
                    <b>{evidenceMeaning(item)}</b>
                    {item.supports && (
                      <span>
                        <strong>支撑结论：</strong>
                        {item.supports}
                      </span>
                    )}
                    {original && (
                      <details>
                        <summary>查看原始依据</summary>
                        <span lang="auto">{original}</span>
                      </details>
                    )}
                  </div>
                  <div className={styles.evidenceStatus}>
                    <small>
                      {pct(item.confidence)}% ·{" "}
                      {verificationLabel(item.verification)}
                    </small>
                    {videoUrl && (
                      <a
                        href={`${videoUrl}#t=${Math.max(0, item.start)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ▶ 回看片段
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {filtered.length > 12 && (
            <button
              className={styles.evidenceToggle}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded
                ? "收起证据"
                : "展开全部 " + filtered.length + " 条证据"}
            </button>
          )}
        </>
      ) : (
        <InlineEmpty text="没有可展示的证据记录" />
      )}
    </>
  );
}

const verificationLabel = (value?: string) =>
  value === "verified"
    ? "已验证"
    : value === "observed"
      ? "已识别"
      : value === "needs_review"
        ? "待复核"
        : value === "rejected"
          ? "已驳回"
          : "待确认";

type StoryPhase = NonNullable<
  Material["analysisV2"]
>["creative"]["timeline"][number];

const concreteDramaticDrivers = (
  phases: StoryPhase[],
  emotions: MaterialTag[],
  conflicts: MaterialTag[],
) => {
  const usable = phases.filter((phase) => phase.label || phase.description);
  const opening = usable[0],
    middle = usable[Math.min(1, Math.max(0, usable.length - 1))],
    ending = usable.at(-1);
  const emotionLabels = emotions
    .map((tag) => tag.label)
    .filter(Boolean)
    .slice(0, 3);
  const conflictLabels = conflicts
    .map((tag) => tag.label)
    .filter(Boolean)
    .slice(0, 3);
  const emotion =
    opening && ending
      ? `${opening.label}引发人物情绪变化${ending !== opening ? `，${ending.label}进一步抬高紧张感` : ""}${emotionLabels.length ? `，主导情绪为${emotionLabels.join("、")}` : ""}。`
      : emotionLabels.length
        ? `人物的${emotionLabels.join("、")}推动剧情发展，但具体诱因仍需结合原片复核。`
        : "尚未识别出能够说明情绪起因和变化的完整剧情节点。";
  const chain = [opening, middle, ending]
    .filter(
      (phase, index, array): phase is StoryPhase =>
        Boolean(phase) && array.indexOf(phase) === index,
    )
    .map((phase) => phase.label);
  const conflict =
    chain.length >= 2
      ? `${chain.join(" → ")}，形成持续升级的行动与关系冲突${conflictLabels.length ? `（${conflictLabels.join("、")}）` : ""}。`
      : conflictLabels.length
        ? `人物围绕${conflictLabels.join("、")}发生对抗，但目标、阻碍与升级过程仍需复核。`
        : "尚未识别出“人物目标—阻碍—冲突升级”的完整因果链。";
  const verified =
    [...emotions, ...conflicts].some(
      (tag) => tag.verification === "verified",
    ) || usable.some((phase) => phase.verification === "verified");
  return { emotion, conflict, needsReview: !verified };
};

function StoryOverview({
  item,
  phases,
}: {
  item: Material;
  phases: StoryPhase[];
}) {
  const data = item.analysisV2!;
  const [reanalysisQueued, setReanalysisQueued] = useState(false);
  const characters =
    data.content.characters
      .map((tag) => tag.label)
      .slice(0, 4)
      .join("、") || "关键人物待确认";
  const conflicts =
    data.content.conflicts
      .map((tag) => tag.label)
      .slice(0, 3)
      .join("、") || "核心冲突待确认";
  const ending =
    phases.at(-1)?.description || data.content.completeness || "故事落点待确认";
  const summary = data.content.summary
    ? copy(data.content.summary)
    : "当前分析尚未形成完整剧情摘要。";
  const detailedStory = phases
    .map((phase) =>
      copy(phase.description || "")
        .trim()
        .replace(/随后[，、：:]?\s*/gu, ""),
    )
    .filter(Boolean)
    .join("；");
  const story = detailedStory || summary;
  const reanalyze = async () => {
    if (
      reanalysisQueued ||
      !window.confirm(
        `确定重新分析“${item.title}”的剧情吗？\n\n将复用已有抽帧、ASR 和 OCR，只刷新剧情理解与分镜文案。`,
      )
    )
      return;
    try {
      await retryInspirationMaterialAnalysis(item.id, true);
      setReanalysisQueued(true);
    } catch (reason) {
      window.alert(
        reason instanceof Error ? reason.message : "重新分析提交失败",
      );
    }
  };
  return (
    <section
      className={`${styles.v2Section} ${styles.storyOverview} ${styles.analysisVerdict}`}
    >
      <div className={styles.sectionHeading}>
        <div>
          <span>全片剧情理解</span>
          <h2>人物为何行动、冲突如何升级、故事停在哪里</h2>
        </div>
        <div className={styles.storySectionActions}>
          <button
            type="button"
            disabled={reanalysisQueued}
            onClick={() => void reanalyze()}
          >
            {reanalysisQueued ? "已进入分析队列" : "重新分析剧情"}
          </button>
          <em>
            {[
              data.creative.hookAssemblyType?.label,
              data.creative.hookSourceStatus?.label,
            ]
              .filter(Boolean)
              .join(" · ") ||
              data.content.completeness ||
              "剧情结构已同步"}
          </em>
        </div>
      </div>
      <div className={styles.storySynopsis}>
        <p>{story}</p>
      </div>
      <div className={styles.storyMeta}>
        <span>
          <b>核心人物：</b>
          {characters}
        </span>
        <span>
          <b>核心冲突：</b>
          {conflicts}
        </span>
        <span>
          <b>当前结局：</b>
          {copy(ending)}
        </span>
      </div>
      {(data.creative.packaging.length > 0 ||
        data.creative.transitions.length > 0 ||
        (data.creative.hook?.sensoryChannels.length ?? 0) > 0) && (
        <div className={styles.creativeDimensions}>
          {data.creative.packaging.length > 0 && (
            <div>
              <b>包装方式</b>
              <TagList tags={data.creative.packaging} />
            </div>
          )}
          {data.creative.transitions.length > 0 && (
            <div>
              <b>转场方式</b>
              <TagList tags={data.creative.transitions} />
            </div>
          )}
          {(data.creative.hook?.sensoryChannels.length ?? 0) > 0 && (
            <div>
              <b>感官通道</b>
              <TagList tags={data.creative.hook?.sensoryChannels ?? []} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type AnalysisHook = NonNullable<
  NonNullable<Material["analysisV2"]>["creative"]["hook"]
>;
function HookLabelPanel({ hook }: { hook: AnalysisHook }) {
  const unknown = "待补分析",
    info = hook.informationStructure ?? {},
    strength = hook.intensity ?? {};
  const metric = (label: string, value?: number, reverse = false) => (
    <div>
      <span>{label}</span>
      {typeof value === "number" && Number.isFinite(value) ? (
        <>
          <b>{Math.round(value)}</b>
          <i>
            <em
              className={reverse ? styles.metricReverse : ""}
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            />
          </i>
        </>
      ) : (
        <small>{unknown}</small>
      )}
    </div>
  );
  return (
    <div className={styles.hookLabelPanel}>
      <section className={styles.matchSemantics}>
        <header>
          <b>匹配语义</b>
          <span>决定适合接哪类剧情</span>
        </header>
        <dl>
          <div>
            <dt>钩子机制</dt>
            <dd><TagList tags={hook.mechanisms} /></dd>
          </div>
          <div>
            <dt>悬念承诺</dt>
            <dd>{hook.narrativePromise || unknown}</dd>
          </div>
          <div>
            <dt>待兑现信息</dt>
            <dd>{info.unrevealed || hook.informationGap || unknown}</dd>
          </div>
        </dl>
      </section>
      <section className={styles.hookStrength}>
        <header>
          <b>匹配参考</b>
          <span>用于候选排序，不替代投放数据</span>
        </header>
        <div>
          {metric("冲突强度", strength.conflict)}
          {metric("理解门槛", strength.comprehensionBarrier, true)}
          {metric("前三秒刺激度", strength.first3sStimulus)}
        </div>
      </section>
    </div>
  );
}

function HookAnalysisReview({ item }: { item: Material }) {
  const data = item.analysisV2!,
    hook = data.creative.hook;
  const videoRef = useRef<HTMLVideoElement>(null),
    [currentTime, setCurrentTime] = useState(Number(hook?.start) || 0),
    [playing, setPlaying] = useState(false),
    [playbackRate, setPlaybackRate] = useState(1);
  const videoUrl = createInspirationMaterialVideoUrl(item),
    start = Math.max(0, Number(hook?.start) || 0),
    end = Math.max(start, Number(hook?.end) || start);
  const hookLength = Math.max(0, end - start),
    relativeTime = Math.max(0, Math.min(hookLength, currentTime - start));
  const inHook = (evidence: EvidenceItem) =>
    evidence.end >= start && evidence.start <= end;
  const shotCount = data.evidence.filter(
    (evidence) => inHook(evidence) && evidenceGroup(evidence.kind) === "镜头",
  ).length;
  const audioCount = data.evidence.filter(
    (evidence) =>
      inHook(evidence) &&
      (evidenceGroup(evidence.kind) === "音频" ||
        evidenceGroup(evidence.kind) === "对白"),
  ).length;
  const plot =
    copy(hook?.plotSummary || hook?.source || "") ||
    "尚未形成完整的钩子剧情设定。";
  const spoken =
    copy(hook?.spokenSummary || "") ||
    (audioCount
      ? `钩子区间已定位 ${audioCount} 条对白或声音证据，具体声音作用待补充分析。`
      : "钩子区间尚未形成可信的对白或声音结论。");
  const visual =
    copy(hook?.visualSummary || "") ||
    (shotCount
      ? `钩子区间识别到 ${shotCount} 个镜头证据，景别变化与运镜方式待补充分析。`
      : "钩子区间尚未形成可信的画面与运镜结论。");
  const seek = (seconds = start, play = false) => {
    const video = videoRef.current;
    if (!video) return;
    const target = Math.max(start, Math.min(end, seconds));
    video.currentTime = target;
    setCurrentTime(target);
    if (play && target < end) {
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < start || video.currentTime >= end)
        video.currentTime = start;
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };
  const stepFrame = (direction: -1 | 1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setPlaying(false);
    seek(video.currentTime + direction / 25);
  };
  useEffect(() => {
    setCurrentTime(start);
    setPlaying(false);
    const video = videoRef.current;
    if (video && video.readyState >= 1) {
      video.pause();
      video.currentTime = start;
    }
  }, [item.id, start, end]);
  if (!hook)
    return (
      <section className={styles.v2Section}>
        <div className={styles.sectionHeading}>
          <div>
            <span>钩子分析层</span>
            <h2>钩子分析与拉片</h2>
          </div>
        </div>
        <InlineEmpty text="当前素材尚未识别出可独立拉片的钩子区间" />
      </section>
    );
  return (
    <section className={`${styles.v2Section} ${styles.hookAnalysisSection}`}>
      <div className={styles.sectionHeading}>
        <div>
          <span>钩子分析层</span>
          <h2>钩子分析与拉片</h2>
        </div>
        <em>{hook.hookType || "钩子类型待确认"}</em>
      </div>
      <p>点击钩子时间戳定位到开场，结合机制、情绪、信息结构与出口状态逐项核对。</p>
      <div className={styles.hookAnalysisLayout}>
        <div className={styles.hookAnalysisDetails}>
          <div className={styles.hookIdentity}>
            <button type="button" onClick={() => seek(start)}>
              {duration(start)}–{duration(end)}
            </button>
            <div>
              <span>钩子类型</span>
              <b>{hook.hookType || "待确认"}</b>
            </div>
            <div>
              <span>素材归属</span>
              <b>
                {data.creative.hookAssemblyType?.label ||
                  data.creative.hookSourceStatus?.label ||
                  "待确认"}
              </b>
            </div>
          </div>
          <HookLabelPanel hook={hook} />
        </div>
        <aside className={styles.hookAnalysisPlayer}>
          <header>
            <div>
              <b>钩子拉片预览</b>
              <span>同一原片的限定钩子区间</span>
            </div>
            <time>
              {duration(relativeTime)} / {duration(hookLength)}
            </time>
          </header>
          {videoUrl ? (
            <>
              <video
                key={`${item.id}-${start}-${end}`}
                ref={videoRef}
                src={`${videoUrl}#t=${start},${end}`}
                preload="metadata"
                playsInline
                onLoadedMetadata={() => seek(start)}
                onClick={togglePlayback}
                onPause={() => setPlaying(false)}
                onPlay={() => setPlaying(true)}
                onTimeUpdate={(event) => {
                  const video = event.currentTarget,
                    time = video.currentTime;
                  if (time < start) {
                    video.currentTime = start;
                    setCurrentTime(start);
                    return;
                  }
                  if (end > start && time >= end) {
                    video.pause();
                    video.currentTime = end;
                    setCurrentTime(end);
                    setPlaying(false);
                    return;
                  }
                  setCurrentTime(time);
                }}
              />
              <div className={styles.hookRangeControls}>
                <button type="button" onClick={togglePlayback}>
                  {playing ? "❚❚ 暂停" : "▶ 播放钩子"}
                </button>
                <input
                  aria-label="钩子区间进度"
                  type="range"
                  min="0"
                  max={Math.max(0.01, hookLength)}
                  step="0.05"
                  value={relativeTime}
                  onChange={(event) => seek(start + Number(event.target.value))}
                />
                <time>
                  {duration(relativeTime)} / {duration(hookLength)}
                </time>
              </div>
              <div className={styles.hookFrameControls}>
                <button type="button" onClick={() => seek(start)}>
                  ↺ 回到起点
                </button>
                <button type="button" onClick={() => stepFrame(-1)}>
                  ← 上一帧
                </button>
                <button type="button" onClick={() => stepFrame(1)}>
                  下一帧 →
                </button>
                <label>
                  播放速度
                  <select
                    value={playbackRate}
                    onChange={(event) => {
                      const rate = Number(event.target.value);
                      setPlaybackRate(rate);
                      if (videoRef.current) videoRef.current.playbackRate = rate;
                    }}
                  >
                    <option value={0.25}>0.25×</option>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={1.5}>1.5×</option>
                    <option value={2}>2×</option>
                  </select>
                </label>
                <time>原片 {currentTime.toFixed(2)}s</time>
              </div>
            </>
          ) : (
            <InlineEmpty text="当前素材没有可播放片源" />
          )}
        </aside>
      </div>
    </section>
  );
}

const scriptTimeSeconds = (value: string) => {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
};

function FormScriptAnalysis({
  item,
  picker,
}: {
  item: Material;
  picker: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const videoUrl = createInspirationMaterialVideoUrl(item);
  const jumpTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, seconds);
    setCurrentTime(Math.max(0, seconds));
  };
  const renderScript = (script: string) =>
    script.split("\n").map((line, index) => {
      const match = line.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\s*--\s*(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      if (!match) return <span key={index}>{line || "\u00a0"}</span>;
      const start = scriptTimeSeconds(match[1]);
      return (
        <span key={index}>
          {line.slice(0, match.index)}
          <button type="button" onClick={() => jumpTo(start)}>
            {match[0]}
          </button>
          {line.slice((match.index ?? 0) + match[0].length)}
        </span>
      );
    });
  return (
    <div className={styles.analysisV2}>
      {picker}
      <section className={`${styles.v2Section} ${styles.formScriptAnalysis}`}>
        <div className={styles.sectionHeading}>
          <div>
            <span>CSV FORM SOURCE</span>
            <h2>表单原始钩子脚本</h2>
          </div>
          <em>{item.formScriptScenes?.length ?? 0} 场</em>
        </div>
        <p>
          点击脚本时间戳可跳转到原片对应节点；表单内容属于候选证据，尚未经过生产门禁验证。
        </p>
        <div className={styles.formScriptPullLayout}>
          <div className={styles.formScriptLedger}>
            {item.formScriptScenes?.map((scene, index) => (
              <article key={`${scene.sceneNumber}-${index}`}>
                <h3>
                  场景 {scene.sceneNumber || index + 1}
                  {scene.reportedDuration ? ` · ${scene.reportedDuration}` : ""}
                </h3>
                <p>{renderScript(scene.script)}</p>
              </article>
            ))}
          </div>
          <aside className={styles.formScriptPlayer}>
            <header>
              <b>钩子原片拉片</b>
              <time>{currentTime.toFixed(2)}s</time>
            </header>
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                preload="metadata"
                playsInline
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ) : (
              <InlineEmpty text="当前表单记录没有可播放片源" />
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

function Analysis({
  item,
  all,
  onSelect,
  onFactory,
}: {
  item: Material;
  all: Material[];
  onSelect: (id: string) => void;
  onFactory: () => void;
}) {
  const reviewVideoRef = useRef<HTMLVideoElement>(null);
  const [reviewTime, setReviewTime] = useState(0);
  const data = item.analysisV2;
  const picker = (
    <div className={styles.instancePicker}>
      <label>
        分析实例
        <select value={item.id} onChange={(e) => onSelect(e.target.value)}>
          {all.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title} · {analysisLabelForPicker(v)}
            </option>
          ))}
        </select>
      </label>
      <span>
        契约 <b>{data ? "material-v2" : analysisLabelForPicker(item)}</b>
      </span>
      {data && (
        <button className={styles.primary} onClick={onFactory}>
          进入内容工厂 →
        </button>
      )}
    </div>
  );
  if (!data && item.formScriptScenes?.length)
    return <FormScriptAnalysis item={item} picker={picker} />;
  if (!data)
    return (
      <div className={styles.analysisV2}>
        {picker}
        <State
          title={
            item.analysisStatus === "failed"
              ? "该素材分析失败"
              : item.analysisStatus === "running"
                ? "该素材正在分析"
                : item.analysisStatus === "queued"
                  ? "该素材正在排队"
                  : "该素材尚未分析"
          }
          detail={
            item.analysisError ||
            item.analysisStage ||
            "可从跑量素材页打开该素材并提交分析。"
          }
        />
      </div>
    );
  const reviewVideoUrl = createInspirationMaterialVideoUrl(item);
  const seekReviewVideo = (seconds: number) => {
    const video = reviewVideoRef.current;
    if (!video) return;
    const target = Math.max(0, Number(seconds) || 0);
    video.currentTime = target;
    video.pause();
    setReviewTime(target);
  };
  const contentGroups: [string, [string, MaterialTag[]][]][] = [
    [
      "故事定位",
      [
        ["题材", data.content.genres],
        ["主题", data.content.themes],
      ],
    ],
    [
      "人物关系",
      [
        ["人物", data.content.characters],
        ["关系", data.content.relations],
      ],
    ],
    [
      "戏剧动力",
      [
        ["情绪", data.content.emotions],
        ["冲突", data.content.conflicts],
      ],
    ],
    [
      "叙事元素",
      [
        ["情节点", data.content.storyBeats],
        ["场景", data.content.scenes],
      ],
    ],
  ];
  const storyboardPhases = data.creative.timeline,
    storyReviewPhases = data.content.storyboardUnits.length
      ? data.content.storyboardUnits
      : storyboardPhases,
    phases = storyboardPhases.slice(0, 7);
  const dramaticDrivers = concreteDramaticDrivers(
    phases,
    data.content.emotions,
    data.content.conflicts,
  );
  const hook = data.creative.hook,
    hookStart = Number(hook?.start),
    hookEnd = Number(hook?.end);
  const hookPhaseIndex =
    Number.isFinite(hookStart) &&
    Number.isFinite(hookEnd) &&
    hookEnd > hookStart
      ? phases.reduce(
          (best, phase, index) => {
            const overlap = Math.max(
              0,
              Math.min(phase.end, hookEnd) - Math.max(phase.start, hookStart),
            );
            return overlap > best.overlap ? { index, overlap } : best;
          },
          { index: -1, overlap: 0 },
        ).index
      : -1;
  const dimensionCount = contentGroups
    .flatMap(([, dimensions]) => dimensions)
    .filter(
      ([label, tags]) =>
        tags.length ||
        ((label === "情绪" || label === "冲突") && phases.length > 0),
    ).length;
  const storyCoverage =
    phases.length >= 4
      ? `${phases.length} 个因果阶段`
      : `仅识别 ${phases.length} 个阶段 · 全片结构待补足`;
  return (
    <div className={styles.analysisV2}>
      {picker}
      <StoryOverview item={item} phases={storyboardPhases} />
      <HookAnalysisReview item={item} />
      <section className={styles.v2Section}>
        <div className={styles.sectionHeading}>
          <div>
            <span>剧情拉片层</span>
            <h2>按剧情节点核对原片</h2>
          </div>
          <em>{storyReviewPhases.length} 个剧情节点</em>
        </div>
        <p>
          点击左侧剧情时间码，右侧播放器会定位到对应画面；可继续拖动进度条逐段拉片。
        </p>
        <div className={styles.factReviewLayout}>
          <div className={styles.factReviewLedgers}>
            {storyReviewPhases.length ? (
              <div
                className={`${styles.storyBeatLedger} ${styles.storyReviewLedger}`}
              >
                <header>
                  <div>
                    <b>分段剧情时间线</b>
                    <span>人物行动 · 冲突推进 · 直接结果</span>
                  </div>
                </header>
                {storyReviewPhases.map((phase, index) => (
                  <article key={`${phase.code}-${index}`}>
                    <i>{index + 1}</i>
                    <button
                      type="button"
                      className={styles.factTimecode}
                      onClick={() => seekReviewVideo(phase.start)}
                      aria-label={`定位到${duration(phase.start)}`}
                    >
                      {duration(phase.start)}–{duration(phase.end)}
                    </button>
                    <div>
                      <b>{phase.label}</b>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <InlineEmpty text="事件账本尚未形成可拉片的剧情时间线，请重新分析剧情" />
            )}
          </div>
          <aside className={styles.factReviewPlayer}>
            <header>
              <div>
                <b>拉片预览</b>
                <span>点击左侧剧情时间码定位</span>
              </div>
              <time>{duration(reviewTime)}</time>
            </header>
            {reviewVideoUrl ? (
              <video
                ref={reviewVideoRef}
                src={reviewVideoUrl}
                controls
                preload="metadata"
                playsInline
                onTimeUpdate={(event) =>
                  setReviewTime(event.currentTarget.currentTime)
                }
              />
            ) : (
              <InlineEmpty text="当前素材没有可播放片源" />
            )}
          </aside>
        </div>
      </section>
      <section className={styles.v2Section}>
        <div className={styles.sectionHeading}>
          <div>
            <span>内容标签层</span>
            <h2>素材内容理解</h2>
          </div>
          <em>{dimensionCount}/8 个维度有结论</em>
        </div>
        <p>
          按“故事定位 → 人物关系 → 戏剧动力 →
          叙事元素”组织；识别质量、语种和技术分段不会作为故事标签展示。
        </p>
        <div className={styles.contentLogic}>
          {contentGroups.map(([group, dimensions]) => (
            <article key={group}>
              <h3>{group}</h3>
              {group === "戏剧动力" ? (
                <div className={styles.dramaticDrivers}>
                  <div>
                    <b>情绪动力</b>
                    <p>{dramaticDrivers.emotion}</p>
                  </div>
                  <div>
                    <b>冲突动力</b>
                    <p>{dramaticDrivers.conflict}</p>
                  </div>
                </div>
              ) : (
                dimensions.map(([label, tags]) => (
                  <div key={label}>
                    <b>{label}</b>
                    <TagList tags={tags} />
                  </div>
                ))
              )}
            </article>
          ))}
        </div>
        {phases.length > 0 && (
          <div className={styles.storyBeatLedger}>
            <header>
              <div>
                <b>全片因果情节点</b>
                <span>人物目标 → 具体事件 → 结果/关系变化</span>
              </div>
              <em
                className={
                  phases.length >= 4
                    ? styles.coverageReady
                    : styles.coverageReview
                }
              >
                {storyCoverage}
              </em>
            </header>
            {phases.map((phase, index) => (
              <article
                className={index === hookPhaseIndex ? styles.hookBeat : ""}
                key={`${phase.code}-${index}`}
              >
                <i>{index + 1}</i>
                <time>
                  {duration(phase.start)}–{duration(phase.end)}
                </time>
                <div>
                  <b>
                    {phase.label}
                    {index === hookPhaseIndex && (
                      <span className={styles.hookBadge}>钩子</span>
                    )}
                  </b>
                  <p>
                    {phase.description ||
                      "该节点缺少具体事件与结果，需要重新分析。"}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
        {!contentGroups.some(([, dimensions]) =>
          dimensions.some(([, tags]) => tags.length),
        ) &&
          !phases.length && (
            <InlineEmpty text="没有可信的故事结论，请退回重分析" />
          )}
      </section>
      {(data.value.scores.length > 0 ||
        data.value.inspirations.length > 0 ||
        data.value.avoid.length > 0) && (
        <section className={styles.v2Section}>
          <h2>灵感与复用价值</h2>
          {data.value.scores.length > 0 && (
            <div className={styles.scoreGrid}>
              {data.value.scores.map((v) => (
                <article key={v.code}>
                  <span>{v.label}</span>
                  <strong>{Math.round(v.score)}</strong>
                  <i>
                    <em
                      style={{
                        width: `${Math.max(0, Math.min(100, v.score))}%`,
                      }}
                    />
                  </i>
                  <small>{v.reason || "无评分说明"}</small>
                </article>
              ))}
            </div>
          )}
          <div className={styles.adviceGrid}>
            {data.value.inspirations.length > 0 && (
              <Advice title="值得借鉴" items={data.value.inspirations} />
            )}{" "}
            {data.value.avoid.length > 0 && (
              <Advice title="不建议复制" items={data.value.avoid} />
            )}{" "}
            {data.value.suitableGenres.length > 0 && (
              <Advice title="适合题材" items={data.value.suitableGenres} />
            )}{" "}
            {data.value.suitableAudiences.length > 0 && (
              <Advice title="适合受众" items={data.value.suitableAudiences} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function HookReview({
  hooks,
  selectedId,
  onSelect,
  onSaved,
  flash,
}: {
  hooks: HookAsset[];
  selectedId: string;
  onSelect: (id: string) => void;
  onSaved: () => void;
  flash: (message: string) => void;
}) {
  const selected = hooks.find((hook) => hook.id === selectedId) ?? hooks[0];
  const [localHook, setLocalHook] = useState(selected),
    [note, setNote] = useState(""),
    [saving, setSaving] = useState(false),
    [reviewStart, setReviewStart] = useState(selected?.start ?? 0),
    [reviewEnd, setReviewEnd] = useState(selected?.end ?? 0);
  useEffect(() => {
    if (!selected) return;
    setLocalHook(selected);
    setReviewStart(selected.start);
    setReviewEnd(selected.end);
    setNote("");
  }, [selected?.id, selected?.boundaryStatus, selected?.reviewStatus]);
  if (!localHook)
    return (
      <State
        title="钩子不存在"
        detail="该钩子可能已被删除，请返回钩子原型页重新选择。"
      />
    );
  const submit = async (status: "approved" | "rejected") => {
    setSaving(true);
    try {
      const updated = await reviewHookBoundary(
        localHook.id,
        status,
        note,
        status === "approved"
          ? { start: reviewStart, end: reviewEnd }
          : undefined,
      );
      setLocalHook(updated);
      setReviewStart(updated.start);
      setReviewEnd(updated.end);
      setNote("");
      flash(
        status === "approved"
          ? "钩子边界已通过并持久保存"
          : "钩子已驳回并持久保存",
      );
      onSaved();
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "钩子复核保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={`${styles.reviewV2} ${styles.hookReviewWorkspace}`}>
      <aside>
        <div className={styles.reviewScope}>
          <b>钩子人工复核</b>
          <small>所有工作区成员均可操作</small>
        </div>
        {hooks.map((hook) => (
          <button
            className={hook.id === localHook.id ? styles.selected : ""}
            key={hook.id}
            onClick={() => onSelect(hook.id)}
          >
            <b>{hook.title}</b>
            <small>
              {hook.boundaryStatus === "verified" &&
              hook.reviewStatus === "approved"
                ? "已通过"
                : "待复核"}{" "}
              · {duration(hook.start)}–{duration(hook.end)}
            </small>
          </button>
        ))}
      </aside>
      <section>
        <div className={styles.hookReviewHeading}>
          <div>
            <span>钩子原型 / 人工复核</span>
            <h2>{localHook.title}</h2>
            <p>
              {localHook.materialTitle || "来源待补充"} · 当前区间{" "}
              {duration(localHook.start)}–{duration(localHook.end)}
            </p>
          </div>
          <em
            className={
              localHook.boundaryStatus === "verified"
                ? styles.hookVerified
                : styles.hookNeedsReview
            }
          >
            {localHook.boundaryStatus === "verified" &&
            localHook.reviewStatus === "approved"
              ? "复核已通过"
              : localHook.reviewStatus === "rejected"
                ? "已驳回"
                : "等待复核"}
          </em>
        </div>
        {localHook.materialVideoUrl ? (
          <video
            className={styles.hookReviewVideo}
            src={`${localHook.materialVideoUrl}#t=${reviewStart},${reviewEnd}`}
            controls
            preload="metadata"
            playsInline
          />
        ) : (
          <InlineEmpty text="当前钩子没有可播放片源，请按证据与时间码复核" />
        )}
        <div className={styles.hookReviewEvidence}>
          <article>
            <span>对白边界</span>
            <b>
              {localHook.safeStart?.dialogueStatus || "未验证"} →{" "}
              {localHook.safeEnd?.dialogueStatus || "未验证"}
            </b>
          </article>
          <article>
            <span>动作边界</span>
            <b>
              {localHook.safeStart?.actionStatus || "未验证"} →{" "}
              {localHook.safeEnd?.actionStatus || "未验证"}
            </b>
          </article>
          <article>
            <span>镜头边界</span>
            <b>
              {localHook.safeStart?.shotStatus || "未验证"} →{" "}
              {localHook.safeEnd?.shotStatus || "未验证"}
            </b>
          </article>
        </div>
        <div className={styles.hookReviewRange}>
          <label>
            起点（秒）
            <input
              aria-label="钩子复核起点"
              type="number"
              min="0"
              step="0.01"
              value={reviewStart}
              onChange={(event) => setReviewStart(Number(event.target.value))}
            />
          </label>
          <label>
            终点（秒）
            <input
              aria-label="钩子复核终点"
              type="number"
              min="0"
              step="0.01"
              value={reviewEnd}
              onChange={(event) => setReviewEnd(Number(event.target.value))}
            />
          </label>
          <span>
            区间长度 {formatDurationZh(Math.max(0, reviewEnd - reviewStart), 2)}
            （允许 0分5秒–1分0秒）
          </span>
        </div>
        <label className={styles.reviewNote}>
          复核依据
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="说明对白、动作、镜头是否完整，以及调整边界的依据"
          />
        </label>
        <div className={styles.reviewActions}>
          <button
            type="button"
            disabled={saving || !note.trim()}
            onClick={() => void submit("rejected")}
          >
            驳回钩子
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={
              saving ||
              !note.trim() ||
              reviewStart < 0 ||
              reviewEnd <= reviewStart ||
              reviewEnd - reviewStart < 5 ||
              reviewEnd - reviewStart > 60
            }
            onClick={() => void submit("approved")}
          >
            {saving ? "保存中…" : "确认边界并通过"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Review({
  items,
  onSaved,
  flash,
}: {
  items: Material[];
  onSaved: () => void;
  flash: (s: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? ""),
    [note, setNote] = useState(""),
    [saving, setSaving] = useState(false);
  const item = items.find((v) => v.id === selectedId) ?? items[0];
  const uncertain = [...(item.analysisV2?.review.items ?? [])];
  for (const group of Object.values(item.analysisV2?.content ?? {})) {
    if (Array.isArray(group))
      for (const tag of group as MaterialTag[])
        if (
          tag.verification === "needs_review" &&
          !uncertain.some((v) => v.id === tag.code)
        )
          uncertain.push({
            id: tag.code,
            field: "content",
            label: tag.label,
            reason: "模型标记为待复核",
            confidence: tag.confidence,
          });
  }
  const submit = async (status: "已通过" | "已修改" | "退回重分析") => {
    setSaving(true);
    try {
      await submitInspirationReview(item.id, status, note);
      flash(
        status === "退回重分析" ? "已退回并重新入队" : "复核结果已持久保存",
      );
      onSaved();
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={styles.reviewV2}>
      <aside>
        {items.map((v) => (
          <button
            className={v.id === item.id ? styles.selected : ""}
            key={v.id}
            onClick={() => setSelectedId(v.id)}
          >
            <b>{v.title}</b>
            <small>{v.analysisV2?.review.items.length ?? 0} 个待确认项</small>
          </button>
        ))}
      </aside>
      <section>
        <h2>人工复核</h2>
        <p>只复核证据不足、不确定或冲突的标签。</p>
        {uncertain.length ? (
          <div className={styles.reviewItems}>
            {uncertain.map((v) => (
              <article key={v.id}>
                <b>{v.label}</b>
                <span>{v.reason || v.field}</span>
                {typeof v.confidence === "number" &&
                  Number.isFinite(v.confidence) && (
                    <small>置信度 {pct(v.confidence)}%</small>
                  )}
                {v.proposedValue && <em>建议：{v.proposedValue}</em>}
              </article>
            ))}
          </div>
        ) : (
          <InlineEmpty text="模型未列出具体待复核标签，可直接确认整体结果" />
        )}
        <label className={styles.reviewNote}>
          复核说明
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="记录修改依据或退回原因"
          />
        </label>
        <div className={styles.reviewActions}>
          <button disabled={saving} onClick={() => void submit("退回重分析")}>
            退回重分析
          </button>
          <button disabled={saving} onClick={() => void submit("已修改")}>
            修改后通过
          </button>
          <button
            className={styles.primary}
            disabled={saving}
            onClick={() => void submit("已通过")}
          >
            确认通过
          </button>
        </div>
      </section>
    </div>
  );
}

function Upload({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (item: Material) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [progress, setProgress] = useState(0),
    [stage, setStage] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!file) {
      setError("请选择视频文件");
      return;
    }
    if (file.size === 0) {
      setError("视频文件为空，请重新选择");
      return;
    }
    setSaving(true);
    setError("");
    setProgress(0);
    try {
      const form = new FormData(formElement);
      setStage("正在校验视频");
      const [videoDuration, contentHash] = await Promise.all([
        readVideoDuration(file),
        hashInspirationVideo(file),
      ]);
      const duplicate = await findInspirationMaterialByHash(contentHash);
      if (duplicate)
        throw new Error(
          `该视频已入库：${duplicate.title}（${duplicate.captured || "已有记录"}）`,
        );
      const sourceUrl = String(form.get("sourceUrl") || "").trim();
      if (sourceUrl) {
        try {
          new URL(sourceUrl);
        } catch {
          throw new Error("原始素材链接格式不正确");
        }
      }
      const input = {
        title: String(form.get("title") || file.name.replace(/\.[^.]+$/, "")),
        type: String(form.get("type")) as InspirationMaterialType,
        source: "外部" as const,
        platform: String(form.get("platform") || "手动上传"),
        market: String(form.get("market") || "未知市场"),
        language: String(form.get("language") || "未知语种"),
        theme: String(form.get("theme") || "待分析"),
        exposure: Math.max(0, Number(form.get("exposure") || 0)),
        days: Math.max(0, Number(form.get("days") || 0)),
        duration: videoDuration,
        contentHash,
        sourceUrl,
        rightsStatus: String(form.get("rightsStatus") || "仅限内部分析"),
      };
      setStage("正在上传并创建分析任务");
      onSaved(await saveInspirationMaterial(input, file, setProgress));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材保存失败");
      setSaving(false);
      setStage("");
    }
  };
  return (
    <div className={styles.modalBackdrop}>
      <form className={styles.uploadModal} onSubmit={submit}>
        <header>
          <div>
            <span className={styles.eyebrow}>MATERIAL INTAKE</span>
            <h2>买量素材入库</h2>
          </div>
          <button type="button" disabled={saving} onClick={onClose}>
            ×
          </button>
        </header>
        <div className={styles.uploadFields}>
          <label className={styles.fullField}>
            视频文件
            <input
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              required
              disabled={saving}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setError("");
              }}
            />
            <small>
              {file
                ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
                : `支持 MP4、MOV、WebM；入库前自动校验可播放性与重复内容`}
            </small>
          </label>
          <label>
            素材标题
            <input name="title" placeholder="默认使用文件名" />
          </label>
          <label>
            素材类型
            <select name="type" defaultValue="未确定">
              <option>未确定</option>
              <option>正片剧集拼接</option>
              <option>正片剧集解说</option>
              <option>外搭钩子＋本剧正片</option>
            </select>
          </label>
          <label>
            平台
            <input name="platform" placeholder="Meta / TikTok / YouTube" />
          </label>
          <label>
            市场
            <input name="market" placeholder="美国、巴西等" />
          </label>
          <label>
            语种
            <input name="language" placeholder="英语、西班牙语等" />
          </label>
          <label>
            题材
            <input name="theme" placeholder="可留空，等待 AI 识别" />
          </label>
          <label>
            真实曝光量
            <input name="exposure" type="number" min="0" />
          </label>
          <label>
            真实跑量天数
            <input name="days" type="number" min="0" />
          </label>
          <label className={styles.fullField}>
            原始素材链接
            <input
              name="sourceUrl"
              type="url"
              placeholder="https://...（可选，用于来源追溯）"
            />
          </label>
          <label className={styles.fullField}>
            授权状态
            <select name="rightsStatus" defaultValue="仅限内部分析">
              <option>仅限内部分析</option>
              <option>授权待确认</option>
              <option>已获授权可制作</option>
              <option>已获授权可投放</option>
            </select>
            <small>授权未确认的素材只能用于内部分析，不能直接进入投放。</small>
          </label>
        </div>
        {saving && (
          <div className={styles.uploadProgress} role="status">
            <div>
              <span>{stage}</span>
              <b>{progress}%</b>
            </div>
            <i>
              <em style={{ width: `${progress}%` }} />
            </i>
          </div>
        )}
        {error && <p className={styles.uploadError}>{error}</p>}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button className={styles.primary} disabled={saving}>
            {saving ? "正在入库…" : "校验并加入分析队列"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function TagList({ tags }: { tags: MaterialTag[] }) {
  return tags.length ? (
    <div className={styles.v2Tags}>
      {tags.map((tag, i) => {
        const scored = Number.isFinite(tag.confidence),
          verified = tag.verification === "verified";
        return (
          <span
            className={verified ? "" : styles.tagNeedsReview}
            key={`${tag.code}-${i}`}
            title={
              scored ? `置信度 ${pct(tag.confidence)}%` : "模型未提供置信度"
            }
          >
            {tag.label}
            {verified && scored && <small>{pct(tag.confidence)}%</small>}
          </span>
        );
      })}
    </div>
  ) : (
    <small className={styles.dimensionEmpty}>暂无可信结论</small>
  );
}
function Advice({ title, items }: { title: string; items: string[] }) {
  return (
    <article>
      <b>{title}</b>
      {items.length ? (
        <ul>
          {items.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
      ) : (
        <small>暂无真实结论</small>
      )}
    </article>
  );
}
function InlineEmpty({ text }: { text: string }) {
  return <div className={styles.inlineEmpty}>{text}</div>;
}
function State({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.statePanel}>
      <i>◇</i>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

export default InspirationWorkspace;
