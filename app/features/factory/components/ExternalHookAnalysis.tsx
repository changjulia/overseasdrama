"use client";

import { useMemo, useRef, useState } from "react";
import { formatDurationZh } from "../../../lib/time-format";
import styles from "./ExternalHookAnalysis.module.css";

export type ExternalHookAnalysisTab = "match" | "transition" | "timeline" | "quality";
export type ExternalHookVerdict = "可以直接生成" | "建议优化" | "阻断";
export type TimelineClipKind = "hook" | "transition" | "episode" | "climax" | "paywall";

export type MatchEvidence = {
  id: string;
  dimension: "人物关系" | "核心矛盾" | "情绪" | "情节" | "视听锚点" | "承诺兑现";
  hookEvidence: string;
  episodeEvidence: string;
  confidence?: number;
};

export type HighlightRecommendation = {
  id: string;
  title: string;
  episode: number;
  startTimecode: string;
  endTimecode?: string;
  startFrame?: number;
  fps?: number;
  score?: number;
  storyScore?: number;
  promiseFulfillmentScore?: number;
  rationale: string;
  relationship: string;
  conflict: string;
  emotion: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  startSeconds?: number;
  endSeconds?: number;
  evidence: MatchEvidence[];
  risks: string[];
  storyArc?: { setup?: string; escalation?: string; payoff?: string; ending?: string; displayNarrativeZh?: { title?:string; hookQuestion?:string; bodyConnection?:string; formedStoryline?:string; relationship?:string; conflict?:string; emotion?:string; connectionType?:string; continuityNotice?:string; phases?:{setup?:string;escalation?:string;payoff?:string;ending?:string} } };
  segments?: Array<{ episode:number;start:number;end:number;purpose?:string;safeStart?:{status?:string};safeEnd?:{status?:string} }>;
  entryPoints?: Array<{id?:string;episode?:number;start?:number;frame?:number;recommended?:boolean;safeBoundary?:{status?:string}}>;
  completeness?: {status?:string;confidence?:number;causalCoverage?:number;missingPhases?:string[]};
  calibration?: {modelConfidence?:number;evidenceCoverage?:number;boundaryReliability?:number;humanVerification?:string;calibratedProbability?:number;method?:string};
  productionGate?: {passed?:boolean;mode?:string;reasons?:string[];advisories?:string[];checks?:Record<string,boolean>;requiredChecks?:Record<string,boolean>;modeChecks?:Record<string,boolean>};
  matchStatus?: string;
  productionReady?: boolean;
  editableBackup?: boolean;
  overrideApplied?: boolean;
};

export type HookEpisodeMatch = {
  hookTitle: string;
  episodeTitle: string;
  status: "idle" | "running" | "completed" | "failed";
  summary?: string;
  recommendations: HighlightRecommendation[];
  selectedRecommendationId?: string;
  resultState?: "idle" | "running" | "waiting_supplemental" | "no_production_candidates" | "failed" | "completed";
  progress?: number;
  stage?: string;
  scope?: { episodes: number[]; scopeLabel: string; targetDurationLabel: string };
  funnel?: { analyzedEpisodes: number; rawCandidates: number; editableCandidates: number; productionCandidates: number };
  rejectionReasons?: Array<{ label: string; count: number }>;
  editableCandidates?: HighlightRecommendation[];
};

export type HookTransitionOption = {
  id: string;
  title: string;
  type: "旁白承接" | "字幕承接" | "同动作匹配" | "同道具匹配" | "声音桥接" | "反应镜头" | "因果补充" | "直接切入";
  durationSeconds: number;
  copy?: string;
  rationale: string;
  continuityScore?: number;
  spoilerRisk?: "低" | "中" | "高";
  hookEndFrameUrl?: string;
  episodeStartFrameUrl?: string;
};

export type ExternalHookTimelineClip = {
  id: string;
  kind: TimelineClipKind;
  title: string;
  sourceLabel: string;
  durationSeconds: number;
  episode?: number;
  startTimecode?: string;
  endTimecode?: string;
  startSeconds?: number;
  endSeconds?: number;
  subtitle?: string;
  locked?: boolean;
};

