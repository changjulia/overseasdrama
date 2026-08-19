"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createInitialFactoryWorkflow, factoryModes } from "./mock-data";
import type { Draft, FactoryMode, FactoryWorkspaceProps } from "./types";
import ExternalHookAnalysis, {
  type ExternalHookTimelineClip,
  type HookEpisodeMatch,
  type HookTransitionOption,
  type ExternalHookQualityReport,
  type HighlightRecommendation,
} from "./components/ExternalHookAnalysis";
import ExternalHookDelivery from "./components/ExternalHookDelivery";
import baseStyles from "./factory.module.css";
import enhancementStyles from "./factory-enhancements.module.css";
import { listPocketBaseDramas } from "../../lib/pocketbase-drama-store";
import { listSelectableExternalHooks } from "../../lib/hook-asset-store";
import { approveHookMatchForProduction, getHookMatchJob, listHookStoryMatches, requestMoreEntryPoints, setHookMatchSoftOverride, startHookStoryMatch, type HookMatchJob, type HookStoryMatch } from "../../lib/hook-match-store";
import { exportFactoryRender, getFactoryRender, reviewFactoryRender, saveFactoryProject, startFactoryRender, type FactoryRenderRecord } from "../../lib/factory-production-store";
import type { FactorySourceContext } from "./types";
import { compareTagSets, normalizeTag, type OntologyDimension } from "../../lib/ontology";

const styles = { ...baseStyles, ...enhancementStyles };
// PRODUCTION WORKFLOW: 正片模式从钩子匹配开始；外搭模式使用独立的八步闭环。

const padEpisode = (episode: number) => `EP ${String(episode).padStart(2, "0")}`;
const timecode = (seconds: number) => `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const passesHardGate = (gate?: {passed?:boolean}) => gate?.passed === true;
const passesNonOverridableGate = (gate?: Record<string,unknown>) => {
  const checks=(gate?.requiredChecks&&typeof gate.requiredChecks==="object"?gate.requiredChecks:gate?.checks&&typeof gate.checks==="object"?gate.checks:{}) as Record<string,unknown>;
  const soft=new Set(["storyScore","story_score","understandingCost","understanding_cost","transitionDifficulty","transition_difficulty"]);
  return Object.entries(checks).every(([name,passed])=>passed!==false||soft.has(name));
};
const isProductionReadyMatch = (item: HookStoryMatch) => item.humanVideoApproved || passesHardGate(item.productionGate)
  && item.storyScore >= 75
  && item.promiseFulfillmentScore >= 70;
const isEditableBackupMatch = (item: HookStoryMatch) => passesNonOverridableGate(item.productionGate)
  && item.storyScore >= 65 && item.storyScore < 75
  && item.promiseFulfillmentScore >= 70;

function selectedRange(episodes: number[]) {
  if (!episodes.length) return "未选择片源";
  return episodes.map(padEpisode).join("、");
}

function previewTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function HookTimelinePreview({ url, start, end, title }: { url: string; start: number; end: number; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.1, end);
  const duration = safeEnd - safeStart;
  const [current, setCurrent] = useState(safeStart);

  const seek = (relativeSeconds: number) => {
    const next = Math.min(safeEnd, Math.max(safeStart, safeStart + relativeSeconds));
    setCurrent(next);
    if (videoRef.current?.readyState) videoRef.current.currentTime = next;
  };

  return <div
    className={styles.hookPreviewShell}
    onMouseEnter={() => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = true;
      if (video.currentTime >= safeEnd - 0.05) video.currentTime = safeStart;
      void video.play().catch(() => undefined);
    }}
    onMouseLeave={() => videoRef.current?.pause()}
  >
    <video
      ref={videoRef}
      className={styles.selectedHookPreview}
      src={`${url}#t=${safeStart}`}
      muted
      playsInline
      preload="metadata"
      aria-label={`${title} 钩子预览`}
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = safeStart; setCurrent(safeStart); }}
      onTimeUpdate={(event) => {
        const video = event.currentTarget;
        if (video.currentTime >= safeEnd) { video.pause(); video.currentTime = safeEnd; setCurrent(safeEnd); }
        else setCurrent(Math.max(safeStart, video.currentTime));
      }}
    />
    <div className={styles.hookSeekBar}>
      <input
        type="range"
        min={0}
        max={duration}
        step={0.01}
        value={Math.min(duration, Math.max(0, current - safeStart))}
        aria-label="拖拽钩子预览时间轴"
        onPointerDown={() => videoRef.current?.pause()}
        onChange={(event) => seek(Number(event.currentTarget.value))}
      />
      <span>{previewTime(current - safeStart)} / {previewTime(duration)}</span>
    </div>
  </div>;
}

