"use client";

import { useMemo, useState } from "react";
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
  storyArc?: { setup?: string; escalation?: string; payoff?: string; ending?: string };
  segments?: Array<{ episode:number;start:number;end:number;purpose?:string;safeStart?:{status?:string};safeEnd?:{status?:string} }>;
  entryPoints?: Array<{id?:string;episode?:number;start?:number;frame?:number;recommended?:boolean;safeBoundary?:{status?:string}}>;
  completeness?: {status?:string;confidence?:number;causalCoverage?:number;missingPhases?:string[]};
  calibration?: {modelConfidence?:number;evidenceCoverage?:number;boundaryReliability?:number;humanVerification?:string;calibratedProbability?:number;method?:string};
  productionGate?: {passed?:boolean;reasons?:string[];advisories?:string[];checks?:Record<string,boolean>};
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

const tabs: Array<{ id: ExternalHookAnalysisTab; step: string; label: string; description: string }> = [
  { id: "match", step: "03", label: "匹配分析", description: "高光、集数与帧" },
  { id: "transition", step: "04", label: "过渡设计", description: "连接钩子与正片" },
  { id: "timeline", step: "05", label: "成片时间线", description: "调整结构与时长" },
  { id: "quality", step: "06", label: "质检门", description: "钩子与货不对板" },
];

const kindLabel: Record<TimelineClipKind, string> = {
  hook: "外搭钩子",
  transition: "过渡",
  episode: "本剧正片",
  climax: "矛盾递进",
  paywall: "付费卡点",
};

