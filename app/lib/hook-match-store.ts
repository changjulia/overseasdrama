"use client";

export type StoryMatchSegment = {
  episode: number;
  start: number;
  end: number;
  purpose?: string;
  highlightAssetId?: string;
  safeStart?: Record<string, unknown>;
  safeEnd?: Record<string, unknown>;
  evidence?: unknown[];
};
export type HookStoryMatch = {
  id: string;
  hookId: string;
  dramaId: string;
  topics: string[];
  episodeScope: number[];
  scopeMode: string;
  targetDurationBand: string;
  matchContextHash: string;
  storyArc: {
    setup?: string;
    escalation?: string;
    payoff?: string;
    ending?: string;
    displayNarrativeZh?: {
      title?: string;
      hookQuestion?: string;
      bodyConnection?: string;
      formedStoryline?: string;
      relationship?: string;
      conflict?: string;
      emotion?: string;
      connectionType?: string;
      continuityNotice?: string;
      phases?: { setup?: string; escalation?: string; payoff?: string; ending?: string };
    };
  };
  storyGraph: Record<string, unknown>;
  entryPoints: unknown[];
  completeness: Record<string, unknown>;
  calibration: Record<string, unknown>;
  productionGate: Record<string, unknown>;
  segments: StoryMatchSegment[];
  matchScore: number;
  storyScore: number;
  promiseFulfillmentScore: number;
  dimensionScores: Record<string, number>;
  evidence: unknown[];
  risks: string[];
  status: string;
  humanVideoApproved: boolean;
  matchStrategy?: ExternalMatchStrategy;
  deliveryGoal?: string;
};
export type HookMatchDiagnostics = {
  outcomeStatus:
    "waiting_supplemental" | "partial" | "failed" | "no_candidates" | "ready";
  funnel: {
    episodesRequested: number;
    rawCandidates: number;
    editableCandidates: number;
    productionCandidates: number;
    storyMatches: number;
    supplementalJobs: Record<string, number>;
  };
  rejectionReasons: Array<{ code: string; count: number }>;
  incomplete: boolean;
};
export type HookMatchJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  stage: string;
  error: string;
  diagnostics?: HookMatchDiagnostics;
  matchContextHash?: string;
};
export type ExternalMatchStrategy =
  "hook_to_story" | "story_to_hook" | "template_reuse";