export type ExternalHookQualityFinding = {
  id: string;
  severity: "通过" | "建议" | "阻断";
  category: "首帧" | "前三秒" | "连续性" | "承诺兑现" | "货不对板" | "音画" | "合规";
  title: string;
  detail: string;
  suggestion?: string;
  actionLabel?: string;
};

export type ExternalHookQualityReport = {
  status: "idle" | "running" | "completed" | "failed";
  verdict?: ExternalHookVerdict;
  score?: number;
  checkedAt?: string;
  findings: ExternalHookQualityFinding[];
};

export type ExternalHookAnalysisProps = {
  match?: HookEpisodeMatch;
  transitions?: HookTransitionOption[];
  selectedTransitionId?: string;
  timeline?: ExternalHookTimelineClip[];
  quality?: ExternalHookQualityReport;
  activeTab?: ExternalHookAnalysisTab;
  selectedClipId?: string;
  disabled?: boolean;
  hookVideoUrl?: string;
  hookStartSeconds?: number;
  hookEndSeconds?: number;
  hookTitle?: string;
  onTabChange?: (tab: ExternalHookAnalysisTab) => void;
  onSelectRecommendation?: (recommendation: HighlightRecommendation) => void;
  onOverrideRecommendation?: (recommendation: HighlightRecommendation) => void;
  onSelectEntryPoint?: (recommendation: HighlightRecommendation, entryPointIndex: number) => void;
  onRequestMoreEntryPoints?: (recommendation: HighlightRecommendation) => void;
  onRetryMatch?: () => void;
  onChangeEpisodeScope?: () => void;
  onChangeHook?: () => void;
  onSelectTransition?: (transition: HookTransitionOption) => void;
  onPreviewTransition?: (transition: HookTransitionOption) => void;
  onRegenerateTransitions?: () => void;
  onSelectClip?: (clip: ExternalHookTimelineClip) => void;
  onMoveClip?: (clipId: string, direction: "backward" | "forward") => void;
  onUpdateClip?: (clipId: string, patch: Partial<ExternalHookTimelineClip>) => void;
  onRemoveClip?: (clipId: string) => void;
  onApplyQualitySuggestion?: (finding: ExternalHookQualityFinding) => void;
  onRunQualityCheck?: () => void;
  onGeneratePreview?: () => void;
};

const kindLabel: Record<TimelineClipKind, string> = {
  hook: "外搭钩子",
  transition: "过渡",
  episode: "本剧正片",
  climax: "矛盾递进",
  paywall: "付费卡点",
};

const clampScore = (value?: number) => Math.max(0, Math.min(100, value ?? 0));
const formatDuration = (seconds: number) => formatDurationZh(seconds);
const episodeLabel = (episode: number) => `EP ${String(episode).padStart(2, "0")}`;
const phaseLabels: Record<string, string> = { setup: "起因铺垫", escalation: "冲突升级", payoff: "关系转折", ending: "阶段落点" };
const candidateTitle = (value: string) => phaseLabels[value.trim().toLowerCase()] || value;
const concise = (value?: string, length = 90) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
};

const analysisStageLabel = (stage?: string) =>
  ({
    interactive_queued: "等待交互分析 Worker",
    queued: "等待交互分析 Worker",
    prepare: "正在准备分析证据",
    matching: "正在评估剧情承接关系",
    entry_precision: "正在复核精确起播点",
    completed: "分析已完成",
  })[stage || ""] || stage || "正在验证故事承接与安全边界";

const recommendationKey = (item: HighlightRecommendation) => {
  const narrative = item.storyArc?.displayNarrativeZh;
  return [
    item.episode,
    item.startTimecode,
    narrative?.connectionType,
    narrative?.formedStoryline || item.title,
  ].map((value) => String(value || "").trim().toLowerCase()).join("|");
};

const optionLabel = (index: number) => ["最推荐", "快速起播", "强冲突备选"][index] || "备选";

const primaryRisk = (item: HighlightRecommendation) =>
  item.risks[0] || item.productionGate?.advisories?.[0] || "分析完成，默认支持进入后续生产。";

const comprehensionLabel = (item: HighlightRecommendation) => {
  const coverage = item.calibration?.evidenceCoverage ?? item.completeness?.causalCoverage;
  if (coverage == null) return "待预览确认";
  if (coverage >= 0.75) return "低";
  if (coverage >= 0.5) return "中";
  return "高";
};

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.emptyState}><i aria-hidden="true">◇</i><b>{title}</b><p>{detail}</p></div>;
}

