"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createInitialFactoryWorkflow, factoryModes } from "./mock-data";
import type { Draft, FactoryMode, FactoryWorkspaceProps } from "./types";
import ExternalHookAnalysis, {
  type ExternalHookTimelineClip,
  type HookEpisodeMatch,
  type HookTransitionOption,
  type ExternalHookQualityReport,
} from "./components/ExternalHookAnalysis";
import ExternalHookDelivery from "./components/ExternalHookDelivery";
import baseStyles from "./factory.module.css";
import enhancementStyles from "./factory-enhancements.module.css";

const styles = { ...baseStyles, ...enhancementStyles };
// PRODUCTION WORKFLOW: legacy modes keep 生产目标、正片承接段、钩子匹配、过渡生成、组合版本、统一质检；外搭模式使用新的八步闭环。

const padEpisode = (episode: number) => `EP ${String(episode).padStart(2, "0")}`;
const timecode = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function selectedRange(episodes: number[]) {
  if (!episodes.length) return "未选择片源";
  return episodes.map(padEpisode).join("、");
}

export function FactoryWorkspace({ initialMode = "episode-splice", editingDraft, sourceContext, dramaSourceContext, hookSourceContext, onChooseDrama, onChooseHook, onDraftAutoSave, onOpenDrafts, onNotify }: FactoryWorkspaceProps) {
  const legacySource = sourceContext ?? editingDraft?.sourceContext ?? null;
  const dramaSource = dramaSourceContext ?? (legacySource?.kind === "library" ? legacySource : null);
  const hookSourceInput = hookSourceContext ?? editingDraft?.hookSourceContext ?? (legacySource?.kind === "favorite" || legacySource?.kind === "inspiration" ? legacySource : null);
  const [mode, setMode] = useState<FactoryMode>(editingDraft?.mode ?? initialMode);
  const source = mode === "external-hook" ? dramaSource : legacySource;
  const [language, setLanguage] = useState(editingDraft?.language ?? source?.language ?? "英语");
  const [ratio, setRatio] = useState<Draft["ratio"]>(editingDraft?.ratio ?? "9:16");
  const [title, setTitle] = useState(editingDraft?.title ?? "");
  const mediaEntries = useMemo(() => Object.values(source?.episodeMedia ?? {}).sort((a, b) => a.episode - b.episode), [source]);
  const connectedEpisodes = useMemo(() => mediaEntries.filter((item) => Boolean(item.url)).map((item) => item.episode), [mediaEntries]);
  const [episodes, setEpisodes] = useState<number[]>(() => editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode)) ?? connectedEpisodes);
  const [previewEpisode, setPreviewEpisode] = useState<number | null>(() => episodes[0] ?? null);
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "尚未保存");
  const [autoSaveCountdown, setAutoSaveCountdown] = useState(15);
  const [, setDirty] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [goal, setGoal] = useState("停滑与点击");
  const [entryStrategy, setEntryStrategy] = useState("最快理解");
  const [hookSource, setHookSource] = useState("同题材高表现钩子");
  const [transition, setTransition] = useState("时间倒叙旁白");
  const [variantCount, setVariantCount] = useState(6);
  const [qualityConfirmed, setQualityConfirmed] = useState(false);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string>();
  const [selectedTransitionId, setSelectedTransitionId] = useState("bridge-narration");
  const [timeline, setTimeline] = useState<ExternalHookTimelineClip[]>([]);
  const [draftId] = useState(() => editingDraft?.id ?? `draft-${Date.now()}`);
  const autoSaveSecondsRef = useRef(15);
  const definition = factoryModes.find((item) => item.id === mode)!;
  const previewMedia = previewEpisode == null ? undefined : source?.episodeMedia?.[previewEpisode];
  const availableWithoutConnection = (source?.availableEpisodes ?? []).filter((episode) => !source?.episodeMedia?.[episode]?.url);
  const canCreate = Boolean(source?.kind === "library" && episodes.length && episodes.every((episode) => source.episodeMedia?.[episode]?.url));
  const externalReady = Boolean(dramaSource && hookSourceInput);
  const steps = mode === "external-hook" ? definition.steps : ["生产目标", "正片承接段", "钩子匹配", "过渡生成", "组合版本", "统一质检"];
  const stepReady = mode === "external-hook"
    ? [Boolean(dramaSource && episodes.length), Boolean(hookSourceInput), Boolean(selectedRecommendationId || dramaSource?.highlightCandidates?.length), Boolean(selectedTransitionId), Boolean(timeline.length || (hookSourceInput && dramaSource?.highlightCandidates?.length)), qualityConfirmed, false, false]
    : [Boolean(goal), episodes.length > 0, Boolean(hookSource), Boolean(transition), variantCount > 0, qualityConfirmed];

  const match = useMemo<HookEpisodeMatch>(() => {
    const recommendations = (dramaSource?.highlightCandidates ?? [])
      .filter((item) => !episodes.length || episodes.includes(item.episode))
      .map((item) => ({
        id: String(item.id), title: item.title, episode: item.episode,
        startTimecode: timecode(item.start), endTimecode: timecode(item.end),
        startFrame: dramaSource?.episodeMedia?.[item.episode]?.fps == null ? undefined : Math.round(item.start * (dramaSource.episodeMedia[item.episode]?.fps ?? 0)), fps: dramaSource?.episodeMedia?.[item.episode]?.fps,
        rationale: item.evidence ?? item.event ?? "来自本剧真实高光解析结果。",
        relationship: "等待人物关系匹配服务返回", conflict: item.event ?? "高光事件", emotion: item.emotion ?? "待分析",
        evidence: item.evidence ? [{ id: `e-${item.id}`, dimension: "情节" as const, hookEvidence: hookSourceInput?.description ?? hookSourceInput?.title ?? "已选外搭钩子", episodeEvidence: item.evidence }] : [],
        risks: ["钩子与正片的承诺兑现仍需匹配服务复核"],
      }));
    return {
      hookTitle: hookSourceInput?.title ?? "尚未选择外搭钩子",
      episodeTitle: dramaSource?.dramaCn ?? dramaSource?.title ?? "尚未选择本剧正片",
      status: recommendations.length ? "completed" : "idle",
      recommendations,
      selectedRecommendationId,
    };
  }, [dramaSource, episodes, hookSourceInput, selectedRecommendationId]);

  const transitionOptions = useMemo<HookTransitionOption[]>(() => [
    { id: "bridge-narration", title: "因果解释旁白", type: "旁白承接", durationSeconds: 2.8, copy: "而这一切，要从她推开那扇门说起。", rationale: "用最少信息交代外搭事件与本剧正片之间的因果关系。", spoilerRisk: "低" },
    { id: "bridge-action", title: "同动作匹配", type: "同动作匹配", durationSeconds: 1.2, rationale: "以钩子末帧动作方向匹配正片首帧，减少视觉跳变。", spoilerRisk: "低" },
    { id: "bridge-audio", title: "声音桥接", type: "声音桥接", durationSeconds: 1.8, rationale: "提前进入正片环境音或关键台词，建立下一场景预期。", spoilerRisk: "中" },
  ], []);

  const effectiveRecommendationId = selectedRecommendationId ?? match.recommendations[0]?.id;
  const selectedRecommendation = match.recommendations.find((item) => item.id === effectiveRecommendationId) ?? match.recommendations[0];
  const selectedTransition = transitionOptions.find((item) => item.id === selectedTransitionId) ?? transitionOptions[0];
  const qualityReport = useMemo<ExternalHookQualityReport>(() => {
    const findings: ExternalHookQualityReport["findings"] = [];
    if (!dramaSource) findings.push({ id: "drama", severity: "阻断", category: "连续性", title: "尚未选择本剧正片", detail: "需要从剧库带入真实剧目与片源。" });
    if (!hookSourceInput) findings.push({ id: "hook", severity: "阻断", category: "首帧", title: "尚未选择外搭钩子", detail: "需要从收藏或灵感大屏带入钩子素材。" });
    if (dramaSource && hookSourceInput && !selectedRecommendation) findings.push({ id: "match", severity: "阻断", category: "承诺兑现", title: "没有可追溯的高光承接点", detail: "请先完成本剧高光解析，匹配必须对应到具体集数和帧。" });
    if (selectedRecommendation) findings.push({ id: "evidence", severity: "建议", category: "货不对板", title: "匹配结论等待服务复核", detail: "当前仅使用真实高光时间码建立承接点，人物、矛盾和承诺兑现仍需匹配服务输出。", suggestion: "运行钩子—正片匹配分析" });
    return { status: "completed", verdict: findings.some((item) => item.severity === "阻断") ? "阻断" : "建议优化", findings };
  }, [dramaSource, hookSourceInput, selectedRecommendation]);

  const defaultTimeline = useMemo<ExternalHookTimelineClip[]>(() => {
    if (!selectedRecommendation || !hookSourceInput) return [];
    return [
      { id: "clip-hook", kind: "hook", title: hookSourceInput.title, sourceLabel: hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏", durationSeconds: 6 },
      { id: "clip-transition", kind: "transition", title: selectedTransition.title, sourceLabel: "过渡设计", durationSeconds: selectedTransition.durationSeconds },
      { id: "clip-episode", kind: "episode", title: selectedRecommendation.title, sourceLabel: dramaSource?.dramaCn ?? dramaSource?.title ?? "本剧正片", durationSeconds: 24, episode: selectedRecommendation.episode, startTimecode: selectedRecommendation.startTimecode, endTimecode: selectedRecommendation.endTimecode },
    ];
  }, [dramaSource, hookSourceInput, selectedRecommendation, selectedTransition]);
  const visibleTimeline = timeline.length ? timeline : defaultTimeline;

  const buildDraft = (): Draft => {
    const workflow = createInitialFactoryWorkflow();
    workflow.currentStep = workflow.steps[activeStep]?.id ?? "episode-source";
    workflow.goal = {
      objective: goal === "停滑与点击" ? "click-through" : goal === "连续观看" ? "completion" : "conversion",
      market: "美国",
      language,
      platform: "Meta",
      ratio,
      targetDurationSeconds: 90,
      plannedVariantCount: variantCount,
      aiGenerationAllowed: hookSource === "新生成钩子",
      intensity: "balanced",
    };
    workflow.steps = workflow.steps.map((step, index) => ({ ...step, state: index < activeStep ? "completed" : index === activeStep ? "active" : stepReady[index] ? "ready" : "locked" }));
    workflow.qualityReport = { status: qualityConfirmed ? "available" : "not-connected", findings: [] };
    return ({
    id: draftId,
    title: title.trim() || `${source?.dramaCn ?? source?.dramaTitle ?? source?.title ?? "未命名项目"} · ${definition.name}`,
    mode,
    drama: source?.dramaTitle ?? source?.title ?? "未关联剧目",
    hook: hookSourceInput?.title ?? (source?.kind === "favorite" || source?.kind === "inspiration" ? source.title : ""),
    episodeRange: selectedRange(episodes),
    transition: mode === "external-hook" ? selectedTransition.title : "未设置",
    language,
    duration: episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) > 0
      ? `${Math.floor(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) / 60)}:${String(Math.round(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) % 60)).padStart(2, "0")}`
      : "未生成",
    ratio,
    qualityStatus: "建议优化后生成",
    updatedAt: "刚刚",
    autoSaved: true,
    thumbnailTone: mode === "external-hook" ? "blue" : mode === "episode-narration" ? "violet" : "rose",
    thumbnailUrl: episodes.map((episode) => source?.episodeMedia?.[episode]?.url).find(Boolean),
    progress: 0,
    productionStatus: "编辑中",
    version: editingDraft?.version ?? 1,
    sourceContext: source,
    hookSourceContext: hookSourceInput,
    selectedEpisodes: episodes,
    workflow,
  });
  };

  const save = (silent = false) => {
    if (!source && !hookSourceInput) {
      if (!silent) onNotify?.("请先选择本剧正片或外搭钩子");
      return;
    }
    const draft = buildDraft();
    onDraftAutoSave?.(draft);
    setSavedAt("刚刚自动保存");
    autoSaveSecondsRef.current = 15;
    setAutoSaveCountdown(15);
    setDirty(false);
    if (!silent) onNotify?.("制作草稿已保存到「我的创作」");
  };

  const latestSaveRef = useRef(save);
  useEffect(() => { latestSaveRef.current = save; });

  useEffect(() => {
    if (!source) return;
    autoSaveSecondsRef.current = 15;
    const timer = window.setInterval(() => {
      autoSaveSecondsRef.current -= 1;
      if (autoSaveSecondsRef.current <= 0) {
        latestSaveRef.current(true);
        autoSaveSecondsRef.current = 15;
      }
      setAutoSaveCountdown(autoSaveSecondsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [source, hookSourceInput?.id]);

  const touch = () => setDirty(true);
  const toggleEpisode = (episode: number) => {
    setEpisodes((current) => current.includes(episode) ? current.filter((item) => item !== episode) : [...current, episode].sort((a, b) => a - b));
    touch();
  };

  useEffect(() => {
    const timer=window.setTimeout(()=>{const validEpisodes = editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode));setEpisodes(validEpisodes?.length ? validEpisodes : connectedEpisodes);setPreviewEpisode(connectedEpisodes[0] ?? null)},0);
    return()=>window.clearTimeout(timer);
    // Reset media state when the source identity changes; connectedEpisodes is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  useEffect(() => {
    const timer=window.setTimeout(()=>{if (!connectedEpisodes.length) {setPreviewEpisode(null);return}if (previewEpisode == null || !connectedEpisodes.includes(previewEpisode)) setPreviewEpisode(connectedEpisodes[0])},0);
    return()=>window.clearTimeout(timer);
  }, [connectedEpisodes, previewEpisode]);

  const moveTimelineClip = (clipId: string, direction: "backward" | "forward") => {
    setTimeline((current) => {
      const base = current.length ? current : defaultTimeline;
      const index = base.findIndex((clip) => clip.id === clipId);
      const target = index + (direction === "backward" ? -1 : 1);
      if (index < 0 || target < 0 || target >= base.length) return base;
      const next = [...base]; [next[index], next[target]] = [next[target], next[index]]; return next;
    });
    touch();
  };

  const externalWorkflow = <section className={styles.externalWorkflow} aria-label="外搭钩子与本剧正片制作流程">
    <div className={styles.dualSourceHeader}><div><span>DUAL SOURCE</span><h2>双素材槽位</h2><p>先准备本剧正片与外搭钩子，再基于真实高光时间码完成匹配和制作。</p></div><strong>{Number(Boolean(dramaSource)) + Number(Boolean(hookSourceInput))} / 2 已就绪</strong></div>
    <div className={styles.dualSourceGrid}>
      <article className={dramaSource ? styles.sourceSlotReady : styles.sourceSlotEmpty}>
        <header><i>01</i><span><small>本剧正片</small><b>{dramaSource?.dramaCn ?? dramaSource?.title ?? "尚未选择"}</b></span><em>{dramaSource ? "✓ 已带入" : "必填"}</em></header>
        {dramaSource ? <><p>{dramaSource.description ?? `${dramaSource.genre ?? "未填写题材"} · ${dramaSource.language ?? "未填写语种"}`}</p><dl><div><dt>可用片源</dt><dd>{connectedEpisodes.length} 集</dd></div><div><dt>已选</dt><dd>{episodes.length} 集</dd></div><div><dt>高光</dt><dd>{dramaSource.highlightCandidates?.length ?? 0} 个</dd></div></dl></> : <p>从剧库选择已上传真实视频、并完成高光解析的本剧正片。</p>}
        <button type="button" onClick={onChooseDrama}>{dramaSource ? "更换本剧正片" : "＋ 从剧库选择正片"}</button>
      </article>
      <article className={hookSourceInput ? styles.sourceSlotReady : styles.sourceSlotEmpty}>
        <header><i>02</i><span><small>外搭钩子</small><b>{hookSourceInput?.title ?? "尚未选择"}</b></span><em>{hookSourceInput ? "✓ 已带入" : "必填"}</em></header>
        {hookSourceInput ? <><p>{hookSourceInput.description ?? "已保留素材来源与钩子分析关联。"}</p><dl><div><dt>来源</dt><dd>{hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏"}</dd></div><div><dt>语种</dt><dd>{hookSourceInput.language ?? "待识别"}</dd></div><div><dt>授权</dt><dd>待确认</dd></div></dl></> : <p>从我的收藏或灵感大屏选择一个可追溯来源的外搭钩子。</p>}
        <button type="button" onClick={onChooseHook}>{hookSourceInput ? "更换外搭钩子" : "＋ 选择匹配外搭钩子"}</button>
      </article>
    </div>

    <nav className={styles.externalSteps} aria-label="外搭钩子制作步骤">{steps.map((step, index) => <button type="button" key={step} className={`${activeStep === index ? styles.externalStepActive : ""} ${stepReady[index] ? styles.externalStepDone : ""}`} onClick={() => setActiveStep(index)}><i>{stepReady[index] ? "✓" : index + 1}</i><span>{step}</span></button>)}</nav>

    <div className={styles.externalStepBody}>
      {activeStep === 0 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>01</span><h2>选择本剧正片</h2></div><small>仅使用已连接的真实视频片源</small></div>
        {!dramaSource ? <div className={styles.emptyState}><h3>先选择本剧正片</h3><p>从剧库带入剧目后，可在这里选择实际制作集数。</p><button type="button" onClick={onChooseDrama}>去剧库选择</button></div> : mediaEntries.length ? <div className={styles.episodeSourceGrid}>{mediaEntries.map((media) => <article key={media.episode} className={`${episodes.includes(media.episode) ? styles.selected : ""} ${!media.url ? styles.episodeDisabled : ""}`}><button type="button" disabled={!media.url} className={styles.episodePreviewButton} onClick={() => setPreviewEpisode(media.episode)}><span><b>{padEpisode(media.episode)}</b><em>{previewEpisode === media.episode ? "正在预览" : "点击预览"}</em></span><small>{media.url ? media.name : "片源未连接"}</small></button><label><input type="checkbox" disabled={!media.url} checked={episodes.includes(media.episode)} onChange={() => toggleEpisode(media.episode)} /><span>{episodes.includes(media.episode) ? "已选入制作" : "选入制作"}</span></label></article>)}</div> : <div className={styles.emptyState}><h3>当前剧目没有可读取片源</h3><p>请回到剧库补传视频后再继续。</p></div>}
      </section>}
      {activeStep === 1 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>02</span><h2>选择匹配的外搭钩子</h2></div><small>来源必须可追溯</small></div>{hookSourceInput ? <div className={styles.selectedHookCard}><i>↗</i><div><small>{hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏"}</small><h3>{hookSourceInput.title}</h3><p>{hookSourceInput.description}</p><span>{hookSourceInput.language ?? "语种待识别"} · 授权状态待确认</span></div><button type="button" onClick={onChooseHook}>更换钩子</button></div> : <div className={styles.emptyState}><h3>还需要一个外搭钩子</h3><p>可从收藏或灵感大屏选择，带入后将与本剧高光逐帧匹配。</p><button type="button" onClick={onChooseHook}>选择外搭钩子</button></div>}</section>}
      {activeStep >= 2 && activeStep <= 5 && <ExternalHookAnalysis
        activeTab={(["match", "transition", "timeline", "quality"] as const)[activeStep - 2]}
        match={match}
        transitions={externalReady && selectedRecommendation ? transitionOptions : []}
        selectedTransitionId={selectedTransitionId}
        timeline={visibleTimeline}
        quality={qualityReport}
        disabled={!externalReady}
        onTabChange={(tab) => setActiveStep({ match: 2, transition: 3, timeline: 4, quality: 5 }[tab])}
        onSelectRecommendation={(item) => { setSelectedRecommendationId(item.id); setTimeline([]); touch(); }}
        onSelectTransition={(item) => { setSelectedTransitionId(item.id); setTimeline((current) => (current.length ? current : defaultTimeline).map((clip) => clip.kind === "transition" ? { ...clip, title: item.title, durationSeconds: item.durationSeconds } : clip)); touch(); }}
        onPreviewTransition={(item) => onNotify?.(`已选择预览方案：${item.title}`)}
        onRegenerateTransitions={() => onNotify?.("已保存重新生成请求；等待过渡服务接入")}
        onMoveClip={moveTimelineClip}
        onUpdateClip={(id, patch) => { setTimeline((current) => (current.length ? current : defaultTimeline).map((clip) => clip.id === id ? { ...clip, ...patch } : clip)); touch(); }}
        onRemoveClip={(id) => { setTimeline((current) => (current.length ? current : defaultTimeline).filter((clip) => clip.id !== id)); touch(); }}
        onRunQualityCheck={() => { setQualityConfirmed(true); onNotify?.("已完成配置完整性检查；模型质检等待服务接入") }}
        onApplyQualitySuggestion={() => onNotify?.("已记录优化建议")}
        onGeneratePreview={() => setActiveStep(6)}
      />}
      {activeStep >= 6 && <ExternalHookDelivery
        projectName={title || `${dramaSource?.dramaCn ?? "未命名剧目"} · 外搭钩子版`}
        hookName={hookSourceInput?.title}
        episodeReference={selectedRecommendation ? `${padEpisode(selectedRecommendation.episode)} · ${selectedRecommendation.startTimecode}${selectedRecommendation.startFrame == null ? " · 帧号待探测" : ` · 第 ${selectedRecommendation.startFrame} 帧`}` : undefined}
        renderConnected={false}
        disabled={!externalReady || qualityReport.verdict === "阻断"}
        onSaveDraft={() => save(false)}
        onRequestRender={() => onNotify?.("渲染服务尚未接入")}
        onReview={(decision) => onNotify?.(decision === "approved" ? "审核已通过" : "已记录驳回意见")}
        onExport={() => onNotify?.("真实成片生成并审核通过后才能导出")}
        onNotify={onNotify}
      />}
    </div>
    <div className={styles.externalFlowActions}><button type="button" disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))}>上一步</button><span>第 {activeStep + 1} 步 / 共 8 步</span><button type="button" disabled={activeStep === 7} onClick={() => setActiveStep((step) => Math.min(7, step + 1))}>下一步</button></div>
  </section>;

  return <section className={styles.workspace} aria-label="内容工厂">
    <header className={styles.header}>
      <div><span>CONTENT ENGINE</span><h1>内容工厂</h1><p>基于已连接的真实片源创建并持久化制作草稿；未接入的分析、渲染和导出不会展示模拟结果。</p></div>
      <div className={styles.headerActions}><button type="button" onClick={onOpenDrafts}>我的草稿 ↗</button></div>
    </header>

    <nav className={styles.modeTabs} aria-label="制作模式">
      {factoryModes.map((item) => <button type="button" key={item.id} className={mode === item.id ? styles.active : ""} onClick={() => { setMode(item.id); touch(); }}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span></button>)}
    </nav>

    {mode === "external-hook" ? externalWorkflow : !source ? <div className={styles.emptyState}><h2>尚未带入剧目与片源</h2><p>请返回剧库，在目标短剧详情中点击“进入内容工厂”。内容工厂不会再自动填入示例剧目或虚构分析。</p></div> : <>
      <div className={styles.sourceBanner}>
        <div><span>当前剧目</span><h2>{source.dramaCn ?? source.title}</h2><p>{source.dramaTitle && source.dramaTitle !== source.title ? source.dramaTitle : source.description}</p></div>
        <dl><div><dt>题材</dt><dd>{source.genre ?? "未填写"}</dd></div><div><dt>语种</dt><dd>{source.language ?? "未填写"}</dd></div><div><dt>剧集</dt><dd>{source.episodes ?? source.availableEpisodes?.length ?? 0} 集</dd></div><div><dt>已连接视频</dt><dd>{connectedEpisodes.length} 集</dd></div></dl>
      </div>

      {availableWithoutConnection.length > 0 && <div className={styles.legalNote}>片源未连接：{availableWithoutConnection.map(padEpisode).join("、")} 只有上传记录，没有可播放文件地址；这些剧集已禁止预览与生成。</div>}

      <div className={styles.editorGrid}>
        <main>
          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><span>01</span><h2>选择真实片源</h2></div><small>仅列出浏览器当前可读取的视频</small></div>
            {mediaEntries.length ? <div className={styles.episodeSourceGrid}>{mediaEntries.map((media) => <article key={media.episode} className={`${episodes.includes(media.episode) ? styles.selected : ""} ${previewEpisode === media.episode ? styles.previewing : ""} ${!media.url ? styles.episodeDisabled : ""}`}><button type="button" disabled={!media.url} className={styles.episodePreviewButton} onClick={() => setPreviewEpisode(media.episode)}><span><b>{padEpisode(media.episode)}</b><em>{previewEpisode === media.episode ? "正在预览" : "点击预览"}</em></span><small>{media.url ? media.name : "片源未连接"}</small></button><label><input type="checkbox" disabled={!media.url} checked={episodes.includes(media.episode)} onChange={() => toggleEpisode(media.episode)} /><span>{episodes.includes(media.episode) ? "已选入制作" : "选入制作"}</span></label></article>)}</div> : <div className={styles.emptyState}><h3>没有可读取的视频文件</h3><p>该剧只传入了集号，没有把视频文件地址带到内容工厂。请在剧库重新上传或补传片源。</p></div>}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}><div><span>02</span><h2>草稿信息</h2></div><small>{selectedRange(episodes)}</small></div>
            <div className={styles.draftForm}>
              <label className={styles.titleField}><span>草稿名称</span><input value={title} onChange={(event) => { setTitle(event.target.value); touch(); }} placeholder={`${source.dramaCn ?? source.title} · ${definition.name}`} /></label>
              <label><span>输出比例</span><select value={ratio} onChange={(event) => { setRatio(event.target.value as Draft["ratio"]); touch(); }}><option>9:16</option><option>16:9</option><option>1:1</option></select></label>
              <label><span>成片语种</span><select value={language} onChange={(event) => { setLanguage(event.target.value); touch(); }}><option>英语</option><option>德语</option><option>葡萄牙语</option><option>西班牙语</option></select></label>
            </div>
            <div className={styles.aiSummary}><b>当前能力边界</b><p>本页会保存真实剧目、片源选择和输出参数。粗解析、细解析、镜头推荐、自动剪辑与成片渲染必须等待对应服务返回结果；当前不会伪造评分、时间线或成片。</p></div>
          </section>
        </main>

        <aside>
          <section className={styles.preview}>
            <div className={styles.previewHeader}><div><span>真实视频预览</span><h2>{previewEpisode ? padEpisode(previewEpisode) : "未选择"}</h2></div>{connectedEpisodes.length > 0 && <label><span>切换剧集</span><select value={previewEpisode ?? ""} onChange={(event) => setPreviewEpisode(Number(event.target.value))}>{connectedEpisodes.map((episode) => <option value={episode} key={episode}>{padEpisode(episode)}</option>)}</select></label>}</div>
            {previewMedia?.url ? <video key={previewMedia.url} src={previewMedia.url} controls preload="metadata" /> : <div className={styles.emptyState}><p>选择一集已连接的视频后可在这里播放。</p></div>}
            {connectedEpisodes.length > 0 && <div className={styles.previewEpisodes}>{connectedEpisodes.map((episode) => <button type="button" key={episode} className={previewEpisode === episode ? styles.selected : ""} onClick={() => setPreviewEpisode(episode)} aria-label={`预览 ${padEpisode(episode)}`}>{padEpisode(episode)}</button>)}</div>}
          </section>
        </aside>
      </div>

      <section className={styles.productionFlow} aria-label="内容生产流程">
        <div className={styles.flowHeading}>
          <div><span>内容生产流程</span><h2>从真实片源到可执行生产配方</h2><p>先完成组合设计与风险检查；分析、生成和渲染服务接入后再执行成片任务。</p></div>
          <strong>{stepReady.filter(Boolean).length} / {steps.length} 已配置</strong>
        </div>

        <nav className={styles.flowSteps} aria-label="生产步骤">
          {steps.map((step, index) => <button type="button" key={step} className={`${activeStep === index ? styles.flowStepActive : ""} ${stepReady[index] ? styles.flowStepDone : ""}`} onClick={() => setActiveStep(index)}><i>{stepReady[index] ? "✓" : index + 1}</i><span>{step}</span></button>)}
        </nav>

        <div className={styles.flowBody}>
          {activeStep === 0 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>01 · BRIEF</span><h3>确定这一批素材要解决的问题</h3><p>目标会决定后续钩子、承接点与质检规则的排序。</p></div>
            <div className={styles.choiceCards}>{["停滑与点击", "连续观看", "付费转化"].map((item) => <button type="button" key={item} className={goal === item ? styles.choiceActive : ""} onClick={() => { setGoal(item); touch(); }}><b>{item}</b><small>{item === "停滑与点击" ? "优先强首帧、强冲突和悬念" : item === "连续观看" ? "优先因果完整与情绪递进" : "优先承诺兑现与付费卡点"}</small></button>)}</div>
            <div className={styles.inlineControls}><label>目标市场<select><option>美国</option><option>德国</option><option>巴西</option><option>西班牙</option></select></label><label>投放平台<select><option>Meta</option><option>TikTok</option><option>YouTube Shorts</option></select></label><label>目标时长<select><option>60–90 秒</option><option>30–60 秒</option><option>90–180 秒</option></select></label><label>计划版本<input type="number" min="1" max="24" value={variantCount} onChange={(event) => { setVariantCount(Math.max(1, Math.min(24, Number(event.target.value) || 1))); touch(); }} /></label></div>
          </div>}

          {activeStep === 1 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>02 · STORY ENTRY</span><h3>选择正片如何开始，而不只是选择集数</h3><p>已选 {selectedRange(episodes)}。点击上方片源可切换预览并调整制作范围。</p></div>
            <div className={styles.choiceCards}>{["最快理解", "最自然承接", "最强转化"].map((item) => <button type="button" key={item} className={entryStrategy === item ? styles.choiceActive : ""} onClick={() => { setEntryStrategy(item); touch(); }}><b>{item}</b><small>{item === "最快理解" ? "从首个可理解冲突进入" : item === "最自然承接" ? "保留人物关系和必要因果" : "围绕高潮或付费卡点组织"}</small></button>)}</div>
            <div className={styles.pendingNotice}><b>等待剧情分析结果</b><span>服务接入后，这里将列出带时间码的承接点、人物关系、理解成本与推荐理由；当前不生成虚假节点。</span></div>
          </div>}

          {activeStep === 2 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>03 · HOOK MATCH</span><h3>选择钩子来源与匹配方向</h3><p>先保存筛选条件；只有钩子库返回真实资产后才会出现候选。</p></div>
            <div className={styles.choiceCards}>{["我的收藏", "长效通用钩子", "同题材高表现钩子", "相似人物关系", "新生成钩子"].map((item) => <button type="button" key={item} className={hookSource === item ? styles.choiceActive : ""} onClick={() => { setHookSource(item); touch(); }}><b>{item}</b><small>{item === "新生成钩子" ? "保存生成Brief，等待模型服务" : "从已入库的合法钩子资产检索"}</small></button>)}</div>
            <div className={styles.matchDimensions}><span>排序维度</span>{["停滑潜力", "情绪匹配", "人物关系", "矛盾匹配", "承诺兑现", "货不对板风险"].map((item) => <i key={item}>{item}</i>)}</div>
          </div>}

          {activeStep === 3 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>04 · TRANSITION</span><h3>设计钩子与正片之间的连接</h3><p>过渡作为独立对象保存，后续可替换和跨项目复用。</p></div>
            <div className={styles.choiceCards}>{["时间倒叙旁白", "因果解释旁白", "身份反差旁白", "同动作转场", "台词承接", "BGM延续"].map((item) => <button type="button" key={item} className={transition === item ? styles.choiceActive : ""} onClick={() => { setTransition(item); touch(); }}><b>{item}</b><small>{item.includes("旁白") ? "需要生成过渡文案与配音" : "需要镜头/音频特征匹配"}</small></button>)}</div>
            <div className={styles.transitionPreview}><div><small>钩子末端</small><b>等待选择真实钩子</b></div><i>→ {transition} →</i><div><small>正片起点</small><b>{previewEpisode ? padEpisode(previewEpisode) : "等待选择片源"}</b></div></div>
          </div>}

          {activeStep === 4 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>05 · VARIANTS</span><h3>配置组合数量与受控变量</h3><p>系统只保存生产矩阵，不会在渲染服务未接入时伪造视频。</p></div>
            <div className={styles.variantFormula}><b>1 个正片配方</b><span>×</span><b>3 个钩子变量</b><span>×</span><b>2 个过渡变量</b><strong>= {variantCount} 个计划版本</strong></div>
            <div className={styles.checkGrid}>{["首帧类型", "第一条台词", "主情绪", "卡断位置", "视听模式", "过渡方式"].map((item) => <label key={item}><input type="checkbox" defaultChecked onChange={touch} />{item}</label>)}</div>
          </div>}

          {activeStep === 5 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>06 · QUALITY GATE</span><h3>统一质检门</h3><p>真实分析返回前只检查配置完整性；模型指标与风险结论不会使用模拟分数。</p></div>
            <div className={styles.qualityChecklist}>{["真实片源已连接", "至少选择一集正片", "生产目标已确定", "钩子来源已确定", "过渡方式已确定", "版本数量有效"].map((item, index) => <span key={item} className={stepReady[index] ? styles.checkPass : ""}><i>{stepReady[index] ? "✓" : "!"}</i>{item}</span>)}</div>
            <label className={styles.confirmQuality}><input type="checkbox" checked={qualityConfirmed} onChange={(event) => { setQualityConfirmed(event.target.checked); touch(); }} /><span><b>确认保存为待分析生产配方</b><small>钩子适配、连通性、货不对板和高点击低转化风险将在真实分析完成后给出。</small></span></label>
          </div>}
        </div>

        <div className={styles.flowActions}><button type="button" disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))}>上一步</button><span>{goal} · {entryStrategy} · {hookSource} · {transition}</span><button type="button" className={styles.nextButton} disabled={activeStep === steps.length - 1} onClick={() => setActiveStep((step) => Math.min(steps.length - 1, step + 1))}>下一步</button></div>
      </section>
    </>}

    {mode !== "external-hook" && <footer className={styles.workspaceFooter}><span><b>自动保存</b>{source ? `${savedAt} · ${autoSaveCountdown} 秒后再次保存` : savedAt}</span><div><button type="button" onClick={() => save(false)} disabled={!source}>保存草稿</button><button type="button" className={styles.generate} disabled={!canCreate} title={!canCreate ? "没有已连接的真实视频片源" : "渲染服务尚未接入；当前仅保存制作草稿"} onClick={() => onNotify?.("片源已就绪；成片渲染服务尚未接入，当前不会生成假视频")}>生成成片（待接入）</button></div></footer>}
  </section>;
}

export default FactoryWorkspace;