export type HookMatchOptions = {
  strategy: ExternalMatchStrategy;
  deliveryGoal: string;
  matchingDimensions: string[];
  templateMaterialId?: string;
  selectedStorylines?: StorylinePlan[];
};
export type StoryNeed = {
  contractVersion: string;
  corePlot: string;
  protagonistGoal: string;
  relationshipState: string[];
  causalChain: string[];
  comprehensionGaps: string[];
  contentTags: string[];
  deliveryGoal: string;
  extendDirections: Array<{ type: string; label: string; query: string[] }>;
  evidence: unknown[];
  selectedStorylineIds?: string[];
  protectedReveals?: string[];
};
export type StorylinePlanSegment = {
  episode: number;
  start: number;
  end: number;
  plot: string;
  narrativePurpose: string;
  highlightAssetId: string;
  analysisVersion: string;
  safeStart: Record<string, unknown>;
  safeEnd: Record<string, unknown>;
  evidence: unknown[];
};
export type StorylinePlan = {
  id: string;
  parentHighlightAssetId?: string;
  semanticFingerprint?: {
    ontologyVersion: string;
    dramaAnalysisVersion: string;
    highlightAssetVersion: string;
    hookAnalysisVersion?: string;
    matchContextHash?: string;
  };
  title: string;
  strategyType: string;
  chronology: "chronological" | "flashback";
  storylineSummary: string;
  audienceQuestion: string;
  totalDurationSeconds: number;
  episodeScope: number[];
  acquisitionScore: number;
  scoreBreakdown: {
    openingStrength: number;
    conflictDensity: number;
    emotionalProgression: number;
    suspenseStrength: number;
    payoffStrength: number;
    continuity: number;
    evidenceAccuracy: number;
    hookBodyFit?: number;
    promiseFulfillment?: number;
  };
  rankingReasons: string[];
  segments: StorylinePlanSegment[];
  hookNeed: {
    purpose: string;
    audienceQuestion: string;
    requiredSignals: string[];
    prohibitedReveals: string[];
    preferredEmotion: string;
    connectionPoint: string;
  };
  evidence: unknown[];
  scriptPlan?: {
    mode: "impact" | "context" | "awakening" | "suspense" | string;
    label: string;
    coreStory: string;
    openingEvent: string;
    audiencePromise: string;
    progression: Array<{
      episode: number;
      start: number;
      end: number;
      beat: string;
      plot: string;
    }>;
    stagePayoff: string;
    endingCliffhanger: string;
    hookDirection: string;
    editRule: string;
  };
  hookUnderstanding?: HookUnderstanding;
  connectionLogic?: {
    type: string;
    hookQuestion: string;
    bodyAnswer: string;
    matchedSignals: string[];
    hookBodyFit: number;
    promiseFulfillment: number;
  };
  templateAdaptation?: {
    templateId: string;
    templateVersion: string;
    structureRetention: number;
    mappedSlots: number;
    totalSlots: number;
    mappings: Array<{
      slotId: string;
      role: string;
      historicalPurpose: string;
      segmentId?: string;
      episode?: number;
      start?: number;
      end?: number;
      currentPlot?: string;
      confidence: number;
      substitutionType: "semantic" | "functional";
    }>;
    missingSlots: string[];
    historicalEvidence: Record<string, unknown>;
    disclaimer: string;
  };
};
export type HookUnderstanding = {
  coreEvent: string;
  relationships: string[];
  conflict: string;
  emotion: string;
  audienceQuestion: string;
  narrativePromise: string;
  revealedFacts?: string[];
  protectedFacts?: string[];
  evidence: unknown[];
};
export type StorylinePlanDiagnostics = {
  available_highlights?: number;
  approved_verified_highlights?: number;
  generated_plans: number;
  quality_standard: Record<string, string>;
  reasons: string[];
};
export type StoryBeatUnderstanding = {
  episode: number;
  start: number;
  end: number;
  stage: "setup" | "escalation" | "turn" | "payoff";
  event: string;
  characters: string[];
  evidenceStatus: "verified" | "partial" | "insufficient";
};
export type StorylineThread = {
  id: string;
  type: "main" | "subplot";
  title: string;
  summary: string;
  characters: string[];
  relationshipSummary: string;
  progression: StoryBeatUnderstanding[];
  unresolvedQuestion: string;
  evidenceStatus: "verified" | "partial" | "insufficient";
  sourcePlanIds: string[];
};
export type SelectedRangeStoryUnderstanding = {
  contractVersion: string;
  dramaId: string;
  episodeRange: number[];
  storylines: StorylineThread[];
  warnings: string[];
};
export type StrategyHookRecommendation = {
  hookId: string;
  materialId?: string;
  score: number;
  direction?: string;
  directionLabel?: string;
  storyNeedCoverage?: number;
  truthSafety?: number;
  bridgeCost?: number;
  spoilerRisk?: number;
  matchedSignals: string[];
  reasons: string[];
  evidenceLevel?: "weak" | "medium" | "strong";
  productionEligible?: boolean;
  tagRelation?: "exact" | "compatible" | "bridgeable" | "contradictory" | "unknown";
  tagGate?: "allow_recall" | "needs_evidence" | "blocked";
  template?: Record<string, unknown>;
};
const configuredUrl =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_POCKETBASE_URL
    : undefined;