function NoProductionResult({ match, onRetry, onChangeScope, onChangeHook }: { match: HookEpisodeMatch; onRetry?: () => void; onChangeScope?: () => void; onChangeHook?: () => void }) {
  const funnel = match.funnel ?? { analyzedEpisodes: match.scope?.episodes.length ?? 0, rawCandidates: 0, editableCandidates: match.editableCandidates?.length ?? 0, productionCandidates: 0 };
  return <div className={styles.noResultWorkbench}>
    <div className={styles.noResultHeadline}><i>!</i><div><b>本轮没有可直接生产的故事线</b><p>{match.summary || "分析已经完成；候选仍可查看和调整，但在通过硬门前不能进入生产。"}</p></div></div>
    {match.scope && <div className={styles.scopeSummary}><small>本轮分析范围</small><b>{match.scope.scopeLabel} · {match.scope.targetDurationLabel}</b><span>{match.scope.episodes.map(episodeLabel).join("、")}</span></div>}
    <div className={styles.funnelGrid}>
      <div><small>已分析剧集</small><b>{funnel.analyzedEpisodes}</b></div><div><small>原始候选</small><b>{funnel.rawCandidates}</b></div><div><small>待处理候选</small><b>{funnel.editableCandidates}</b></div><div><small>可直接生产</small><b>{funnel.productionCandidates}</b></div>
    </div>
    <div className={styles.rejectionList}><b>主要未通过原因</b>{match.rejectionReasons?.length ? match.rejectionReasons.map(item=><div key={item.label}><span>{item.label}</span><em>{item.count}</em></div>) : <p>当前服务没有返回候选级淘汰明细。本次“0 候选”暂时不能作为降低评分标准的依据。</p>}</div>
    <div className={styles.stateActions}><button type="button" onClick={onRetry}>补充高光分析</button><button type="button" onClick={onChangeScope}>调整剧集范围</button><button type="button" onClick={onChangeHook}>更换钩子</button></div>
  </div>;
}

function EditableCandidatePanel({ candidates, onSelect, onRetry }: { candidates: HighlightRecommendation[]; onSelect: (item: HighlightRecommendation) => void; onRetry?: () => void }) {
  return <div className={styles.editablePanel}><header><span>分析诊断</span><h3>{candidates.length ? `发现 ${candidates.length} 条待处理候选` : "没有返回可诊断候选"}</h3><p>{candidates.length ? "候选已经返回；可查看分数、故事证据和生产阻断项。只有标记为可编辑备选的项目才能审核覆盖。" : "系统需要保存原始候选、边界状态与淘汰原因，才能继续补充分析。"}</p></header>
    {candidates.length ? <div className={styles.editableCards}>{candidates.map(item=><article key={item.id}><div><b>{item.title}</b><small>{episodeLabel(item.episode)} · {item.startTimecode}{item.endTimecode ? `–${item.endTimecode}` : ""}</small></div><dl><div><dt>故事分</dt><dd>{clampScore(item.storyScore ?? item.score)}</dd></div><div><dt>承诺兑现</dt><dd>{clampScore(item.promiseFulfillmentScore)}</dd></div></dl><p>{item.productionGate?.reasons?.[0] || item.risks[0] || "需要进一步验证生产边界"}</p><button type="button" onClick={()=>onSelect(item)}>查看候选证据</button></article>)}</div> : <div className={styles.candidateContract}><b>建议服务端补回</b><span>原始分数 · 边界状态 · 淘汰原因 · 可修复建议</span><button type="button" onClick={onRetry}>补充分析并刷新</button></div>}
  </div>;
}

