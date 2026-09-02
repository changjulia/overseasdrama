export type FactoryMode = "episode-splice" | "episode-narration" | "external-hook";

export type QualityStatus =
  | "可以直接生成"
  | "建议优化后生成"
  | "停滑能力弱"
  | "情绪强但信息不足"
  | "信息清晰但缺少刺激"
  | "音画不同步"
  | "悬念锚定缺失"
  | "过度剧透"
  | "高点击低转化风险"
  | "货不对板，禁止批量生成";

export type FactoryFlowStepId =
  | "episode-source"
  | "hook-source"
  | "hook-match"
  | "transition"
  | "timeline"
  | "quality-gate"
  | "preview-review"
  | "save-export";

export type FactoryStepState = "locked" | "ready" | "active" | "completed";
export type IntegrationState = "not-connected" | "available" | "running" | "failed" | "completed";

export type FactorySemanticFingerprint = {
  ontologyVersion: string;
  dramaAnalysisVersion: string;
  highlightAssetVersion: string;
  hookAnalysisVersion?: string;
  matchContextHash?: string;
};

/** Multi-select preserves one immutable semantic context per entity. */
export type FactorySemanticSelection = {
  entityId: string;
  entityType: "highlight" | "storyline";
  parentEntityId?: string;
  fingerprint: FactorySemanticFingerprint;
};

export type FactoryFlowStep = {
  id: FactoryFlowStepId;
  order: number;
  name: string;
  description: string;
  state: FactoryStepState;
  prerequisite?: FactoryFlowStepId;
};

export type ProductionGoal = {
  objective: "stop-rate" | "click-through" | "completion" | "conversion" | null;
  market: string;
  language: string;
  platform: "Meta" | "TikTok" | "YouTube" | "other" | null;
  ratio: "9:16" | "16:9" | "1:1";
  targetDurationSeconds?: number;
  plannedVariantCount?: number;
  aiGenerationAllowed: boolean;
  intensity: "conservative" | "balanced" | "aggressive";
};

export type EpisodeEntryPoint = {
  id: string;
  episode: number;
  startSeconds: number;
  endSeconds?: number;
  strategy: "fast-context" | "natural-continuity" | "conversion-first" | "manual";
  title: string;
  rationale: string;
  sourceUrl?: string;
  status: IntegrationState;
};

export type HookCandidate = {
  id: string;
  title: string;
  source: "favorite" | "hook-library" | "high-performing" | "generated";
  previewUrl?: string;
  scores?: Partial<Record<"stopRate" | "emotion" | "relationship" | "conflict" | "continuity" | "promiseFulfillment", number>>;
  rationale?: string;
  risks: string[];
  status: IntegrationState;
};

export type TransitionCandidate = {
  id: string;
  type: "time-rewind" | "causal-bridge" | "identity-contrast" | "action-match" | "dialogue-bridge" | "audio-bridge" | "title-card" | "manual";
  title: string;
  durationSeconds?: number;
  copy?: string;
  rationale?: string;
  previewUrl?: string;
  status: IntegrationState;
};

export type CombinationVariant = {
  id: string;
  name: string;
  hookId: string;
  entryPointId: string;
  transitionId: string;
  changedVariables: string[];
  renderStatus: IntegrationState;
  outputUrl?: string;
  outputName?: string;
};

export type QualityFinding = {
  id: string;
  severity: "info" | "warning" | "blocking";
  category: "hook" | "continuity" | "promise" | "audio-visual" | "compliance";
  message: string;
  suggestion?: string;
};

export type QualityReport = {
  status: IntegrationState;
  verdict?: QualityStatus;
  score?: number;
  findings: QualityFinding[];
  checkedAt?: string;
};

export type FactoryWorkflow = {
  currentStep: FactoryFlowStepId;
  steps: FactoryFlowStep[];
  goal: ProductionGoal;
  entryPoints: EpisodeEntryPoint[];
  selectedEntryPointId?: string;
  hooks: HookCandidate[];
  selectedHookId?: string;
  transitions: TransitionCandidate[];
  selectedTransitionId?: string;
  combinations: CombinationVariant[];
  qualityReport: QualityReport;
};

