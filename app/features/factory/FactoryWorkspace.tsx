"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDurationZh } from "../../lib/time-format";
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
import {
  listSelectableExternalHooks,
  type HookAsset,
} from "../../lib/hook-asset-store";
import {
  approveHookMatchForProduction,
  getHookMatchJob,
  listHistoricalTemplateRecommendations,
  listHookDrivenStorylinePlans,
  listStorylinePlans,
  listStoryDrivenHookRecommendations,
  listTemplateAdaptationPlans,
  listHookStoryMatches,
  requestMoreEntryPoints,
  setHookMatchSoftOverride,
  startHookStoryMatch,
  type ExternalMatchStrategy,
  type HookMatchJob,
  type HookStoryMatch,
  type HookUnderstanding,
  type StoryNeed,
  type SelectedRangeStoryUnderstanding,
  type StorylinePlan,
  type StorylinePlanDiagnostics,
  type StrategyHookRecommendation,
} from "../../lib/hook-match-store";
import {
  exportFactoryRender,
  getFactoryRender,
  reviewFactoryRender,
  saveEpisodeSpliceProject,
  saveFactoryProject,
  startFactoryRender,
  type FactoryRenderRecord,
} from "../../lib/factory-production-store";
import type { FactorySourceContext } from "./types";
import {
  compareTagSets,
  normalizeTag,
  type OntologyDimension,
} from "../../lib/ontology";