export function FactoryWorkspace({ initialMode = "episode-splice", editingDraft, sourceContext, dramaSourceContext, hookSourceContext, onModeChange, onChooseDrama, onChooseHook, onDraftAutoSave, onOpenDrafts, onNotify }: FactoryWorkspaceProps) {
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
  const defaultFreeEpisodes = useMemo(() => connectedEpisodes.filter((episode) => episode <= (source?.freeEpisodes ?? connectedEpisodes.length)), [connectedEpisodes, source?.freeEpisodes]);
  const [episodes, setEpisodes] = useState<number[]>(() => editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode)) ?? defaultFreeEpisodes);
  const [previewEpisode, setPreviewEpisode] = useState<number | null>(() => episodes[0] ?? null);
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "尚未保存");
  const [autoSaveCountdown, setAutoSaveCountdown] = useState(15);
  const [dirty, setDirty] = useState(false);
  const [activeStep, setActiveStep] = useState(editingDraft?.isHistorySnapshot ? 6 : 0);
  const goal = "停滑与点击";
  const [hookSource, setHookSource] = useState("同题材高表现钩子");
  const [transition, setTransition] = useState("时间倒叙旁白");
  const variantCount = 6;
  const [qualityConfirmed, setQualityConfirmed] = useState(Boolean(editingDraft?.factorySnapshot?.qualityReport));
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string|undefined>(editingDraft?.storyMatchId);
  const [selectedTransitionId, setSelectedTransitionId] = useState(String(editingDraft?.factorySnapshot?.transition?.id||"bridge-narration"));
  const [timeline, setTimeline] = useState<ExternalHookTimelineClip[]>(()=>Array.isArray(editingDraft?.factorySnapshot?.timeline)?editingDraft.factorySnapshot.timeline as ExternalHookTimelineClip[]:[]);
  const [sourcePicker,setSourcePicker]=useState<"drama"|"hook"|null>(null);
  const [pickerLoading,setPickerLoading]=useState(false);
  const [pickerError,setPickerError]=useState("");
  const [dramaOptions,setDramaOptions]=useState<FactorySourceContext[]>([]);
  const [hookOptions,setHookOptions]=useState<FactorySourceContext[]>([]);
  const [hookThemeFilter,setHookThemeFilter]=useState("全部主题");
  const [hookTagQuery,setHookTagQuery]=useState("");
  const [hookQueryDimension,setHookQueryDimension]=useState<OntologyDimension>("theme");
  const [targetDurationSeconds,setTargetDurationSeconds]=useState(()=>editingDraft?.workflow?.goal.targetDurationSeconds===1500?1500:900);
  const [storyOverrides,setStoryOverrides]=useState<string[]>([]);
  const [selectedEntryPoints,setSelectedEntryPoints]=useState<Record<string,number>>({});
  const [paidScopeConfirmed,setPaidScopeConfirmed]=useState(false);
  const [matchRetryToken,setMatchRetryToken]=useState(0);
  const [matchRequestToken,setMatchRequestToken]=useState(0);
  const [entryRefreshToken,setEntryRefreshToken]=useState(0);
  const [matchJob,setMatchJob]=useState<HookMatchJob|null>(null);
  const [storyMatches,setStoryMatches]=useState<HookStoryMatch[]>([]);
  const [matchError,setMatchError]=useState("");
  const entryPollAttemptsRef=useRef(0);
  const [factoryProjectId,setFactoryProjectId]=useState<string|undefined>(editingDraft?.factoryProjectId);
  const [factoryRender,setFactoryRender]=useState<FactoryRenderRecord|null>(null);
  const [draftId,setDraftId] = useState(() => editingDraft?.id ?? `draft-${Date.now()}`);
  const [draftVersion,setDraftVersion]=useState(editingDraft?.version??1);
  const [historyForked,setHistoryForked]=useState(!editingDraft?.isHistorySnapshot);
  const autoSaveSecondsRef = useRef(15);
  const definition = factoryModes.find((item) => item.id === mode)!;
  const previewMedia = previewEpisode == null ? undefined : source?.episodeMedia?.[previewEpisode];
  const availableWithoutConnection = (source?.availableEpisodes ?? []).filter((episode) => !source?.episodeMedia?.[episode]?.url);
  const canCreate = Boolean(source?.kind === "library" && episodes.length && episodes.every((episode) => source.episodeMedia?.[episode]?.url));
  const externalReady = Boolean(dramaSource && hookSourceInput);
  const containsPaidEpisodes = episodes.some(episode=>episode>(dramaSource?.freeEpisodes??Number.MAX_SAFE_INTEGER));
  const steps = mode === "external-hook" ? definition.steps : ["钩子匹配", "过渡生成", "组合版本", "统一质检"];
  const externalPageTitles = ["选择剧集", "根据主题 / 内容标签筛选外搭钩子", "匹配完整故事线与投放区间", "设计钩子到正片的过渡", "编排成片时间线", "执行生成前质检", "生成并预览成片", "保存与导出成片"];
  const hasApprovedStoryMatch = Boolean(selectedRecommendationId && storyMatches.some(item=>item.id===selectedRecommendationId&&(isProductionReadyMatch(item)||(storyOverrides.includes(item.id)&&isEditableBackupMatch(item)))));
  const stepReady = mode === "external-hook"
    ? [Boolean(dramaSource && episodes.length), Boolean(hookSourceInput?.hookAssetId), hasApprovedStoryMatch, hasApprovedStoryMatch&&Boolean(selectedTransitionId), hasApprovedStoryMatch&&Boolean(timeline.length), hasApprovedStoryMatch&&qualityConfirmed, false, false]
    : [Boolean(hookSource), Boolean(transition), variantCount > 0, qualityConfirmed];

  const match = useMemo<HookEpisodeMatch>(() => {
    const seenIntervals = new Set<string>();
    const candidateRecommendations = [...storyMatches].sort((a,b)=>b.storyScore-a.storyScore||b.promiseFulfillmentScore-a.promiseFulfillmentScore||b.matchScore-a.matchScore).slice(0,3).flatMap((item) => {
      const first=item.segments[0],last=item.segments[item.segments.length-1];
      if(!first||!last)return [];
      const rawEntries=item.entryPoints.slice(0,3),selectedEntryIndex=selectedEntryPoints[item.id]??Math.max(0,rawEntries.findIndex(value=>(value as {recommended?:boolean}).recommended));
      const entry=(rawEntries[selectedEntryIndex]??rawEntries[0]) as {start?:number;frame?:number}|undefined,fps=dramaSource?.episodeMedia?.[first.episode]?.fps;
      // This list represents entry points, not every possible downstream story
      // route. Two matches that enter the same approved source interval are one
      // actionable candidate even when their later segments differ.
      const entryStart=entry?.start??first.start;
      const intervalKey=`${first.episode}:${entryStart.toFixed(2)}-${first.end.toFixed(2)}`;
      if(seenIntervals.has(intervalKey))return [];
      seenIntervals.add(intervalKey);
      const episodeTitle=first.purpose||item.storyArc.payoff||item.storyArc.ending||`第 ${first.episode} 集正片承接区间`;
      const overridden=item.humanVideoApproved||storyOverrides.includes(item.id);
      return [{id:item.id,title:episodeTitle,episode:first.episode,startTimecode:timecode(entryStart),endTimecode:timecode(last.end),startSeconds:entryStart,endSeconds:first.end,videoUrl:dramaSource?.episodeMedia?.[first.episode]?.url,startFrame:entry?.frame??(fps==null?undefined:Math.round(entryStart*fps)),fps,score:item.matchScore,storyScore:item.storyScore,promiseFulfillmentScore:item.promiseFulfillmentScore,productionReady:isProductionReadyMatch(item)||overridden,editableBackup:isEditableBackupMatch(item),overrideApplied:overridden,rationale:[item.storyArc.setup,item.storyArc.escalation,item.storyArc.payoff,item.storyArc.ending].filter(Boolean).join(" → "),relationship:(hookSourceInput?.relationships??[]).join("、")||"关系证据待复核",conflict:hookSourceInput?.conflict||"冲突待复核",emotion:hookSourceInput?.emotion||"情绪待复核",evidence:[{id:`promise-${item.id}`,dimension:"承诺兑现" as const,hookEvidence:hookSourceInput?.narrativePromise||hookSourceInput?.informationGap||"钩子叙事承诺",episodeEvidence:item.storyArc.payoff||item.storyArc.ending||"正片兑现证据",confidence:item.dimensionScores.promise}],risks:item.risks,storyArc:item.storyArc,segments:item.segments,entryPoints:rawEntries as HighlightRecommendation["entryPoints"],completeness:item.completeness as HighlightRecommendation["completeness"],calibration:item.calibration as HighlightRecommendation["calibration"],productionGate:item.productionGate as HighlightRecommendation["productionGate"],matchStatus:item.status}];
    });
    const recommendations=candidateRecommendations.filter(item=>item.productionReady);
    const editableCandidates=candidateRecommendations.filter(item=>!item.productionReady);
    const reasonCounts=new Map<string,number>();
    storyMatches.forEach(item=>{const reasons=(item.productionGate.reasons as string[]|undefined)??item.risks;if(!reasons.length)reasonCounts.set("故事分或承诺兑现未达到候选门槛",(reasonCounts.get("故事分或承诺兑现未达到候选门槛")??0)+1);reasons.forEach(reason=>reasonCounts.set(reason,(reasonCounts.get(reason)??0)+1))});
    const diagnostics=matchJob?.diagnostics;
    const waitingSupplemental=diagnostics?.outcomeStatus==="waiting_supplemental"||(matchJob?.status==="running"&&/supplement|highlight|高光/i.test(matchJob.stage));
    const diagnosticLabels:Record<string,string>={boundary_unverified:"高光边界尚未验证",action_incomplete:"动作或对白不完整",duration_out_of_range:"候选时长不在可生产区间",invalid_media_boundary:"媒体时间边界无效",story_score:"故事分未达生产线",understanding_cost:"陌生观众理解成本过高",transition_difficulty:"过渡难度过高"};
    return {
      hookTitle: hookSourceInput?.title ?? "尚未选择外搭钩子",
      episodeTitle: dramaSource?.dramaCn ?? dramaSource?.title ?? "尚未选择本剧正片",
      status: matchError||matchJob?.status==="failed"?"failed":matchJob?.status==="running"||matchJob?.status==="queued"?"running":recommendations.length||storyMatches.length||matchJob?.status==="succeeded"?"completed":"idle",
      summary: matchError||(storyMatches.length&&!recommendations.length?"匹配已完成并返回候选，但候选仍需补证或审核，暂不能进入生产。":undefined),
      recommendations,
      editableCandidates,
      resultState: matchError||matchJob?.status==="failed"||diagnostics?.outcomeStatus==="failed"||diagnostics?.outcomeStatus==="partial"?"failed":waitingSupplemental?"waiting_supplemental":matchJob?.status==="running"||matchJob?.status==="queued"?"running":matchJob?.status==="succeeded"&&!recommendations.length?"no_production_candidates":recommendations.length?"completed":"idle",
      progress: matchJob?.progress,
      stage: matchJob?.stage,
      scope:{episodes,scopeLabel:containsPaidEpisodes?"包含付费集":"仅免费集",targetDurationLabel:targetDurationSeconds>900?"目标 15–25 分钟":"目标 5–15 分钟"},
      funnel:{analyzedEpisodes:diagnostics?.funnel.episodesRequested||episodes.length,rawCandidates:diagnostics?.funnel.rawCandidates??storyMatches.length,editableCandidates:Math.max(diagnostics?.funnel.editableCandidates??0,editableCandidates.length),productionCandidates:recommendations.length},
      rejectionReasons:(diagnostics?.rejectionReasons.length?diagnostics.rejectionReasons.map(item=>({label:diagnosticLabels[item.code]||item.code,count:item.count})):[...reasonCounts.entries()].map(([label,count])=>({label,count}))).sort((a,b)=>b.count-a.count).slice(0,5),
      selectedRecommendationId,
    };
  }, [containsPaidEpisodes, dramaSource, episodes, hookSourceInput, matchError, matchJob, selectedEntryPoints, selectedRecommendationId, storyMatches, storyOverrides, targetDurationSeconds]);

  const transitionOptions = useMemo<HookTransitionOption[]>(() => [
    { id: "fade-cut", title: "短淡出淡入", type: "直接切入", durationSeconds: .25, rationale: "用短音画淡出淡入明确外搭与正片来源切换。", spoilerRisk: "低" },
    { id: "hard-cut", title: "直接硬切", type: "直接切入", durationSeconds: 0, rationale: "不插入过渡帧，保留最大节奏冲击。", spoilerRisk: "低" },
    { id: "soft-fade", title: "长淡出淡入", type: "直接切入", durationSeconds: .5, rationale: "用更柔和的音画过渡降低人物与场景突变感。", spoilerRisk: "低" },
  ], []);

  const effectiveRecommendationId = selectedRecommendationId ?? match.recommendations[0]?.id;
  const selectedRecommendation = match.recommendations.find((item) => item.id === effectiveRecommendationId) ?? match.recommendations[0];
  const selectedTransition = transitionOptions.find((item) => item.id === selectedTransitionId) ?? transitionOptions[0];
  const qualityReport = useMemo<ExternalHookQualityReport>(() => {
    const findings: ExternalHookQualityReport["findings"] = [];
    const humanApproved = selectedRecommendation?.overrideApplied === true;
    if (!dramaSource) findings.push({ id: "drama", severity: "阻断", category: "连续性", title: "尚未选择本剧正片", detail: "需要从剧库带入真实剧目与片源。" });
    if (!hookSourceInput) findings.push({ id: "hook", severity: "阻断", category: "首帧", title: "尚未选择外搭钩子", detail: "需要从收藏或灵感大屏带入钩子素材。" });
    if (hookSourceInput && hookSourceInput.hookSourceClass !== "external_material") findings.push({ id: "hook-source", severity: "阻断", category: "货不对板", title: "钩子不是外搭素材片段", detail: "此模式只允许匹配从外搭素材中定位出的具体钩子。" });
    if (hookSourceInput && hookSourceInput.hookBoundaryStatus !== "verified") findings.push({ id: "hook-boundary", severity: "阻断", category: "连续性", title: "钩子边界尚未验证", detail: "钩子起止点必须同时通过完整对白、完整动作和镜头边界检查。" });
    if (hookSourceInput && !["已获授权可制作","已获授权可投放"].includes(hookSourceInput.rightsStatus??"")) findings.push({ id: "hook-rights", severity: "建议", category: "合规", title: "钩子授权状态待确认", detail: "当前版本不把授权状态作为生产硬门，但正式投放前仍建议核对。" });
    if (dramaSource && hookSourceInput && !selectedRecommendation) findings.push({ id: "match", severity: "阻断", category: "承诺兑现", title: "没有可追溯的高光承接点", detail: "请先完成本剧高光解析，匹配必须对应到具体集数和帧。" });
    if (selectedRecommendation && !selectedRecommendation.videoUrl) findings.push({ id: "story-video", severity: "阻断", category: "连续性", title: "候选没有可播放正片", detail: "人工批准的前提是候选关联真实视频和有效时间范围。" });
    if (selectedRecommendation?.matchStatus==="needs_review"&&!passesHardGate(selectedRecommendation.productionGate)) findings.push({ id: "match-review", severity: humanApproved?"建议":"阻断", category: "连续性", title: humanApproved?"人工已接管承接判断":"承接证据需要复核", detail: humanApproved?"该视频候选已由人工批准；模型复核问题保留为预览检查项。":"匹配结果存在安全边界或硬性证据问题；请结合生产门禁明细处理。" });
    if (selectedRecommendation?.productionGate&&!passesHardGate(selectedRecommendation.productionGate)) findings.push({ id: "production-gate", severity: humanApproved?"建议":"阻断", category: "承诺兑现", title: humanApproved?"模型生产门未通过，人工已批准":"匹配尚未通过生产门禁", detail: selectedRecommendation.productionGate.reasons?.join("；")||"需要满足校准概率、证据覆盖和边界可靠度要求。" });
    if (selectedRecommendation?.completeness?.status==="partial") findings.push({ id: "story-advisory", severity: "建议", category: "承诺兑现", title: "故事采用高吸引力截取结构", detail: `当前未覆盖完整故事阶段：${selectedRecommendation.completeness.missingPhases?.join("、")||"部分因果链"}。允许继续生成，请在预览中确认不影响理解。` });
    if ((selectedRecommendation?.calibration?.calibratedProbability??0)>=.9 && (selectedRecommendation?.completeness?.confidence??0)<.5 && (selectedRecommendation?.completeness?.causalCoverage??0)<.5) findings.push({ id: "score-consistency", severity: "建议", category: "承诺兑现", title: "高匹配分与结构证据不一致", detail: "标签与对白相似度较高，但事件因果链和故事阶段覆盖不足；95 分不能等同于完整承接质量。", suggestion: "保留高刺激短线，同时在预览中重点检查片段间语义跳跃" });
    if (selectedTransition.id==="hard-cut" && hookSourceInput?.hookSourceClass==="external_material") findings.push({ id: "transition-risk", severity: "建议", category: "连续性", title: "外搭素材使用硬切", detail: "外搭人物与正片人物、场景通常不同，硬切可能造成来源突变。", suggestion: "优先比较短淡出淡入版本" });
    if (selectedRecommendation?.segments?.some(segment=>segment.safeStart?.status!=="verified"||segment.safeEnd?.status!=="verified")) findings.push({ id: "segment-boundary", severity: humanApproved?"建议":"阻断", category: "连续性", title: "正片片段存在不安全切点", detail: humanApproved?"人工已允许进入生产，请在预览中重点检查对白、动作和反应镜头是否截断。":"时间线不能截断人物完整一句话、连续动作或反应镜头。" });
    if (selectedRecommendation && !hookSourceInput?.narrativePromise) findings.push({ id: "promise", severity: "建议", category: "承诺兑现", title: "钩子叙事承诺需要确认", detail: "钩子已有时间码，但叙事承诺尚未形成可审核文本。", suggestion: "在钩子原型页补充承诺拆解" });
    if (selectedRecommendation && !findings.some(item=>item.severity==="阻断")) findings.push({ id: "evidence", severity: "通过", category: "承诺兑现", title: "匹配证据与安全边界可追溯", detail: "匹配结果包含具体剧集区间、承接证据及双端安全边界；故事完整度单独作为创意建议。" });
    const sourceScore = dramaSource&&hookSourceInput?.hookSourceClass==="external_material" ? 20 : 0;
    const playableScore = selectedRecommendation?.videoUrl ? 20 : 0;
    const boundaryScore = hookSourceInput?.hookBoundaryStatus==="verified" ? 10 : 0;
    const segmentBoundaryRatio = selectedRecommendation?.segments?.length ? selectedRecommendation.segments.filter(segment=>segment.safeStart?.status==="verified"&&segment.safeEnd?.status==="verified").length/selectedRecommendation.segments.length : 0;
    const storyScore = Math.round(Math.min(15,Math.max(0,(selectedRecommendation?.storyScore??0)*.15)));
    const promiseScore = Math.round(Math.min(15,Math.max(0,(selectedRecommendation?.promiseFulfillmentScore??0)*.15)));
    const evidenceScore = Math.round(Math.min(10,Math.max(0,(((selectedRecommendation?.calibration?.evidenceCoverage??0)+(selectedRecommendation?.calibration?.boundaryReliability??0))/2)*10)));
    const continuityScore = Math.round(segmentBoundaryRatio*5)+(selectedTransition.id==="hard-cut"?2:5);
    let score = Math.max(0,Math.min(100,sourceScore+playableScore+boundaryScore+storyScore+promiseScore+evidenceScore+continuityScore));
    if (findings.some(item=>item.severity==="阻断")) score=Math.min(score,59);
    const verdict = findings.some((item) => item.severity === "阻断") ? "阻断" : findings.some((item)=>item.severity==="建议")?"建议优化":"可以直接生成";
    return { status: "completed", verdict, score, checkedAt:new Date().toLocaleString("zh-CN",{hour12:false}), findings };
  }, [dramaSource, hookSourceInput, selectedRecommendation, selectedTransition.id]);

  const defaultTimeline = useMemo<ExternalHookTimelineClip[]>(() => {
    if (!selectedRecommendation || !hookSourceInput) return [];
    const storyClips=(selectedRecommendation.segments??[]).map((segment,index)=>({id:`clip-episode-${index+1}`,kind:(index===0?"episode":index===(selectedRecommendation.segments?.length??1)-1?"paywall":"climax") as ExternalHookTimelineClip["kind"],title:`${padEpisode(segment.episode)} · ${segment.purpose||"完整故事段"}`,sourceLabel:dramaSource?.dramaCn??dramaSource?.title??"本剧正片",durationSeconds:Math.max(0,segment.end-segment.start),episode:segment.episode,startTimecode:timecode(segment.start),endTimecode:timecode(segment.end),startSeconds:segment.start,endSeconds:segment.end,locked:segment.safeStart?.status!=="verified"||segment.safeEnd?.status!=="verified"}));
    return [
      { id: "clip-hook", kind: "hook", title: hookSourceInput.title, sourceLabel: hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏", durationSeconds: Math.max(0,(hookSourceInput.hookEnd??0)-(hookSourceInput.hookStart??0)),startTimecode:timecode(hookSourceInput.hookStart??0),endTimecode:timecode(hookSourceInput.hookEnd??0),locked:hookSourceInput.hookBoundaryStatus!=="verified" },
      { id: "clip-transition", kind: "transition", title: selectedTransition.title, sourceLabel: "过渡设计", durationSeconds: selectedTransition.durationSeconds },
      ...storyClips,
    ];
  }, [dramaSource, hookSourceInput, selectedRecommendation, selectedTransition]);
  const visibleTimeline = timeline.length ? timeline : defaultTimeline;

  const buildDraft = (projectIdOverride?:string): Draft => {
    const workflow = createInitialFactoryWorkflow();
    workflow.currentStep = workflow.steps[activeStep]?.id ?? "episode-source";
    workflow.goal = {
      objective: goal === "停滑与点击" ? "click-through" : goal === "连续观看" ? "completion" : "conversion",
      market: "美国",
      language,
      platform: "Meta",
      ratio,
      targetDurationSeconds,
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
    version: draftVersion,
    sourceContext: source,
    hookSourceContext: hookSourceInput,
    selectedEpisodes: episodes,
    workflow,
    factoryProjectId:projectIdOverride??factoryProjectId,
    factoryRenderId: factoryRender?.id,
    storyMatchId: selectedRecommendation?.id,
    isHistorySnapshot: !historyForked,
    factorySnapshot: {timeline:visibleTimeline,transition:selectedTransition as unknown as Record<string,unknown>,qualityReport:qualityReport as unknown as Record<string,unknown>,review:editingDraft?.factorySnapshot?.review??{},projectStatus:factoryRender?.status??"editing"},
  });
  };

  const save = async (silent = false) => {
    if (silent && !dirty) return;
    if (!source && !hookSourceInput) {
      if (!silent) onNotify?.("请先选择本剧正片或外搭钩子");
      return;
    }
    if(editingDraft?.isHistorySnapshot&&!historyForked&&!dirty){onDraftAutoSave?.(buildDraft(factoryProjectId));if(!silent)onNotify?.("历史版本未发生修改，已保留原成片与审核记录");return}
    let persistedProjectId=factoryProjectId;
    if(mode==="external-hook"&&externalReady&&selectedRecommendation){try{persistedProjectId=(await persistExternalProject()).id}catch(error){if(!silent)onNotify?.(error instanceof Error?error.message:"生产项目保存失败");return}}
    const draft = buildDraft(persistedProjectId);
    onDraftAutoSave?.(draft);
    setSavedAt("刚刚自动保存");
    autoSaveSecondsRef.current = 15;
    setAutoSaveCountdown(15);
    setDirty(false);
    if (!silent) onNotify?.("制作草稿已保存到「我的创作」");
  };

  const persistExternalProject=async()=>{
    if(!dramaSource?.id||!hookSourceInput?.hookAssetId||!selectedRecommendation||!visibleTimeline.length)throw new Error("请先完成钩子、剧集与完整故事线匹配");
    const project=await saveFactoryProject({id:factoryProjectId,forkFrom:!factoryProjectId&&historyForked?editingDraft?.factoryProjectId:undefined,forkReason:"历史草稿参数修改自动副本",changedParameters:["标题","剧集范围","外搭钩子","故事线","过渡方案","时间线","输出比例","成片语种","质检确认"],title:title.trim()||`${dramaSource.dramaCn??dramaSource.title} · 外搭钩子版`,dramaId:dramaSource.id,hookId:hookSourceInput.hookAssetId,storyMatchId:selectedRecommendation.id,selectedEpisodes:episodes,topics:hookSourceInput.themes??[],transition:selectedTransition,timeline:visibleTimeline,qualityReport:qualityReport,version:draftVersion,ratio,language,paidScopeConfirmed});setFactoryProjectId(project.id);return project;
  };

  const requestExternalRender=async()=>{
    const project=await persistExternalProject(),render=await startFactoryRender(project.id);setFactoryRender(render);
    const controller=new AbortController();
    for(let attempts=0;attempts<900;attempts+=1){await new Promise(resolve=>window.setTimeout(resolve,2000));const current=await getFactoryRender(render.id,controller.signal);setFactoryRender(current);if(current.status==="succeeded"){onNotify?.("真实预览已生成，等待人工审核");return}if(current.status==="failed")throw new Error(current.error||"真实预览生成失败")}
    controller.abort();throw new Error("渲染超时，请到任务中心查看")
  };

  const latestSaveRef = useRef(save);
  useEffect(() => { latestSaveRef.current = save; });

  useEffect(() => {
    if (!source) return;
    autoSaveSecondsRef.current = 15;
    const timer = window.setInterval(() => {
      autoSaveSecondsRef.current -= 1;
      if (autoSaveSecondsRef.current <= 0) {
        void latestSaveRef.current(true);
        autoSaveSecondsRef.current = 15;
      }
      setAutoSaveCountdown(autoSaveSecondsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [source, hookSourceInput?.id]);

  const touch = () => {
    if (!historyForked) {
      setHistoryForked(true); setFactoryProjectId(undefined); setFactoryRender(null); setDraftId(`draft-${Date.now()}`); setDraftVersion((value)=>value+1); setTitle((value)=>value.endsWith("· 副本")?value:`${value} · 副本`);
      onNotify?.("检测到历史版本参数变更，已自动创建原草稿副本");
    }
    setDirty(true);
  };
  useEffect(()=>{if(!editingDraft?.factoryRenderId)return;const controller=new AbortController();void getFactoryRender(editingDraft.factoryRenderId,controller.signal).then(setFactoryRender).catch(()=>{});return()=>controller.abort()},[editingDraft?.factoryRenderId]);
  useEffect(()=>{if(!sourcePicker)return;const controller=new AbortController();void (sourcePicker==="drama"?listPocketBaseDramas().then(records=>setDramaOptions(records.map(record=>({kind:"library" as const,id:record.recordId,title:record.title,dramaTitle:record.title,dramaCn:record.cn,description:`${record.genre} · ${record.language} · ${Object.keys(record.episodeMedia).length}/${record.totalEpisodes} 集片源`,genre:record.genre,language:record.language,episodes:record.totalEpisodes,freeEpisodes:record.freeEpisodes,availableEpisodes:Object.keys(record.episodeMedia).map(Number),episodeMedia:record.episodeMedia,highlightCandidates:[]})))):listSelectableExternalHooks(controller.signal).then(items=>setHookOptions(items.map(item=>({kind:"inspiration" as const,id:item.id,hookAssetId:item.id,hookSourceClass:item.sourceClass,hookMaterialId:item.materialId,hookMediaUrl:item.materialVideoUrl,hookStart:item.start,hookEnd:item.end,hookStartFrame:item.startFrame,hookEndFrame:item.endFrame,hookBoundaryStatus:item.boundaryStatus,hookType:item.hookType,themes:item.themes,contentTags:item.contentTags,ontologyTags:item.ontologyTags,relationships:item.relationships,conflict:item.conflict,emotion:item.emotion,narrativePromise:item.narrativePromise,informationGap:item.informationGap,rightsStatus:item.rightsStatus,title:item.title,description:`${item.materialTitle??"灵感大屏"} · ${item.hookType} · ${item.start.toFixed(2)}–${item.end.toFixed(2)} 秒`}))))).catch(error=>{if(!controller.signal.aborted)setPickerError(error instanceof Error?error.message:"素材读取失败")}).finally(()=>{if(!controller.signal.aborted)setPickerLoading(false)});return()=>controller.abort()},[sourcePicker]);
  const openPicker=(kind:"drama"|"hook")=>{setPickerLoading(true);setPickerError("");setSourcePicker(kind)};
  const openDramaPicker=()=>openPicker("drama");
  const openHookPicker=()=>openPicker("hook");
  const hookThemes=[...new Set(hookOptions.flatMap(option=>option.themes??[]))];
  const filteredHookOptions=hookOptions.filter(option=>{
    const themeMatch=hookThemeFilter==="全部主题"||compareTagSets([hookThemeFilter],(option.themes??[]),"theme").relation!=="contradictory";
    const dimensionLabels=(option.ontologyTags??[]).filter(tag=>tag.dimension===hookQueryDimension).map(tag=>tag.original??tag.label);
    return themeMatch&&(!hookTagQuery.trim()||dimensionLabels.some(label=>label.toLowerCase().includes(hookTagQuery.trim().toLowerCase())));
  }).map(option=>{
    const targetLabels:Array<{label:string;dimension:OntologyDimension}>=[dramaSource?.genre?{label:dramaSource.genre,dimension:"genre"}:null,hookThemeFilter!=="全部主题"?{label:hookThemeFilter,dimension:"theme"}:null,hookTagQuery.trim()?{label:hookTagQuery.trim(),dimension:hookQueryDimension}:null].filter((value):value is {label:string;dimension:OntologyDimension}=>Boolean(value));
    const hookTags=option.ontologyTags??[];
    let score=0,verifiedCount=0;const reasons:string[]=[];let relation:FactorySourceContext["hookMatchRelation"]="unknown";
    for(const requested of targetLabels){const target=normalizeTag(requested.label,requested.dimension);const candidates=hookTags.filter(tag=>tag.dimension===target.dimension).map(tag=>tag.original??tag.label);if(!candidates.length){reasons.push(`${target.label}：证据未知`);continue}const compared=compareTagSets([requested.label],candidates,target.dimension);if(compared.relation!=="unknown"){score+=compared.score;verifiedCount+=1}if(compared.relation==="contradictory")relation="contradictory";else if(relation!=="contradictory"&&(compared.relation==="exact"||compared.relation==="compatible"||compared.relation==="bridgeable"))relation=compared.relation;reasons.push(`${target.label}：${compared.relation==="unknown"?"证据未知":compared.relation}`)}
    return {...option,hookMatchScore:verifiedCount?Math.round(Math.max(0,Math.min(1,score/verifiedCount))*100):undefined,hookMatchRelation:relation,hookMatchReasons:reasons};
  }).sort((left,right)=>(right.hookMatchScore??-1)-(left.hookMatchScore??-1));
  useEffect(()=>{
    if(mode!=="external-hook"||matchRequestToken===0||!hookSourceInput?.hookAssetId||!dramaSource?.id||!episodes.length)return;
    const controller=new AbortController();let pollTimer:number|undefined;
    const run=async()=>{try{
      setMatchError("");
      const existing=await listHookStoryMatches(hookSourceInput.hookAssetId!,dramaSource.id,controller.signal);
      if(controller.signal.aborted)return;
      setStoryMatches(existing);
      // A history draft must restore its exact approved story-match snapshot.
      // Re-running matching here both loses the saved selection temporarily and
      // creates unnecessary analysis jobs every time the user opens a draft.
      if(matchRetryToken===0&&selectedRecommendationId&&existing.some(item=>item.id===selectedRecommendationId))return;
      const requestedScope=[...episodes].sort((a,b)=>a-b).join(",");
      const requestedTopics=[...(hookSourceInput.themes??[])].sort().join("|");
      const requestedScopeMode=episodes.some(episode=>episode>(dramaSource.freeEpisodes??0))?"custom":"free_only";
      const requestedDurationBand=targetDurationSeconds>900?"15_25m":"5_15m";
      const compatible=existing.filter(item=>item.matchContextHash&&item.scopeMode===requestedScopeMode&&item.targetDurationBand===requestedDurationBand&&[...item.episodeScope].sort((a,b)=>a-b).join(",")===requestedScope&&[...item.topics].sort().join("|")===requestedTopics&&item.segments.length>0);
      const scoped=compatible[0];
      if(matchRetryToken===0&&scoped){setStoryMatches(compatible);setSelectedRecommendationId(scoped.id);return}
      setStoryMatches([]);
      const created=await startHookStoryMatch(hookSourceInput.hookAssetId!,dramaSource.id,episodes,hookSourceInput.themes??[],requestedScopeMode,targetDurationSeconds,true);entryPollAttemptsRef.current=0;setMatchJob(created);
      const poll=async()=>{if(controller.signal.aborted)return;const current=await getHookMatchJob(created.id,controller.signal);setMatchJob(current);if(current.status==="succeeded"){setStoryMatches(await listHookStoryMatches(hookSourceInput.hookAssetId!,dramaSource.id,controller.signal));setMatchRetryToken(0);return}if(current.status==="failed"){setMatchError(current.error||"故事线匹配失败");return}pollTimer=window.setTimeout(()=>void poll(),2000)};await poll()
    }catch(error){if(!controller.signal.aborted)setMatchError(error instanceof Error?error.message:"故事线匹配任务创建失败")}};
    const startTimer=window.setTimeout(()=>void run(),0);return()=>{controller.abort();window.clearTimeout(startTimer);if(pollTimer)window.clearTimeout(pollTimer)};
  },[dramaSource?.id,episodes.join(","),hookSourceInput?.hookAssetId,matchRequestToken,matchRetryToken,mode,targetDurationSeconds]);
  useEffect(()=>{
    if(!hookSourceInput?.hookAssetId||!dramaSource?.id||!storyMatches.slice(0,3).some(item=>item.entryPoints.length===0)||entryPollAttemptsRef.current>=30)return;
    const controller=new AbortController();let timer:number|undefined;
    const poll=async()=>{if(controller.signal.aborted||entryPollAttemptsRef.current>=30)return;entryPollAttemptsRef.current+=1;try{const fresh=await listHookStoryMatches(hookSourceInput.hookAssetId!,dramaSource.id,controller.signal);if(controller.signal.aborted)return;setStoryMatches(fresh);if(fresh.slice(0,3).some(item=>item.entryPoints.length===0))timer=window.setTimeout(()=>void poll(),2000)}catch{if(!controller.signal.aborted)timer=window.setTimeout(()=>void poll(),2000)}};
    timer=window.setTimeout(()=>void poll(),2000);return()=>{controller.abort();if(timer)window.clearTimeout(timer)};
  },[dramaSource?.id,entryRefreshToken,hookSourceInput?.hookAssetId,matchJob?.id]);
  const toggleEpisode = (episode: number) => {
    setEpisodes((current) => current.includes(episode) ? current.filter((item) => item !== episode) : [...current, episode].sort((a, b) => a - b));
    touch();
  };

  useEffect(() => {
    const timer=window.setTimeout(()=>{const validEpisodes = editingDraft?.selectedEpisodes?.filter((episode) => connectedEpisodes.includes(episode));setEpisodes(validEpisodes?.length ? validEpisodes : defaultFreeEpisodes);setPreviewEpisode(defaultFreeEpisodes[0] ?? connectedEpisodes[0] ?? null)},0);
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
    <nav className={styles.externalSteps} aria-label="外搭钩子制作步骤">{steps.map((step, index) => <button type="button" key={step} disabled={index>2&&!stepReady[2]} className={`${activeStep === index ? styles.externalStepActive : ""} ${stepReady[index] ? styles.externalStepDone : ""}`} onClick={() => setActiveStep(index)}><i>{stepReady[index] ? "✓" : index + 1}</i><span>{step}</span></button>)}</nav>

    <div className={styles.externalStepBody}>
      {activeStep === 0 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>01</span><h2>选择剧集</h2><p className={styles.selectedDramaName}>{dramaSource ? `${dramaSource.dramaCn ?? dramaSource.title} / ${dramaSource.dramaTitle ?? dramaSource.title}` : "尚未选择剧目"}</p></div><small>仅使用已连接的真实视频片源</small></div>
        <div className={styles.hookPickerFilters}><label>目标时长 <select value={targetDurationSeconds} onChange={event=>setTargetDurationSeconds(Number(event.target.value))}><option value={900}>5–15 分钟</option><option value={1500}>15–25 分钟</option></select></label>{containsPaidEpisodes&&<button type="button" onClick={()=>setPaidScopeConfirmed(true)}>{paidScopeConfirmed?"✓ 已确认使用付费集":"确认使用付费集范围"}</button>}</div>
        {!dramaSource ? <div className={styles.emptyState}><h3>先选择本剧正片</h3><p>从剧库带入剧目后，可在这里选择实际制作集数。</p><button type="button" onClick={openDramaPicker}>从右侧剧库选择</button></div> : mediaEntries.length ? <div className={styles.episodeSourceGrid}>{mediaEntries.map((media) => <article key={media.episode} className={`${episodes.includes(media.episode) ? styles.selected : ""} ${!media.url ? styles.episodeDisabled : ""}`}>{media.url&&<video className={styles.hoverPreview} src={media.url} muted playsInline preload="metadata" onMouseEnter={event=>{const video=event.currentTarget;video.dataset.hovering="true";void video.play().catch(()=>undefined)}} onMouseLeave={event=>{const video=event.currentTarget;video.dataset.hovering="false";video.pause();if(video.readyState>=1)video.currentTime=0}} onCanPlay={event=>{const video=event.currentTarget;if(video.dataset.hovering==="true")void video.play().catch(()=>undefined)}}/>}<button type="button" disabled={!media.url} className={styles.episodePreviewButton} onClick={() => setPreviewEpisode(media.episode)}><span><b>{padEpisode(media.episode)}</b><em>悬停播放</em></span><small>{media.url ? media.name : "片源未连接"}</small></button><label><input type="checkbox" disabled={!media.url} checked={episodes.includes(media.episode)} onChange={() => toggleEpisode(media.episode)} /><span>{episodes.includes(media.episode) ? "已选入制作" : "选入制作"}</span></label></article>)}</div> : <div className={styles.emptyState}><h3>当前剧目没有可读取片源</h3><p>请回到剧库补传视频后再继续。</p></div>}
      </section>}
      {activeStep === 1 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>02</span><h2>根据主题 / 内容标签筛选外搭钩子</h2></div><small>来源必须可追溯</small></div>{hookSourceInput ? <div className={styles.selectedHookCard}>{hookSourceInput.hookMediaUrl?<HookTimelinePreview url={hookSourceInput.hookMediaUrl} start={hookSourceInput.hookStart??0} end={hookSourceInput.hookEnd??0} title={hookSourceInput.title}/>:<i>↗</i>}<div className={styles.selectedHookDetails}><small>{hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏"}</small><h3>{hookSourceInput.title}</h3><p>{hookSourceInput.description}</p><span>{hookSourceInput.language ?? "语种待识别"} · {hookSourceInput.rightsStatus??"授权待确认"} · 悬停预览 / 拖拽时间轴</span></div><button type="button" onClick={openHookPicker}>更换钩子</button></div> : <div className={styles.emptyState}><h3>按主题和内容标签选择外搭钩子</h3><p>从收藏或灵感大屏筛选可追溯素材，带入后将按故事脉络匹配完整投放区间。</p><button type="button" onClick={openHookPicker}>筛选外搭钩子</button></div>}</section>}
      {activeStep >= 2 && activeStep <= 5 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>{String(activeStep + 1).padStart(2,"0")}</span><h2>{externalPageTitles[activeStep]}</h2></div><small>{activeStep===5?`当前结论：${qualityReport.verdict}`:"真实数据驱动"}</small></div><ExternalHookAnalysis
        activeTab={(["match", "transition", "timeline", "quality"] as const)[activeStep - 2]}
        match={match}
        transitions={externalReady && selectedRecommendation ? transitionOptions : []}
        selectedTransitionId={selectedTransitionId}
        timeline={visibleTimeline}
        quality={qualityReport}
        disabled={!externalReady}
        onTabChange={(tab) => setActiveStep({ match: 2, transition: 3, timeline: 4, quality: 5 }[tab])}
        onSelectRecommendation={(item) => { setSelectedRecommendationId(item.id); setTimeline([]); touch(); }}
        onOverrideRecommendation={(item) => { const approve=item.videoUrl?approveHookMatchForProduction(item.id):setHookMatchSoftOverride(item.id,["story_score"]);void approve.then(()=>{setStoryOverrides(current=>current.includes(item.id)?current:[...current,item.id]);setSelectedRecommendationId(item.id);onNotify?.(item.videoUrl?"人工已确认该视频候选进入生产。模型评分与风险保留为提示。":"已持久化故事分审核覆盖")}).catch(error=>onNotify?.(error instanceof Error?error.message:"人工生产确认保存失败")) }}
        onSelectEntryPoint={(item,index) => {setSelectedEntryPoints(current=>({...current,[item.id]:index}));setSelectedRecommendationId(item.id);setTimeline([]);touch()}}
        onRequestMoreEntryPoints={(item)=>{void requestMoreEntryPoints(item.id).then(()=>{entryPollAttemptsRef.current=0;setEntryRefreshToken(value=>value+1);onNotify?.(`已提交「${item.title}」追加精确接点分析请求`)}).catch(error=>onNotify?.(error instanceof Error?error.message:"追加接点请求失败"))}}
        onRetryMatch={()=>{setMatchJob(null);setStoryMatches([]);setMatchError("");setMatchRetryToken(value=>value+1);setMatchRequestToken(value=>value+1);onNotify?.("正在补充高光分析并重新匹配")}}
        onChangeEpisodeScope={()=>setActiveStep(0)}
        onChangeHook={()=>{setActiveStep(1);openHookPicker()}}
        onSelectTransition={(item) => { setSelectedTransitionId(item.id); setTimeline((current) => (current.length ? current : defaultTimeline).map((clip) => clip.kind === "transition" ? { ...clip, title: item.title, durationSeconds: item.durationSeconds } : clip)); touch(); }}
        onPreviewTransition={(item) => onNotify?.(`已选择预览方案：${item.title}`)}
        onRegenerateTransitions={() => onNotify?.("已保存重新生成请求；等待过渡服务接入")}
        onMoveClip={moveTimelineClip}
        onUpdateClip={(id, patch) => { setTimeline((current) => (current.length ? current : defaultTimeline).map((clip) => clip.id === id ? { ...clip, ...patch } : clip)); touch(); }}
        onRemoveClip={(id) => { setTimeline((current) => (current.length ? current : defaultTimeline).filter((clip) => clip.id !== id)); touch(); }}
        onRunQualityCheck={() => { setQualityConfirmed(true); onNotify?.(`质检完成：${qualityReport.findings.length} 项检查，结论为「${qualityReport.verdict}」`) }}
        onApplyQualitySuggestion={() => onNotify?.("已记录优化建议")}
        onGeneratePreview={() => setActiveStep(6)}
      /></section>}
      {activeStep >= 6 && <section className={styles.panel}><div className={styles.panelHeader}><div><span>{String(activeStep + 1).padStart(2,"0")}</span><h2>{externalPageTitles[activeStep]}</h2></div><small>{activeStep===6?"生成真实可播放文件":"设置文件名与交付规格"}</small></div><ExternalHookDelivery
        view={activeStep===6?"preview":"export"}
        projectName={title || `${dramaSource?.dramaCn ?? "未命名剧目"} · 外搭钩子版`}
        hookName={hookSourceInput?.title}
        episodeReference={selectedRecommendation ? `${padEpisode(selectedRecommendation.episode)} · ${selectedRecommendation.startTimecode}${selectedRecommendation.startFrame == null ? " · 帧号待探测" : ` · 第 ${selectedRecommendation.startFrame} 帧`}` : undefined}
        previewUrl={factoryRender?.previewUrl}
        renderConnected={true}
        initialReviewStatus={!historyForked&&editingDraft?.factorySnapshot?.review?.decision==="approved"?"approved":!historyForked&&editingDraft?.factorySnapshot?.review?.decision==="rejected"?"rejected":"pending"}
        initialReviewComment={!historyForked&&typeof editingDraft?.factorySnapshot?.review?.note==="string"?editingDraft.factorySnapshot.review.note:""}
        versions={!historyForked?editingDraft?.renderVersions?.map(item=>({id:item.id,label:`真实渲染 V${item.version}`,createdAt:item.created||"历史版本",status:item.outputUrl?(editingDraft.productionStatus==="已导出"?"exported":"approved"):item.status==="failed"?"rejected":"reviewing",previewUrl:item.previewUrl})):undefined}
        disabled={!externalReady || qualityReport.verdict === "阻断" || (containsPaidEpisodes&&!paidScopeConfirmed)}
        onSaveDraft={() => {save(false);void persistExternalProject().then(()=>onNotify?.("生产项目已持久保存")).catch(error=>onNotify?.(error instanceof Error?error.message:"项目保存失败"))}}
        onRequestRender={requestExternalRender}
        onReview={async(decision,note)=>{if(!factoryProjectId||!factoryRender)throw new Error("请先生成真实预览");await reviewFactoryRender(factoryProjectId,factoryRender.id,decision,note)}}
        onExport={async(config)=>{if(!factoryProjectId||!factoryRender?.outputUrl){onNotify?.("真实成片生成并审核通过后才能导出");return}const exported=await exportFactoryRender(factoryProjectId,factoryRender.id,config.fileName);const link=document.createElement("a");link.href=exported.outputUrl;link.download=exported.fileName;document.body.appendChild(link);link.click();link.remove();onNotify?.("已开始下载并记录正式导出")}}
        onNotify={onNotify}
      /></section>}
    </div>
    <div className={styles.externalFlowActions}><button type="button" disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))}>上一步</button><span>第 {activeStep + 1} 步 / 共 8 步</span><button type="button" disabled={activeStep === 7||(activeStep===1&&!hookSourceInput?.hookAssetId)||(activeStep===2&&!stepReady[2])} onClick={() => { if(activeStep===1){setMatchJob(null);setStoryMatches([]);setMatchError("");setMatchRequestToken(value=>value+1);setActiveStep(2);onNotify?.("已创建故事线匹配任务");return} setActiveStep((step) => Math.min(7, step + 1)); }}>{activeStep===1?"开始匹配":"下一步"}</button></div>
    {sourcePicker&&<div className={styles.sourcePickerMask} onMouseDown={event=>{if(event.target===event.currentTarget)setSourcePicker(null)}}><aside className={styles.sourcePicker}>
      <header><div><small>{sourcePicker==="drama"?"DRAMA LIBRARY":"HOOK ASSET LIBRARY"}</small><h2>{sourcePicker==="drama"?"选择本剧正片":"筛选外搭钩子资产"}</h2><p>{sourcePicker==="drama"?"默认读取免费剧集，可在步骤 01 手动修改范围。":"这里只展示从外搭素材中定位出的片段级钩子，不再把整条素材作为匹配对象。"}</p></div><button type="button" aria-label="关闭选择栏" onClick={()=>setSourcePicker(null)}>×</button></header>
      {sourcePicker==="hook"&&<div className={styles.hookPickerFilters}><select value={hookQueryDimension} onChange={event=>setHookQueryDimension(event.target.value as OntologyDimension)}><option value="theme">主题</option><option value="relation">人物关系</option><option value="conflict">核心矛盾</option><option value="emotion">情绪</option><option value="storyBeat">情节点</option><option value="audience">受众</option><option value="acquisition">买量用途</option></select><input value={hookTagQuery} onChange={event=>setHookTagQuery(event.target.value)} placeholder="按所选标签维度搜索"/><select value={hookThemeFilter} onChange={event=>setHookThemeFilter(event.target.value)}><option>全部主题</option>{hookThemes.map(theme=><option key={theme}>{theme}</option>)}</select></div>}
      <div className={styles.sourcePickerList}>{pickerLoading?<div className={styles.sourcePickerState}>正在读取素材…</div>:pickerError?<div className={styles.sourcePickerState}>{pickerError}</div>:(sourcePicker==="drama"?dramaOptions:filteredHookOptions).length===0?<div className={styles.sourcePickerState}>{sourcePicker==="hook"?"没有同时满足边界已验证、审核通过及当前标签条件的外搭钩子。授权状态只展示，不影响分析选择。":"暂无符合条件的可选择资产"}</div>:(sourcePicker==="drama"?dramaOptions:filteredHookOptions).map(option=><button type="button" className={styles.sourcePickerCard} key={option.id} disabled={sourcePicker==="hook"&&option.hookMatchRelation==="contradictory"} title={sourcePicker==="hook"&&option.hookMatchRelation==="contradictory"?"标签体系检测到硬冲突":undefined} onClick={()=>{if(sourcePicker==="drama")onChooseDrama?.(option);else onChooseHook?.(option);setSourcePicker(null);touch()}}><span>{sourcePicker==="drama"?"剧库正片":"外搭钩子资产"}{sourcePicker==="hook"&&option.hookMatchScore!==undefined?` · 适配 ${option.hookMatchScore}%`:sourcePicker==="hook"?" · 证据未知":""}</span><h3>{option.dramaCn??option.title}</h3>{option.dramaCn&&<b>{option.title}</b>}<p>{option.description}</p>{sourcePicker==="hook"&&<div className={styles.sourcePickerTags}>{[option.hookType,...(option.themes??[]),...(option.contentTags??[])].filter(Boolean).slice(0,6).map((tag,index)=><i key={`${tag}-${index}`}>{tag}</i>)}</div>}{sourcePicker==="hook"&&Boolean(option.hookMatchReasons?.length)&&<small>{option.hookMatchReasons?.join(" · ")}</small>}<footer><em>{sourcePicker==="hook"?`边界已验证 · 审核通过 · 授权：${option.rightsStatus??"待确认"}`:option.language??"语种待识别"}</em><strong>选择 →</strong></footer></button>)}</div>
    </aside></div>}
  </section>;

  return <section className={styles.workspace} aria-label="内容工厂">
    <header className={styles.header}>
      <div><span>CONTENT ENGINE</span><h1>内容工厂</h1><p>基于已连接的真实片源创建并持久化制作草稿；未接入的分析、渲染和导出不会展示模拟结果。</p></div>
      <div className={styles.headerActions}><button type="button" aria-label="返回我的创作中的我的草稿" onClick={onOpenDrafts}>← 返回我的创作 · 我的草稿</button></div>
    </header>

    <nav className={styles.modeTabs} aria-label="制作模式">
      {factoryModes.map((item) => <button type="button" key={item.id} className={mode === item.id ? styles.active : ""} onClick={() => { setMode(item.id); onModeChange?.(item.id); setActiveStep(0); touch(); }}><i>{item.icon}</i><span><b>{item.name}</b><small>{item.description}</small></span></button>)}
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
            <div className={styles.sectionIntro}><span>01 · HOOK MATCH</span><h3>选择钩子来源与匹配方向</h3><p>先保存筛选条件；只有钩子库返回真实资产后才会出现候选。</p></div>
            <div className={styles.choiceCards}>{["我的收藏", "长效通用钩子", "同题材高表现钩子", "相似人物关系", "新生成钩子"].map((item) => <button type="button" key={item} className={hookSource === item ? styles.choiceActive : ""} onClick={() => { setHookSource(item); touch(); }}><b>{item}</b><small>{item === "新生成钩子" ? "保存生成Brief，等待模型服务" : "从已入库的合法钩子资产检索"}</small></button>)}</div>
            <div className={styles.matchDimensions}><span>排序维度</span>{["停滑潜力", "情绪匹配", "人物关系", "矛盾匹配", "承诺兑现", "货不对板风险"].map((item) => <i key={item}>{item}</i>)}</div>
          </div>}

          {activeStep === 1 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>02 · TRANSITION</span><h3>设计钩子与正片之间的连接</h3><p>过渡作为独立对象保存，后续可替换和跨项目复用。</p></div>
            <div className={styles.choiceCards}>{["时间倒叙旁白", "因果解释旁白", "身份反差旁白", "同动作转场", "台词承接", "BGM延续"].map((item) => <button type="button" key={item} className={transition === item ? styles.choiceActive : ""} onClick={() => { setTransition(item); touch(); }}><b>{item}</b><small>{item.includes("旁白") ? "需要生成过渡文案与配音" : "需要镜头/音频特征匹配"}</small></button>)}</div>
            <div className={styles.transitionPreview}><div><small>钩子末端</small><b>等待选择真实钩子</b></div><i>→ {transition} →</i><div><small>正片起点</small><b>{previewEpisode ? padEpisode(previewEpisode) : "等待选择片源"}</b></div></div>
          </div>}

          {activeStep === 2 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>03 · VARIANTS</span><h3>配置组合数量与受控变量</h3><p>系统只保存生产矩阵，不会在渲染服务未接入时伪造视频。</p></div>
            <div className={styles.variantFormula}><b>1 个正片配方</b><span>×</span><b>3 个钩子变量</b><span>×</span><b>2 个过渡变量</b><strong>= {variantCount} 个计划版本</strong></div>
            <div className={styles.checkGrid}>{["首帧类型", "第一条台词", "主情绪", "卡断位置", "视听模式", "过渡方式"].map((item) => <label key={item}><input type="checkbox" defaultChecked onChange={touch} />{item}</label>)}</div>
          </div>}

          {activeStep === 3 && <div className={styles.flowPanel}>
            <div className={styles.sectionIntro}><span>04 · QUALITY GATE</span><h3>统一质检门</h3><p>真实分析返回前只检查配置完整性；模型指标与风险结论不会使用模拟分数。</p></div>
            <div className={styles.qualityChecklist}>{["钩子来源已确定", "过渡方式已确定", "版本数量有效", "质检确认完成"].map((item, index) => <span key={item} className={stepReady[index] ? styles.checkPass : ""}><i>{stepReady[index] ? "✓" : "!"}</i>{item}</span>)}</div>
            <label className={styles.confirmQuality}><input type="checkbox" checked={qualityConfirmed} onChange={(event) => { setQualityConfirmed(event.target.checked); touch(); }} /><span><b>确认保存为待分析生产配方</b><small>钩子适配、连通性、货不对板和高点击低转化风险将在真实分析完成后给出。</small></span></label>
          </div>}
        </div>

        <div className={styles.flowActions}><button type="button" disabled={activeStep === 0} onClick={() => setActiveStep((step) => Math.max(0, step - 1))}>上一步</button><span>{hookSource} · {transition}</span><button type="button" className={styles.nextButton} disabled={activeStep === steps.length - 1} onClick={() => setActiveStep((step) => Math.min(steps.length - 1, step + 1))}>下一步</button></div>
      </section>
    </>}

    {mode !== "external-hook" && <footer className={styles.workspaceFooter}><span><b>自动保存</b>{source ? `${savedAt} · ${autoSaveCountdown} 秒后再次保存` : savedAt}</span><div><button type="button" onClick={() => save(false)} disabled={!source}>保存草稿</button><button type="button" className={styles.generate} disabled={!canCreate} title={!canCreate ? "没有已连接的真实视频片源" : "渲染服务尚未接入；当前仅保存制作草稿"} onClick={() => onNotify?.("片源已就绪；成片渲染服务尚未接入，当前不会生成假视频")}>生成成片（待接入）</button></div></footer>}
  </section>;
}

export default FactoryWorkspace;
