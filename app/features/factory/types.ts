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
  | "production-goal"
  | "episode-entry"
  | "hook-match"
  | "transition"
  | "combinations"
  | "quality-gate";

export type FactoryStepState = "locked" | "ready" | "active" | "completed";
export type IntegrationState = "not-connected" | "available" | "running" | "failed" | "completed";

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
  selectedEpisodes?: number[];
  /** Only set after a renderer returns a real playable file. */
  outputUrl?: string;
  outputName?: string;
  workflow?: FactoryWorkflow;
};

export type FactoryEpisodeMedia = {
  episode: number;
  name: string;
  url?: string;
  duration?: number;
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
  episodeMedia?: Record<number, FactoryEpisodeMedia>;
};

export type FactoryWorkspaceProps = {
  initialMode?: FactoryMode;
  editingDraft?: Draft | null;
  sourceContext?: FactorySourceContext | null;
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