const styles = { ...baseStyles, ...enhancementStyles };
type StorylineMatchCacheEntry = {
  hookAssetId: string;
  matches: HookStoryMatch[];
  job: HookMatchJob | null;
  selectedRecommendationId?: string;
  savedAt: string;
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
// PRODUCTION WORKFLOW: 正片模式从钩子匹配开始；外搭模式使用独立的八步闭环。

const padEpisode = (episode: number) =>
  `EP ${String(episode).padStart(2, "0")}`;
const timecode = (seconds: number) =>
  `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const hookOptionFromAsset = (
  item: HookAsset,
  rec?: StrategyHookRecommendation,
): FactorySourceContext => ({
  kind: "inspiration",
  id: item.id,
  hookAssetId: item.id,
  hookSourceClass: item.sourceClass,
  hookMaterialId: item.materialId,
  hookMaterialPlatform: item.materialPlatform,
  hookMaterialExposure: item.materialExposure,
  hookMaterialRunDays: item.materialRunDays,
  hookMediaUrl: item.materialVideoUrl,
  hookStart: item.start,
  hookEnd: item.end,
  hookStartFrame: item.startFrame,
  hookEndFrame: item.endFrame,
  hookBoundaryStatus: item.boundaryStatus,
  hookType: item.hookType,
  themes: item.themes,
  contentTags: item.contentTags,
  ontologyTags: item.ontologyTags,
  relationships: item.relationships,
  conflict: item.conflict,
  emotion: item.emotion,
  narrativePromise: item.narrativePromise,
  informationGap: item.informationGap,
  rightsStatus: item.rightsStatus,
  title: item.title,
  description: `${item.materialTitle ?? "灵感大屏"} · ${item.hookType} · ${formatDurationZh(item.start, 2)}–${formatDurationZh(item.end, 2)}`,
  hookMatchScore: rec?.score,
  hookMatchReasons: rec?.reasons,
  hookRetrievalDirection: rec?.directionLabel,
  hookStoryNeedCoverage: rec?.storyNeedCoverage,
  hookTruthSafety: rec?.truthSafety,
  hookBridgeCost: rec?.bridgeCost,
  hookSpoilerRisk: rec?.spoilerRisk,
  historicalTemplate: rec?.template,
  templateEvidenceLevel: rec?.evidenceLevel,
  templateProductionEligible: rec?.productionEligible,
});
const passesHardGate = (gate?: { passed?: boolean }) => gate?.passed === true;
const passesNonOverridableGate = (gate?: Record<string, unknown>) => {
  const checks = (
    gate?.requiredChecks && typeof gate.requiredChecks === "object"
      ? gate.requiredChecks
      : gate?.checks && typeof gate.checks === "object"
        ? gate.checks
        : {}
  ) as Record<string, unknown>;
  const soft = new Set([
    "storyScore",
    "story_score",
    "calibratedProbability",
    "calibrated_probability",
    "storyCompleteness",
    "story_completeness",
    "understandingCost",
    "understanding_cost",
    "transitionDifficulty",
    "transition_difficulty",
  ]);
  return Object.entries(checks).every(
    ([name, passed]) => passed !== false || soft.has(name),
  );
};
const isProductionReadyMatch = (item: HookStoryMatch) =>
  item.humanVideoApproved ||
  (passesHardGate(item.productionGate) &&
    item.storyScore >= 75 &&
    item.promiseFulfillmentScore >= 70);
const isEditableBackupMatch = (item: HookStoryMatch) =>
  passesNonOverridableGate(item.productionGate) &&
  !isProductionReadyMatch(item) &&
  item.storyScore >= 65 &&
  item.promiseFulfillmentScore >= 70;

function selectedRange(episodes: number[]) {
  if (!episodes.length) return "未选择片源";
  return episodes.map(padEpisode).join("、");
}

const containsChinese=(value:string)=>/[\u3400-\u9fff]/u.test(value);
function chineseStoryNeedSummary(need:StoryNeed,drama?:FactorySourceContext|null) {
  const raw=String(need.corePlot||"").replace(/\s+/g," ").trim();
  const chineseCount=(raw.match(/[\u3400-\u9fff]/gu)||[]).length;
  const latinCount=(raw.match(/[A-Za-z]/g)||[]).length;
  if(chineseCount>=8&&chineseCount>=latinCount*.2)return raw;
  const ontology=(drama?.ontologyTags??[]).filter(tag=>tag.prominence==="primary"&&containsChinese(tag.label)).map(tag=>tag.label);
  const tags=[...ontology,...(need.contentTags??[]).filter(value=>containsChinese(String(value))).map(String)];
  const relationships=(need.relationshipState??[]).filter(value=>containsChinese(String(value))).map(String);
  const uniqueTags=[...new Set(tags)].slice(0,6),uniqueRelationships=[...new Set(relationships)].slice(0,3);
  const parts=[];
  if(uniqueTags.length)parts.push(`核心标签为${uniqueTags.map(value=>`「${value}」`).join("、")}`);
  if(uniqueRelationships.length)parts.push(`重点人物关系为${uniqueRelationships.join("、")}`);
  const directions=(need.extendDirections??[]).map(item=>item.label).filter(Boolean).slice(0,5);
  if(directions.length)parts.push(`建议从${directions.join("、")}等方向检索历史钩子结构`);
  return parts.length?`${parts.join("；")}。`:"系统将基于已选剧集的剧情分析、人物关系和内容标签检索历史钩子结构。";
}

function previewTime(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function selectedRangePlotOverview(
  plan: StorylinePlan,
  understanding: SelectedRangeStoryUnderstanding | null,
) {
  const orderedSegments = [...plan.segments].sort(
    (left, right) => left.episode - right.episode || left.start - right.start,
  );
  const allText = orderedSegments.map((item) => item.plot).join("；");
  const places = [
    ...new Set(
      allText.match(
        /(?:上东区|火灾现场|医院|酒店|庄园|公司|办公室|家中|家里|卧室|学校|餐厅|酒吧)/g,
      ) ?? [],
    ),
  ].slice(0, 3);
  const characters = [
    ...new Set(
      (understanding?.storylines ?? []).flatMap((item) => item.characters),
    ),
  ];
  const time = orderedSegments
    .map(
      (item) =>
        `第${item.episode}集 ${formatDurationZh(item.start, 2)}–${formatDurationZh(item.end, 2)}`,
    )
    .join("；");
  const mode = String(plan.scriptPlan?.mode || "impact");
  const opening = orderedSegments[0];
  const earlyEntry = Number(opening?.start || 0) < 15;
  const entryLabel = opening
    ? `第${opening.episode}集 ${formatDurationZh(opening.start, 2)}，${earlyEntry ? "从关系背景与离婚状态切入" : "从再次提出离婚的正面冲突切入"}`
    : "原片未明确";
  const variants: Record<
    string,
    { focus: string; event: string; cause: string; consequence: string }
  > = {
    impact: {
      focus: earlyEntry ? "反复离婚造成的情感控制" : "Stella停止挽留前的正面冲突",
      cause:
        "阿什顿在三年婚姻中反复提出离婚，Stella此前一次次恳求并配合撤回文件。两人已经形成“提出离婚—挽留—撤回”的失衡循环。",
      event: earlyEntry
        ? "先交代阿什顿频繁提出离婚的异常婚姻状态，再进入Stella的正面控诉。第2集通过七年前火灾旧事补充两人裂痕，使冲突从一次离婚升级为长期感情消耗。"
        : "从阿什顿再次提出离婚、Stella不再退让的时刻直接起播。随后Stella翻出七年前火灾旧事，指责阿什顿长期轻视她的付出，把情绪迅速推到关系决裂。",
      consequence:
        "Stella的态度由反复挽留转为愤怒和清醒，婚姻线停在是否彻底结束关系的追看点。第3集随后转入父女冲突，是新的独立支线。",
    },
    context: {
      focus: earlyEntry ? "婚姻为何走到反复离婚" : "离婚冲突背后的多年旧账",
      cause:
        "阿什顿与Stella相爱多年，但婚后三年里阿什顿反复提出离婚。Stella长期挽留，使表面的婚姻维持掩盖了双方信任已经破裂的事实。",
      event: earlyEntry
        ? "从两人的婚姻状态开始，先说明阿什顿为何被视为反复伤害关系的一方；第2集再补充七年前火灾中的选择，解释Stella的委屈并非来自单次争吵。"
        : "以这次离婚申请为现实导火索，向前追溯三年内的多次反复和七年前火灾旧事。重点是让观众理解两人长期积累的误解、忽视和控制。",
      consequence:
        "观众获得婚姻决裂的完整背景，并理解Stella为何不愿继续维系关系。第3集转入她与父亲的家庭矛盾，展示另一段长期被忽视的关系。",
    },
    awakening: {
      focus: earlyEntry ? "Stella从长期退让到开始醒悟" : "Stella在离婚冲突中停止讨好",
      cause:
        "Stella长期把维持婚姻放在自己感受之前，多次恳求阿什顿撤回离婚。阿什顿持续反复，让她逐渐确认自己的付出没有得到尊重。",
      event: earlyEntry
        ? "先呈现Stella过去不断挽留的状态，再通过离婚冲突和火灾旧事推动她看清关系。她从希望修复婚姻转向公开表达愤怒，不再替阿什顿寻找理由。"
        : "从Stella拒绝继续承受离婚威胁的节点切入。她回顾七年前火灾和多年的感情消耗，把压抑的委屈转化为明确反抗。",
      consequence:
        "Stella完成从挽留者到主动划清边界的阶段转变。第3集她面对父亲偏爱继女时再次选择切断伤害自己的关系，形成同一人物的觉醒延续。",
    },
    suspense: {
      focus: earlyEntry ? "阿什顿为何反复提出离婚" : "七年前火灾真相如何改变两人关系",
      cause:
        "婚姻中出现明显信息差：阿什顿三年内反复提出离婚，Stella却持续挽留；两人都没有在当前片段中完整解释七年前火灾留下的核心误会。",
      event: earlyEntry
        ? "从异常的“一百次离婚申请”建立问题，再逐步透露Stella曾在火灾中先救陌生人。观众需要继续确认阿什顿的真实动机，以及火灾是否是两人决裂的真正原因。"
        : "直接从离婚冲突制造悬念，随后抛出七年前火灾中的关键选择。Stella的控诉解释了情绪，却仍保留阿什顿为何长期反复伤害她的问题。",
      consequence:
        "婚姻线保留两个未解问题：阿什顿是否真正决定离开，以及火灾旧事能否被双方说清。第3集转入独立父女线，暂不兑现这两个问题。",
    },
  };
  const hasCurrentStoryEvidence =
    /三年婚姻|一百次提出离婚|频繁提出离婚/.test(allText) &&
    /Stella|Aston|Ashton|阿什顿/.test(allText);
  const variant = hasCurrentStoryEvidence
    ? (variants[mode] ?? variants.impact)
    : {
        focus:
          plan.scriptPlan?.hookDirection ||
          plan.hookNeed?.purpose ||
          "当前高光承接方向",
        cause:
          plan.scriptPlan?.openingEvent ||
          orderedSegments[0]?.plot ||
          "原片未明确",
        event:
          plan.scriptPlan?.coreStory ||
          orderedSegments.map((segment) => segment.plot).join("；"),
        consequence:
          plan.scriptPlan?.stagePayoff ||
          orderedSegments[orderedSegments.length - 1]?.plot ||
          "原片未明确",
      };
  return {
    focus: variant.focus,
    opening: entryLabel,
    time,
    place: places.join("、") || "原片未明确",
    people: characters.join("、") || "原片未明确",
    event: variant.event,
    cause: variant.cause,
    consequence: variant.consequence,
  };
}

function HookTimelinePreview({
  url,
  start,
  end,
  title,
}: {
  url: string;
  start: number;
  end: number;
  title: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.1, end);
  const duration = safeEnd - safeStart;
  const [current, setCurrent] = useState(safeStart);

  const seek = (relativeSeconds: number) => {
    const next = Math.min(
      safeEnd,
      Math.max(safeStart, safeStart + relativeSeconds),
    );
    setCurrent(next);
    if (videoRef.current?.readyState) videoRef.current.currentTime = next;
  };

  return (
    <div
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
        onLoadedMetadata={(event) => {
          event.currentTarget.currentTime = safeStart;
          setCurrent(safeStart);
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (video.currentTime >= safeEnd) {
            video.pause();
            video.currentTime = safeEnd;
            setCurrent(safeEnd);
          } else setCurrent(Math.max(safeStart, video.currentTime));
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
        <span>
          {previewTime(current - safeStart)} / {previewTime(duration)}
        </span>
      </div>
    </div>
  );
}

export function FactoryWorkspace({
  initialMode = "episode-splice",
  editingDraft,
  sourceContext,
  dramaSourceContext,
  hookSourceContext,
  onModeChange,
  onChooseDrama,
  onChooseHook,
  onDraftAutoSave,
  onOpenDrafts,
  onNotify,
}: FactoryWorkspaceProps) {
  const legacySource = sourceContext ?? editingDraft?.sourceContext ?? null;
  const dramaSource =
    dramaSourceContext ??
    (legacySource?.kind === "library" ? legacySource : null);
  const hookSourceInput =
    hookSourceContext ??
    editingDraft?.hookSourceContext ??
    (legacySource?.kind === "favorite" || legacySource?.kind === "inspiration"
      ? legacySource
      : null);
  const [mode, setMode] = useState<FactoryMode>(
    editingDraft?.mode ?? initialMode,
  );
  const source = mode === "external-hook" ? dramaSource : legacySource;
  const [language, setLanguage] = useState(
    editingDraft?.language ?? source?.language ?? "英语",
  );
  const [ratio, setRatio] = useState<Draft["ratio"]>(
    editingDraft?.ratio ?? "9:16",
  );
  const [title, setTitle] = useState(editingDraft?.title ?? "");
  const mediaEntries = useMemo(
    () =>
      Object.values(source?.episodeMedia ?? {}).sort(
        (a, b) => a.episode - b.episode,
      ),
    [source],
  );
  const connectedEpisodes = useMemo(
    () =>
      mediaEntries
        .filter((item) => Boolean(item.url))
        .map((item) => item.episode),
    [mediaEntries],
  );
  const defaultFreeEpisodes = useMemo(
    () =>
      connectedEpisodes.filter(
        (episode) =>
          episode <= (source?.freeEpisodes ?? connectedEpisodes.length),
      ),
    [connectedEpisodes, source?.freeEpisodes],
  );
  const [episodes, setEpisodes] = useState<number[]>(
    () =>
      editingDraft?.selectedEpisodes?.filter((episode) =>
        connectedEpisodes.includes(episode),
      ) ?? defaultFreeEpisodes,
  );
  const [previewEpisode, setPreviewEpisode] = useState<number | null>(
    () => episodes[0] ?? null,
  );
  const [savedAt, setSavedAt] = useState(editingDraft?.updatedAt ?? "尚未保存");
  const [autoSaveCountdown, setAutoSaveCountdown] = useState(15);
  const [dirty, setDirty] = useState(false);
  const [activeStep, setActiveStep] = useState(
    editingDraft?.isHistorySnapshot ? 5 : 0,
  );
  const goal = "停滑与点击";
  const [matchStrategy, setMatchStrategy] = useState<ExternalMatchStrategy>(
    () => {
      const saved = editingDraft?.factorySnapshot?.transition?.matchStrategy;
      return saved === "story_to_hook" ||
        saved === "template_reuse" ||
        saved === "hook_to_story"
        ? saved
        : hookSourceInput && !dramaSource
          ? "hook_to_story"
          : dramaSource && !hookSourceInput
            ? "story_to_hook"
            : "hook_to_story";
    },
  );
  const matchingDimensions = ["剧情事件", "人物关系", "情绪曲线", "悬念与承诺"];
  const [hookSource, setHookSource] = useState("同题材高表现钩子");
  const [transition, setTransition] = useState("时间倒叙旁白");
  const variantCount = 6;
  const [qualityConfirmed, setQualityConfirmed] = useState(
    Boolean(editingDraft?.factorySnapshot?.qualityReport),
  );
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<
    string | undefined
  >(editingDraft?.storyMatchId);
  const [selectedTransitionId, setSelectedTransitionId] = useState(
    String(editingDraft?.factorySnapshot?.transition?.id || "bridge-narration"),
  );
  const [timeline, setTimeline] = useState<ExternalHookTimelineClip[]>(() =>
    Array.isArray(editingDraft?.factorySnapshot?.timeline)
      ? (editingDraft.factorySnapshot.timeline as ExternalHookTimelineClip[])
      : [],
  );
  const [sourcePicker, setSourcePicker] = useState<"drama" | "hook" | null>(
    null,
  );
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [pickerRequestToken, setPickerRequestToken] = useState(0);
  const [dramaOptions, setDramaOptions] = useState<FactorySourceContext[]>([]);
  const [hookOptions, setHookOptions] = useState<FactorySourceContext[]>([]);
  const [strategyStoryNeed, setStrategyStoryNeed] = useState<StoryNeed | null>(
    null,
  );
  const [storyUnderstanding, setStoryUnderstanding] =
    useState<SelectedRangeStoryUnderstanding | null>(null);
  const [activeStoryThreadId, setActiveStoryThreadId] = useState<string>();
  const [storylinePlans, setStorylinePlans] = useState<StorylinePlan[]>([]);
  const [selectedStorylineIds, setSelectedStorylineIds] = useState<string[]>(
    () => {
      const saved =
        editingDraft?.factorySnapshot?.transition?.selectedStorylineIds;
      return Array.isArray(saved) ? saved.map(String) : [];
    },
  );
  const [storylineDiagnostics, setStorylineDiagnostics] =
    useState<StorylinePlanDiagnostics | null>(null);
  const [hookUnderstanding, setHookUnderstanding] =
    useState<HookUnderstanding | null>(null);
  const [activeStorylineId, setActiveStorylineId] = useState<
    string | undefined
  >(editingDraft?.factorySnapshot?.activeStorylineId);
  const [storylineHookPairs, setStorylineHookPairs] = useState<
    Record<string, FactorySourceContext>
  >(() => editingDraft?.factorySnapshot?.storylineHookPairs ?? {});
  const [storylineMatchCache, setStorylineMatchCache] = useState<
    Record<string, StorylineMatchCacheEntry>
  >(() => (editingDraft?.factorySnapshot?.storylineMatchCache ?? {}) as Record<string, StorylineMatchCacheEntry>);
  const [bulkHookMatching, setBulkHookMatching] = useState(false);
  const [storylineLoading, setStorylineLoading] = useState(false);
  const [storylineError, setStorylineError] = useState("");
  const [storylineRequestToken, setStorylineRequestToken] = useState(0);
  const [hookThemeFilter, setHookThemeFilter] = useState("全部主题");
  const [hookTagQuery, setHookTagQuery] = useState("");
  const [hookQueryDimension, setHookQueryDimension] =
    useState<OntologyDimension>("theme");
  // Current paid-media delivery is standardized at 5–15 minutes. Keep this
  // as a production contract rather than a cosmetic selector.
  const [targetDurationSeconds] = useState(900);
  const [storyOverrides, setStoryOverrides] = useState<string[]>([]);
  const [selectedEntryPoints, setSelectedEntryPoints] = useState<
    Record<string, number>
  >({});
  const [paidScopeConfirmed, setPaidScopeConfirmed] = useState(false);
  const [matchRetryToken, setMatchRetryToken] = useState(0);
  const [matchRequestToken, setMatchRequestToken] = useState(0);
  const [entryRefreshToken, setEntryRefreshToken] = useState(0);
  const [matchJob, setMatchJob] = useState<HookMatchJob | null>(() => {
    const id = editingDraft?.factorySnapshot?.activeStorylineId;
    return id ? ((editingDraft?.factorySnapshot?.storylineMatchCache?.[id] as StorylineMatchCacheEntry | undefined)?.job ?? null) : null;
  });
  const [storyMatches, setStoryMatches] = useState<HookStoryMatch[]>(() => {
    const id = editingDraft?.factorySnapshot?.activeStorylineId;
    return id ? ((editingDraft?.factorySnapshot?.storylineMatchCache?.[id] as StorylineMatchCacheEntry | undefined)?.matches ?? []) : [];
  });
  const [matchError, setMatchError] = useState("");
  const entryPollAttemptsRef = useRef(0);
  const [factoryProjectId, setFactoryProjectId] = useState<string | undefined>(
    editingDraft?.factoryProjectId,
  );
  const [factoryRender, setFactoryRender] =
    useState<FactoryRenderRecord | null>(null);
  const [factoryRendersByStoryline, setFactoryRendersByStoryline] = useState<
    Record<string, FactoryRenderRecord>
  >({});
  const [factoryRenderError, setFactoryRenderError] = useState("");
  const [selectedSpliceHighlightId, setSelectedSpliceHighlightId] = useState<
    string | undefined
  >();
  const [spliceReviewStatus, setSpliceReviewStatus] = useState<
    "pending" | "approved" | "rejected"
  >("pending");
  const [draftId, setDraftId] = useState(
    () => editingDraft?.id ?? `draft-${Date.now()}`,
  );
  const [draftVersion, setDraftVersion] = useState(editingDraft?.version ?? 1);
  const [historyForked, setHistoryForked] = useState(
    !editingDraft?.isHistorySnapshot,
  );
  const autoSaveSecondsRef = useRef(15);
  const definition = factoryModes.find((item) => item.id === mode)!;
  const previewMedia =
    previewEpisode == null ? undefined : source?.episodeMedia?.[previewEpisode];
  const availableWithoutConnection = (source?.availableEpisodes ?? []).filter(
    (episode) => !source?.episodeMedia?.[episode]?.url,
  );
  const spliceHighlights = useMemo(
    () =>
      (source?.highlightCandidates ?? [])
        .filter(
          (item) =>
            connectedEpisodes.includes(item.episode) &&
            Number.isFinite(item.start) &&
            item.start >= 0,
        )
        .slice()
        .sort(
          (left, right) =>
            left.episode - right.episode || left.start - right.start,
        ),
    [connectedEpisodes, source?.highlightCandidates],
  );
  const selectedSpliceHighlight =
    spliceHighlights.find(
      (item) => String(item.id) === selectedSpliceHighlightId,
    ) ?? spliceHighlights[0];
  const spliceTimeline = useMemo<ExternalHookTimelineClip[]>(() => {
    if (!selectedSpliceHighlight || !source?.episodeMedia) return [];
    const startIndex = connectedEpisodes.indexOf(selectedSpliceHighlight.episode);
    if (startIndex < 0) return [];
    const selectedNumbers = connectedEpisodes.slice(startIndex, startIndex + 3);
    const durationOf = (episode: number, index: number) => {
      const duration = Number(source.episodeMedia?.[episode]?.duration || 0);
      const start = index === 0 ? selectedSpliceHighlight.start : 0;
      return Math.max(0, duration - start);
    };
    let total = selectedNumbers.reduce(
      (sum, episode, index) => sum + durationOf(episode, index),
      0,
    );
    if (total < 300 && connectedEpisodes[startIndex + 3] != null) {
      selectedNumbers.push(connectedEpisodes[startIndex + 3]);
      total += durationOf(connectedEpisodes[startIndex + 3], 3);
    }
    return selectedNumbers.map((episode, index) => {
      const end = Number(source.episodeMedia?.[episode]?.duration || 0);
      const start = index === 0 ? selectedSpliceHighlight.start : 0;
      return {
        id: `splice-episode-${episode}`,
        kind: index === 0 ? "hook" : "episode",
        episode,
        title:
          index === 0
            ? `${padEpisode(episode)} · 从高光开始至本集结束`
            : `${padEpisode(episode)} · 完整顺序承接`,
        sourceLabel: source.dramaCn ?? source.title,
        startSeconds: start,
        endSeconds: end,
        startTimecode: timecode(start),
        endTimecode: timecode(end),
        durationSeconds: Math.max(0, end - start),
        locked: true,
        safeStart:
          index === 0
            ? { status: "verified", source: "selected_highlight_start" }
            : { status: "verified", source: "episode_start" },
        safeEnd: { status: "verified", source: "episode_end" },
      } as ExternalHookTimelineClip;
    });
  }, [connectedEpisodes, selectedSpliceHighlight, source]);
  const spliceDurationSeconds = spliceTimeline.reduce(
    (sum, item) => sum + item.durationSeconds,
    0,
  );
  const spliceDurationReady =
    spliceTimeline.length >= 3 &&
    spliceTimeline.length <= 4 &&
    spliceDurationSeconds >= 300 &&
    spliceDurationSeconds <= 900;
  const canCreate = Boolean(
    source?.kind === "library" &&
    episodes.length &&
    episodes.every((episode) => source.episodeMedia?.[episode]?.url),
  );
  const externalReady = Boolean(dramaSource && hookSourceInput);
  const containsPaidEpisodes = episodes.some(
    (episode) =>
      episode > (dramaSource?.freeEpisodes ?? Number.MAX_SAFE_INTEGER),
  );
  const hookSelectionTitle =
    matchStrategy === "story_to_hook"
      ? "按故事走向匹配外搭钩子"
      : matchStrategy === "template_reuse"
        ? "选择历史跑量钩子模板"
        : "筛选钩子并选择承接故事方向";
  const storyToHookSteps = [
    "选择剧集",
    "生成并选择正片故事线",
    "按故事走向匹配外搭钩子",
    "设计过渡",
    "成片时间线",
    "预览和审核",
    "保存和导出",
  ];
  const templateReuseSteps = [
    "选择剧集",
    "选择历史跑量模板",
    "生成并选择模板适配方案",
    "设计过渡",
    "成片时间线",
    "预览和审核",
    "保存和导出",
  ];
  const hookToStorySteps = [
    "选择剧集",
    "筛选钩子并选择承接故事方向",
    "按选中方向匹配正片片段",
    "设计过渡",
    "成片时间线",
    "预览和审核",
    "保存和导出",
  ];
  const steps =
    mode === "external-hook"
      ? matchStrategy === "story_to_hook"
        ? storyToHookSteps
        : matchStrategy === "template_reuse"
          ? templateReuseSteps
          : hookToStorySteps
      : ["钩子匹配", "过渡生成", "组合版本", "统一质检"];
  const visibleExternalSteps =
    mode === "external-hook" && matchStrategy === "hook_to_story"
      ? [
          { label: "选择剧集", internalStep: 0 },
          { label: "选择钩子", internalStep: 1 },
          { label: "选择正片起播方案", internalStep: 2 },
          { label: "确认连接并生成草稿", internalStep: 3 },
          { label: "保存和导出", internalStep: 6 },
        ]
      : steps.map((label, internalStep) => ({ label, internalStep }));
  const visibleExternalStepIndex = Math.max(
    0,
    visibleExternalSteps.findIndex((item, index) => {
      const next = visibleExternalSteps[index + 1]?.internalStep ?? Number.POSITIVE_INFINITY;
      return activeStep >= item.internalStep && activeStep < next;
    }),
  );
  const externalPageTitles =
    matchStrategy === "story_to_hook"
      ? storyToHookSteps
      : matchStrategy === "template_reuse"
        ? templateReuseSteps
        : hookToStorySteps;
  const readinessRecommendationId =
    selectedRecommendationId ?? storyMatches[0]?.id;
  const selectedRawStoryMatch = readinessRecommendationId
    ? storyMatches.find((item) => item.id === readinessRecommendationId)
    : undefined;
  const selectedRawStorySegment = selectedRawStoryMatch?.segments.find(
    (segment) =>
      Number.isFinite(Number(segment.episode)) &&
      Number.isFinite(Number(segment.start)) &&
      Number(segment.end) > Number(segment.start),
  );
  // Raw hook matches store timing in `segments`; the playable URL belongs to
  // the drama episode media map. The previous gate read flattened display-only
  // fields from HookStoryMatch, so a visibly selected/playable result could
  // never enable the next workflow step.
  const hasApprovedStoryMatch = Boolean(
    selectedRawStoryMatch &&
      selectedRawStorySegment &&
      dramaSource?.episodeMedia?.[Number(selectedRawStorySegment.episode)]?.url,
  );
  const hasSelectedStoryMatch = Boolean(selectedRawStoryMatch);
  const hasUsableStoryMatch =
    matchStrategy === "template_reuse"
      ? hasSelectedStoryMatch
      : hasApprovedStoryMatch;
  const stepReady =
    mode === "external-hook"
      ? [
          Boolean(dramaSource && episodes.length),
          matchStrategy === "story_to_hook"
            ? Boolean(selectedStorylineIds.length)
            : matchStrategy === "hook_to_story"
              ? Boolean(
                  hookSourceInput?.hookAssetId && selectedStorylineIds.length,
                )
              : Boolean(hookSourceInput?.hookAssetId),
          matchStrategy === "template_reuse"
            ? Boolean(selectedStorylineIds.length && hasSelectedStoryMatch)
            : hasApprovedStoryMatch,
          hasUsableStoryMatch && Boolean(selectedTransitionId),
          hasUsableStoryMatch && Boolean(timeline.length),
          false,
          false,
        ]
      : [
          Boolean(hookSource),
          Boolean(transition),
          variantCount > 0,
          qualityConfirmed,
        ];

  const match = useMemo<HookEpisodeMatch>(() => {
    const seenIntervals = new Set<string>();
    const candidateRecommendations = [...storyMatches]
      .sort(
        (a, b) =>
          b.storyScore - a.storyScore ||
          b.promiseFulfillmentScore - a.promiseFulfillmentScore ||
          b.matchScore - a.matchScore,
      )
      .slice(0, 3)
      .flatMap((item) => {
        const first = item.segments[0],
          last = item.segments[item.segments.length - 1];
        if (!first || !last) return [];
        const rawEntries = item.entryPoints.slice(0, 3),
          selectedEntryIndex =
            selectedEntryPoints[item.id] ??
            Math.max(
              0,
              rawEntries.findIndex(
                (value) => (value as { recommended?: boolean }).recommended,
              ),
            );
        const requestedEntry = (rawEntries[selectedEntryIndex] ?? rawEntries[0]) as
          { episode?: number; start?: number; frame?: number } | undefined;
        const mediaEpisodes = Object.keys(dramaSource?.episodeMedia ?? {})
          .map(Number)
          .filter(Number.isFinite);
        const supportsSequentialBody = (episode?: number) =>
          Number(episode) > 0 &&
          mediaEpisodes.includes(Number(episode) + 1) &&
          mediaEpisodes.includes(Number(episode) + 2);
        const sequentialAnchor = [...item.segments]
          .filter((segment) => supportsSequentialBody(segment.episode))
          .sort(
            (left, right) =>
              left.episode - right.episode || left.start - right.start,
          )[0];
        const entry = supportsSequentialBody(requestedEntry?.episode)
          ? requestedEntry
          : sequentialAnchor
            ? {
                episode: sequentialAnchor.episode,
                start: sequentialAnchor.start,
              }
            : undefined;
        // This list represents entry points, not every possible downstream story
        // route. Two matches that enter the same approved source interval are one
        // actionable candidate even when their later segments differ.
        const entryStart = entry?.start ?? first.start;
        const entryEpisode = entry?.episode ?? first.episode;
        if (!supportsSequentialBody(entryEpisode)) return [];
        const entrySegment =
          item.segments.find(
            (segment) =>
              segment.episode === entryEpisode &&
              segment.start <= entryStart &&
              segment.end >= entryStart,
          ) ??
          item.segments.find((segment) => segment.episode === entryEpisode) ??
          first;
        const entryEnd = Math.max(entryStart, entrySegment.end);
        const fps = dramaSource?.episodeMedia?.[entryEpisode]?.fps;
        const displayNarrativeZh = item.storyArc.displayNarrativeZh;
        const intervalKey = `${entryEpisode}:${entryStart.toFixed(2)}-${entryEnd.toFixed(2)}`;
        if (seenIntervals.has(intervalKey)) return [];
        seenIntervals.add(intervalKey);
        const episodeTitle =
          displayNarrativeZh?.title ||
          first.purpose ||
          item.storyArc.payoff ||
          item.storyArc.ending ||
          `第 ${first.episode} 集正片承接区间`;
        const overridden =
          item.humanVideoApproved || storyOverrides.includes(item.id);
        return [
          {
            id: item.id,
            title: episodeTitle,
            episode: entryEpisode,
            startTimecode: timecode(entryStart),
            endTimecode: timecode(entryEnd),
            startSeconds: entryStart,
            endSeconds: entryEnd,
            videoUrl: dramaSource?.episodeMedia?.[entryEpisode]?.url,
            startFrame:
              entry?.frame ??
              (fps == null ? undefined : Math.round(entryStart * fps)),
            fps,
            score: item.matchScore,
            storyScore: item.storyScore,
            promiseFulfillmentScore: item.promiseFulfillmentScore,
            productionReady: isProductionReadyMatch(item) || overridden,
            editableBackup: isEditableBackupMatch(item),
            overrideApplied: overridden,
            rationale: displayNarrativeZh?.formedStoryline || "",
            relationship: displayNarrativeZh?.relationship || "",
            conflict: displayNarrativeZh?.conflict || "",
            emotion: displayNarrativeZh?.emotion || "",
            evidence: [
              {
                id: `promise-${item.id}`,
                dimension: "承诺兑现" as const,
                hookEvidence:
                  hookSourceInput?.narrativePromise ||
                  hookSourceInput?.informationGap ||
                  "钩子叙事承诺",
                episodeEvidence: displayNarrativeZh?.bodyConnection || item.storyArc.payoff || item.storyArc.ending || "",
                confidence: item.dimensionScores.promise,
              },
            ],
            risks: item.risks,
            storyArc: item.storyArc,
            segments: item.segments,
            entryPoints: rawEntries as HighlightRecommendation["entryPoints"],
            completeness:
              item.completeness as HighlightRecommendation["completeness"],
            calibration:
              item.calibration as HighlightRecommendation["calibration"],
            productionGate:
              item.productionGate as HighlightRecommendation["productionGate"],
            matchStatus: item.status,
          },
        ];
      });
    const recommendations = candidateRecommendations.filter(
      (item) => item.productionReady,
    );
    const editableCandidates = candidateRecommendations.filter(
      (item) => !item.productionReady,
    );
    const reasonCounts = new Map<string, number>();
    storyMatches.forEach((item) => {
      const reasons =
        (item.productionGate.reasons as string[] | undefined) ?? item.risks;
      if (!reasons.length)
        reasonCounts.set(
          "故事分或承诺兑现未达到候选门槛",
          (reasonCounts.get("故事分或承诺兑现未达到候选门槛") ?? 0) + 1,
        );
      reasons.forEach((reason) =>
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1),
      );
    });
    const diagnostics = matchJob?.diagnostics;
    const waitingSupplemental =
      diagnostics?.outcomeStatus === "waiting_supplemental" ||
      (matchJob?.status === "running" &&
        /supplement|highlight|高光/i.test(matchJob.stage));
    const diagnosticLabels: Record<string, string> = {
      boundary_unverified: "高光边界尚未验证",
      action_incomplete: "动作或对白不完整",
      duration_out_of_range: "候选时长不在可生产区间",
      invalid_media_boundary: "媒体时间边界无效",
      story_score: "故事分未达生产线",
      understanding_cost: "陌生观众理解成本过高",
      transition_difficulty: "过渡难度过高",
    };
    return {
      hookTitle: hookSourceInput?.title ?? "尚未选择外搭钩子",
      episodeTitle:
        dramaSource?.dramaCn ?? dramaSource?.title ?? "尚未选择本剧正片",
      status:
        matchError || matchJob?.status === "failed"
          ? "failed"
          : matchJob?.status === "running" || matchJob?.status === "queued"
            ? "running"
            : recommendations.length ||
                storyMatches.length ||
                matchJob?.status === "succeeded"
              ? "completed"
              : "idle",
      summary:
        matchError ||
        (storyMatches.length && !recommendations.length
          ? "匹配已完成并返回候选，但候选仍需补证或审核，暂不能进入生产。"
          : undefined),
      recommendations,
      editableCandidates,
      resultState:
        matchError ||
        matchJob?.status === "failed" ||
        diagnostics?.outcomeStatus === "failed" ||
        diagnostics?.outcomeStatus === "partial"
          ? "failed"
          : waitingSupplemental
            ? "waiting_supplemental"
            : matchJob?.status === "running" || matchJob?.status === "queued"
              ? "running"
              : matchJob?.status === "succeeded" && !recommendations.length
                ? "no_production_candidates"
                : recommendations.length
                  ? "completed"
                  : "idle",
      progress: matchJob?.progress,
      stage: matchJob?.stage,
      scope: {
        episodes,
        scopeLabel: containsPaidEpisodes ? "包含付费集" : "仅免费集",
        targetDurationLabel:
          targetDurationSeconds <= 300
            ? "目标 1–5 分钟"
            : targetDurationSeconds > 900
              ? "目标 15–25 分钟"
              : "目标 5–15 分钟",
      },
      funnel: {
        analyzedEpisodes:
          diagnostics?.funnel.episodesRequested || episodes.length,
        rawCandidates: diagnostics?.funnel.rawCandidates ?? storyMatches.length,
        editableCandidates: Math.max(
          diagnostics?.funnel.editableCandidates ?? 0,
          editableCandidates.length,
        ),
        productionCandidates: recommendations.length,
      },
      rejectionReasons: (diagnostics?.rejectionReasons.length
        ? diagnostics.rejectionReasons.map((item) => ({
            label: diagnosticLabels[item.code] || item.code,
            count: item.count,
          }))
        : [...reasonCounts.entries()].map(([label, count]) => ({
            label,
            count,
          }))
      )
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      selectedRecommendationId,
    };
  }, [
    containsPaidEpisodes,
    dramaSource,
    episodes,
    hookSourceInput,
    matchError,
    matchJob,
    selectedEntryPoints,
    selectedRecommendationId,
    storyMatches,
    storyOverrides,
    targetDurationSeconds,
  ]);

  const transitionOptions = useMemo<HookTransitionOption[]>(
    () => [
      {
        id: "fade-cut",
        title: "短淡出淡入",
        type: "直接切入",
        durationSeconds: 0.25,
        rationale: "用短音画淡出淡入明确外搭与正片来源切换。",
        spoilerRisk: "低",
      },
      {
        id: "hard-cut",
        title: "直接硬切",
        type: "直接切入",
        durationSeconds: 0,
        rationale: "不插入过渡帧，保留最大节奏冲击。",
        spoilerRisk: "低",
      },
      {
        id: "soft-fade",
        title: "长淡出淡入",
        type: "直接切入",
        durationSeconds: 0.5,
        rationale: "用更柔和的音画过渡降低人物与场景突变感。",
        spoilerRisk: "低",
      },
    ],
    [],
  );

  const selectableRecommendations = [
    ...match.recommendations,
    ...(match.editableCandidates ?? []),
  ];
  const effectiveRecommendationId =
    selectedRecommendationId ?? selectableRecommendations[0]?.id;
  const selectedRecommendation =
    selectableRecommendations.find(
      (item) => item.id === effectiveRecommendationId,
    ) ?? selectableRecommendations[0];
  const selectedTransition =
    transitionOptions.find((item) => item.id === selectedTransitionId) ??
    transitionOptions[0];
  const qualityReport = useMemo<ExternalHookQualityReport>(() => {
    const findings: ExternalHookQualityReport["findings"] = [];
    const humanApproved = Boolean(
      selectedRecommendation &&
        (selectedRecommendation.overrideApplied === true ||
          storyOverrides.includes(selectedRecommendation.id)),
    );
    const durationGateFailed =
      selectedRecommendation?.productionGate?.requiredChecks?.targetDuration ===
        false ||
      selectedRecommendation?.productionGate?.checks?.targetDuration === false;
    if (!dramaSource)
      findings.push({
        id: "drama",
        severity: "阻断",
        category: "连续性",
        title: "尚未选择本剧正片",
        detail: "需要从剧库带入真实剧目与片源。",
      });
    if (!hookSourceInput)
      findings.push({
        id: "hook",
        severity: "阻断",
        category: "首帧",
        title: "尚未选择外搭钩子",
        detail: "需要从收藏或灵感大屏带入钩子素材。",
      });
    if (
      hookSourceInput &&
      hookSourceInput.hookSourceClass !== "external_material"
    )
      findings.push({
        id: "hook-source",
        severity: "阻断",
        category: "货不对板",
        title: "钩子不是外搭素材片段",
        detail: "此模式只允许匹配从外搭素材中定位出的具体钩子。",
      });
    if (hookSourceInput && hookSourceInput.hookBoundaryStatus !== "verified")
      findings.push({
        id: "hook-boundary",
        severity: "阻断",
        category: "连续性",
        title: "钩子边界尚未验证",
        detail: "钩子起止点必须同时通过完整对白、完整动作和镜头边界检查。",
      });
    if (
      hookSourceInput &&
      !["已获授权可制作", "已获授权可投放"].includes(
        hookSourceInput.rightsStatus ?? "",
      )
    )
      findings.push({
        id: "hook-rights",
        severity: "建议",
        category: "合规",
        title: "钩子授权状态待确认",
        detail: "当前版本不把授权状态作为生产硬门，但正式投放前仍建议核对。",
      });
    if (dramaSource && hookSourceInput && !selectedRecommendation)
      findings.push({
        id: "match",
        severity: "阻断",
        category: "承诺兑现",
        title: "没有可追溯的高光承接点",
        detail: "请先完成本剧高光解析，匹配必须对应到具体集数和帧。",
      });
    if (selectedRecommendation && !selectedRecommendation.videoUrl)
      findings.push({
        id: "story-video",
        severity: "阻断",
        category: "连续性",
        title: "候选没有可播放正片",
        detail: "人工批准的前提是候选关联真实视频和有效时间范围。",
      });
    if (
      selectedRecommendation?.matchStatus === "needs_review" &&
      !passesHardGate(selectedRecommendation.productionGate)
    )
      findings.push({
        id: "match-review",
        severity:
          humanApproved || matchStrategy === "template_reuse"
            ? "建议"
            : "阻断",
        category: "连续性",
        title:
          humanApproved || matchStrategy === "template_reuse"
            ? "承接证据保留为人工复核项"
            : "承接证据需要复核",
        detail:
          humanApproved || matchStrategy === "template_reuse"
          ? "该模式暂不启用模型分数门禁；问题保留为预览检查项。"
          : "匹配结果存在安全边界或硬性证据问题；请结合生产门禁明细处理。",
      });
    if (
      selectedRecommendation?.productionGate &&
      !passesHardGate(selectedRecommendation.productionGate)
    )
      findings.push({
        id: "production-gate",
        severity: humanApproved || matchStrategy === "template_reuse"
            ? "建议"
            : "阻断",
        category: "承诺兑现",
        title: durationGateFailed
          ? "承接片段尚未达到成片目标时长"
          : humanApproved || matchStrategy === "template_reuse"
          ? "模型生产门未通过，保留人工判断"
          : "匹配尚未通过生产门禁",
        detail:
          durationGateFailed
            ? "这里仅选择正片承接点，不再按5–15分钟阻断；最终时长将在成片时间线形成后校验。"
            : selectedRecommendation.productionGate.reasons?.join("；") ||
              "需要满足校准概率、证据覆盖和边界可靠度要求。",
      });
    if (selectedRecommendation?.completeness?.status === "partial")
      findings.push({
        id: "story-advisory",
        severity: "建议",
        category: "承诺兑现",
        title: "故事采用高吸引力截取结构",
        detail: `当前未覆盖完整故事阶段：${selectedRecommendation.completeness.missingPhases?.join("、") || "部分因果链"}。允许继续生成，请在预览中确认不影响理解。`,
      });
    if (
      (selectedRecommendation?.calibration?.calibratedProbability ?? 0) >=
        0.9 &&
      (selectedRecommendation?.completeness?.confidence ?? 0) < 0.5 &&
      (selectedRecommendation?.completeness?.causalCoverage ?? 0) < 0.5
    )
      findings.push({
        id: "score-consistency",
        severity: "建议",
        category: "承诺兑现",
        title: "高匹配分与结构证据不一致",
        detail:
          "标签与对白相似度较高，但事件因果链和故事阶段覆盖不足；95 分不能等同于完整承接质量。",
        suggestion: "保留高刺激短线，同时在预览中重点检查片段间语义跳跃",
      });
    if (
      selectedTransition.id === "hard-cut" &&
      hookSourceInput?.hookSourceClass === "external_material"
    )
      findings.push({
        id: "transition-risk",
        severity: "建议",
        category: "连续性",
        title: "外搭素材使用硬切",
        detail: "外搭人物与正片人物、场景通常不同，硬切可能造成来源突变。",
        suggestion: "优先比较短淡出淡入版本",
      });
    if (
      selectedRecommendation?.segments?.some(
        (segment) =>
          segment.safeStart?.status !== "verified" ||
          segment.safeEnd?.status !== "verified",
      )
    )
      findings.push({
        id: "segment-boundary",
        severity:
          humanApproved || matchStrategy === "template_reuse"
            ? "建议"
            : "阻断",
        category: "连续性",
        title: "正片片段存在不安全切点",
        detail: humanApproved
          ? "人工已允许进入生产，请在预览中重点检查对白、动作和反应镜头是否截断。"
          : "时间线不能截断人物完整一句话、连续动作或反应镜头。",
      });
    if (selectedRecommendation && !hookSourceInput?.narrativePromise)
      findings.push({
        id: "promise",
        severity: "建议",
        category: "承诺兑现",
        title: "钩子叙事承诺需要确认",
        detail: "钩子已有时间码，但叙事承诺尚未形成可审核文本。",
        suggestion: "在钩子原型页补充承诺拆解",
      });
    if (
      selectedRecommendation &&
      !findings.some((item) => item.severity === "阻断")
    )
      findings.push({
        id: "evidence",
        severity: "通过",
        category: "承诺兑现",
        title: "匹配证据与安全边界可追溯",
        detail:
          "匹配结果包含具体剧集区间、承接证据及双端安全边界；故事完整度单独作为创意建议。",
      });
    const sourceScore =
      dramaSource && hookSourceInput?.hookSourceClass === "external_material"
        ? 20
        : 0;
    const playableScore = selectedRecommendation?.videoUrl ? 20 : 0;
    const boundaryScore =
      hookSourceInput?.hookBoundaryStatus === "verified" ? 10 : 0;
    const segmentBoundaryRatio = selectedRecommendation?.segments?.length
      ? selectedRecommendation.segments.filter(
          (segment) =>
            segment.safeStart?.status === "verified" &&
            segment.safeEnd?.status === "verified",
        ).length / selectedRecommendation.segments.length
      : 0;
    const storyScore = Math.round(
      Math.min(
        15,
        Math.max(0, (selectedRecommendation?.storyScore ?? 0) * 0.15),
      ),
    );
    const promiseScore = Math.round(
      Math.min(
        15,
        Math.max(
          0,
          (selectedRecommendation?.promiseFulfillmentScore ?? 0) * 0.15,
        ),
      ),
    );
    const evidenceScore = Math.round(
      Math.min(
        10,
        Math.max(
          0,
          (((selectedRecommendation?.calibration?.evidenceCoverage ?? 0) +
            (selectedRecommendation?.calibration?.boundaryReliability ?? 0)) /
            2) *
            10,
        ),
      ),
    );
    const continuityScore =
      Math.round(segmentBoundaryRatio * 5) +
      (selectedTransition.id === "hard-cut" ? 2 : 5);
    let score = Math.max(
      0,
      Math.min(
        100,
        sourceScore +
          playableScore +
          boundaryScore +
          storyScore +
          promiseScore +
          evidenceScore +
          continuityScore,
      ),
    );
    if (findings.some((item) => item.severity === "阻断"))
      score = Math.min(score, 59);
    const verdict = findings.some((item) => item.severity === "阻断")
      ? "阻断"
      : findings.some((item) => item.severity === "建议")
        ? "建议优化"
        : "可以直接生成";
    return {
      status: "completed",
      verdict,
      score,
      checkedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      findings,
    };
  }, [
    dramaSource,
    hookSourceInput,
    matchStrategy,
    selectedRecommendation,
    selectedTransition.id,
    storyOverrides,
  ]);

  const defaultTimeline = useMemo<ExternalHookTimelineClip[]>(() => {
    if (!selectedRecommendation || !hookSourceInput) return [];
    const anchorSegment = [...(selectedRecommendation.segments ?? [])]
      .filter(
        (segment) =>
          Number(segment.episode) > 0 && Number.isFinite(Number(segment.start)),
      )
      .sort(
        (left, right) =>
          Number(left.episode) - Number(right.episode) ||
          Number(left.start) - Number(right.start),
      )[0];
    const anchorEpisode = Number(
      anchorSegment?.episode ?? selectedRecommendation.episode,
    );
    const anchorStart = Number(
      anchorSegment?.start ?? selectedRecommendation.startSeconds,
    );
    if (!Number.isFinite(anchorStart) || anchorStart < 0) return [];
    const availableEpisodes = Object.keys(dramaSource?.episodeMedia ?? {})
      .map(Number)
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const sequentialEpisodes: number[] = [];
    for (let offset = 0; offset <= 3; offset += 1) {
      const episode = anchorEpisode + offset;
      if (!availableEpisodes.includes(episode)) break;
      sequentialEpisodes.push(episode);
    }
    const storyClips = sequentialEpisodes.flatMap((episode, index) => {
      const media = dramaSource?.episodeMedia?.[episode];
      const episodeEnd = Number(media?.duration ?? 0);
      const start = index === 0 ? anchorStart : 0;
      if (!media?.url || !Number.isFinite(episodeEnd) || episodeEnd <= start)
        return [];
      return [
        {
          id: `clip-sequential-episode-${episode}`,
          kind: (index === 0
            ? "episode"
            : index === sequentialEpisodes.length - 1
              ? "paywall"
              : "climax") as ExternalHookTimelineClip["kind"],
          title:
            index === 0
              ? `${padEpisode(episode)} · 从命中高光顺播至本集结束`
              : `${padEpisode(episode)} · 顺序完整承接`,
          sourceLabel:
            dramaSource?.dramaCn ?? dramaSource?.title ?? "本剧正片",
          durationSeconds: episodeEnd - start,
          episode,
          startTimecode: timecode(start),
          endTimecode: timecode(episodeEnd),
          startSeconds: start,
          endSeconds: episodeEnd,
          locked: false,
        },
      ];
    });
    return [
      {
        id: "clip-hook",
        kind: "hook",
        title: hookSourceInput.title,
        sourceLabel:
          hookSourceInput.kind === "favorite" ? "我的收藏" : "灵感大屏",
        durationSeconds: Math.max(
          0,
          (hookSourceInput.hookEnd ?? 0) - (hookSourceInput.hookStart ?? 0),
        ),
        startTimecode: timecode(hookSourceInput.hookStart ?? 0),
        endTimecode: timecode(hookSourceInput.hookEnd ?? 0),
        locked: hookSourceInput.hookBoundaryStatus !== "verified",
      },
      {
        id: "clip-transition",
        kind: "transition",
        title: selectedTransition.title,
        sourceLabel: "过渡设计",
        durationSeconds: selectedTransition.durationSeconds,
      },
      ...storyClips,
    ];
  }, [
    dramaSource,
    hookSourceInput,
    selectedRecommendation,
    selectedTransition,
  ]);
  const productionEpisodeNumbers = useMemo(
    () =>
      Array.from(
        new Set(
          defaultTimeline
            .map((clip) => clip.episode)
            .filter((episode): episode is number => Number(episode) > 0),
        ),
      ),
    [defaultTimeline],
  );
  const visibleTimeline = timeline.length ? timeline : defaultTimeline;
  const externalTimelineDurationSeconds = visibleTimeline.reduce(
    (sum, clip) => sum + Math.max(0, Number(clip.durationSeconds) || 0),
    0,
  );
  const externalTimelineDurationReady =
    externalTimelineDurationSeconds >= 300 &&
    externalTimelineDurationSeconds <= 900;

  const buildDraft = (projectIdOverride?: string): Draft => {
    const workflow = createInitialFactoryWorkflow();
    workflow.currentStep = workflow.steps[activeStep]?.id ?? "episode-source";
    workflow.goal = {
      objective:
        goal === "停滑与点击"
          ? "click-through"
          : goal === "连续观看"
            ? "completion"
            : "conversion",
      market: "美国",
      language,
      platform: "Meta",
      ratio,
      targetDurationSeconds,
      plannedVariantCount: variantCount,
      aiGenerationAllowed: hookSource === "新生成钩子",
      intensity: "balanced",
    };
    workflow.steps = workflow.steps.map((step, index) => ({
      ...step,
      state:
        index < activeStep
          ? "completed"
          : index === activeStep
            ? "active"
            : stepReady[index]
              ? "ready"
              : "locked",
    }));
    workflow.qualityReport = {
      status: qualityConfirmed ? "available" : "not-connected",
      findings: [],
    };
    return {
      id: draftId,
      title:
        title.trim() ||
        `${source?.dramaCn ?? source?.dramaTitle ?? source?.title ?? "未命名项目"} · ${definition.name}`,
      mode,
      drama: source?.dramaTitle ?? source?.title ?? "未关联剧目",
      hook:
        hookSourceInput?.title ??
        (source?.kind === "favorite" || source?.kind === "inspiration"
          ? source.title
          : ""),
      episodeRange: selectedRange(episodes),
      transition:
        mode === "external-hook" ? selectedTransition.title : "未设置",
      language,
      duration:
        episodes.reduce(
          (sum, episode) =>
            sum + (source?.episodeMedia?.[episode]?.duration ?? 0),
          0,
        ) > 0
          ? `${Math.floor(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) / 60)}:${String(Math.round(episodes.reduce((sum, episode) => sum + (source?.episodeMedia?.[episode]?.duration ?? 0), 0) % 60)).padStart(2, "0")}`
          : "未生成",
      ratio,
      qualityStatus: "建议优化后生成",
      updatedAt: "刚刚",
      autoSaved: true,
      thumbnailTone:
        mode === "external-hook"
          ? "blue"
          : mode === "episode-narration"
            ? "violet"
            : "rose",
      thumbnailUrl: episodes
        .map((episode) => source?.episodeMedia?.[episode]?.url)
        .find(Boolean),
      progress: 0,
      productionStatus: "编辑中",
      version: draftVersion,
      sourceContext: source,
      hookSourceContext: hookSourceInput,
      selectedEpisodes: productionEpisodeNumbers.length
        ? productionEpisodeNumbers
        : episodes,
      workflow,
      factoryProjectId: projectIdOverride ?? factoryProjectId,
      factoryRenderId: factoryRender?.id,
      storyMatchId: selectedRecommendation?.id,
      isHistorySnapshot: !historyForked,
      factorySnapshot: {
        timeline: visibleTimeline,
        activeStorylineId,
        storylineHookPairs,
        storylineMatchCache,
        transition: {
          ...selectedTransition,
          matchStrategy,
          deliveryGoal: goal,
          matchingDimensions,
          selectedStorylineIds,
          selectedStorylines: selectedStorylinePlans,
        } as unknown as Record<string, unknown>,
        qualityReport: qualityReport as unknown as Record<string, unknown>,
        review: editingDraft?.factorySnapshot?.review ?? {},
        projectStatus: factoryRender?.status ?? "editing",
      },
    };
  };

  const save = async (silent = false) => {
    if (silent && !dirty) return;
    if (!source && !hookSourceInput) {
      if (!silent) onNotify?.("请先选择本剧正片或外搭钩子");
      return;
    }
    if (editingDraft?.isHistorySnapshot && !historyForked && !dirty) {
      onDraftAutoSave?.(buildDraft(factoryProjectId));
      if (!silent) onNotify?.("历史版本未发生修改，已保留原成片与审核记录");
      return;
    }
    let persistedProjectId = factoryProjectId;
    if (
      mode === "external-hook" &&
      externalReady &&
      selectedRecommendation &&
      !factoryRender?.outputUrl
    ) {
      try {
        persistedProjectId = (await persistExternalProject()).id;
      } catch (error) {
        if (!silent)
          onNotify?.(
            error instanceof Error ? error.message : "生产项目保存失败",
          );
        return;
      }
    }
    const draft = buildDraft(persistedProjectId);
    onDraftAutoSave?.(draft);
    setSavedAt("刚刚自动保存");
    autoSaveSecondsRef.current = 15;
    setAutoSaveCountdown(15);
    setDirty(false);
    if (!silent) onNotify?.("制作草稿已保存到「我的创作」");
  };

  const persistExternalProject = async () => {
    if (
      !dramaSource?.id ||
      !hookSourceInput?.hookAssetId ||
      !selectedRecommendation ||
      !visibleTimeline.length
    )
      throw new Error("请先完成钩子、剧集与完整故事线匹配");
    const projectPayload = {
      id: factoryProjectId,
      forkFrom:
        !factoryProjectId && historyForked
          ? editingDraft?.factoryProjectId
          : undefined,
      forkReason: "历史草稿参数修改自动副本",
      changedParameters: [
        "标题",
        "剧集范围",
        "外搭钩子",
        "匹配方向",
        "正片故事线方案",
        "故事线",
        "过渡方案",
        "时间线",
        "输出比例",
        "成片语种",
        "质检确认",
      ],
      title:
        title.trim() ||
        `${dramaSource.dramaCn ?? dramaSource.title} · 外搭钩子版`,
      dramaId: dramaSource.id,
      hookId: hookSourceInput.hookAssetId,
      storyMatchId: selectedRecommendation.id,
      selectedEpisodes: episodes,
      topics: hookSourceInput.themes ?? [],
      transition: {
        ...selectedTransition,
        matchStrategy,
        deliveryGoal: goal,
        matchingDimensions,
        selectedStorylineIds,
        selectedStorylines: selectedStorylinePlans,
        bodyAssemblyMode: "sequential_from_highlight",
        sequentialEpisodeCount: productionEpisodeNumbers.length,
      },
      timeline: visibleTimeline,
      qualityReport: qualityReport,
      version: draftVersion,
      ratio,
      language,
      paidScopeConfirmed,
    };
    let project;
    try {
      project = await saveFactoryProject(projectPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !factoryProjectId ||
        !message.toLowerCase().includes("immutable")
      )
        throw error;
      // A reviewed/approved render is immutable evidence. If the user keeps
      // editing from that browser state, transparently fork the exact current
      // workspace instead of leaving the preview button in a dead end.
      project = await saveFactoryProject({
        ...projectPayload,
        id: undefined,
        forkFrom: factoryProjectId,
        forkReason: "已审核版本继续制作自动副本",
      });
      setDraftVersion((value) => value + 1);
      setHistoryForked(true);
      onNotify?.("已保留审核历史，并自动创建可继续制作的副本");
    }
    setFactoryProjectId(project.id);
    return project;
  };

  const requestExternalRender = async () => {
    setFactoryRenderError("");
    onNotify?.("正在保存项目并创建预览任务…");
    const project = await persistExternalProject();
    const render = await startFactoryRender(project.id);
    setFactoryRender(render);
  };

  const requestStorylineBatchRenders = async () => {
    if (!dramaSource?.id || !selectedStorylinePlans.length)
      throw new Error("请先选择需要生成的故事线版本");
    setFactoryRenderError("");
    onNotify?.(`正在创建 ${selectedStorylinePlans.length} 个独立预览任务…`);
    const created: Record<string, FactoryRenderRecord> = {};
    for (const plan of selectedStorylinePlans) {
      const pair = storylineHookPairs[plan.id];
      const cached = storylineMatchCache[plan.id];
      if (!pair?.hookAssetId || !cached?.job?.id) continue;
      const job = await getHookMatchJob(cached.job.id);
      if (job.status !== "succeeded") continue;
      const matches = cached.matches.length
        ? cached.matches
        : await listHookStoryMatches(
            pair.hookAssetId,
            dramaSource.id,
            undefined,
            job.matchContextHash,
          );
      const storyMatch = matches.find(
        (item) => item.id === cached.selectedRecommendationId,
      ) ?? matches[0];
      if (!storyMatch) continue;
      const versionTimeline: ExternalHookTimelineClip[] = [
        {
          id: `hook-${plan.id}`,
          kind: "hook",
          title: pair.title,
          sourceLabel: "外搭钩子",
          durationSeconds: Math.max(
            0,
            (pair.hookEnd ?? 0) - (pair.hookStart ?? 0),
          ),
          startTimecode: timecode(pair.hookStart ?? 0),
          endTimecode: timecode(pair.hookEnd ?? 0),
        },
        {
          id: `transition-${plan.id}`,
          kind: "transition",
          title: selectedTransition.title,
          sourceLabel: "过渡设计",
          durationSeconds: selectedTransition.durationSeconds,
        },
        ...plan.segments.map((segment, index) => ({
          id: `story-${plan.id}-${index}`,
          kind: (index === 0 ? "episode" : "climax") as ExternalHookTimelineClip["kind"],
          title: segment.plot,
          sourceLabel: dramaSource.dramaCn ?? dramaSource.title,
          episode: segment.episode,
          durationSeconds: Math.max(0, segment.end - segment.start),
          startSeconds: segment.start,
          endSeconds: segment.end,
          startTimecode: timecode(segment.start),
          endTimecode: timecode(segment.end),
        })),
      ];
      const project = await saveFactoryProject({
        title: `${title || dramaSource.dramaCn || dramaSource.title} · ${plan.title}`,
        dramaId: dramaSource.id,
        hookId: pair.hookAssetId,
        storyMatchId: storyMatch.id,
        selectedEpisodes: [...new Set(plan.segments.map((item) => item.episode))],
        topics: pair.themes ?? [],
        transition: {
          ...selectedTransition,
          matchStrategy: "story_to_hook",
          storylineId: plan.id,
          storylineTitle: plan.title,
          bodyAssemblyMode: "selected_storyline_version",
        },
        timeline: versionTimeline,
        qualityReport: { skipped: true, reason: "content_check_removed" },
        version: 1,
        ratio,
        language,
        paidScopeConfirmed,
      });
      created[plan.id] = await startFactoryRender(project.id);
    }
    if (!Object.keys(created).length)
      throw new Error("已选故事线尚无完成的匹配结果，暂时无法生成预览");
    setFactoryRendersByStoryline((current) => ({ ...current, ...created }));
    const first = created[selectedStorylinePlans[0]?.id] ?? Object.values(created)[0];
    setFactoryRender(first);
    onNotify?.(`已创建 ${Object.keys(created).length} 个版本的预览任务`);
  };

  const persistEpisodeSpliceProject = async () => {
    if (!source?.id || !selectedSpliceHighlight || !spliceDurationReady)
      throw new Error("请选择可形成5–15分钟成片的高光起点");
    const project = await saveEpisodeSpliceProject({
      id: factoryProjectId,
      title:
        title.trim() ||
        `${source.dramaCn ?? source.title} · 正片顺序拼接`,
      dramaId: source.id,
      selectedEpisodes: spliceTimeline.map((item) => Number(item.episode)),
      timeline: spliceTimeline,
      qualityReport: {
        passed: true,
        strategy: "highlight-to-episode-end-plus-next-episodes",
        durationSeconds: spliceDurationSeconds,
        checks: {
          consecutiveEpisodes: true,
          minimumFollowingEpisodes: spliceTimeline.length >= 3,
          targetDuration: spliceDurationReady,
          realSources: spliceTimeline.every(
            (item) => Boolean(source.episodeMedia?.[Number(item.episode)]?.url),
          ),
        },
      },
      ratio,
      language,
    });
    setFactoryProjectId(project.id);
    return project;
  };

  const requestEpisodeSpliceRender = async () => {
    setFactoryRenderError("");
    const project = await persistEpisodeSpliceProject();
    const render = await startFactoryRender(project.id);
    setFactoryRender(render);
  };

  const latestSaveRef = useRef(save);
  const savedStorylineCacheSignatureRef = useRef("");
  useEffect(() => {
    latestSaveRef.current = save;
  });

  useEffect(() => {
    if (
      matchStrategy !== "story_to_hook" ||
      !activeStorylineId ||
      !hookSourceInput?.hookAssetId ||
      (!matchJob && !storyMatches.length)
    )
      return;
    setStorylineMatchCache((current) => ({
      ...current,
      [activeStorylineId]: {
        hookAssetId: hookSourceInput.hookAssetId!,
        matches: storyMatches,
        job: matchJob,
        selectedRecommendationId,
        savedAt: new Date().toISOString(),
      },
    }));
    setDirty(true);
  }, [
    activeStorylineId,
    hookSourceInput?.hookAssetId,
    matchJob,
    matchStrategy,
    selectedRecommendationId,
    storyMatches,
  ]);

  useEffect(() => {
    if (!activeStorylineId) return;
    const cached = storylineMatchCache[activeStorylineId];
    if (!cached?.matches.length) return;
    const signature = `${activeStorylineId}|${cached.hookAssetId}|${cached.matches.map((item) => item.id).join(",")}|${cached.selectedRecommendationId ?? ""}`;
    if (savedStorylineCacheSignatureRef.current === signature) return;
    savedStorylineCacheSignatureRef.current = signature;
    const timer = window.setTimeout(() => {
      void latestSaveRef.current(true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [activeStorylineId, storylineMatchCache]);

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
      setHistoryForked(true);
      setFactoryProjectId(undefined);
      setFactoryRender(null);
      setDraftId(`draft-${Date.now()}`);
      setDraftVersion((value) => value + 1);
      setTitle((value) =>
        value.endsWith("· 副本") ? value : `${value} · 副本`,
      );
      onNotify?.("检测到历史版本参数变更，已自动创建原草稿副本");
    }
    setDirty(true);
  };
  useEffect(() => {
    if (!editingDraft?.factoryRenderId) return;
    const controller = new AbortController();
    void getFactoryRender(editingDraft.factoryRenderId, controller.signal)
      .then(setFactoryRender)
      .catch(() => {});
    return () => controller.abort();
  }, [editingDraft?.factoryRenderId]);
  useEffect(() => {
    if (!factoryRender?.id || (factoryRender.status !== "queued" && factoryRender.status !== "rendering")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getFactoryRender(factoryRender.id, controller.signal)
        .then((current) => {
          setFactoryRenderError("");
          setFactoryRender(current);
          if (current.status === "succeeded") onNotify?.("真实预览已生成，等待人工审核");
          if (current.status === "failed") setFactoryRenderError(current.error || "真实预览生成失败，请重新生成");
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setFactoryRenderError(error instanceof Error ? `任务状态更新失败：${error.message}` : "任务状态更新失败，请检查服务连接");
        });
    }, 1500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [factoryRender?.id, factoryRender?.status, factoryRender?.progress, onNotify]);
  useEffect(() => {
    const pending = Object.entries(factoryRendersByStoryline).filter(
      ([, render]) => render.status === "queued" || render.status === "rendering",
    );
    if (!pending.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void Promise.all(
        pending.map(async ([planId, render]) => [
          planId,
          await getFactoryRender(render.id, controller.signal),
        ] as const),
      ).then((updates) => {
        if (controller.signal.aborted) return;
        setFactoryRendersByStoryline((current) => ({
          ...current,
          ...Object.fromEntries(updates),
        }));
        const activeUpdate = updates.find(
          ([planId]) => planId === activeStorylineId,
        );
        if (activeUpdate) setFactoryRender(activeUpdate[1]);
      }).catch(() => {});
    }, 1500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [activeStorylineId, factoryRendersByStoryline]);
  useEffect(() => {
    if (
      mode !== "external-hook" ||
      !dramaSource?.id ||
      !episodes.length ||
      ((matchStrategy === "hook_to_story" ||
        matchStrategy === "template_reuse") &&
        !hookSourceInput?.hookAssetId)
    ) {
      setStorylinePlans([]);
      setStoryUnderstanding(null);
      setActiveStoryThreadId(undefined);
      setSelectedStorylineIds([]);
      setHookUnderstanding(null);
      return;
    }
    const controller = new AbortController();
    setStorylineLoading(true);
    setStorylineError("");
    const request =
      matchStrategy === "template_reuse"
        ? listTemplateAdaptationPlans(
            hookSourceInput!.hookAssetId!,
            dramaSource.id,
            episodes,
            goal,
            targetDurationSeconds,
            controller.signal,
          )
        : matchStrategy === "hook_to_story"
          ? listHookDrivenStorylinePlans(
              hookSourceInput!.hookAssetId!,
              dramaSource.id,
              episodes,
              goal,
              targetDurationSeconds,
              controller.signal,
            )
          : listStorylinePlans(
              dramaSource.id,
              episodes,
              goal,
              targetDurationSeconds,
              controller.signal,
            );
    void request
      .then((result) => {
        if ("storyNeed" in result) setStrategyStoryNeed(result.storyNeed);
        if ("storyUnderstanding" in result) {
          setStoryUnderstanding(result.storyUnderstanding);
          setActiveStoryThreadId((current) =>
            (result.storyUnderstanding.storylines ?? []).some(
              (storyline) => storyline.id === current,
            )
              ? current
              : result.storyUnderstanding.storylines?.[0]?.id,
          );
        } else {
          setStoryUnderstanding(null);
          setActiveStoryThreadId(undefined);
        }
        if ("hookUnderstanding" in result)
          setHookUnderstanding(result.hookUnderstanding);
        else setHookUnderstanding(null);
        setStorylineDiagnostics(result.diagnostics);
        setStorylinePlans(result.items);
        setSelectedStorylineIds((current) =>
          current.filter((id) => result.items.some((item) => item.id === id)),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setStorylineError(
            error instanceof Error ? error.message : "故事线生成失败",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setStorylineLoading(false);
      });
    return () => controller.abort();
  }, [
    dramaSource?.id,
    episodes.join(","),
    goal,
    hookSourceInput?.hookAssetId,
    matchStrategy,
    mode,
    targetDurationSeconds,
    storylineRequestToken,
  ]);
  const selectedStorylinePlans = storylinePlans.filter((item) =>
    selectedStorylineIds.includes(item.id),
  );
  const activeStoryThread = storyUnderstanding?.storylines.find(
    (storyline) => storyline.id === activeStoryThreadId,
  );
  const visibleStorylinePlans = activeStoryThread
    ? storylinePlans.filter((plan) =>
        activeStoryThread.sourcePlanIds.includes(plan.id),
      )
    : storylinePlans;
  const primaryTemplatePlan =
    matchStrategy === "template_reuse" ? selectedStorylinePlans[0] : undefined;
  const selectedTemplate = asRecord(hookSourceInput?.historicalTemplate);
  const templatePerformance = asRecord(selectedTemplate.performanceEvidence);
  const templateTimeline = Array.isArray(selectedTemplate.timelineSkeleton)
    ? (selectedTemplate.timelineSkeleton as Array<Record<string, unknown>>)
    : [];
  const templateBody = Array.isArray(selectedTemplate.bodyStructure)
    ? (selectedTemplate.bodyStructure as Array<Record<string, unknown>>)
    : [];
  const activeStorylinePlan = storylinePlans.find(
    (item) => item.id === activeStorylineId,
  );
  const activateStorylinePair = (planId: string) => {
    if (planId === activeStorylineId) return;
    if (activeStorylineId && hookSourceInput?.hookAssetId) {
      setStorylineMatchCache((current) => ({
        ...current,
        [activeStorylineId]: {
          hookAssetId: hookSourceInput.hookAssetId!,
          matches: storyMatches,
          job: matchJob,
          selectedRecommendationId,
          savedAt: new Date().toISOString(),
        },
      }));
    }
    setActiveStorylineId(planId);
    setMatchError("");
    setTimeline([]);
    const pairedHook = storylineHookPairs[planId];
    const cached = storylineMatchCache[planId];
    if (pairedHook) {
      onChooseHook?.(pairedHook);
      if (cached?.hookAssetId === pairedHook.hookAssetId) {
        setMatchJob(cached.job);
        setStoryMatches(cached.matches);
        setSelectedRecommendationId(cached.selectedRecommendationId);
        setMatchRequestToken(0);
        onNotify?.("已切换故事线，并恢复该方案已保存的匹配结果");
      } else {
        setMatchJob(null);
        setStoryMatches([]);
        setSelectedRecommendationId(undefined);
        setMatchRequestToken((value) => value + 1);
        onNotify?.("已切换故事线，正在进行该方案的首次匹配");
      }
    } else {
      setMatchJob(null);
      setStoryMatches([]);
      setSelectedRecommendationId(undefined);
      setMatchRequestToken(0);
      onNotify?.("已切换故事线；该方案尚未匹配钩子");
    }
  };
  const toggleStoryline = (id: string) => {
    setSelectedStorylineIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
    setHookOptions([]);
    setMatchRequestToken(0);
    setMatchJob(null);
    setStoryMatches([]);
    touch();
  };
  const matchAllSelectedStorylines = async () => {
    if (
      !dramaSource?.id ||
      !episodes.length ||
      !selectedStorylinePlans.length ||
      bulkHookMatching
    )
      return;
    setBulkHookMatching(true);
    setPickerError("");
    try {
      const assets = await listSelectableExternalHooks();
      const assetsById = new Map(assets.map((item) => [item.id, item]));
      const used = new Set<string>();
      const pairs: Record<string, FactorySourceContext> = {};
      for (const plan of selectedStorylinePlans) {
        const result = await listStoryDrivenHookRecommendations(
          dramaSource.id,
          episodes,
          goal,
          [plan],
        );
        const recommendation =
          result.items.find(
            (item) => !used.has(item.hookId) && assetsById.has(item.hookId),
          ) ?? result.items.find((item) => assetsById.has(item.hookId));
        if (!recommendation) continue;
        const asset = assetsById.get(recommendation.hookId)!;
        used.add(asset.id);
        pairs[plan.id] = hookOptionFromAsset(asset, recommendation);
      }
      setStorylineHookPairs((current) => ({ ...current, ...pairs }));
      const requestedScopeMode = episodes.some(
        (episode) => episode > (dramaSource.freeEpisodes ?? 0),
      )
        ? "custom"
        : "free_only";
      const startedJobs = await Promise.all(
        selectedStorylinePlans
          .filter((plan) => pairs[plan.id]?.hookAssetId)
          .map(async (plan) => {
            const pair = pairs[plan.id];
            const job = await startHookStoryMatch(
              pair.hookAssetId!,
              dramaSource.id,
              episodes,
              pair.themes ?? [],
              requestedScopeMode,
              targetDurationSeconds,
              false,
              {
                strategy: "story_to_hook",
                deliveryGoal: goal,
                matchingDimensions,
                selectedStorylines: [plan],
              },
            );
            return { plan, pair, job };
          }),
      );
      setStorylineMatchCache((current) => {
        const next = { ...current };
        for (const { plan, pair, job } of startedJobs) {
          next[plan.id] = {
            hookAssetId: pair.hookAssetId!,
            matches: [],
            job,
            selectedRecommendationId: undefined,
            savedAt: new Date().toISOString(),
          };
        }
        return next;
      });
      const firstPlan = selectedStorylinePlans.find((plan) => pairs[plan.id]);
      if (firstPlan) {
        const firstStarted = startedJobs.find(
          (item) => item.plan.id === firstPlan.id,
        );
        setActiveStorylineId(firstPlan.id);
        onChooseHook?.(pairs[firstPlan.id]);
        setMatchJob(firstStarted?.job ?? null);
        setStoryMatches([]);
        setSelectedRecommendationId(undefined);
        setMatchError("");
        setMatchRequestToken(0);
      }
      onNotify?.(
        `已为 ${Object.keys(pairs).length}/${selectedStorylinePlans.length} 条故事线分配候选钩子，并自动启动 ${startedJobs.length} 个故事匹配任务`,
      );
    } catch (error) {
      setMatchError(
        error instanceof Error ? error.message : "一键匹配钩子失败",
      );
    } finally {
      setBulkHookMatching(false);
    }
  };
  useEffect(() => {
    if (!sourcePicker) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort("素材读取超时"),
      15000,
    );
    setPickerLoading(true);
    setPickerError("");
    const request =
      sourcePicker === "drama"
        ? listPocketBaseDramas(controller.signal).then((records) =>
            setDramaOptions(
              records.map((record) => ({
                kind: "library" as const,
                id: record.recordId,
                title: record.title,
                dramaTitle: record.title,
                dramaCn: record.cn,
                description: `${record.genre} · ${record.language} · ${Object.keys(record.episodeMedia).length}/${record.totalEpisodes} 集片源`,
                genre: record.genre,
                language: record.language,
                episodes: record.totalEpisodes,
                freeEpisodes: record.freeEpisodes,
                availableEpisodes: Object.keys(record.episodeMedia).map(Number),
                episodeMedia: record.episodeMedia,
                highlightCandidates: [],
              })),
            ),
          )
        : (async () => {
            const items = await listSelectableExternalHooks(controller.signal);
            let recommendations: StrategyHookRecommendation[] = [];
            if (
              dramaSource?.id &&
              episodes.length &&
              matchStrategy === "story_to_hook"
            ) {
              const result = await listStoryDrivenHookRecommendations(
                dramaSource.id,
                episodes,
                goal,
                activeStorylinePlan ? [activeStorylinePlan] : [],
                controller.signal,
              );
              recommendations = result.items;
              setStrategyStoryNeed(result.storyNeed);
            } else if (
              dramaSource?.id &&
              episodes.length &&
              matchStrategy === "template_reuse"
            ) {
              const result = await listHistoricalTemplateRecommendations(
                dramaSource.id,
                episodes,
                goal,
                controller.signal,
              );
              recommendations = result.items;
              setStrategyStoryNeed(result.storyNeed);
            } else setStrategyStoryNeed(null);
            const ranked = new Map(
              recommendations.map((item) => [item.hookId, item]),
            );
            const candidates = recommendations.length
              ? items
                  .filter((item) => ranked.has(item.id))
                  .sort(
                    (left, right) =>
                      (ranked.get(right.id)?.score ?? 0) -
                      (ranked.get(left.id)?.score ?? 0),
                  )
              : items;
            setHookOptions(
              candidates.map((item) => {
                const rec = ranked.get(item.id);
                return {
                  kind: "inspiration" as const,
                  id: item.id,
                  hookAssetId: item.id,
                  hookSourceClass: item.sourceClass,
                  hookMaterialId: item.materialId,
                  hookMaterialPlatform: item.materialPlatform,
                  hookMaterialExposure: item.materialExposure,
                  hookMaterialRunDays: item.materialRunDays,
                  hookMediaUrl: item.materialVideoUrl,
                  hookStart: item.start,
                  hookEnd: item.end,
                  hookStartFrame: item.startFrame,
                  hookEndFrame: item.endFrame,
                  hookBoundaryStatus: item.boundaryStatus,
                  hookType: item.hookType,
                  themes: item.themes,
                  contentTags: item.contentTags,
                  ontologyTags: item.ontologyTags,
                  relationships: item.relationships,
                  conflict: item.conflict,
                  emotion: item.emotion,
                  narrativePromise: item.narrativePromise,
                  informationGap: item.informationGap,
                  rightsStatus: item.rightsStatus,
                  title: item.title,
                  description: `${item.materialTitle ?? "灵感大屏"} · ${item.hookType} · ${formatDurationZh(item.start, 2)}–${formatDurationZh(item.end, 2)}`,
                  hookMatchScore: rec?.score,
                  hookMatchReasons: rec?.reasons,
                  hookRetrievalDirection: rec?.directionLabel,
                  hookStoryNeedCoverage: rec?.storyNeedCoverage,
                  hookTruthSafety: rec?.truthSafety,
                  hookBridgeCost: rec?.bridgeCost,
                  hookSpoilerRisk: rec?.spoilerRisk,
                  historicalTemplate: rec?.template,
                  templateEvidenceLevel: rec?.evidenceLevel,
                  templateProductionEligible: rec?.productionEligible,
                };
              }),
            );
          })();
    void request
      .catch((error) => {
        const timedOut =
          controller.signal.aborted &&
          controller.signal.reason === "素材读取超时";
        if (timedOut) setPickerError("素材读取超时，请点击重试");
        else if (!controller.signal.aborted)
          setPickerError(
            error instanceof Error ? error.message : "素材读取失败",
          );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        setPickerLoading(false);
      });
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [sourcePicker, pickerRequestToken]);
  const openPicker = (kind: "drama" | "hook") => {
    setSourcePicker(kind);
    setPickerRequestToken((value) => value + 1);
  };
  const openDramaPicker = () => openPicker("drama");
  const openHookPicker = () => openPicker("hook");
  const hookThemes = [
    ...new Set(hookOptions.flatMap((option) => option.themes ?? [])),
  ];
  const filteredHookOptions = hookOptions
    .filter((option) => {
      const themeMatch =
        hookThemeFilter === "全部主题" ||
        compareTagSets([hookThemeFilter], option.themes ?? [], "theme")
          .relation !== "contradictory";
      const dimensionLabels = (option.ontologyTags ?? [])
        .filter((tag) => tag.dimension === hookQueryDimension)
        .map((tag) => tag.original ?? tag.label);
      return (
        themeMatch &&
        (!hookTagQuery.trim() ||
          dimensionLabels.some((label) =>
            label.toLowerCase().includes(hookTagQuery.trim().toLowerCase()),
          ))
      );
    })
    .map((option) => {
      if (matchStrategy !== "hook_to_story") return option;
      const carriedDramaTags = (dramaSource?.ontologyTags ?? [])
        .filter((tag) =>
          [
            "genre",
            "theme",
            "relation",
            "conflict",
            "emotion",
            "storyBeat",
            "audience",
            "acquisition",
          ].includes(tag.dimension),
        )
        .sort(
          (left, right) =>
            (left.prominence === "primary" ? -1 : 1) -
            (right.prominence === "primary" ? -1 : 1),
        )
        .slice(0, 18)
        .map((tag) => ({
          label: tag.original ?? tag.label,
          dimension: tag.dimension as OntologyDimension,
        }));
      const targetLabels: Array<{
        label: string;
        dimension: OntologyDimension;
      }> = [
        ...carriedDramaTags,
        dramaSource?.genre
          ? { label: dramaSource.genre, dimension: "genre" }
          : null,
        hookThemeFilter !== "全部主题"
          ? { label: hookThemeFilter, dimension: "theme" }
          : null,
        hookTagQuery.trim()
          ? { label: hookTagQuery.trim(), dimension: hookQueryDimension }
          : null,
      ]
        .filter(
          (value): value is { label: string; dimension: OntologyDimension } =>
            Boolean(value),
        )
        .filter(
          (value, index, items) =>
            items.findIndex(
              (item) =>
                item.dimension === value.dimension &&
                item.label === value.label,
            ) === index,
        );
      const hookTags = option.ontologyTags ?? [];
      let score = 0,
        verifiedCount = 0;
      const reasons: string[] = [];
      let relation: FactorySourceContext["hookMatchRelation"] = "unknown";
      for (const requested of targetLabels) {
        const target = normalizeTag(requested.label, requested.dimension);
        const candidates = hookTags
          .filter((tag) => tag.dimension === target.dimension)
          .map((tag) => tag.original ?? tag.label);
        if (!candidates.length) {
          reasons.push(`${target.label}：证据未知`);
          continue;
        }
        const compared = compareTagSets(
          [requested.label],
          candidates,
          target.dimension,
        );
        if (compared.relation !== "unknown") {
          score += compared.score;
          verifiedCount += 1;
        }
        if (compared.relation === "contradictory") relation = "contradictory";
        else if (
          relation !== "contradictory" &&
          (compared.relation === "exact" ||
            compared.relation === "compatible" ||
            compared.relation === "bridgeable")
        )
          relation = compared.relation;
        reasons.push(
          `${target.label}：${compared.relation === "unknown" ? "证据未知" : compared.relation}`,
        );
      }
      return {
        ...option,
        hookMatchScore: verifiedCount
          ? Math.round(Math.max(0, Math.min(1, score / verifiedCount)) * 100)
          : undefined,
        hookMatchRelation: relation,
        hookMatchReasons: reasons,
      };
    })
    .sort(
      (left, right) =>
        (right.hookMatchScore ?? -1) - (left.hookMatchScore ?? -1),
    );
  useEffect(() => {
    if (
      mode !== "external-hook" ||
      matchRequestToken === 0 ||
      !hookSourceInput?.hookAssetId ||
      !dramaSource?.id ||
      !episodes.length
    )
      return;
    const controller = new AbortController();
    let pollTimer: number | undefined;
    const run = async () => {
      try {
        setMatchError("");
        const existing = await listHookStoryMatches(
          hookSourceInput.hookAssetId!,
          dramaSource.id,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStoryMatches(existing);
        // A history draft must restore its exact approved story-match snapshot.
        // Re-running matching here both loses the saved selection temporarily and
        // creates unnecessary analysis jobs every time the user opens a draft.
        if (
          matchRetryToken === 0 &&
          selectedRecommendationId &&
          existing.some(
            (item) =>
              item.id === selectedRecommendationId &&
              item.matchStrategy === matchStrategy,
          )
        )
          return;
        const requestedScope = [...episodes].sort((a, b) => a - b).join(",");
        const requestedTopics = [...(hookSourceInput.themes ?? [])]
          .sort()
          .join("|");
        const requestedScopeMode = episodes.some(
          (episode) => episode > (dramaSource.freeEpisodes ?? 0),
        )
          ? "custom"
          : "free_only";
        const requestedDurationBand =
          targetDurationSeconds <= 300
            ? "1_5m"
            : targetDurationSeconds > 900
              ? "15_25m"
              : "5_15m";
        const compatible =
          matchStrategy === "story_to_hook"
            ? []
            : existing.filter(
                (item) =>
                  item.matchContextHash &&
                  item.matchStrategy === matchStrategy &&
                  item.deliveryGoal === goal &&
                  item.scopeMode === requestedScopeMode &&
                  item.targetDurationBand === requestedDurationBand &&
                  [...item.episodeScope].sort((a, b) => a - b).join(",") ===
                    requestedScope &&
                  [...item.topics].sort().join("|") === requestedTopics &&
                  item.segments.length > 0,
              );
        const scoped = compatible[0];
        if (matchRetryToken === 0 && scoped) {
          setStoryMatches(compatible);
          setSelectedRecommendationId(scoped.id);
          return;
        }
        setStoryMatches([]);
        const created = await startHookStoryMatch(
          hookSourceInput.hookAssetId!,
          dramaSource.id,
          episodes,
          hookSourceInput.themes ?? [],
          requestedScopeMode,
          targetDurationSeconds,
          matchRetryToken > 0,
          {
            strategy: matchStrategy,
            deliveryGoal: goal,
            matchingDimensions,
            templateMaterialId:
              matchStrategy === "template_reuse"
                ? hookSourceInput.hookMaterialId
                : undefined,
            selectedStorylines:
              matchStrategy === "story_to_hook" && activeStorylinePlan
                ? [activeStorylinePlan]
                : matchStrategy === "hook_to_story" ||
                    matchStrategy === "template_reuse"
                  ? selectedStorylinePlans
                  : undefined,
          },
        );
        entryPollAttemptsRef.current = 0;
        setMatchJob(created);
        let pollFailures = 0;
        const poll = async () => {
          if (controller.signal.aborted) return;
          try {
            const current = await getHookMatchJob(
              created.id,
              controller.signal,
            );
            pollFailures = 0;
            setMatchJob(current);
            if (current.status === "succeeded") {
              setStoryMatches(
                await listHookStoryMatches(
                  hookSourceInput.hookAssetId!,
                  dramaSource.id,
                  controller.signal,
                  current.matchContextHash,
                ),
              );
              setMatchRetryToken(0);
              setMatchRequestToken(0);
              return;
            }
            if (current.status === "failed") {
              setMatchRequestToken(0);
              setMatchError(current.error || "故事线匹配失败");
              return;
            }
            pollTimer = window.setTimeout(() => void poll(), 2000);
          } catch (error) {
            if (controller.signal.aborted) return;
            pollFailures += 1;
            // PocketBase or the local dev proxy can briefly return 502 while a
            // semantic job continues in the worker. Keep polling for one full
            // worker lease/recovery window instead of presenting a false task
            // failure after only twelve seconds.
            if (pollFailures >= 30) {
              setMatchRequestToken(0);
              setMatchError(
                error instanceof Error
                  ? `读取匹配进度失败：${error.message}`
                  : "读取匹配进度失败",
              );
              return;
            }
            pollTimer = window.setTimeout(() => void poll(), 2000);
          }
        };
        await poll();
      } catch (error) {
        if (!controller.signal.aborted)
          setMatchError(
            error instanceof Error ? error.message : "故事线匹配任务创建失败",
          );
      }
    };
    const startTimer = window.setTimeout(() => void run(), 0);
    return () => {
      controller.abort();
      window.clearTimeout(startTimer);
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [
    activeStorylineId,
    dramaSource?.id,
    episodes.join(","),
    goal,
    hookSourceInput?.hookAssetId,
    matchRequestToken,
    matchRetryToken,
    matchStrategy,
    mode,
    targetDurationSeconds,
  ]);
  // Switching between storylines restores the saved job snapshot instead of
  // creating the same analysis again. A queued/running snapshot still needs a
  // live progress subscription, otherwise the restored card remains at 0%
  // even after the worker has picked up (or completed) the job.
  useEffect(() => {
    if (
      mode !== "external-hook" ||
      matchRequestToken !== 0 ||
      !matchJob?.id ||
      !["queued", "running", "succeeded"].includes(matchJob.status) ||
      !hookSourceInput?.hookAssetId ||
      !dramaSource?.id
    )
      return;
    const controller = new AbortController();
    let pollTimer: number | undefined;
    let pollFailures = 0;
    const poll = async () => {
      if (controller.signal.aborted) return;
      try {
        const current = await getHookMatchJob(matchJob.id, controller.signal);
        if (controller.signal.aborted) return;
        pollFailures = 0;
        if (current.status === "succeeded") {
          const matches = await listHookStoryMatches(
            hookSourceInput.hookAssetId!,
            dramaSource.id,
            controller.signal,
            current.matchContextHash,
          );
          if (controller.signal.aborted) return;
          setMatchJob(current);
          setStoryMatches(matches);
          setSelectedRecommendationId((selected) =>
            selected && matches.some((item) => item.id === selected)
              ? selected
              : matches[0]?.id,
          );
          setMatchRetryToken(0);
          setMatchError("");
          return;
        }
        if (current.status === "failed") {
          setMatchJob(current);
          setMatchError(current.error || "故事线匹配失败");
          return;
        }
        setMatchJob(current);
        pollTimer = window.setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (controller.signal.aborted) return;
        pollFailures += 1;
        if (pollFailures >= 30) {
          setMatchError(
            error instanceof Error
              ? `恢复匹配进度失败：${error.message}`
              : "恢复匹配进度失败",
          );
          return;
        }
        pollTimer = window.setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [
    dramaSource?.id,
    hookSourceInput?.hookAssetId,
    matchJob?.id,
    matchJob?.status,
    matchRequestToken,
    mode,
  ]);
  useEffect(() => {
    if (
      !hookSourceInput?.hookAssetId ||
      !dramaSource?.id ||
      !storyMatches.slice(0, 3).some((item) => item.entryPoints.length === 0) ||
      entryPollAttemptsRef.current >= 30
    )
      return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      if (controller.signal.aborted || entryPollAttemptsRef.current >= 30)
        return;
      entryPollAttemptsRef.current += 1;
      try {
        const fresh = await listHookStoryMatches(
          hookSourceInput.hookAssetId!,
          dramaSource.id,
          controller.signal,
          matchJob?.matchContextHash,
        );
        if (controller.signal.aborted) return;
        setStoryMatches(fresh);
        if (fresh.slice(0, 3).some((item) => item.entryPoints.length === 0))
          timer = window.setTimeout(() => void poll(), 2000);
      } catch {
        if (!controller.signal.aborted)
          timer = window.setTimeout(() => void poll(), 2000);
      }
    };
    timer = window.setTimeout(() => void poll(), 2000);
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [
    dramaSource?.id,
    entryRefreshToken,
    hookSourceInput?.hookAssetId,
    matchJob?.id,
  ]);
  const toggleEpisode = (episode: number) => {
    setMatchRequestToken(0);
    setEpisodes((current) =>
      current.includes(episode)
        ? current.filter((item) => item !== episode)
        : [...current, episode].sort((a, b) => a - b),
    );
    touch();
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const validEpisodes = editingDraft?.selectedEpisodes?.filter((episode) =>
        connectedEpisodes.includes(episode),
      );
      setEpisodes(validEpisodes?.length ? validEpisodes : defaultFreeEpisodes);
      setPreviewEpisode(defaultFreeEpisodes[0] ?? connectedEpisodes[0] ?? null);
    }, 0);
    return () => window.clearTimeout(timer);
    // Reset media state when the source identity changes; connectedEpisodes is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!connectedEpisodes.length) {
        setPreviewEpisode(null);
        return;
      }
      if (previewEpisode == null || !connectedEpisodes.includes(previewEpisode))
        setPreviewEpisode(connectedEpisodes[0]);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [connectedEpisodes, previewEpisode]);

  const moveTimelineClip = (
    clipId: string,
    direction: "backward" | "forward",
  ) => {
    setTimeline((current) => {
      const base = current.length ? current : defaultTimeline;
      const index = base.findIndex((clip) => clip.id === clipId);
      const target = index + (direction === "backward" ? -1 : 1);
      if (index < 0 || target < 0 || target >= base.length) return base;
      const next = [...base];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  };

  const episodeSpliceWorkflow = !source ? (
    <div className={styles.emptyState}>
      <h2>尚未带入剧目与片源</h2>
      <p>请从剧库目标剧目进入内容工厂，再选择正片高光起点。</p>
    </div>
  ) : (
    <section className={styles.externalWorkflow} aria-label="正片顺序拼接流程">
      <section className={styles.matchStrategyPanel}>
        <header><div><small>SEQUENTIAL EPISODE SPLICE</small><h2>正片顺序拼接</h2><p>从一个高光安全起点开始，保留本集剩余剧情，并顺序承接后续2–3集。</p></div></header>
        <footer><b>固定生产规则</b><span>不跳集</span><span>不倒序</span><span>不删除中间剧情</span><span>5–15分钟</span></footer>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><span>01</span><h2>选择高光起点</h2><p className={styles.selectedDramaName}>{source.dramaCn ?? source.title}</p></div><small>高光只决定开场，后续保留连续原片</small></div>
        {spliceHighlights.length ? (
          <div className={styles.storylinePlanGrid}>
            {spliceHighlights.map((item) => {
              const selected = selectedSpliceHighlight?.id === item.id;
              return <article key={String(item.id)} className={`${styles.storylinePlanCard} ${selected ? styles.storylinePlanSelected : ""}`}>
                <header><span>{padEpisode(item.episode)} · {timecode(item.start)}</span><strong>{item.emotion || "高光起点"}</strong></header>
                <h3>{item.title}</h3><p>{item.event || item.evidence || "从此处开始保留本集剩余剧情"}</p>
                <button type="button" onClick={() => { setSelectedSpliceHighlightId(String(item.id)); setFactoryProjectId(undefined); setFactoryRender(null); setSpliceReviewStatus("pending"); touch(); }}>{selected ? "✓ 已选为起点" : "选择这个起点"}</button>
              </article>;
            })}
          </div>
        ) : <div className={styles.emptyState}><h3>没有可用高光起点</h3><p>请先在剧库完成剧目分析并生成带时间戳的高光。</p></div>}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><span>02</span><h2>自动生成连续时间线</h2></div><small>{formatDurationZh(Math.round(spliceDurationSeconds))}</small></div>
        <div className={styles.qualityChecklist}>
          {spliceTimeline.map((item, index) => <span key={item.id} className={styles.checkPass}><i>✓</i>{index === 0 ? `${padEpisode(Number(item.episode))} ${item.startTimecode}—本集结束` : `${padEpisode(Number(item.episode))} 完整承接`}</span>)}
          <span className={spliceDurationReady ? styles.checkPass : ""}><i>{spliceDurationReady ? "✓" : "!"}</i>{spliceDurationReady ? "总时长符合5–15分钟" : "当前连续范围不足5分钟或超过15分钟"}</span>
        </div>
        {!spliceDurationReady && <div className={styles.legalNote}>系统最多顺接后续3集；当前范围仍不足5分钟时禁止生成，请选择更早的高光起点。</div>}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><span>03</span><h2>真实预览、审核与导出</h2></div><small>渲染后检查首帧、集间衔接和结尾</small></div>
        <ExternalHookDelivery
          projectName={title || `${source.dramaCn ?? source.title} · 正片顺序拼接`}
          hookName="正片高光起点"
          hookLabel="剪辑规则"
          bodyLabel="正片起点"
          episodeReference={selectedSpliceHighlight ? `${padEpisode(selectedSpliceHighlight.episode)} · ${timecode(selectedSpliceHighlight.start)} 开始` : undefined}
          duration={spliceDurationSeconds ? formatDurationZh(Math.round(spliceDurationSeconds)) : "--:--"}
          previewUrl={factoryRender?.previewUrl}
          renderConnected={true}
          disabled={!spliceDurationReady}
          initialReviewStatus={spliceReviewStatus}
          initialProgress={factoryRender?.progress ?? 0}
          initialRenderError={factoryRenderError || factoryRender?.error || ""}
          initialRenderStatus={factoryRender?.status === "succeeded" ? "ready" : factoryRender?.status === "failed" ? "failed" : factoryRender?.status === "rendering" ? "rendering" : factoryRender?.status === "queued" ? "queued" : "idle"}
          onRequestRender={requestEpisodeSpliceRender}
          onReview={async (decision, note) => {
            if (!factoryRender) throw new Error("请先生成真实预览");
            await reviewFactoryRender(factoryRender.project, factoryRender.id, decision, note);
            setSpliceReviewStatus(decision);
          }}
          onNotify={onNotify}
        />
        {spliceReviewStatus === "approved" && factoryRender?.outputUrl && <div className={styles.flowActions}><span>人工审核已通过</span><button type="button" className={styles.nextButton} onClick={async () => { const exported = await exportFactoryRender(factoryRender.project, factoryRender.id, `${title || source.dramaCn || source.title}_正片顺序拼接.mp4`); const link = document.createElement("a"); link.href = exported.outputUrl; link.download = exported.fileName; document.body.appendChild(link); link.click(); link.remove(); onNotify?.("已开始下载正片顺序拼接成片"); }}>导出成片</button></div>}
      </section>
    </section>
  );

  const externalWorkflow = (
    <section
      className={styles.externalWorkflow}
      aria-label="外搭钩子与本剧正片制作流程"
    >
      <section className={styles.matchStrategyPanel} aria-label="外搭匹配入口">
        <header>
          <div>
            <small>NEXT-STAGE MATCHING</small>
            <h2>选择制作入口</h2>
            <p>入口决定分析方向，后续仍沿用现有 8 步制作流程。</p>
          </div>
        </header>
        <div className={styles.matchStrategyGrid}>
          {(
            [
              [
                "hook_to_story",
                "用这个钩子找正片",
                "先拆钩子的事件、关系、情绪与悬念，再找能承接或兑现的正片。",
              ],
              [
                "story_to_hook",
                "为这个正片找钩子",
                "先提取正片核心剧情，再从前因、后果、背景和平行线推荐钩子。",
              ],
              [
                "template_reuse",
                "复用历史跑量模板",
                "提取历史高表现素材的钩子结构与连接逻辑，替换为当前剧目证据。",
              ],
            ] as Array<[ExternalMatchStrategy, string, string]>
          ).map(([id, label, description]) => (
            <button
              type="button"
              key={id}
              className={matchStrategy === id ? styles.matchStrategyActive : ""}
              onClick={() => {
                setMatchRequestToken(0);
                setMatchStrategy(id);
                setSelectedStorylineIds([]);
                setHookOptions([]);
                setMatchJob(null);
                setStoryMatches([]);
                setMatchError("");
                touch();
              }}
            >
              <b>{label}</b>
              <span>{description}</span>
            </button>
          ))}
        </div>
        <footer>
          <b>内部匹配维度</b>
          {matchingDimensions.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </footer>
      </section>
      <nav className={styles.externalSteps} aria-label="外搭钩子制作步骤">
        {visibleExternalSteps.map((step, index) => (
          <button
            type="button"
            key={`${step.internalStep}-${step.label}`}
            disabled={step.internalStep > 2 && !stepReady[2]}
            className={`${visibleExternalStepIndex === index ? styles.externalStepActive : ""} ${stepReady[step.internalStep] ? styles.externalStepDone : ""}`}
            onClick={() => setActiveStep(step.internalStep)}
          >
            <i>{stepReady[step.internalStep] ? "✓" : index + 1}</i>
            <span>{step.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.externalStepBody}>
        {activeStep === 0 && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <span>01</span>
                <h2>选择剧集</h2>
                <p className={styles.selectedDramaName}>
                  {dramaSource
                    ? `${dramaSource.dramaCn ?? dramaSource.title} / ${dramaSource.dramaTitle ?? dramaSource.title}`
                    : "尚未选择剧目"}
                </p>
              </div>
              <small>仅使用已连接的真实视频片源</small>
            </div>
            <div className={styles.hookPickerFilters}>
              <label>
                目标时长 <strong>5–15 分钟</strong>
              </label>
              {containsPaidEpisodes && (
                <button
                  type="button"
                  onClick={() => setPaidScopeConfirmed(true)}
                >
                  {paidScopeConfirmed
                    ? "✓ 已确认使用付费集"
                    : "确认使用付费集范围"}
                </button>
              )}
            </div>
            {!dramaSource ? (
              <div className={styles.emptyState}>
                <h3>先选择本剧正片</h3>
                <p>从剧库带入剧目后，可在这里选择实际制作集数。</p>
                <button type="button" onClick={openDramaPicker}>
                  从右侧剧库选择
                </button>
              </div>
            ) : mediaEntries.length ? (
              <div className={styles.episodeSourceGrid}>
                {mediaEntries.map((media) => (
                  <article
                    key={media.episode}
                    className={`${episodes.includes(media.episode) ? styles.selected : ""} ${!media.url ? styles.episodeDisabled : ""}`}
                  >
                    {media.url && (
                      <video
                        className={styles.hoverPreview}
                        src={media.url}
                        muted
                        playsInline
                        preload="metadata"
                        onMouseEnter={(event) => {
                          const video = event.currentTarget;
                          video.dataset.hovering = "true";
                          void video.play().catch(() => undefined);
                        }}
                        onMouseLeave={(event) => {
                          const video = event.currentTarget;
                          video.dataset.hovering = "false";
                          video.pause();
                          if (video.readyState >= 1) video.currentTime = 0;
                        }}
                        onCanPlay={(event) => {
                          const video = event.currentTarget;
                          if (video.dataset.hovering === "true")
                            void video.play().catch(() => undefined);
                        }}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!media.url}
                      className={styles.episodePreviewButton}
                      onClick={() => setPreviewEpisode(media.episode)}
                    >
                      <span>
                        <b>{padEpisode(media.episode)}</b>
                        <em>悬停播放</em>
                      </span>
                      <small>{media.url ? media.name : "片源未连接"}</small>
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!media.url}
                        checked={episodes.includes(media.episode)}
                        onChange={() => toggleEpisode(media.episode)}
                      />
                      <span>
                        {episodes.includes(media.episode)
                          ? "已选入制作"
                          : "选入制作"}
                      </span>
                    </label>
                  </article>
                ))}
              </div>
            ) : (
              <div className={styles.emptyState}>
                <h3>当前剧目没有可读取片源</h3>
                <p>请回到剧库补传视频后再继续。</p>
              </div>
            )}
          </section>
        )}
        {activeStep === 1 && matchStrategy === "story_to_hook" && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <span>02</span>
                <h2>生成并选择正片故事线</h2>
              </div>
              <small>最多10个 · 按起量潜力排序 · 可任意多选</small>
            </div>
            {storyUnderstanding?.storylines.length ? (
              <div className={styles.strategyEvidence}>
                <b>所选剧集剧情理解</b>
                <div className={styles.storylineMetrics}>
                  {storyUnderstanding.storylines.map((storyline) => (
                    <button
                      key={storyline.id}
                      type="button"
                      onClick={() => {
                        setActiveStoryThreadId(storyline.id);
                        setSelectedStorylineIds([]);
                      }}
                    >
                      {storyline.id === activeStoryThread?.id ? "✓ " : ""}
                      {storyline.title}
                    </button>
                  ))}
                </div>
                {activeStoryThread && (
                  <>
                    <h3>{activeStoryThread.summary}</h3>
                    <p>
                      <b>人物：</b>
                      {activeStoryThread.characters.join("、") || "证据不足"}
                      <br />
                      <b>关系：</b>
                      {activeStoryThread.relationshipSummary}
                    </p>
                    <ol>
                      {activeStoryThread.progression.map((beat) => (
                        <li key={`${beat.episode}-${beat.start}-${beat.end}`}>
                          <b>
                            第{beat.episode}集 · {formatDurationZh(beat.start, 2)}–
                            {formatDurationZh(beat.end, 2)}
                          </b>{" "}
                          {beat.event}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            ) : null}
            {storylineLoading ? (
              <div className={styles.sourcePickerState}>
                正在从已审核素材证据生成故事线…
              </div>
            ) : storylineError ? (
              <div className={styles.sourcePickerState}>
                {storylineError}
                <br />
                <button
                  type="button"
                  onClick={() => setStorylineRequestToken((value) => value + 1)}
                >
                  重新生成
                </button>
              </div>
            ) : storylinePlans.length === 0 ? (
              <div className={styles.emptyState}>
                <h3>当前素材不足以形成高质量故事线</h3>
                <p>
                  {storylineDiagnostics?.reasons?.join("；") ||
                    "当前范围没有满足明确质量标准的方案。"}
                </p>
                {storylineDiagnostics && (
                  <div className={styles.storylineStandard}>
                    <b>“足够”的明确标准</b>
                    {Object.values(
                      storylineDiagnostics.quality_standard || {},
                    ).map((item) => (
                      <span key={item}>• {item}</span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setStorylineRequestToken((value) => value + 1)}
                >
                  重新读取证据
                </button>
              </div>
            ) : (
              <>
                <div className={styles.storylineSummaryBar}>
                  <b>当前主线生成 {visibleStorylinePlans.length} 个方案</b>
                  <span>
                    已选 {selectedStorylineIds.length} 个；全部采用“高光开始至本集结束＋顺序后续 2–3 集”，其他编排方式后续开放
                  </span>
                  <button
                    type="button"
                    onClick={() => setStorylineRequestToken((value) => value + 1)}
                  >
                    重新生成故事线
                  </button>
                </div>
                {activeStoryThread && visibleStorylinePlans.length === 0 && (
                  <div className={styles.sourcePickerState}>
                    该独立支线在当前“高光起播＋顺序后续2–3集”规则下无法单独成片。
                    请调整剧集范围，或返回主线继续生成；系统不会复用主线方案冒充支线结果。
                  </div>
                )}
                <div className={styles.storylinePlanGrid}>
                  {visibleStorylinePlans.map((plan, index) => (
                    <article
                      key={plan.id}
                      className={`${styles.storylinePlanCard} ${selectedStorylineIds.includes(plan.id) ? styles.storylinePlanSelected : ""}`}
                    >
                      <header>
                        <span>
                          #{index + 1} ·{" "}
                          正序连播
                        </span>
                        <strong>起量潜力 {plan.acquisitionScore}</strong>
                      </header>
                      <h3>{plan.title}</h3>
                      {plan.scriptPlan && (
                        <div className={styles.scriptPlanSummary}>
                          <span>
                            <small>观众追看问题</small>
                            <b>{plan.scriptPlan.audiencePromise}</b>
                          </span>
                          <span>
                            <small>开场事件</small>
                            <b>{plan.scriptPlan.openingEvent}</b>
                          </span>
                          <span>
                            <small>阶段兑现</small>
                            <b>{plan.scriptPlan.stagePayoff}</b>
                          </span>
                          <span>
                            <small>结尾卡点</small>
                            <b>{plan.scriptPlan.endingCliffhanger}</b>
                          </span>
                          <em>适配钩子：{plan.scriptPlan.hookDirection}</em>
                        </div>
                      )}
                      <p>{plan.storylineSummary}</p>
                      <div className={styles.storylineMetrics}>
                        <span>开场 {plan.scoreBreakdown.openingStrength}</span>
                        <span>冲突 {plan.scoreBreakdown.conflictDensity}</span>
                        <span>悬念 {plan.scoreBreakdown.suspenseStrength}</span>
                        <span>连贯 {plan.scoreBreakdown.continuity}</span>
                      </div>
                      {(() => {
                        const overview = selectedRangePlotOverview(
                          plan,
                          storyUnderstanding,
                        );
                        return (
                          <div className={styles.strategyEvidence}>
                            <b>所选剧集范围剧情概述</b>
                            <p>
                              方案重点：{overview.focus}
                              <br />
                              高光切入：{overview.opening}
                              <br />
                              时间：{overview.time}
                              <br />
                              地点：{overview.place}
                              <br />
                              人物：{overview.people}
                              <br />
                              事件：{overview.event}
                              <br />
                              前因：{overview.cause}
                              <br />
                              后果：{overview.consequence}
                            </p>
                          </div>
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => toggleStoryline(plan.id)}
                      >
                        {selectedStorylineIds.includes(plan.id)
                          ? "✓ 已选择"
                          : "选择此故事线"}
                      </button>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
        {activeStep === 1 && matchStrategy !== "story_to_hook" && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <span>02</span>
                <h2>{hookSelectionTitle}</h2>
              </div>
              <small>来源、分析版本与证据必须可追溯</small>
            </div>
            {strategyStoryNeed && matchStrategy !== "hook_to_story" && (
              <div className={styles.strategyEvidence}>
                <b>本剧检索需求</b>
                <p>
                  {chineseStoryNeedSummary(strategyStoryNeed,dramaSource)}
                </p>
                <span>
                  {strategyStoryNeed.extendDirections
                    .map((item) => item.label)
                    .join(" · ")}
                </span>
              </div>
            )}
            {hookSourceInput ? (
              <div className={styles.selectedHookCard}>
                {hookSourceInput.hookMediaUrl ? (
                  <HookTimelinePreview
                    url={hookSourceInput.hookMediaUrl}
                    start={hookSourceInput.hookStart ?? 0}
                    end={hookSourceInput.hookEnd ?? 0}
                    title={hookSourceInput.title}
                  />
                ) : (
                  <i>↗</i>
                )}
                <div className={styles.selectedHookDetails}>
                  <small>
                    {matchStrategy === "template_reuse"
                      ? `历史模板 · 证据 ${hookSourceInput.templateEvidenceLevel ?? "未知"}`
                      : hookSourceInput.kind === "favorite"
                        ? "我的收藏"
                        : "灵感大屏"}
                  </small>
                  <h3>{hookSourceInput.title}</h3>
                  <p>{hookSourceInput.description}</p>
                  {matchStrategy === "template_reuse" && (
                    <div className={styles.templateEvidenceGrid}>
                      <span>
                        <small>平台 / 市场</small>
                        <b>
                          {String(
                            templatePerformance.platform ||
                              hookSourceInput.hookMaterialPlatform ||
                              "待补",
                          )}{" "}
                          · {String(templatePerformance.market || "待补")}
                        </b>
                      </span>
                      <span>
                        <small>历史曝光</small>
                        <b>
                          {Number(
                            templatePerformance.exposure ||
                              hookSourceInput.hookMaterialExposure ||
                              0,
                          ).toLocaleString("zh-CN")}
                        </b>
                      </span>
                      <span>
                        <small>连续跑量</small>
                        <b>
                          {Number(
                            templatePerformance.runDays ||
                              hookSourceInput.hookMaterialRunDays ||
                              0,
                          )}{" "}
                          天
                        </b>
                      </span>
                      <span>
                        <small>结构节点</small>
                        <b>
                          {templateBody.length || templateTimeline.length || 1}{" "}
                          个
                        </b>
                      </span>
                    </div>
                  )}
                  {hookSourceInput.hookRetrievalDirection && (
                    <p>
                      检索方向：{hookSourceInput.hookRetrievalDirection} ·
                      故事需求覆盖 {hookSourceInput.hookStoryNeedCoverage ?? 0}%
                      · 事实安全 {hookSourceInput.hookTruthSafety ?? 0}%
                    </p>
                  )}
                  <span>
                    {hookSourceInput.language ?? "语种待识别"} ·{" "}
                    {hookSourceInput.rightsStatus ?? "授权待确认"} · 悬停预览 /
                    拖拽时间轴
                  </span>
                  {matchStrategy === "template_reuse" && (
                    <small className={styles.templateTrace}>
                      模板版本：
                      {String(selectedTemplate.version || "computed-v1")} ·
                      结构证据：
                      {templateBody.length
                        ? "完整正文结构"
                        : "当前仅有钩子结构，将按功能近似映射"}{" "}
                      · 历史效果仅作结构证据，不代表新成片必然复制原效果
                    </small>
                  )}
                </div>
                <button type="button" onClick={openHookPicker}>
                  {matchStrategy === "template_reuse" ? "更换模板" : "更换钩子"}
                </button>
              </div>
            ) : (
              <div className={styles.emptyState}>
                <h3>
                  {matchStrategy === "template_reuse"
                    ? "选择带历史证据与结构快照的模板"
                    : "按主题和内容标签选择外搭钩子"}
                </h3>
                <p>
                  {matchStrategy === "hook_to_story"
                    ? "从收藏或灵感大屏筛选可追溯素材，带入后将按故事脉络匹配完整投放区间。"
                    : "系统会先读取当前剧目分析，再自动召回和排序候选；标签仅用于粗召回。"}
                </p>
                <button type="button" onClick={openHookPicker}>
                  {matchStrategy === "template_reuse"
                    ? "推荐历史模板"
                    : "推荐外搭钩子"}
                </button>
              </div>
            )}
          </section>
        )}
        {activeStep === 1 &&
          matchStrategy === "hook_to_story" &&
          hookSourceInput && (
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <span>02-A</span>
                  <h2>基于钩子理解选择故事方向</h2>
                </div>
                <small>最多10个 · 真实正片时间戳 · 可多选</small>
              </div>
              {hookUnderstanding && (
                <div className={styles.strategyEvidence}>
                  <b>钩子深度理解</b>
                  <p>{hookUnderstanding.coreEvent || "核心事件待补证"}</p>
                  <span>
                    观众问题：{hookUnderstanding.audienceQuestion || "待确认"} ·
                    叙事承诺：{hookUnderstanding.narrativePromise || "待确认"} ·
                    情绪：{hookUnderstanding.emotion || "待确认"}
                  </span>
                </div>
              )}
              {storylineLoading ? (
                <div className={styles.sourcePickerState}>
                  正在理解钩子并生成正片承接方向…
                </div>
              ) : storylineError ? (
                <div className={styles.sourcePickerState}>
                  {storylineError}
                  <br />
                  <button
                    type="button"
                    onClick={() =>
                      setStorylineRequestToken((value) => value + 1)
                    }
                  >
                    重新生成
                  </button>
                </div>
              ) : storylinePlans.length === 0 ? (
                <div className={styles.emptyState}>
                  <h3>当前范围尚未形成可验证的承接方向</h3>
                  <p>
                    {storylineDiagnostics?.reasons?.join("；") ||
                      "请扩大剧集范围或更换钩子后重试。"}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setStorylineRequestToken((value) => value + 1)
                    }
                  >
                    重新读取证据
                  </button>
                </div>
              ) : (
                <>
                  <div className={styles.storylineSummaryBar}>
                    <b>已生成 {storylinePlans.length} 个钩子驱动方案</b>
                    <span>
                      已选 {selectedStorylineIds.length}{" "}
                      个；系统只按选中走向匹配正片
                    </span>
                  </div>
                  <div className={styles.storylinePlanGrid}>
                    {storylinePlans.map((plan, index) => (
                      <article
                        key={plan.id}
                        className={`${styles.storylinePlanCard} ${selectedStorylineIds.includes(plan.id) ? styles.storylinePlanSelected : ""}`}
                      >
                        <header>
                          <span>
                            #{index + 1} · {plan.strategyType}
                          </span>
                          <strong>起量潜力 {plan.acquisitionScore}</strong>
                        </header>
                        <h3>{plan.title}</h3>
                        <p>{plan.storylineSummary}</p>
                        <div className={styles.storylineMetrics}>
                          <span>
                            钩片适配 {plan.scoreBreakdown.hookBodyFit ?? 0}
                          </span>
                          <span>
                            承诺兑现{" "}
                            {plan.scoreBreakdown.promiseFulfillment ?? 0}
                          </span>
                          <span>连贯 {plan.scoreBreakdown.continuity}</span>
                          <span>
                            时间证据 {plan.scoreBreakdown.evidenceAccuracy}
                          </span>
                        </div>
                        <ol>
                          {plan.segments.map((segment) => (
                            <li
                              key={`${segment.highlightAssetId}-${segment.episode}-${segment.start}`}
                            >
                              <b>
                                第{segment.episode}集{" "}
                                {formatDurationZh(segment.start, 2)}–
                                {formatDurationZh(segment.end, 2)}
                              </b>
                              <span>
                                {segment.narrativePurpose}：{segment.plot}
                              </span>
                            </li>
                          ))}
                        </ol>
                        {plan.connectionLogic && (
                          <small>
                            钩子问题：{plan.connectionLogic.hookQuestion} ·
                            正片回答：{plan.connectionLogic.bodyAnswer}
                          </small>
                        )}
                        <small>
                          {plan.rankingReasons.join(" · ")} · 总素材{" "}
                          {formatDurationZh(plan.totalDurationSeconds, 2)}
                        </small>
                        <button
                          type="button"
                          onClick={() => toggleStoryline(plan.id)}
                        >
                          {selectedStorylineIds.includes(plan.id)
                            ? "✓ 已选择"
                            : "选择此承接方向"}
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
        {activeStep >= 2 && activeStep <= 4 && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <span>{String(activeStep + 1).padStart(2, "0")}</span>
                <h2>{externalPageTitles[activeStep]}</h2>
              </div>
              <small>真实数据驱动</small>
            </div>
            {matchStrategy === "template_reuse" &&
              activeStep >= 3 &&
              activeStep <= 4 &&
              primaryTemplatePlan && (
                <div className={styles.templateStageContext}>
                  <header><div><small>当前模板适配方案</small><b>{primaryTemplatePlan.title}</b></div><strong>结构保留 {primaryTemplatePlan.templateAdaptation?.structureRetention ?? 0}%</strong></header>
                  {activeStep === 3 && (
                    <div className={styles.templateStageGrid}>
                      <span><small>历史钩子问题</small><b>{String(asRecord(selectedTemplate.connectionLogic).hookQuestion || hookSourceInput?.informationGap || "待从历史证据确认")}</b></span>
                      <span><small>当前正片回答</small><b>{primaryTemplatePlan.storylineSummary}</b></span>
                      <span><small>推荐连接点</small><b>{primaryTemplatePlan.hookNeed.connectionPoint}</b></span>
                    </div>
                  )}
                  {activeStep === 4 && (
                    <div className={styles.templateStructureTimeline}>
                      {primaryTemplatePlan.templateAdaptation?.mappings.map((mapping, index) => <div key={mapping.slotId}><i>{index + 1}</i><span><small>{mapping.historicalPurpose}</small><b>{mapping.currentPlot || "当前剧暂无对应片段"}</b><em>{mapping.episode ? `第${mapping.episode}集 ${formatDurationZh(mapping.start ?? 0, 2)}–${formatDurationZh(mapping.end ?? 0, 2)}` : "待补素材"}</em></span></div>)}
                    </div>
                  )}
                </div>
              )}
            {activeStep === 2 && matchStrategy === "template_reuse" && (
              <div className={styles.templateAdaptationWorkspace}>
                <div className={styles.templateCompareHeader}>
                  <div>
                    <small>历史模板</small>
                    <b>{hookSourceInput?.title || "尚未选择模板"}</b>
                    <span>
                      {templateBody.length || templateTimeline.length || 1}{" "}
                      个结构节点 · 证据{" "}
                      {hookSourceInput?.templateEvidenceLevel || "未知"}
                    </span>
                  </div>
                  <i>映射到</i>
                  <div>
                    <small>当前剧目</small>
                    <b>{dramaSource?.dramaCn || dramaSource?.title}</b>
                    <span>
                      {selectedRange(episodes)} · 真实时间戳与剧情证据
                    </span>
                  </div>
                </div>
                {storylineLoading ? (
                  <div className={styles.sourcePickerState}>
                    正在拆解历史结构并生成当前剧目的10套适配方案…
                  </div>
                ) : storylineError ? (
                  <div className={styles.sourcePickerState}>
                    {storylineError}
                    <br />
                    <button
                      type="button"
                      onClick={() =>
                        setStorylineRequestToken((value) => value + 1)
                      }
                    >
                      重新生成
                    </button>
                  </div>
                ) : storylinePlans.length === 0 ? (
                  <div className={styles.emptyState}>
                    <h3>当前范围尚未形成模板适配方案</h3>
                    <p>
                      {storylineDiagnostics?.reasons?.join("；") ||
                        "请扩大剧集范围或更换历史模板。"}
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        setStorylineRequestToken((value) => value + 1)
                      }
                    >
                      重新读取证据
                    </button>
                  </div>
                ) : (
                  <>
                    <div className={styles.storylineSummaryBar}>
                      <b>已生成 {storylinePlans.length} 个模板适配方案</b>
                      <span>
                        已选 {selectedStorylineIds.length}{" "}
                        个；选择后系统将按真实片段执行完整匹配
                      </span>
                    </div>
                    <div className={styles.storylinePlanGrid}>
                      {storylinePlans.map((plan, index) => {
                        const adaptation = plan.templateAdaptation;
                        return (
                          <article
                            key={plan.id}
                            className={`${styles.storylinePlanCard} ${selectedStorylineIds.includes(plan.id) ? styles.storylinePlanSelected : ""}`}
                          >
                            <header>
                              <span>
                                方案 #{index + 1} · {plan.strategyType}
                              </span>
                              <strong>预测起量 {plan.acquisitionScore}</strong>
                            </header>
                            <h3>{plan.title}</h3>
                            <p>{plan.storylineSummary}</p>
                            <div className={styles.storylineMetrics}>
                              <span>
                                结构保留 {adaptation?.structureRetention ?? 0}%
                              </span>
                              <span>
                                槽位映射 {adaptation?.mappedSlots ?? 0}/
                                {adaptation?.totalSlots ?? 0}
                              </span>
                              <span>
                                剧情连贯 {plan.scoreBreakdown.continuity}
                              </span>
                              <span>
                                时间证据 {plan.scoreBreakdown.evidenceAccuracy}
                              </span>
                            </div>
                            <div className={styles.templateMappingList}>
                              {adaptation?.mappings
                                .slice(0, 5)
                                .map((mapping) => (
                                  <div key={mapping.slotId}>
                                    <span>{mapping.historicalPurpose}</span>
                                    <i>→</i>
                                    <b>
                                      {mapping.currentPlot ||
                                        "当前剧暂无对应片段"}
                                    </b>
                                    <em>
                                      {mapping.episode
                                        ? `第${mapping.episode}集 ${formatDurationZh(mapping.start ?? 0, 2)}–${formatDurationZh(mapping.end ?? 0, 2)}`
                                        : "待补素材"}{" "}
                                      · {mapping.confidence}%
                                    </em>
                                  </div>
                                ))}
                            </div>
                            {Boolean(adaptation?.missingSlots.length) && (
                              <small>
                                近似或缺失节点：
                                {adaptation?.missingSlots.join("、")}
                              </small>
                            )}
                            <small>
                              {plan.rankingReasons.join(" · ")} · 总素材{" "}
                              {formatDurationZh(plan.totalDurationSeconds, 2)}
                            </small>
                            <small>{adaptation?.disclaimer}</small>
                            <button
                              type="button"
                              onClick={() => toggleStoryline(plan.id)}
                            >
                              {selectedStorylineIds.includes(plan.id)
                                ? "✓ 已选择此适配方案"
                                : "选择此适配方案"}
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            {activeStep === 2 && matchStrategy === "story_to_hook" && (
              <div className={styles.storylinePairList}>
                {selectedStorylinePlans.map((plan) => {
                  const paired = storylineHookPairs[plan.id],
                    cachedMatch = storylineMatchCache[plan.id],
                    active = plan.id === activeStorylineId;
                  return (
                    <article
                      key={plan.id}
                      className={active ? styles.storylinePairActive : ""}
                      role="button"
                      tabIndex={0}
                      aria-pressed={active}
                      aria-label={`切换到故事线：${plan.title}`}
                      onClick={() => activateStorylinePair(plan.id)}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          activateStorylinePair(plan.id);
                        }
                      }}
                    >
                      <div>
                        <span>
                          故事线 #
                          {storylinePlans.findIndex(
                            (item) => item.id === plan.id,
                          ) + 1}{" "}
                          ·{" "}
                          {plan.chronology === "chronological"
                            ? "正序"
                            : "倒叙"}
                        </span>
                        <b>{plan.title}</b>
                        <p>{plan.storylineSummary}</p>
                      </div>
                      <aside>
                        {paired ? (
                          <>
                            <small>一对一匹配钩子</small>
                            <strong>{paired.title}</strong>
                            <small>
                              {cachedMatch?.job?.status === "succeeded"
                                ? "分析已完成，点击查看结果"
                                : cachedMatch?.job
                                  ? `已自动启动分析 · ${Math.round(cachedMatch.job.progress || 0)}%`
                                  : "选中后将自动启动分析"}
                            </small>
                          </>
                        ) : (
                          <small>尚未匹配钩子</small>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveStorylineId(plan.id);
                            setMatchRequestToken(0);
                            openHookPicker();
                          }}
                        >
                          {paired ? "更换此方案钩子" : "为此方案匹配钩子"}
                        </button>
                      </aside>
                    </article>
                  );
                })}
              </div>
            )}
            <ExternalHookAnalysis
              activeTab={
                (["match", "transition", "timeline"] as const)[
                  activeStep - 2
                ]
              }
              match={match}
              transitions={
                externalReady && selectedRecommendation ? transitionOptions : []
              }
              selectedTransitionId={selectedTransitionId}
              timeline={visibleTimeline}
              quality={qualityReport}
              disabled={!externalReady}
              onTabChange={(tab) =>
                setActiveStep(
                  { match: 2, transition: 3, timeline: 4, quality: 4 }[tab],
                )
              }
              onSelectRecommendation={(item) => {
                setSelectedRecommendationId(item.id);
                setTimeline([]);
                touch();
              }}
              onOverrideRecommendation={(item) => {
                const approve = item.videoUrl
                  ? approveHookMatchForProduction(item.id)
                  : setHookMatchSoftOverride(item.id, ["story_score"]);
                void approve
                  .then(() => {
                    setStoryOverrides((current) =>
                      current.includes(item.id)
                        ? current
                        : [...current, item.id],
                    );
                    setSelectedRecommendationId(item.id);
                    onNotify?.(
                      item.videoUrl
                        ? "人工已确认该视频候选进入生产。模型评分与风险保留为提示。"
                        : "已持久化故事分审核覆盖",
                    );
                  })
                  .catch((error) =>
                    onNotify?.(
                      error instanceof Error
                        ? error.message
                        : "人工生产确认保存失败",
                    ),
                  );
              }}
              onSelectEntryPoint={(item, index) => {
                setSelectedEntryPoints((current) => ({
                  ...current,
                  [item.id]: index,
                }));
                setSelectedRecommendationId(item.id);
                setTimeline([]);
                touch();
              }}
              onRequestMoreEntryPoints={(item) => {
                void requestMoreEntryPoints(item.id)
                  .then(() => {
                    entryPollAttemptsRef.current = 0;
                    setEntryRefreshToken((value) => value + 1);
                    onNotify?.(`已提交「${item.title}」追加精确接点分析请求`);
                  })
                  .catch((error) =>
                    onNotify?.(
                      error instanceof Error
                        ? error.message
                        : "追加接点请求失败",
                    ),
                  );
              }}
              onRetryMatch={() => {
                setMatchJob(null);
                setStoryMatches([]);
                setMatchError("");
                setMatchRetryToken((value) => value + 1);
                setMatchRequestToken((value) => value + 1);
                onNotify?.("正在补充高光分析并重新匹配");
              }}
              onChangeEpisodeScope={() => {
                setMatchRequestToken(0);
                setActiveStep(0);
              }}
              onChangeHook={() => {
                if (matchStrategy !== "story_to_hook") setActiveStep(1);
                openHookPicker();
              }}
              onSelectTransition={(item) => {
                setSelectedTransitionId(item.id);
                setTimeline((current) =>
                  (current.length ? current : defaultTimeline).map((clip) =>
                    clip.kind === "transition"
                      ? {
                          ...clip,
                          title: item.title,
                          durationSeconds: item.durationSeconds,
                        }
                      : clip,
                  ),
                );
                touch();
              }}
              onPreviewTransition={(item) =>
                onNotify?.(`已选择预览方案：${item.title}`)
              }
              onRegenerateTransitions={() =>
                onNotify?.("已保存重新生成请求；等待过渡服务接入")
              }
              onMoveClip={moveTimelineClip}
              onUpdateClip={(id, patch) => {
                setTimeline((current) =>
                  (current.length ? current : defaultTimeline).map((clip) =>
                    clip.id === id ? { ...clip, ...patch } : clip,
                  ),
                );
                touch();
              }}
              onRemoveClip={(id) => {
                setTimeline((current) =>
                  (current.length ? current : defaultTimeline).filter(
                    (clip) => clip.id !== id,
                  ),
                );
                touch();
              }}
              onRunQualityCheck={() => {
                setQualityConfirmed(true);
                onNotify?.(
                  `质检完成：${qualityReport.findings.length} 项检查，结论为「${qualityReport.verdict}」`,
                );
              }}
              onApplyQualitySuggestion={() => onNotify?.("已记录优化建议")}
              onGeneratePreview={() => setActiveStep(5)}
            />
          </section>
        )}
        {activeStep >= 5 && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <span>{String(activeStep + 1).padStart(2, "0")}</span>
                <h2>{externalPageTitles[activeStep]}</h2>
              </div>
              <small>
                {activeStep === 5
                  ? "生成真实可播放文件"
                  : "设置文件名与交付规格"}
              </small>
            </div>
            <ExternalHookDelivery
              view={activeStep === 5 ? "preview" : "export"}
              projectName={
                title || `${dramaSource?.dramaCn ?? "未命名剧目"} · 外搭钩子版`
              }
              hookName={hookSourceInput?.title}
              episodeReference={
                selectedRecommendation
                  ? `${padEpisode(selectedRecommendation.episode)} · ${selectedRecommendation.startTimecode}${selectedRecommendation.startFrame == null ? " · 帧号待探测" : ` · 第 ${selectedRecommendation.startFrame} 帧`}`
                  : undefined
              }
              previewUrl={factoryRender?.previewUrl}
              renderConnected={true}
              initialProgress={factoryRender?.progress ?? 0}
              initialRenderError={factoryRenderError || factoryRender?.error || ""}
              initialRenderStatus={factoryRender?.status === "succeeded" ? "ready" : factoryRender?.status === "failed" ? "failed" : factoryRender?.status === "rendering" ? "rendering" : factoryRender?.status === "queued" ? "queued" : "idle"}
              renderCount={
                matchStrategy === "story_to_hook"
                  ? Math.max(1, selectedStorylinePlans.length)
                  : 1
              }
              exportableVersionCount={
                matchStrategy === "story_to_hook"
                  ? Object.values(factoryRendersByStoryline).filter(
                      (item) => item.status === "succeeded" && item.outputUrl,
                    ).length
                  : factoryRender?.outputUrl
                    ? 1
                    : 0
              }
              initialReviewStatus={
                !historyForked &&
                editingDraft?.factorySnapshot?.review?.decision === "approved"
                  ? "approved"
                  : !historyForked &&
                      editingDraft?.factorySnapshot?.review?.decision ===
                        "rejected"
                    ? "rejected"
                    : "pending"
              }
              initialReviewComment={
                !historyForked &&
                typeof editingDraft?.factorySnapshot?.review?.note === "string"
                  ? editingDraft.factorySnapshot.review.note
                  : ""
              }
              versions={
                matchStrategy === "story_to_hook" && selectedStorylinePlans.length
                  ? selectedStorylinePlans.map((plan, index) => {
                      const render = factoryRendersByStoryline[plan.id];
                      return {
                        id: plan.id,
                        label: `版本 ${index + 1} · ${plan.title}`,
                        createdAt: render
                          ? `渲染 V${render.version}`
                          : "等待批量生成",
                        status: render?.outputUrl
                          ? "approved" as const
                          : render?.status === "failed"
                            ? "rejected" as const
                            : render
                              ? "reviewing" as const
                              : "draft" as const,
                        previewUrl: render?.previewUrl,
                      };
                    })
                  : !historyForked
                  ? editingDraft?.renderVersions?.map((item) => ({
                      id: item.id,
                      label: `真实渲染 V${item.version}`,
                      createdAt: item.created || "历史版本",
                      status: item.outputUrl
                        ? editingDraft.productionStatus === "已导出"
                          ? "exported"
                          : "approved"
                        : item.status === "failed"
                          ? "rejected"
                          : "reviewing",
                      previewUrl: item.previewUrl,
                    }))
                  : undefined
              }
              onSelectVersion={(version) => {
                const render = factoryRendersByStoryline[version.id];
                if (render) setFactoryRender(render);
                if (storylineHookPairs[version.id]) {
                  setActiveStorylineId(version.id);
                  onChooseHook?.(storylineHookPairs[version.id]);
                }
              }}
              disabled={
                !externalReady ||
                (containsPaidEpisodes && !paidScopeConfirmed)
              }
              onSaveDraft={() => {
                save(false);
                void persistExternalProject()
                  .then(() => onNotify?.("生产项目已持久保存"))
                  .catch((error) =>
                    onNotify?.(
                      error instanceof Error ? error.message : "项目保存失败",
                    ),
                  );
              }}
              onRequestRender={
                matchStrategy === "story_to_hook"
                  ? requestStorylineBatchRenders
                  : requestExternalRender
              }
              onReview={async (decision, note) => {
                if (!factoryRender)
                  throw new Error("请先生成真实预览");
                await reviewFactoryRender(
                  factoryRender.project,
                  factoryRender.id,
                  decision,
                  note,
                );
              }}
              onExport={async (config) => {
                if (matchStrategy === "story_to_hook") {
                  const completed = Object.entries(factoryRendersByStoryline).filter(
                    ([, render]) => render.status === "succeeded" && render.outputUrl,
                  );
                  if (!completed.length) {
                    onNotify?.("请先批量生成至少一个真实成片版本");
                    return;
                  }
                  for (const [planId, render] of completed) {
                    const plan = selectedStorylinePlans.find((item) => item.id === planId);
                    const exported = await exportFactoryRender(
                      render.project,
                      render.id,
                      `${config.fileName.replace(/\.[^.]+$/, "")}_${plan?.title || planId}.${config.format.toLowerCase()}`,
                    );
                    const link = document.createElement("a");
                    link.href = exported.outputUrl;
                    link.download = exported.fileName;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                  }
                  onNotify?.(`已开始批量导出 ${completed.length} 个成片版本`);
                  return;
                }
                if (!factoryRender?.outputUrl) {
                  onNotify?.("真实成片生成并审核通过后才能导出");
                  return;
                }
                const exported = await exportFactoryRender(
                  factoryRender.project,
                  factoryRender.id,
                  config.fileName,
                );
                const link = document.createElement("a");
                link.href = exported.outputUrl;
                link.download = exported.fileName;
                document.body.appendChild(link);
                link.click();
                link.remove();
                onNotify?.("已开始下载并记录正式导出");
              }}
              onNotify={onNotify}
            />
          </section>
        )}
      </div>
      {activeStep === 2 && matchStrategy === "story_to_hook" && (
        <div className={styles.storylineBulkActions}>
          <div>
            <b>一对一批量匹配</b>
            <span>
              为全部方案分配候选钩子后自动创建故事匹配任务；钩子不足时允许复用作方案对比。
            </span>
          </div>
          <button
            type="button"
            disabled={
              bulkHookMatching ||
              (!matchError && matchJob?.status === "queued") ||
              (!matchError && matchJob?.status === "running") ||
              !selectedStorylinePlans.length
            }
            onClick={() => void matchAllSelectedStorylines()}
          >
            {bulkHookMatching
              ? "正在分配候选钩子…"
              : !matchError && matchJob?.status === "queued"
                ? "排队等待匹配 Worker"
                : !matchError && matchJob?.status === "running"
                  ? `正在分析证据 ${Math.round(matchJob.progress || 0)}%`
                : matchError
                  ? "重新分配候选钩子"
                  : "一键为所有方案分配钩子"}
          </button>
        </div>
      )}
      {activeStep === 4 && (
        <div className={styles.legalNote} role="status">
          成片时间线总时长：{formatDurationZh(Math.round(externalTimelineDurationSeconds))}。
          {externalTimelineDurationReady
            ? " 已符合 5–15 分钟生产范围。"
            : " 需要调整到 5–15 分钟后才能生成预览。"}
        </div>
      )}
      <div className={styles.externalFlowActions}>
        <button
          type="button"
          disabled={activeStep === 0}
          onClick={() => setActiveStep((step) =>
            matchStrategy === "hook_to_story" && step === 5
              ? 3
              : Math.max(0, step - 1)
          )}
        >
          上一步
        </button>
        <span>第 {visibleExternalStepIndex + 1} 步 / 共 {visibleExternalSteps.length} 步</span>
        <button
          type="button"
          disabled={
            activeStep === steps.length - 1 ||
            (activeStep === 4 && !externalTimelineDurationReady) ||
            (activeStep === 1 &&
              matchStrategy === "story_to_hook" &&
              !selectedStorylineIds.length) ||
            (activeStep === 1 &&
              matchStrategy !== "story_to_hook" &&
              !hookSourceInput?.hookAssetId) ||
            (activeStep === 1 &&
              matchStrategy === "hook_to_story" &&
              !selectedStorylineIds.length) ||
            (activeStep === 2 &&
              matchStrategy === "template_reuse" &&
              !selectedStorylineIds.length) ||
            (activeStep === 2 &&
              matchStrategy !== "template_reuse" &&
              !stepReady[2])
          }
          onClick={() => {
            if (activeStep === 1 && matchStrategy === "story_to_hook") {
              const first = selectedStorylineIds[0];
              setActiveStorylineId(first);
              setActiveStep(2);
              openHookPicker();
              onNotify?.(
                `已选择 ${selectedStorylineIds.length} 个故事线方案，将逐条进行一对一钩子匹配`,
              );
              return;
            }
            if (activeStep === 1) {
              setMatchJob(null);
              setStoryMatches([]);
              setMatchError("");
              if (matchStrategy === "template_reuse") {
                setActiveStep(2);
                onNotify?.("正在基于历史结构生成当前剧目的适配方案");
                return;
              }
              setMatchRequestToken((value) => value + 1);
              setActiveStep(2);
              onNotify?.("已创建故事线匹配任务");
              return;
            }
            if (
              activeStep === 2 &&
              matchStrategy === "template_reuse" &&
              !hasSelectedStoryMatch
            ) {
              setMatchJob(null);
              setStoryMatches([]);
              setMatchError("");
              setMatchRequestToken((value) => value + 1);
              onNotify?.(
                `已选择 ${selectedStorylineIds.length} 个模板适配方案，正在执行真实素材匹配`,
              );
              return;
            }
            if (matchStrategy === "hook_to_story" && activeStep === 3) {
              setActiveStep(5);
              onNotify?.("连接方案已确认，正在生成可播放草稿");
              return;
            }
            setActiveStep((step) => Math.min(steps.length - 1, step + 1));
          }}
        >
          {matchStrategy === "hook_to_story" && activeStep === 3
            ? "确认连接并生成草稿"
            : activeStep === 1
            ? matchStrategy === "story_to_hook"
              ? "逐条匹配外搭钩子"
              : matchStrategy === "template_reuse"
                ? "生成10套适配方案"
                : "开始匹配"
            : activeStep === 2 &&
                matchStrategy === "template_reuse" &&
                !hasSelectedStoryMatch
              ? "按选中方案开始完整匹配"
              : "下一步"}
        </button>
      </div>
      {sourcePicker && (
        <div
          className={styles.sourcePickerMask}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSourcePicker(null);
          }}
        >
          <aside className={styles.sourcePicker}>
            <header>
              <div>
                <small>
                  {sourcePicker === "drama"
                    ? "DRAMA LIBRARY"
                    : matchStrategy === "template_reuse"
                      ? "HISTORICAL TEMPLATE LIBRARY"
                      : "HOOK ASSET LIBRARY"}
                </small>
                <h2>
                  {sourcePicker === "drama"
                    ? "选择本剧正片"
                    : hookSelectionTitle}
                </h2>
                <p>
                  {sourcePicker === "drama"
                    ? "默认读取免费剧集，可在步骤 01 手动修改范围。"
                    : matchStrategy === "story_to_hook"
                      ? `当前仅为「${activeStorylinePlan?.title ?? "所选故事线"}」进行一对一钩子召回，不会把多个故事强行合并。`
                : matchStrategy === "template_reuse"
                  ? "模板携带历史表现证据、钩子结构、连接逻辑与版本快照；证据等级和缺口会如实展示，但不阻止人工选择。"
                        : "这里只展示从外搭素材中定位出的片段级钩子，不再把整条素材作为匹配对象。"}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭选择栏"
                onClick={() => setSourcePicker(null)}
              >
                ×
              </button>
            </header>
            {sourcePicker === "hook" && (
              <div className={styles.hookPickerFilters}>
                <select
                  value={hookQueryDimension}
                  onChange={(event) =>
                    setHookQueryDimension(
                      event.target.value as OntologyDimension,
                    )
                  }
                >
                  <option value="theme">主题</option>
                  <option value="relation">人物关系</option>
                  <option value="conflict">核心矛盾</option>
                  <option value="emotion">情绪</option>
                  <option value="storyBeat">情节点</option>
                  <option value="audience">受众</option>
                  <option value="acquisition">买量用途</option>
                </select>
                <input
                  value={hookTagQuery}
                  onChange={(event) => setHookTagQuery(event.target.value)}
                  placeholder="按所选标签维度搜索"
                />
                <select
                  value={hookThemeFilter}
                  onChange={(event) => setHookThemeFilter(event.target.value)}
                >
                  <option>全部主题</option>
                  {hookThemes.map((theme) => (
                    <option key={theme}>{theme}</option>
                  ))}
                </select>
              </div>
            )}
            <div className={styles.sourcePickerList}>
              {pickerLoading ? (
                <div className={styles.sourcePickerState}>正在读取素材…</div>
              ) : pickerError ? (
                <div className={styles.sourcePickerState}>
                  <p>{pickerError}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setPickerError("");
                      setPickerRequestToken((value) => value + 1);
                    }}
                  >
                    重新读取素材
                  </button>
                </div>
              ) : (sourcePicker === "drama"
                  ? dramaOptions
                  : filteredHookOptions
                ).length === 0 ? (
                <div className={styles.sourcePickerState}>
                  {sourcePicker === "hook"
                    ? "没有满足当前故事需求的候选。"
                    : "暂无符合条件的可选择资产"}
                </div>
              ) : (
                (sourcePicker === "drama"
                  ? dramaOptions
                  : filteredHookOptions
                ).map((option) => (
                  <button
                    type="button"
                    className={styles.sourcePickerCard}
                    key={option.id}
                    disabled={
                      sourcePicker === "hook" &&
                      option.hookMatchRelation === "contradictory"
                    }
                    title={
                      sourcePicker === "hook" &&
                      option.hookMatchRelation === "contradictory"
                        ? "标签体系检测到硬冲突"
                        : undefined
                    }
                    onClick={() => {
                      if (sourcePicker === "drama") onChooseDrama?.(option);
                      else {
                        if (
                          matchStrategy === "story_to_hook" &&
                          activeStorylineId
                        ) {
                          setStorylineHookPairs((current) => ({
                            ...current,
                            [activeStorylineId]: option,
                          }));
                          setStorylineMatchCache((current) => {
                            const next = { ...current };
                            delete next[activeStorylineId];
                            return next;
                          });
                        }
                        onChooseHook?.(option);
                        setMatchJob(null);
                        setStoryMatches([]);
                        setSelectedRecommendationId(undefined);
                        setMatchError("");
                        if (matchStrategy === "hook_to_story")
                          setSelectedStorylineIds([]);
                        if (matchStrategy === "story_to_hook") {
                          setMatchRequestToken((value) => value + 1);
                          onNotify?.("已选择钩子，正在自动分析该组合的故事承接证据");
                        } else {
                          setMatchRequestToken(0);
                        }
                      }
                      setSourcePicker(null);
                      touch();
                    }}
                  >
                    <span>
                      {sourcePicker === "drama"
                        ? "剧库正片"
                        : matchStrategy === "template_reuse"
                          ? `历史模板 · ${option.templateEvidenceLevel ?? "unknown"}`
                          : "外搭钩子资产"}
                      {sourcePicker === "hook" &&
                      option.hookMatchScore !== undefined
                        ? ` · 适配 ${option.hookMatchScore}%`
                        : sourcePicker === "hook"
                          ? " · 证据未知"
                          : ""}
                    </span>
                    <h3>{option.dramaCn ?? option.title}</h3>
                    {option.dramaCn && <b>{option.title}</b>}
                    <p>{option.description}</p>
                    {sourcePicker === "hook" &&
                      option.hookRetrievalDirection && (
                        <small>
                          {option.hookRetrievalDirection} · 需求覆盖{" "}
                          {option.hookStoryNeedCoverage ?? 0}% · 事实安全{" "}
                          {option.hookTruthSafety ?? 0}% · 桥接成本{" "}
                          {option.hookBridgeCost ?? 0}
                        </small>
                      )}
                    {sourcePicker === "hook" && (
                      <div className={styles.sourcePickerTags}>
                        {[
                          option.hookType,
                          ...(option.themes ?? []),
                          ...(option.contentTags ?? []),
                        ]
                          .filter(Boolean)
                          .slice(0, 6)
                          .map((tag, index) => (
                            <i key={`${tag}-${index}`}>{tag}</i>
                          ))}
                      </div>
                    )}
                    {sourcePicker === "hook" &&
                      Boolean(option.hookMatchReasons?.length) && (
                        <small>{option.hookMatchReasons?.join(" · ")}</small>
                      )}
                    <footer>
                      <em>
                        {sourcePicker === "hook"
                          ? matchStrategy === "template_reuse"
                            ? `曝光 ${option.hookMaterialExposure ?? 0} · 跑量 ${option.hookMaterialRunDays ?? 0} 天 · ${option.templateProductionEligible ? "证据可生产" : "弱证据，需补效果指标"}`
                            : `边界已验证 · 审核通过 · 授权：${option.rightsStatus ?? "待确认"}`
                          : (option.language ?? "语种待识别")}
                      </em>
                      <strong>
                        {matchStrategy === "story_to_hook"
                          ? "与此故事线配对 →"
                          : "选择 →"}
                      </strong>
                    </footer>
                  </button>
                ))
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );

  return (
    <section className={styles.workspace} aria-label="内容工厂">
      <header className={styles.header}>
        <div>
          <span>CONTENT ENGINE</span>
          <h1>内容工厂</h1>
          <p>
            基于已连接的真实片源创建并持久化制作草稿；未接入的分析、渲染和导出不会展示模拟结果。
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            aria-label="返回我的创作中的我的草稿"
            onClick={onOpenDrafts}
          >
            ← 返回我的创作 · 我的草稿
          </button>
        </div>
      </header>

      <nav className={styles.modeTabs} aria-label="制作模式">
        {factoryModes.map((item) => (
          <button
            type="button"
            key={item.id}
            className={mode === item.id ? styles.active : ""}
            onClick={() => {
              setMode(item.id);
              onModeChange?.(item.id);
              setActiveStep(0);
              touch();
            }}
          >
            <i>{item.icon}</i>
            <span>
              <b>{item.name}</b>
              <small>{item.description}</small>
            </span>
          </button>
        ))}
      </nav>

      {mode === "external-hook" ? (
        externalWorkflow
      ) : mode === "episode-splice" ? (
        episodeSpliceWorkflow
      ) : !source ? (
        <div className={styles.emptyState}>
          <h2>尚未带入剧目与片源</h2>
          <p>
            请返回剧库，在目标短剧详情中点击“进入内容工厂”。内容工厂不会再自动填入示例剧目或虚构分析。
          </p>
        </div>
      ) : (
        <>
          <div className={styles.sourceBanner}>
            <div>
              <span>当前剧目</span>
              <h2>{source.dramaCn ?? source.title}</h2>
              <p>
                {source.dramaTitle && source.dramaTitle !== source.title
                  ? source.dramaTitle
                  : source.description}
              </p>
            </div>
            <dl>
              <div>
                <dt>题材</dt>
                <dd>{source.genre ?? "未填写"}</dd>
              </div>
              <div>
                <dt>语种</dt>
                <dd>{source.language ?? "未填写"}</dd>
              </div>
              <div>
                <dt>剧集</dt>
                <dd>
                  {source.episodes ?? source.availableEpisodes?.length ?? 0} 集
                </dd>
              </div>
              <div>
                <dt>已连接视频</dt>
                <dd>{connectedEpisodes.length} 集</dd>
              </div>
            </dl>
          </div>

          {availableWithoutConnection.length > 0 && (
            <div className={styles.legalNote}>
              片源未连接：
              {availableWithoutConnection.map(padEpisode).join("、")}{" "}
              只有上传记录，没有可播放文件地址；这些剧集已禁止预览与生成。
            </div>
          )}

          <div className={styles.editorGrid}>
            <main>
              <section className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <span>01</span>
                    <h2>选择真实片源</h2>
                  </div>
                  <small>仅列出浏览器当前可读取的视频</small>
                </div>
                {mediaEntries.length ? (
                  <div className={styles.episodeSourceGrid}>
                    {mediaEntries.map((media) => (
                      <article
                        key={media.episode}
                        className={`${episodes.includes(media.episode) ? styles.selected : ""} ${previewEpisode === media.episode ? styles.previewing : ""} ${!media.url ? styles.episodeDisabled : ""}`}
                      >
                        <button
                          type="button"
                          disabled={!media.url}
                          className={styles.episodePreviewButton}
                          onClick={() => setPreviewEpisode(media.episode)}
                        >
                          <span>
                            <b>{padEpisode(media.episode)}</b>
                            <em>
                              {previewEpisode === media.episode
                                ? "正在预览"
                                : "点击预览"}
                            </em>
                          </span>
                          <small>{media.url ? media.name : "片源未连接"}</small>
                        </button>
                        <label>
                          <input
                            type="checkbox"
                            disabled={!media.url}
                            checked={episodes.includes(media.episode)}
                            onChange={() => toggleEpisode(media.episode)}
                          />
                          <span>
                            {episodes.includes(media.episode)
                              ? "已选入制作"
                              : "选入制作"}
                          </span>
                        </label>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    <h3>没有可读取的视频文件</h3>
                    <p>
                      该剧只传入了集号，没有把视频文件地址带到内容工厂。请在剧库重新上传或补传片源。
                    </p>
                  </div>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <span>02</span>
                    <h2>草稿信息</h2>
                  </div>
                  <small>{selectedRange(episodes)}</small>
                </div>
                <div className={styles.draftForm}>
                  <label className={styles.titleField}>
                    <span>草稿名称</span>
                    <input
                      value={title}
                      onChange={(event) => {
                        setTitle(event.target.value);
                        touch();
                      }}
                      placeholder={`${source.dramaCn ?? source.title} · ${definition.name}`}
                    />
                  </label>
                  <label>
                    <span>输出比例</span>
                    <select
                      value={ratio}
                      onChange={(event) => {
                        setRatio(event.target.value as Draft["ratio"]);
                        touch();
                      }}
                    >
                      <option>9:16</option>
                      <option>16:9</option>
                      <option>1:1</option>
                    </select>
                  </label>
                  <label>
                    <span>成片语种</span>
                    <select
                      value={language}
                      onChange={(event) => {
                        setLanguage(event.target.value);
                        touch();
                      }}
                    >
                      <option>英语</option>
                      <option>德语</option>
                      <option>葡萄牙语</option>
                      <option>西班牙语</option>
                    </select>
                  </label>
                </div>
                <div className={styles.aiSummary}>
                  <b>当前能力边界</b>
                  <p>
                    本页会保存真实剧目、片源选择和输出参数。粗解析、细解析、镜头推荐、自动剪辑与成片渲染必须等待对应服务返回结果；当前不会伪造评分、时间线或成片。
                  </p>
                </div>
              </section>
            </main>

            <aside>
              <section className={styles.preview}>
                <div className={styles.previewHeader}>
                  <div>
                    <span>真实视频预览</span>
                    <h2>
                      {previewEpisode ? padEpisode(previewEpisode) : "未选择"}
                    </h2>
                  </div>
                  {connectedEpisodes.length > 0 && (
                    <label>
                      <span>切换剧集</span>
                      <select
                        value={previewEpisode ?? ""}
                        onChange={(event) =>
                          setPreviewEpisode(Number(event.target.value))
                        }
                      >
                        {connectedEpisodes.map((episode) => (
                          <option value={episode} key={episode}>
                            {padEpisode(episode)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {previewMedia?.url ? (
                  <video
                    key={previewMedia.url}
                    src={previewMedia.url}
                    controls
                    preload="metadata"
                  />
                ) : (
                  <div className={styles.emptyState}>
                    <p>选择一集已连接的视频后可在这里播放。</p>
                  </div>
                )}
                {connectedEpisodes.length > 0 && (
                  <div className={styles.previewEpisodes}>
                    {connectedEpisodes.map((episode) => (
                      <button
                        type="button"
                        key={episode}
                        className={
                          previewEpisode === episode ? styles.selected : ""
                        }
                        onClick={() => setPreviewEpisode(episode)}
                        aria-label={`预览 ${padEpisode(episode)}`}
                      >
                        {padEpisode(episode)}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </aside>
          </div>

          <section className={styles.productionFlow} aria-label="内容生产流程">
            <div className={styles.flowHeading}>
              <div>
                <span>内容生产流程</span>
                <h2>从真实片源到可执行生产配方</h2>
                <p>
                  先完成组合设计与风险检查；分析、生成和渲染服务接入后再执行成片任务。
                </p>
              </div>
              <strong>
                {stepReady.filter(Boolean).length} / {steps.length} 已配置
              </strong>
            </div>

            <nav className={styles.flowSteps} aria-label="生产步骤">
              {steps.map((step, index) => (
                <button
                  type="button"
                  key={step}
                  className={`${activeStep === index ? styles.flowStepActive : ""} ${stepReady[index] ? styles.flowStepDone : ""}`}
                  onClick={() => setActiveStep(index)}
                >
                  <i>{stepReady[index] ? "✓" : index + 1}</i>
                  <span>{step}</span>
                </button>
              ))}
            </nav>

            <div className={styles.flowBody}>
              {activeStep === 0 && (
                <div className={styles.flowPanel}>
                  <div className={styles.sectionIntro}>
                    <span>01 · HOOK MATCH</span>
                    <h3>选择钩子来源与匹配方向</h3>
                    <p>
                      先保存筛选条件；只有钩子库返回真实资产后才会出现候选。
                    </p>
                  </div>
                  <div className={styles.choiceCards}>
                    {[
                      "我的收藏",
                      "长效通用钩子",
                      "同题材高表现钩子",
                      "相似人物关系",
                      "新生成钩子",
                    ].map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={
                          hookSource === item ? styles.choiceActive : ""
                        }
                        onClick={() => {
                          setHookSource(item);
                          touch();
                        }}
                      >
                        <b>{item}</b>
                        <small>
                          {item === "新生成钩子"
                            ? "保存生成Brief，等待模型服务"
                            : "从已入库的合法钩子资产检索"}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className={styles.matchDimensions}>
                    <span>排序维度</span>
                    {[
                      "停滑潜力",
                      "情绪匹配",
                      "人物关系",
                      "矛盾匹配",
                      "承诺兑现",
                      "货不对板风险",
                    ].map((item) => (
                      <i key={item}>{item}</i>
                    ))}
                  </div>
                </div>
              )}

              {activeStep === 1 && (
                <div className={styles.flowPanel}>
                  <div className={styles.sectionIntro}>
                    <span>02 · TRANSITION</span>
                    <h3>设计钩子与正片之间的连接</h3>
                    <p>过渡作为独立对象保存，后续可替换和跨项目复用。</p>
                  </div>
                  <div className={styles.choiceCards}>
                    {[
                      "时间倒叙旁白",
                      "因果解释旁白",
                      "身份反差旁白",
                      "同动作转场",
                      "台词承接",
                      "BGM延续",
                    ].map((item) => (
                      <button
                        type="button"
                        key={item}
                        className={
                          transition === item ? styles.choiceActive : ""
                        }
                        onClick={() => {
                          setTransition(item);
                          touch();
                        }}
                      >
                        <b>{item}</b>
                        <small>
                          {item.includes("旁白")
                            ? "需要生成过渡文案与配音"
                            : "需要镜头/音频特征匹配"}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className={styles.transitionPreview}>
                    <div>
                      <small>钩子末端</small>
                      <b>等待选择真实钩子</b>
                    </div>
                    <i>→ {transition} →</i>
                    <div>
                      <small>正片起点</small>
                      <b>
                        {previewEpisode
                          ? padEpisode(previewEpisode)
                          : "等待选择片源"}
                      </b>
                    </div>
                  </div>
                </div>
              )}

              {activeStep === 2 && (
                <div className={styles.flowPanel}>
                  <div className={styles.sectionIntro}>
                    <span>03 · VARIANTS</span>
                    <h3>配置组合数量与受控变量</h3>
                    <p>系统只保存生产矩阵，不会在渲染服务未接入时伪造视频。</p>
                  </div>
                  <div className={styles.variantFormula}>
                    <b>1 个正片配方</b>
                    <span>×</span>
                    <b>3 个钩子变量</b>
                    <span>×</span>
                    <b>2 个过渡变量</b>
                    <strong>= {variantCount} 个计划版本</strong>
                  </div>
                  <div className={styles.checkGrid}>
                    {[
                      "首帧类型",
                      "第一条台词",
                      "主情绪",
                      "卡断位置",
                      "视听模式",
                      "过渡方式",
                    ].map((item) => (
                      <label key={item}>
                        <input
                          type="checkbox"
                          defaultChecked
                          onChange={touch}
                        />
                        {item}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {activeStep === 3 && (
                <div className={styles.flowPanel}>
                  <div className={styles.sectionIntro}>
                    <span>04 · QUALITY GATE</span>
                    <h3>统一质检门</h3>
                    <p>
                      真实分析返回前只检查配置完整性；模型指标与风险结论不会使用模拟分数。
                    </p>
                  </div>
                  <div className={styles.qualityChecklist}>
                    {[
                      "钩子来源已确定",
                      "过渡方式已确定",
                      "版本数量有效",
                      "质检确认完成",
                    ].map((item, index) => (
                      <span
                        key={item}
                        className={stepReady[index] ? styles.checkPass : ""}
                      >
                        <i>{stepReady[index] ? "✓" : "!"}</i>
                        {item}
                      </span>
                    ))}
                  </div>
                  <label className={styles.confirmQuality}>
                    <input
                      type="checkbox"
                      checked={qualityConfirmed}
                      onChange={(event) => {
                        setQualityConfirmed(event.target.checked);
                        touch();
                      }}
                    />
                    <span>
                      <b>确认保存为待分析生产配方</b>
                      <small>
                        钩子适配、连通性、货不对板和高点击低转化风险将在真实分析完成后给出。
                      </small>
                    </span>
                  </label>
                </div>
              )}
            </div>

            <div className={styles.flowActions}>
              <button
                type="button"
                disabled={activeStep === 0}
                onClick={() => setActiveStep((step) => Math.max(0, step - 1))}
              >
                上一步
              </button>
              <span>
                {hookSource} · {transition}
              </span>
              <button
                type="button"
                className={styles.nextButton}
                disabled={activeStep === steps.length - 1}
                onClick={() =>
                  setActiveStep((step) => Math.min(steps.length - 1, step + 1))
                }
              >
                下一步
              </button>
            </div>
          </section>
        </>
      )}

      {mode === "episode-narration" && (
        <footer className={styles.workspaceFooter}>
          <span>
            <b>自动保存</b>
            {source
              ? `${savedAt} · ${formatDurationZh(autoSaveCountdown)}后再次保存`
              : savedAt}
          </span>
          <div>
            <button
              type="button"
              onClick={() => save(false)}
              disabled={!source}
            >
              保存草稿
            </button>
            <button
              type="button"
              className={styles.generate}
              disabled={!canCreate}
              title={
                !canCreate
                  ? "没有已连接的真实视频片源"
                  : "渲染服务尚未接入；当前仅保存制作草稿"
              }
              onClick={() =>
                onNotify?.(
                  "片源已就绪；成片渲染服务尚未接入，当前不会生成假视频",
                )
              }
            >
              生成成片（待接入）
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

export default FactoryWorkspace;