const PB_URL = (
  configuredUrl ||
  (typeof window !== "undefined" ? "/pb" : "http://127.0.0.1:8090")
).replace(/\/$/, "");
async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${PB_URL}${path}`, {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      value?.message || `故事线匹配请求失败（HTTP ${response.status}）`,
    );
  }
  return response.json();
}
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export async function startHookStoryMatch(
  hookId: string,
  dramaId: string,
  episodeScope: number[],
  topics: string[],
  scopeMode: "free_only" | "custom" = "free_only",
  targetDurationSeconds = 900,
  forceRetry = false,
  options?: HookMatchOptions,
): Promise<HookMatchJob> {
  const targetDurationBand =
    targetDurationSeconds <= 300
      ? "1_5m"
      : targetDurationSeconds > 900
        ? "15_25m"
        : "5_15m";
  const jobRequest = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_id: hookId,
      drama_id: dramaId,
      episode_scope: episodeScope,
      topics,
      scope_mode: scopeMode,
      target_duration_band: targetDurationBand,
      force_retry: forceRetry,
      match_strategy: options?.strategy,
      delivery_goal: options?.deliveryGoal,
      matching_dimensions: options?.matchingDimensions,
      template_material_id: options?.templateMaterialId,
      selected_storylines: options?.selectedStorylines,
    }),
  };
  let value: Record<string, unknown>;
  try {
    value = (await request(
      "/api/lumina/hook-matching/jobs",
      jobRequest,
    )) as Record<string, unknown>;
  } catch (error) {
    const retryJobId =
      forceRetry && error instanceof Error
        ? error.message.match(/hook-matching\/jobs\/([^/\s]+)\/retry/i)?.[1]
        : undefined;
    if (!retryJobId) throw error;
    const current = (await request(
      `/api/collections/hook_match_jobs/records/${encodeURIComponent(retryJobId)}`,
    )) as Record<string, unknown>;
    await request(
      `/api/lumina/hook-matching/jobs/${encodeURIComponent(retryJobId)}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: "用户在内容工厂中重新匹配",
          override_non_retryable: true,
          override_reason: "用户已修正素材或匹配规则，并明确要求重新运行分析",
          idempotency_key: `factory-retry:${retryJobId}:${String(current.updated || "unknown")}`,
          expected_status: String(current.status || "failed"),
          expected_updated: String(current.updated || ""),
        }),
      },
    );
    value = {
      ...current,
      status: "queued",
      progress: 0,
      current_stage: "interactive_queued",
      error: "",
    };
  }
  return {
    id: String(value.id),
    status: String(value.status) as HookMatchJob["status"],
    progress: Number(value.progress || 0),
    stage: String(value.current_stage || "queued"),
    error: String(value.error || ""),
    matchContextHash: String(value.match_context_hash || "") || undefined,
  };
}

function recommendation(
  value: Record<string, unknown>,
): StrategyHookRecommendation {
  const retrieval = object(value.retrieval),
    template = object(value.template),
    hook = object(value.hook);
  const relation = String(retrieval.tagRelation || retrieval.relation || "unknown") as StrategyHookRecommendation["tagRelation"];
  return {
    hookId: String(value.hook_id || template.sourceHookId || hook.id || ""),
    materialId:
      String(value.material_id || template.sourceMaterialId || "") || undefined,
    score: Number(retrieval.score || 0),
    direction: String(retrieval.direction || "") || undefined,
    directionLabel: String(retrieval.directionLabel || "") || undefined,
    storyNeedCoverage: Number(retrieval.storyNeedCoverage || 0),
    truthSafety: Number(retrieval.truthSafety || 0),
    bridgeCost: Number(retrieval.bridgeCost || 0),
    spoilerRisk: Number(retrieval.spoilerRisk || 0),
    matchedSignals: list(retrieval.matchedSignals).map(String),
    reasons: list(retrieval.reasons).map(String),
    evidenceLevel: String(
      retrieval.evidenceLevel || "",
    ) as StrategyHookRecommendation["evidenceLevel"],
    tagRelation: relation,
    tagGate: relation === "contradictory" ? "blocked" : relation === "unknown" ? "needs_evidence" : "allow_recall",
    productionEligible: relation !== "contradictory" && relation !== "unknown" && retrieval.productionEligible === true,
    template: Object.keys(template).length ? template : undefined,
  };
}