const clampScore = (value?: number) => Math.max(0, Math.min(100, value ?? 0));
const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const episodeLabel = (episode: number) => `EP ${String(episode).padStart(2, "0")}`;

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
  onTabChange,
  onSelectRecommendation,
  onOverrideRecommendation,
  onSelectEntryPoint,
  onRequestMoreEntryPoints,
  onRetryMatch,
  onChangeEpisodeScope,
  onChangeHook,
  onSelectTransition,
  onPreviewTransition,
  onRegenerateTransitions,
  onSelectClip,
  onMoveClip,
  onUpdateClip,
  onRemoveClip,
  onApplyQualitySuggestion,
  onRunQualityCheck,
  onGeneratePreview,
}: ExternalHookAnalysisProps) {
  const [internalTab, setInternalTab] = useState<ExternalHookAnalysisTab>(activeTab ?? "match");
  const [internalRecommendationId, setInternalRecommendationId] = useState<string>();
  const [internalTransitionId, setInternalTransitionId] = useState<string>();
  const [internalClipId, setInternalClipId] = useState<string>();
  const currentTab = activeTab ?? internalTab;
  const currentRecommendationId = match?.selectedRecommendationId ?? internalRecommendationId;
  const currentTransitionId = selectedTransitionId ?? internalTransitionId;
  const currentClipId = selectedClipId ?? internalClipId;
  const resultState = match?.resultState ?? (match?.status === "running" ? "running" : match?.status === "failed" ? "failed" : match?.status === "completed" && !match.recommendations.length ? "no_production_candidates" : match?.status === "completed" ? "completed" : "idle");
  const recommendationPool = [...(match?.recommendations ?? []), ...(match?.editableCandidates ?? [])];
  const selectedRecommendation = recommendationPool.find((item) => item.id === currentRecommendationId) ?? (resultState === "completed" ? match?.recommendations[0] : undefined);
  const selectedTransition = transitions.find((item) => item.id === currentTransitionId) ?? transitions[0];
  const totalDuration = useMemo(() => timeline.reduce((sum, clip) => sum + clip.durationSeconds, 0), [timeline]);

  const changeTab = (tab: ExternalHookAnalysisTab) => {
    if (activeTab == null) setInternalTab(tab);
    onTabChange?.(tab);
  };

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

  return <section className={styles.analysis} aria-label="外搭钩子与本剧正片分析">

    {currentTab === "match" && <div className={styles.matchLayout}>
      <aside className={styles.recommendationList}>
        <div className={styles.sectionTitle}><div><span>推荐候选</span><h3>对应到正片的精确承接点</h3></div><em>{recommendationPool.length} 个候选</em></div>
        {resultState === "running" ? <div className={styles.resultState}><EmptyState title="正在分析完整故事线" detail={`${match?.stage || "正在比对主题、人物关系、核心矛盾、情绪与钩子承诺"}${match?.progress != null ? ` · ${Math.round(match.progress)}%` : ""}`} /></div> : resultState === "waiting_supplemental" ? <div className={styles.resultState}><EmptyState title="正在补充高光资产" detail="当前范围缺少足够的已验证高光。补充分析完成后会自动继续故事匹配。"/><div className={styles.stateActions}><button type="button" onClick={onRetryMatch}>刷新分析状态</button><button type="button" onClick={onChangeEpisodeScope}>调整剧集范围</button></div></div> : resultState === "failed"?<div className={styles.resultState}><EmptyState title="本轮分析未完整执行" detail={match?.summary||"部分分析任务失败，当前结果不能用于判断素材质量。"}/><div className={styles.stateActions}><button type="button" onClick={onRetryMatch}>重试失败任务</button><button type="button" onClick={onChangeEpisodeScope}>调整剧集范围</button><button type="button" onClick={onChangeHook}>更换钩子</button></div></div>:recommendationPool.length ? recommendationPool.map((recommendation, index) => <button type="button" key={recommendation.id} className={`${styles.recommendation} ${selectedRecommendation?.id === recommendation.id ? styles.selected : ""}`} onClick={() => selectRecommendation(recommendation)}>
          <span className={styles.rank}>#{index + 1}</span>
          <span className={styles.recommendationCopy}><b>{recommendation.title}</b><small>{episodeLabel(recommendation.episode)} · {recommendation.startTimecode}{recommendation.endTimecode ? `–${recommendation.endTimecode}` : ""}</small><em>{recommendation.startFrame == null ? "帧号待探测" : `第 ${recommendation.startFrame.toLocaleString()} 帧`}{recommendation.fps ? ` · ${recommendation.fps}fps` : ""}</em></span>
          <strong>{clampScore(recommendation.storyScore ?? recommendation.score)}<small>{recommendation.productionReady?"可生产":recommendation.editableBackup?"可审核":"待补证"}</small></strong>
        </button>) : resultState === "no_production_candidates" ? <NoProductionResult match={match} onRetry={onRetryMatch} onChangeScope={onChangeEpisodeScope} onChangeHook={onChangeHook}/> : <EmptyState title="尚未开始故事匹配" detail="确认剧集范围与外搭钩子后，点击“开始匹配”创建分析任务。" />}
      </aside>

      <main className={styles.matchDetail}>
        {selectedRecommendation ? <>
          <div className={styles.matchHero}>
            {selectedRecommendation.videoUrl ? <div><video className={styles.frameImage} src={`${selectedRecommendation.videoUrl}#t=${selectedRecommendation.startSeconds ?? 0}`} muted playsInline preload="metadata" aria-label={`${selectedRecommendation.title} 正片承接片段`} onMouseEnter={event=>{const video=event.currentTarget;video.dataset.hovering="true";video.currentTime=selectedRecommendation.startSeconds??0;void video.play().catch(()=>undefined)}} onTimeUpdate={event=>{if(selectedRecommendation.endSeconds!=null&&event.currentTarget.currentTime>=selectedRecommendation.endSeconds)event.currentTarget.pause()}} onMouseLeave={event=>{const video=event.currentTarget;video.dataset.hovering="false";video.pause();video.currentTime=selectedRecommendation.startSeconds??0}} onCanPlay={event=>{const video=event.currentTarget;if(video.dataset.hovering==="true")void video.play().catch(()=>undefined)}} /><small className={styles.previewCaption}>{episodeLabel(selectedRecommendation.episode)} · {selectedRecommendation.startTimecode}–{selectedRecommendation.endTimecode} · 悬停播放正片</small></div> : selectedRecommendation.thumbnailUrl ? <div className={styles.frameImage} role="img" aria-label={`${selectedRecommendation.title} 承接帧`} style={{ backgroundImage: `url(${selectedRecommendation.thumbnailUrl})` }} /> : <div className={styles.framePlaceholder}><span>{episodeLabel(selectedRecommendation.episode)}</span><b>{selectedRecommendation.startTimecode}</b><small>{selectedRecommendation.startFrame == null ? "帧号待媒体探测" : `第 ${selectedRecommendation.startFrame.toLocaleString()} 帧`}</small></div>}
            <div><span>推荐承接高光</span><h3>{selectedRecommendation.title}</h3><p>{selectedRecommendation.rationale}</p><dl><div><dt>人物关系</dt><dd>{selectedRecommendation.relationship}</dd></div><div><dt>核心矛盾</dt><dd>{selectedRecommendation.conflict}</dd></div><div><dt>共同情绪</dt><dd>{selectedRecommendation.emotion}</dd></div></dl></div>
          </div>
          <div className={styles.evidenceHeading}><h4>匹配证据</h4><small>钩子证据 ↔ 正片证据</small></div>
          {selectedRecommendation.storyArc && <div className={styles.storyArc}><article><small>起因</small><p>{selectedRecommendation.storyArc.setup||"待补充"}</p></article><article><small>发展</small><p>{selectedRecommendation.storyArc.escalation||"待补充"}</p></article><article><small>兑现</small><p>{selectedRecommendation.storyArc.payoff||"待补充"}</p></article><article><small>落点</small><p>{selectedRecommendation.storyArc.ending||"待补充"}</p></article></div>}
          <div className={styles.riskBox}><h4>业务分与生产门</h4><p>故事线 {clampScore(selectedRecommendation.storyScore ?? selectedRecommendation.score)} 分 · 承诺兑现 {clampScore(selectedRecommendation.promiseFulfillmentScore)} 分</p><p>{selectedRecommendation.productionReady?"已通过生产门，可进入过渡与成片编排":selectedRecommendation.videoUrl?"模型建议暂缓；当前候选有真实视频，可由人工确认进入生产":"当前候选没有可播放视频，不能进入生产"}</p>{selectedRecommendation.productionGate?.reasons?.length ? <ul>{selectedRecommendation.productionGate.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}</div>
          {selectedRecommendation.videoUrl && !selectedRecommendation.productionReady && <div className={styles.riskBox}><h4>人工生产决策</h4><p>人工判断为第一优先级。确认后允许进入下一步，模型评分和风险项继续保留供后续预览、质检参考。</p><button type="button" onClick={()=>onOverrideRecommendation?.(selectedRecommendation)}>人工确认进入生产</button></div>}
          <div className={styles.riskBox}><h4>精确接点（最多 3 个）</h4>{selectedRecommendation.entryPoints?.slice(0,3).length?<ul>{selectedRecommendation.entryPoints.slice(0,3).map((point,index)=><li key={point.id??index}><button type="button" onClick={()=>onSelectEntryPoint?.(selectedRecommendation,index)}>EP {point.episode??selectedRecommendation.episode} · {point.start?.toFixed(2)??"待定"}s {point.recommended?"· 推荐":""}</button></li>)}</ul>:<p>尚无精确接点。</p>}<button type="button" onClick={()=>onRequestMoreEntryPoints?.(selectedRecommendation)}>追加接点分析</button></div>
          {selectedRecommendation.calibration && <div className={styles.riskBox}><h4>生产可信度校准</h4><p>校准概率 {Math.round((selectedRecommendation.calibration.calibratedProbability??0)*100)}% · 证据覆盖 {Math.round((selectedRecommendation.calibration.evidenceCoverage??0)*100)}% · 边界可靠度 {Math.round((selectedRecommendation.calibration.boundaryReliability??0)*100)}% · 故事完整度 {Math.round((selectedRecommendation.completeness?.confidence??0)*100)}%</p></div>}
          <div className={styles.evidenceList}>{selectedRecommendation.evidence.map((evidence) => <article key={evidence.id}><header><b>{evidence.dimension}</b>{evidence.confidence != null && <span>{clampScore(evidence.confidence)}% 可信</span>}</header><div><p><small>钩子</small>{evidence.hookEvidence}</p><i aria-hidden="true">↔</i><p><small>正片</small>{evidence.episodeEvidence}</p></div></article>)}</div>
          <div className={styles.riskBox}><h4>风险提示</h4>{selectedRecommendation.risks.length ? <ul>{selectedRecommendation.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>当前没有发现需要提示的匹配风险。</p>}</div>
        </> : resultState === "no_production_candidates" ? <EditableCandidatePanel candidates={match?.editableCandidates ?? []} onSelect={selectRecommendation} onRetry={onRetryMatch}/> : <EmptyState title={resultState === "running" || resultState === "waiting_supplemental" ? "分析完成后将在这里展示证据" : "请选择一个推荐高光"} detail={resultState === "running" || resultState === "waiting_supplemental" ? "候选不会在缺少真实证据时提前进入生产。" : "选中后可查看集数、精确帧、共同人物关系与逐项证据。"} />}
      </main>
    </div>}

    {currentTab === "transition" && <div className={styles.transitionLayout}>
      <div className={styles.sectionTitle}><div><span>过渡候选</span><h3>设计钩子到正片的连接</h3></div><button type="button" disabled={disabled} onClick={onRegenerateTransitions}>重新生成方案</button></div>
      {transitions.length ? <div className={styles.transitionGrid}>{transitions.slice(0, 5).map((transition, index) => <article key={transition.id} className={selectedTransition?.id === transition.id ? styles.transitionSelected : ""}>
        <button type="button" className={styles.transitionPick} onClick={() => selectTransition(transition)}>
          <span><i>{String(index + 1).padStart(2, "0")}</i><em>{transition.type}</em></span><h4>{transition.title}</h4><p>{transition.rationale}</p>
          {transition.copy && <blockquote>“{transition.copy}”</blockquote>}
          <dl><div><dt>时长</dt><dd>{transition.durationSeconds.toFixed(1)}s</dd></div><div><dt>自然度</dt><dd>{transition.continuityScore == null ? "待分析" : `${clampScore(transition.continuityScore)}%`}</dd></div><div><dt>剧透风险</dt><dd>{transition.spoilerRisk ?? "待分析"}</dd></div></dl>
        </button>
        <div className={styles.transitionActions}><span>{selectedTransition?.id === transition.id ? "✓ 已选方案" : "可选方案"}</span><button type="button" onClick={() => onPreviewTransition?.(transition)}>预览</button></div>
      </article>)}</div> : <EmptyState title="暂无过渡方案" detail="匹配承接点确认后，可生成 3–5 个旁白、动作、声音或字幕过渡方案。" />}
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
          <label><span>时长</span><input type="number" min="0.1" step="0.1" value={clip.durationSeconds} disabled={disabled || clip.locked} onChange={(event) => onUpdateClip?.(clip.id, { durationSeconds: Math.max(0.1, Number(event.target.value) || 0.1) })} /></label>
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
      <footer className={styles.qualityFooter}><span>{quality?.findings.filter((item) => item.severity === "阻断").length ?? 0} 个阻断项 · {quality?.findings.filter((item) => item.severity === "建议").length ?? 0} 个优化项</span><button type="button" disabled={disabled || quality?.verdict === "阻断" || quality?.status !== "completed"} onClick={onGeneratePreview}>生成预览并送审</button></footer>
    </div>}
  </section>;
}

export default ExternalHookAnalysis;