export function ExternalHookAnalysis({
  match,
  transitions = [],
  selectedTransitionId,
  timeline = [],
  quality,
  activeTab,
  selectedClipId,
  disabled = false,
  hookVideoUrl,
  hookStartSeconds = 0,
  hookEndSeconds,
  hookTitle = "外搭钩子",
  onSelectRecommendation,
  onSelectEntryPoint,
  onRequestMoreEntryPoints,
  onRetryMatch,
  onChangeEpisodeScope,
  onChangeHook,
  onSelectTransition,
  onPreviewTransition,
  onSelectClip,
  onMoveClip,
  onUpdateClip,
  onRemoveClip,
  onApplyQualitySuggestion,
  onRunQualityCheck,
  onGeneratePreview,
}: ExternalHookAnalysisProps) {
  const [internalTab] = useState<ExternalHookAnalysisTab>(activeTab ?? "match");
  const [internalRecommendationId, setInternalRecommendationId] = useState<string>();
  const [internalTransitionId, setInternalTransitionId] = useState<string>();
  const [internalClipId, setInternalClipId] = useState<string>();
  const [connectionPreviewing, setConnectionPreviewing] = useState(false);
  const hookPreviewRef = useRef<HTMLVideoElement>(null);
  const episodePreviewRef = useRef<HTMLVideoElement>(null);
  const currentTab = activeTab ?? internalTab;
  const currentRecommendationId = match?.selectedRecommendationId ?? internalRecommendationId;
  const currentTransitionId = selectedTransitionId ?? internalTransitionId;
  const currentClipId = selectedClipId ?? internalClipId;
  const resultState = match?.resultState ?? (match?.status === "running" ? "running" : match?.status === "failed" ? "failed" : match?.status === "completed" && !match.recommendations.length ? "no_production_candidates" : match?.status === "completed" ? "completed" : "idle");
  const recommendationPool = (() => {
    const source = match?.recommendations?.length
      ? match.recommendations
      : (match?.editableCandidates ?? []);
    const seen = new Set<string>();
    return source.filter((item) => {
      const key = recommendationKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3);
  })();
  const selectedRecommendation = recommendationPool.find((item) => item.id === currentRecommendationId) ?? (resultState === "completed" ? match?.recommendations[0] : undefined);
  const displayNarrativeZh = selectedRecommendation?.storyArc?.displayNarrativeZh;
  const selectedTransition = transitions.find((item) => item.id === currentTransitionId) ?? transitions[0];
  const totalDuration = useMemo(() => timeline.reduce((sum, clip) => sum + clip.durationSeconds, 0), [timeline]);

  const selectRecommendation = (recommendation: HighlightRecommendation) => {
    if (match?.selectedRecommendationId == null) setInternalRecommendationId(recommendation.id);
    onSelectRecommendation?.(recommendation);
  };

  const selectTransition = (transition: HookTransitionOption) => {
    if (selectedTransitionId == null) setInternalTransitionId(transition.id);
    onSelectTransition?.(transition);
  };

  const selectClip = (clip: ExternalHookTimelineClip) => {
    if (selectedClipId == null) setInternalClipId(clip.id);
    onSelectClip?.(clip);
  };

  const previewConnection = () => {
    if (!selectedTransition) return;
    onPreviewTransition?.(selectedTransition);
    const hookVideo = hookPreviewRef.current;
    const episodeVideo = episodePreviewRef.current;
    if (!hookVideo || !episodeVideo) return;
    const hookEnd = hookEndSeconds ?? Math.max(hookStartSeconds + 3, hookVideo.duration || 0);
    hookVideo.currentTime = Math.max(hookStartSeconds, hookEnd - 3);
    episodeVideo.pause();
    episodeVideo.currentTime = selectedRecommendation?.startSeconds ?? 0;
    setConnectionPreviewing(true);
    void hookVideo.play().catch(() => setConnectionPreviewing(false));
  };

  return <section className={styles.analysis} aria-label="外搭钩子与本剧正片分析">

    {currentTab === "match" && <div className={styles.matchDecision}>
      <header className={styles.decisionHeader}>
        <div><span>正片匹配</span><h2>只选择正片从哪里开始</h2><p>系统最多保留三个有真实差异的方案；没有可靠方案时不会补齐数量。</p></div>
        {match?.scope && <small>{match.scope.scopeLabel} · {match.scope.targetDurationLabel}</small>}
      </header>
      <div className={styles.decisionBody}>
      <aside className={styles.recommendationList}>
        <div className={styles.sectionTitle}><div><span>TOP OPTIONS</span><h3>可用正片方案</h3></div><em>最多 3 个</em></div>
        {resultState === "running" ? <div className={styles.resultState}><EmptyState title="正在寻找正片起播点" detail={`${analysisStageLabel(match?.stage)}${match?.progress != null ? ` · ${Math.round(match.progress)}%` : ""}`} /></div> : resultState === "waiting_supplemental" ? <div className={styles.resultState}><EmptyState title="正在补充正片证据" detail="当前范围缺少足够的已验证片段。补充完成后会自动继续匹配。"/><div className={styles.stateActions}><button type="button" onClick={onRetryMatch}>刷新分析状态</button><button type="button" onClick={onChangeEpisodeScope}>调整剧集范围</button></div></div> : resultState === "failed"?<div className={styles.resultState}><EmptyState title="本轮匹配未完成" detail={match?.summary||"分析任务失败，当前结果不能用于选择正片。"}/><div className={styles.stateActions}><button type="button" onClick={onRetryMatch}>重新匹配</button><button type="button" onClick={onChangeEpisodeScope}>调整范围</button><button type="button" onClick={onChangeHook}>更换钩子</button></div></div>:recommendationPool.length ? recommendationPool.map((recommendation, index) => <button type="button" key={recommendation.id} className={`${styles.recommendation} ${selectedRecommendation?.id === recommendation.id ? styles.selected : ""}`} onClick={() => selectRecommendation(recommendation)}>
          <span className={styles.rank}>{index + 1}</span>
          <span className={styles.recommendationCopy}><strong>{optionLabel(index)}</strong><b>{candidateTitle(recommendation.storyArc?.displayNarrativeZh?.title || recommendation.title)}</b><small>{episodeLabel(recommendation.episode)} · 从 {recommendation.startTimecode} 起播</small><em>{concise(recommendation.storyArc?.displayNarrativeZh?.bodyConnection || recommendation.rationale, 42) || "点击查看承接理由"}</em></span>
          <span className={styles.optionArrow}>›</span>
        </button>) : resultState === "no_production_candidates" && match ? <NoProductionResult match={match} onRetry={onRetryMatch} onChangeScope={onChangeEpisodeScope} onChangeHook={onChangeHook}/> : <EmptyState title="尚未开始故事匹配" detail="确认剧集范围与外搭钩子后，点击“开始匹配”创建分析任务。" />}
      </aside>

      <main className={styles.matchDetail}>
        {selectedRecommendation ? <>
          <div className={styles.matchHeroCompact}>
            {selectedRecommendation.videoUrl ? <div><video className={styles.frameImage} src={`${selectedRecommendation.videoUrl}#t=${selectedRecommendation.startSeconds ?? 0}`} muted playsInline preload="metadata" aria-label={`${selectedRecommendation.title} 正片承接片段`} onMouseEnter={event=>{const video=event.currentTarget;video.dataset.hovering="true";video.currentTime=selectedRecommendation.startSeconds??0;void video.play().catch(()=>undefined)}} onTimeUpdate={event=>{if(selectedRecommendation.endSeconds!=null&&event.currentTarget.currentTime>=selectedRecommendation.endSeconds)event.currentTarget.pause()}} onMouseLeave={event=>{const video=event.currentTarget;video.dataset.hovering="false";video.pause();video.currentTime=selectedRecommendation.startSeconds??0}} onCanPlay={event=>{const video=event.currentTarget;if(video.dataset.hovering==="true")void video.play().catch(()=>undefined)}} /><small className={styles.previewCaption}>{episodeLabel(selectedRecommendation.episode)} · {selectedRecommendation.startTimecode}–{selectedRecommendation.endTimecode} · 悬停播放正片</small></div> : selectedRecommendation.thumbnailUrl ? <div className={styles.frameImage} role="img" aria-label={`${selectedRecommendation.title} 承接帧`} style={{ backgroundImage: `url(${selectedRecommendation.thumbnailUrl})` }} /> : <div className={styles.framePlaceholder}><span>{episodeLabel(selectedRecommendation.episode)}</span><b>{selectedRecommendation.startTimecode}</b><small>{selectedRecommendation.startFrame == null ? "帧号待媒体探测" : `第 ${selectedRecommendation.startFrame.toLocaleString()} 帧`}</small></div>}
            <div><span>当前方案</span><h3>{displayNarrativeZh?.title || candidateTitle(selectedRecommendation.title)}</h3><p>{displayNarrativeZh?.bodyConnection || selectedRecommendation.rationale}</p><dl><div><dt>正片起播</dt><dd>{episodeLabel(selectedRecommendation.episode)} · {selectedRecommendation.startTimecode}</dd></div><div><dt>理解成本</dt><dd>{comprehensionLabel(selectedRecommendation)}</dd></div><div><dt>承接方式</dt><dd>{displayNarrativeZh?.connectionType || "待预览确认"}</dd></div></dl><div className={styles.primaryRisk}><small>最大风险</small><b>{concise(primaryRisk(selectedRecommendation), 100)}</b></div></div>
          </div>
          <section className={styles.entryPointSection}><div className={styles.storyDetailHeading}><h4>为什么从这里起播</h4><p>比较相邻接点，只确认理解和剪辑边界。</p></div><div className={styles.entryPointGrid}>{(selectedRecommendation.entryPoints?.length ? selectedRecommendation.entryPoints.slice(0,3) : [{recommended:true,start:selectedRecommendation.startSeconds}]).map((point,index)=><button type="button" key={point.id??index} className={point.recommended?styles.entryPointRecommended:""} onClick={()=>onSelectEntryPoint?.(selectedRecommendation,index)}><small>{point.recommended?"推荐起播":"备选起播"}</small><b>{point.start == null ? selectedRecommendation.startTimecode : formatDurationZh(point.start,2)}</b><span>{point.recommended?"事件完整、关系和目标可理解":"点击预览并比较信息是否过早或缺失"}</span><em>{point.safeBoundary?.status==="verified"?"✓ 边界已验证":"△ 边界待确认"}</em></button>)}</div></section>
          <div className={styles.storyArcCompact}>{displayNarrativeZh?.phases && Object.entries(displayNarrativeZh.phases).filter(([,value])=>value).slice(0,4).map(([phase,value])=><article key={phase}><small>{phaseLabels[phase]||phase}</small><p>{concise(value,72)}</p></article>)}</div>
          <details className={styles.rawEvidence}><summary>查看原始对白与匹配证据</summary><div className={styles.evidenceList}>{selectedRecommendation.evidence.map((evidence) => <article key={evidence.id}><header><b>{evidence.dimension}</b></header><div><p><small>钩子证据</small>{evidence.hookEvidence}</p><i aria-hidden="true">↔</i><p><small>正片证据</small>{evidence.episodeEvidence}</p></div></article>)}</div>{selectedRecommendation.entryPoints?.length ? <button type="button" onClick={()=>onRequestMoreEntryPoints?.(selectedRecommendation)}>重新分析起播点</button> : null}</details>
        </> : resultState === "no_production_candidates" ? <EditableCandidatePanel candidates={match?.editableCandidates ?? []} onSelect={selectRecommendation} onRetry={onRetryMatch}/> : <EmptyState title={resultState === "running" || resultState === "waiting_supplemental" ? "分析完成后将在这里展示证据" : "请选择一个推荐高光"} detail={resultState === "running" || resultState === "waiting_supplemental" ? "候选不会在缺少真实证据时提前进入生产。" : "选中后可查看集数、精确帧、共同人物关系与逐项证据。"} />}
      </main>
      </div>
    </div>}

    {currentTab === "transition" && <div className={styles.connectionLayout}>
      <div className={styles.decisionHeader}><div><span>连接预览</span><h2>确认钩子接到正片是否成立</h2><p>只处理必要连接，不生成多套相似过渡文案。</p></div></div>
      {selectedRecommendation && selectedTransition ? <>
        <div className={styles.connectionPreview}>
          <article><small>钩子结尾</small>{hookVideoUrl?<video ref={hookPreviewRef} className={styles.connectionFrame} src={`${hookVideoUrl}#t=${hookStartSeconds}${hookEndSeconds != null ? `,${hookEndSeconds}` : ""}`} muted controls playsInline preload="metadata" aria-label={`${hookTitle} 钩子片段`} onTimeUpdate={event=>{if(hookEndSeconds!=null&&event.currentTarget.currentTime>=hookEndSeconds){event.currentTarget.pause();if(connectionPreviewing&&episodePreviewRef.current){episodePreviewRef.current.currentTime=selectedRecommendation.startSeconds??0;void episodePreviewRef.current.play().catch(()=>setConnectionPreviewing(false))}}}}/>:<div className={styles.connectionFrame}>{selectedTransition.hookEndFrameUrl?<span className={styles.connectionFrameImage} role="img" aria-label="钩子末帧" style={{backgroundImage:`url(${selectedTransition.hookEndFrameUrl})`}}/>:<span>钩子视频暂不可用</span>}</div>}<p>组合预览从钩子结尾前 3 秒开始。</p></article>
          <i>→</i>
          <article className={styles.defaultTransition}><small>直接切入</small><b>{selectedTransition.title}</b><div className={styles.transitionChoices}>{transitions.map(item=><button type="button" key={item.id} data-selected={item.id===selectedTransition.id} onClick={()=>selectTransition(item)}>{item.title}<em>{item.durationSeconds ? `${item.durationSeconds}秒` : "0秒"}</em></button>)}</div>{selectedTransition.copy&&<blockquote>“{selectedTransition.copy}”</blockquote>}<p>{selectedTransition.rationale}</p><dl className={styles.transitionFacts}><div><dt>节奏影响</dt><dd>{selectedTransition.durationSeconds===0?"无":selectedTransition.durationSeconds<=0.25?"极低":"低"}</dd></div><div><dt>适用条件</dt><dd>{selectedTransition.id==="hard-cut"?"冲突强、切点完整":"人物或场景跨度较大"}</dd></div></dl><div><button type="button" onClick={previewConnection}>{connectionPreviewing?"正在预览…":"预览：钩子末尾3秒＋正片5秒"}</button></div></article>
          <i>→</i>
          <article><small>正片起播</small>{selectedRecommendation.videoUrl?<video ref={episodePreviewRef} className={styles.connectionFrame} src={`${selectedRecommendation.videoUrl}#t=${selectedRecommendation.startSeconds??0}`} muted controls playsInline preload="metadata" onTimeUpdate={event=>{if(connectionPreviewing&&event.currentTarget.currentTime>=(selectedRecommendation.startSeconds??0)+5){event.currentTarget.pause();setConnectionPreviewing(false)}}}/>:<div className={styles.connectionFrame}><span>{episodeLabel(selectedRecommendation.episode)}<br/>{selectedRecommendation.startTimecode}</span></div>}<p>{displayNarrativeZh?.bodyConnection||selectedRecommendation.rationale}</p></article>
        </div>
        <section className={styles.blockerSection}><div className={styles.storyDetailHeading}><h4>继续生成前只检查严重问题</h4><p>人物误认、事实冲突、承诺冲突与切点断裂。</p></div>{quality?.findings.filter(item=>item.severity!=="通过"&&["连续性","承诺兑现","货不对板"].includes(item.category)).slice(0,4).length?<div className={styles.blockerList}>{quality?.findings.filter(item=>item.severity!=="通过"&&["连续性","承诺兑现","货不对板"].includes(item.category)).slice(0,4).map(item=><article key={item.id} data-severity={item.severity}><i>{item.severity==="阻断"?"×":"!"}</i><div><b>{item.title}</b><p>{item.detail}</p></div></article>)}</div>:<div className={styles.connectionPass}><i>✓</i><div><b>连接可以继续</b><p>未发现明显人物误认、事实冲突、承诺冲突或边界断裂。</p></div></div>}</section>
        <footer className={styles.connectionFooter}><button type="button" onClick={onChangeHook}>返回更换方案</button><button type="button" disabled={disabled||quality?.findings.some(item=>item.severity==="阻断")} onClick={onGeneratePreview}>确认连接并生成草稿</button></footer>
      </> : <EmptyState title="等待正片方案" detail="先选择一个可播放、可追溯的正片起播方案。"/>}
    </div>}

    {currentTab === "timeline" && <div className={styles.timelineLayout}>
      <div className={styles.sectionTitle}><div><span>成片结构</span><h3>外搭钩子 → 过渡 → 本剧正片</h3></div><em>{timeline.length} 个片段 · {formatDuration(totalDuration)}</em></div>
      {timeline.length ? <>
        <div className={styles.timelineTrack} role="list" aria-label="成片时间线">
          {timeline.map((clip, index) => <button type="button" role="listitem" key={clip.id} data-kind={clip.kind} style={{ flexGrow: Math.max(clip.durationSeconds, 3) }} className={currentClipId === clip.id ? styles.clipSelected : ""} onClick={() => selectClip(clip)}><small>{kindLabel[clip.kind]}</small><b>{clip.title}</b><span>{formatDuration(clip.durationSeconds)}</span><i>{index + 1}</i></button>)}
        </div>
        <div className={styles.clipList}>{timeline.map((clip, index) => <article key={clip.id} className={currentClipId === clip.id ? styles.clipRowSelected : ""}>
          <button type="button" className={styles.clipSummary} onClick={() => selectClip(clip)}><i data-kind={clip.kind}>{index + 1}</i><span><b>{clip.title}</b><small>{kindLabel[clip.kind]} · {clip.sourceLabel}{clip.episode ? ` · ${episodeLabel(clip.episode)}` : ""}</small></span></button>
          <label><span>入点</span><input value={clip.startTimecode ?? "—"} disabled={disabled || clip.locked} onChange={(event) => onUpdateClip?.(clip.id, { startTimecode: event.target.value })} /></label>
          <label><span>出点</span><input value={clip.endTimecode ?? "—"} disabled={disabled || clip.locked} onChange={(event) => onUpdateClip?.(clip.id, { endTimecode: event.target.value })} /></label>
          <label><span>时长</span><input type="number" min="0.1" step="0.1" value={Math.round(clip.durationSeconds*100)/100} disabled={disabled || clip.locked} onChange={(event) => onUpdateClip?.(clip.id, { durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label>
          <div className={styles.clipActions}><button type="button" aria-label="前移" disabled={disabled || clip.locked || index === 0} onClick={() => onMoveClip?.(clip.id, "backward")}>←</button><button type="button" aria-label="后移" disabled={disabled || clip.locked || index === timeline.length - 1} onClick={() => onMoveClip?.(clip.id, "forward")}>→</button><button type="button" className={styles.removeButton} disabled={disabled || clip.locked} onClick={() => onRemoveClip?.(clip.id)}>删除</button></div>
        </article>)}</div>
      </> : <EmptyState title="时间线尚未生成" detail="确认钩子、承接高光与过渡方案后，系统会创建可编辑的成片结构。" />}
    </div>}

    {currentTab === "quality" && <div className={styles.qualityLayout}>
      <div className={styles.qualitySummary} data-verdict={quality?.verdict ?? "未质检"}>
        <div className={styles.scoreRing}><strong>{quality?.score == null ? "—" : clampScore(quality.score)}</strong><small>/ 100</small></div>
        <div><span>QUALITY GATE</span><h3>{quality?.status === "running" ? "正在进行全链路质检" : quality?.verdict ?? "等待执行质检"}</h3><p>{quality?.verdict === "可以直接生成" ? "首帧、前三秒、承诺兑现和正片承接均达到生成要求。" : quality?.verdict === "建议优化" ? "可生成预览，但建议先处理下方问题以降低投放风险。" : quality?.verdict === "阻断" ? "存在货不对板或合规阻断项，处理前不可生成。" : "将检查钩子停滑力、连续性、货不对板、音画与合规风险。"}</p>{quality?.checkedAt && <small>最近检查：{quality.checkedAt}</small>}</div>
        <button type="button" disabled={disabled || quality?.status === "running"} onClick={onRunQualityCheck}>{quality?.status === "running" ? "检查中…" : "重新质检"}</button>
      </div>
      {quality?.findings.length ? <div className={styles.findingList}>{quality.findings.map((finding) => <article key={finding.id} data-severity={finding.severity}>
        <i>{finding.severity === "通过" ? "✓" : finding.severity === "建议" ? "!" : "×"}</i><div><header><span>{finding.category}</span><b>{finding.title}</b></header><p>{finding.detail}</p>{finding.suggestion && <small>建议：{finding.suggestion}</small>}</div>{finding.actionLabel && <button type="button" disabled={disabled || finding.severity === "通过"} onClick={() => onApplyQualitySuggestion?.(finding)}>{finding.actionLabel}</button>}
      </article>)}</div> : <EmptyState title="暂无质检结果" detail="完成时间线后运行质检，系统会返回可以生成、建议优化或阻断结论。" />}
      <footer className={styles.qualityFooter}><span>检查结果仅供内容判断，不阻断当前制作流程</span><button type="button" disabled={disabled || quality?.status !== "completed"} onClick={onGeneratePreview}>生成预览并送审</button></footer>
    </div>}
  </section>;
}

export default ExternalHookAnalysis;