export async function listStorylinePlans(
  dramaId: string,
  episodeScope: number[],
  deliveryGoal: string,
  targetDurationSeconds: number,
  selectedHighlightIds: string[] = [],
  signal?: AbortSignal,
): Promise<{
  storyNeed: StoryNeed;
  storyUnderstanding: SelectedRangeStoryUnderstanding;
  items: StorylinePlan[];
  diagnostics: StorylinePlanDiagnostics;
}> {
  const value = (await request("/api/lumina/storyline-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      drama_id: dramaId,
      episode_scope: episodeScope,
      delivery_goal: deliveryGoal,
      target_duration_seconds: targetDurationSeconds,
      selected_highlight_ids: selectedHighlightIds,
    }),
    signal,
  })) as Record<string, unknown>;
  const rawUnderstanding = object(value.story_understanding);
  const storyUnderstanding: SelectedRangeStoryUnderstanding = {
    contractVersion: String(
      rawUnderstanding.contractVersion || "lumina-range-story-understanding-v1",
    ),
    dramaId: String(rawUnderstanding.dramaId || dramaId),
    episodeRange: list(rawUnderstanding.episodeRange).map(Number),
    storylines: list(rawUnderstanding.storylines) as StorylineThread[],
    warnings: list(rawUnderstanding.warnings).map(String),
  };
  return {
    storyNeed: object(value.story_need) as StoryNeed,
    storyUnderstanding,
    items: list(value.plans) as StorylinePlan[],
    diagnostics: object(value.diagnostics) as StorylinePlanDiagnostics,
  };
}
export async function listHookDrivenStorylinePlans(
  hookId: string,
  dramaId: string,
  episodeScope: number[],
  deliveryGoal: string,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<{
  hookUnderstanding: HookUnderstanding;
  items: StorylinePlan[];
  diagnostics: StorylinePlanDiagnostics;
}> {
  const value = (await request("/api/lumina/hook-driven-storyline-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_id: hookId,
      drama_id: dramaId,
      episode_scope: episodeScope,
      delivery_goal: deliveryGoal,
      target_duration_seconds: targetDurationSeconds,
    }),
    signal,
  })) as Record<string, unknown>;
  return {
    hookUnderstanding: object(value.hook_understanding) as HookUnderstanding,
    items: list(value.plans) as StorylinePlan[],
    diagnostics: object(value.diagnostics) as StorylinePlanDiagnostics,
  };
}
export async function listStoryDrivenHookRecommendations(
  dramaId: string,
  episodeScope: number[],
  deliveryGoal: string,
  selectedStorylines: StorylinePlan[] = [],
  signal?: AbortSignal,
): Promise<{ storyNeed: StoryNeed; items: StrategyHookRecommendation[] }> {
  const value = (await request("/api/lumina/story-hook-recommendations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      drama_id: dramaId,
      episode_scope: episodeScope,
      delivery_goal: deliveryGoal,
      selected_storylines: selectedStorylines,
    }),
    signal,
  })) as Record<string, unknown>;
  return {
    storyNeed: object(value.story_need) as StoryNeed,
    items: list(value.candidates).map((item) => recommendation(object(item))),
  };
}

export async function listHistoricalTemplateRecommendations(
  dramaId: string,
  episodeScope: number[],
  deliveryGoal: string,
  signal?: AbortSignal,
): Promise<{ storyNeed: StoryNeed; items: StrategyHookRecommendation[] }> {
  const value = (await request(
    "/api/lumina/historical-template-recommendations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        drama_id: dramaId,
        episode_scope: episodeScope,
        delivery_goal: deliveryGoal,
      }),
      signal,
    },
  )) as Record<string, unknown>;
  return {
    storyNeed: object(value.story_need) as StoryNeed,
    items: list(value.templates).map((item) => recommendation(object(item))),
  };
}

