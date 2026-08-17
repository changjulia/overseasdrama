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
  rationale: string;
  relationship: string;
  conflict: string;
  emotion: string;
  thumbnailUrl?: string;
  evidence: MatchEvidence[];
  risks: string[];
};

export type HookEpisodeMatch = {
  hookTitle: string;
  episodeTitle: string;
  status: "idle" | "running" | "completed" | "failed";
  summary?: string;
  recommendations: HighlightRecommendation[];
  selectedRecommendationId?: string;
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
  const selectedRecommendation = match?.recommendations.find((item) => item.id === currentRecommendationId) ?? match?.recommendations[0];
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
    <header className={styles.heading}>
      <div><span>EXTERNAL HOOK WORKBENCH</span><h2>钩子与正片组合工作台</h2><p>用可追溯证据确认承接点，再完成过渡、时间线和货不对板质检。</p></div>
      <div className={styles.headingStatus}><small>当前质检结论</small><strong data-verdict={quality?.verdict ?? "未质检"}>{quality?.verdict ?? "等待质检"}</strong></div>
    </header>

    <nav className={styles.tabs} aria-label="分析步骤">
      {tabs.map((tab) => <button type="button" key={tab.id} className={currentTab === tab.id ? styles.tabActive : ""} onClick={() => changeTab(tab.id)}><i>{tab.step}</i><span><b>{tab.label}</b><small>{tab.description}</small></span></button>)}
    </nav>

    {currentTab === "match" && <div className={styles.matchLayout}>
      <aside className={styles.recommendationList}>
        <div className={styles.sectionTitle}><div><span>高光推荐</span><h3>对应到正片的精确承接点</h3></div><em>{match?.recommendations.length ?? 0} 个候选</em></div>
        {match?.status === "running" ? <EmptyState title="正在分析匹配关系" detail="正在比对人物、矛盾、情绪与承诺兑现，请稍候。" /> : match?.recommendations.length ? match.recommendations.map((recommendation, index) => <button type="button" key={recommendation.id} className={`${styles.recommendation} ${selectedRecommendation?.id === recommendation.id ? styles.selected : ""}`} onClick={() => selectRecommendation(recommendation)}>
          <span className={styles.rank}>#{index + 1}</span>
          <span className={styles.recommendationCopy}><b>{recommendation.title}</b><small>{episodeLabel(recommendation.episode)} · {recommendation.startTimecode}{recommendation.endTimecode ? `–${recommendation.endTimecode}` : ""}</small><em>{recommendation.startFrame == null ? "帧号待探测" : `第 ${recommendation.startFrame.toLocaleString()} 帧`}{recommendation.fps ? ` · ${recommendation.fps}fps` : ""}</em></span>
          {recommendation.score != null && <strong>{clampScore(recommendation.score)}</strong>}
        </button>) : <EmptyState title="等待真实匹配结果" detail="选择本剧正片与外搭钩子后，分析服务会在这里返回高光及逐帧承接点。" />}
      </aside>

      <main className={styles.matchDetail}>
        {selectedRecommendation ? <>
          <div className={styles.matchHero}>
            {selectedRecommendation.thumbnailUrl ? <div className={styles.frameImage} role="img" aria-label={`${selectedRecommendation.title} 承接帧`} style={{ backgroundImage: `url(${selectedRecommendation.thumbnailUrl})` }} /> : <div className={styles.framePlaceholder}><span>{episodeLabel(selectedRecommendation.episode)}</span><b>{selectedRecommendation.startTimecode}</b><small>{selectedRecommendation.startFrame == null ? "帧号待媒体探测" : `第 ${selectedRecommendation.startFrame.toLocaleString()} 帧`}</small></div>}
            <div><span>推荐承接高光</span><h3>{selectedRecommendation.title}</h3><p>{selectedRecommendation.rationale}</p><dl><div><dt>人物关系</dt><dd>{selectedRecommendation.relationship}</dd></div><div><dt>核心矛盾</dt><dd>{selectedRecommendation.conflict}</dd></div><div><dt>共同情绪</dt><dd>{selectedRecommendation.emotion}</dd></div></dl></div>
          </div>
          <div className={styles.evidenceHeading}><h4>匹配证据</h4><small>钩子证据 ↔ 正片证据</small></div>
          <div className={styles.evidenceList}>{selectedRecommendation.evidence.map((evidence) => <article key={evidence.id}><header><b>{evidence.dimension}</b>{evidence.confidence != null && <span>{clampScore(evidence.confidence)}% 可信</span>}</header><div><p><small>钩子</small>{evidence.hookEvidence}</p><i aria-hidden="true">↔</i><p><small>正片</small>{evidence.episodeEvidence}</p></div></article>)}</div>
          <div className={styles.riskBox}><h4>风险提示</h4>{selectedRecommendation.risks.length ? <ul>{selectedRecommendation.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>当前没有发现需要提示的匹配风险。</p>}</div>
        </> : <EmptyState title="请选择一个推荐高光" detail="选中后可查看集数、精确帧、共同人物关系与逐项证据。" />}
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