export type Draft = {
  id: string;
  title: string;
  mode: FactoryMode;
  drama: string;
  hook: string;
  episodeRange: string;
  transition: string;
  language: string;
  duration: string;
  ratio: "9:16" | "16:9" | "1:1";
  qualityStatus: QualityStatus;
  updatedAt: string;
  autoSaved: boolean;
  thumbnailTone: "rose" | "blue" | "violet" | "amber" | "mint";
  /** First selected source video; used to render the draft's default first-frame thumbnail. */
  thumbnailUrl?: string;
  progress: number;
  productionStatus?: "自动保存" | "编辑中" | "生成中" | "待质检" | "建议优化" | "通过" | "禁止批量生成" | "待审核" | "已导出";
  version?: number;
  sourceContext?: FactorySourceContext | null;
  hookSourceContext?: FactorySourceContext | null;
  onModeChange?: (mode: FactoryMode) => void;
  selectedEpisodes?: number[];
  /** Only set after a renderer returns a real playable file. */
  outputUrl?: string;
  outputName?: string;
  workflow?: FactoryWorkflow;
  factoryProjectId?: string;
  parentFactoryProjectId?: string;
  factoryRenderId?: string;
  renderVersions?: Array<{
    id: string;
    version: number;
    status: string;
    previewUrl?: string;
    outputUrl?: string;
    created?: string;
  }>;
  storyMatchId?: string;
  isHistorySnapshot?: boolean;
  factorySnapshot?: {
    timeline: unknown[];
    transition: Record<string, unknown>;
    qualityReport: Record<string, unknown>;
    review: Record<string, unknown>;
    projectStatus: string;
    activeStorylineId?: string;
    storylineHookPairs?: Record<string, FactorySourceContext>;
    storylineMatchCache?: Record<string, unknown>;
  };
};

export type FactoryEpisodeMedia = {
  episode: number;
  name: string;
  url?: string;
  duration?: number;
  fps?: number;
  mimeType?: string;
  analysisStatus?: "idle" | "queued" | "running" | "processing" | "failed" | "completed";
  analysisProgress?: number;
  analysisError?: string;
  analysisResult?: unknown;
};

export type FactorySourceContext = {
  kind: "inspiration" | "library" | "favorite";
  id: string;
  title: string;
  description?: string;
  language?: string;
  dramaTitle?: string;
  dramaCn?: string;
  genre?: string;
  episodes?: number;
  freeEpisodes?: number;
  availableEpisodes?: number[];
  hookAssetId?: string;
  hookSourceClass?: "episode_highlight" | "narration_opening" | "external_material";
  hookMaterialId?: string;
  hookMaterialPlatform?: string;
  hookMaterialExposure?: number;
  hookMaterialRunDays?: number;
  hookMediaUrl?: string;
  hookStart?: number;
  hookEnd?: number;
  hookStartFrame?: number;
  hookEndFrame?: number;
  hookBoundaryStatus?: "unverified" | "verified" | "rejected";
  hookType?: string;
  themes?: string[];
  contentTags?: string[];
  ontologyTags?: Array<{ code:string;label:string;dimension:string;original?:string;confidence?:number;evidence?:string[];episodes?:number[];prominence?:"primary"|"secondary" }>;
  hookMatchScore?: number;
  hookMatchRelation?: "exact"|"compatible"|"bridgeable"|"contradictory"|"unknown";
  hookMatchReasons?: string[];
  hookRetrievalDirection?: string;
  hookStoryNeedCoverage?: number;
  hookTruthSafety?: number;
  hookBridgeCost?: number;
  hookSpoilerRisk?: number;
  historicalTemplate?: Record<string,unknown>;
  templateEvidenceLevel?: "weak"|"medium"|"strong";
  templateProductionEligible?: boolean;
  relationships?: string[];
  conflict?: string;
  emotion?: string;
  narrativePromise?: string;
  informationGap?: string;
  rightsStatus?: string;
  episodeMedia?: Record<number, FactoryEpisodeMedia>;
  highlightCandidates?: Array<{
    id: number | string;
    episode: number;
    start: number;
    end: number;
    title: string;
    evidence?: string;
    event?: string;
    emotion?: string;
    highlightAssetId?: string;
    highlightAssetIds?: string[];
    analysisVersion?: string;
    ontologyVersion?: string;
    matchContextHash?: string;
  }>;
  semanticSelections?: FactorySemanticSelection[];
};

export type FactoryWorkspaceProps = {
  initialMode?: FactoryMode;
  editingDraft?: Draft | null;
  sourceContext?: FactorySourceContext | null;
  dramaSourceContext?: FactorySourceContext | null;
  hookSourceContext?: FactorySourceContext | null;
  onModeChange?: (mode: FactoryMode) => void;
  onChooseDrama?: (source: FactorySourceContext) => void;
  onChooseHook?: (source: FactorySourceContext) => void;
  onDraftAutoSave?: (draft: Draft) => void;
  onOpenDrafts?: () => void;
  onNotify?: (message: string) => void;
};

export type FactoryModeDefinition = {
  id: FactoryMode;
  name: string;
  description: string;
  icon: string;
  steps: string[];
};