export async function listTemplateAdaptationPlans(
  hookId: string,
  dramaId: string,
  episodeScope: number[],
  deliveryGoal: string,
  targetDurationSeconds: number,
  signal?: AbortSignal,
): Promise<{
  template: Record<string, unknown>;
  storyNeed: StoryNeed;
  items: StorylinePlan[];
  diagnostics: StorylinePlanDiagnostics;
}> {
  const value = (await request("/api/lumina/template-adaptation-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hook_id: hookId,
      drama_id: dramaId,
      episode_scope: episodeScope,
      delivery_goal: deliveryGoal,
      target_duration_seconds: targetDurationSeconds,
    }),
    signal,
  })) as Record<string, unknown>;
  return {
    template: object(value.template),
    storyNeed: object(value.story_need) as StoryNeed,
    items: list(value.plans) as StorylinePlan[],
    diagnostics: object(value.diagnostics) as StorylinePlanDiagnostics,
  };
}
export async function setHookMatchSoftOverride(
  matchId: string,
  codes: Array<"story_score" | "understanding_cost" | "transition_difficulty">,
  enabled = true,
): Promise<void> {
  await request(
    `/api/lumina/hook-story-matches/${encodeURIComponent(matchId)}/soft-override`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codes, enabled }),
    },
  );
}
export async function approveHookMatchForProduction(
  matchId: string,
): Promise<void> {
  await request(
    `/api/lumina/hook-story-matches/${encodeURIComponent(matchId)}/human-production-approval`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
}
export async function requestMoreEntryPoints(matchId: string): Promise<void> {
  await request("/api/lumina/entry-precision/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ match_id: matchId }),
  });
}
function parseDiagnostics(
  value: Record<string, unknown>,
): HookMatchDiagnostics | undefined {
  const raw = object(value.diagnostics),
    funnel = object(raw.funnel),
    supplemental = object(funnel.supplemental_jobs);
  const outcome = String(value.outcome_status || raw.outcome_status || "");
  if (!outcome) return undefined;
  return {
    outcomeStatus: outcome as HookMatchDiagnostics["outcomeStatus"],
    funnel: {
      episodesRequested: Number(funnel.episodes_requested || 0),
      rawCandidates: Number(funnel.raw_candidates || 0),
      editableCandidates: Number(funnel.editable_candidates || 0),
      productionCandidates: Number(funnel.production_candidates || 0),
      storyMatches: Number(funnel.story_matches || 0),
      supplementalJobs: Object.fromEntries(
        Object.entries(supplemental).map(([key, count]) => [
          key,
          Number(count || 0),
        ]),
      ),
    },
    rejectionReasons: list(raw.rejection_reasons).map((item) => {
      const row = object(item);
      return {
        code: String(row.code || "unknown"),
        count: Number(row.count || 0),
      };
    }),
    incomplete: Boolean(raw.incomplete),
  };
}
export async function getHookMatchJob(
  id: string,
  signal?: AbortSignal,
): Promise<HookMatchJob> {
  const value = (await request(
    `/api/collections/hook_match_jobs/records/${encodeURIComponent(id)}`,
    { signal },
  )) as Record<string, unknown>;
  return {
    id: String(value.id),
    status: String(value.status) as HookMatchJob["status"],
    progress: Number(value.progress || 0),
    stage: String(value.current_stage || ""),
    error: String(value.error || ""),
    matchContextHash: String(value.match_context_hash || ""),
    diagnostics: parseDiagnostics(value),
  };
}
export async function listHookStoryMatches(
  hookId: string,
  dramaId: string,
  signal?: AbortSignal,
  matchContextHash?: string,
): Promise<HookStoryMatch[]> {
  const filter = encodeURIComponent(`hook="${hookId}" && drama="${dramaId}"`),
    payload = (await request(
      `/api/collections/hook_story_matches/records?perPage=100&sort=-id&filter=${filter}`,
      { signal },
    )) as { items?: Array<Record<string, unknown>> };
  return (payload.items ?? [])
    .map((value) => {
      const dimensions = object(value.dimension_scores) as Record<
        string,
        number
      >;
      return {
        id: String(value.id),
        hookId: String(value.hook),
        dramaId: String(value.drama),
        topics: list(value.topics).map(String),
        episodeScope: list(value.episode_scope).map(Number),
        scopeMode: String(value.scope_mode || "free_only"),
        targetDurationBand: String(value.target_duration_band || "5_15m"),
        matchContextHash: String(value.match_context_hash || ""),
        matchStrategy: String(
          object(value.match_context).matchStrategy || "",
        ) as ExternalMatchStrategy,
        deliveryGoal: String(object(value.match_context).deliveryGoal || ""),
        storyArc: object(value.story_arc),
        storyGraph: object(value.story_graph),
        entryPoints: list(value.entry_points),
        completeness: object(value.completeness),
        calibration: object(value.calibration),
        productionGate: object(value.production_gate),
        segments: list(value.segments).map((raw) => {
          const item = object(raw);
          return {
            episode: Number(item.episode),
            start: Number(item.start),
            end: Number(item.end),
            purpose: String(item.purpose || ""),
            highlightAssetId: String(item.highlightAssetId || ""),
            safeStart: object(item.safeStart),
            safeEnd: object(item.safeEnd),
            evidence: list(item.evidence),
          };
        }),
        matchScore: Number(value.match_score || 0),
        storyScore: Number(value.story_score ?? value.match_score ?? 0),
        promiseFulfillmentScore: Number(
          value.promise_fulfillment_score ?? dimensions.promise ?? 0,
        ),
        dimensionScores: dimensions,
        evidence: list(value.evidence),
        risks: list(value.risks).map((raw) => {
          const risk = object(raw);
          return String(risk.description || risk.reason || raw);
        }),
        status: String(value.status || "candidate"),
        humanVideoApproved:
          object(object(value.soft_override).human_video_approval)
            .overridden === true,
      };
    })
    .filter(
      (item) => !matchContextHash || item.matchContextHash === matchContextHash,
    );
}
