function authorize(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
}

function constantTimeTextEqual(left, right) {
  const a = String(left || ""), b = String(right || "");
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function authorizeLocalUi(e) {
  const headers = e.requestInfo().headers;
  const rawHeader = e.request && e.request.header;
  const header = (name) => String(headers[name] || headers[name.toLowerCase()] || (rawHeader ? rawHeader.get(name) : "") || "");
  const gatewayToken = $os.getenv("LUMINA_UI_GATEWAY_TOKEN");
  const bearer = header("authorization").replace(/^Bearer\s+/i, "");
  if (gatewayToken && constantTimeTextEqual(bearer, gatewayToken)) return;
  const origin = header("origin");
  // Go promotes Host out of the Header map for inbound requests.
  const host = String((e.request && e.request.host) || header("host") || "");
  const localUiHeader = header("x-lumina-ui");
  const browserOriginAllowed = /^https?:\/\/(localhost|127\.0\.0\.1):(3000|3001|8090)$/i.test(origin);
  const localHostAllowed = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  if ($os.getenv("LUMINA_UI_MODE") !== "local-loopback" || !localHostAllowed || localUiHeader !== "local" || (origin && !browserOriginAllowed)) {
    throw new ForbiddenError("Material retry is only available to the local Lumina UI");
  }
}

function createJob(app, material) {
  const jobs = app.findCollectionByNameOrId("material_analysis_jobs");
  const key = `material:${material.id}:v1`;
  try { return app.findFirstRecordByFilter(jobs, "idempotency_key = {:key}", { key }); } catch (_) {}
  const job = new Record(jobs);
  job.set("material", material.id);
  job.set("stage", "material");
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("max_attempts", 3);
  job.set("idempotency_key", key);
  job.set("result_schema_version", "material-v2");
  job.set("current_stage", "queued");
  app.save(job);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("review_status", "pending");
  material.set("analysis_schema_version", "material-v2");
  material.set("analysis_stage", "queued");
  app.save(material);
  return job;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function claimText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return String(value.value || value.label || value.code || "");
  }
  return String(value || "");
}

function verifiedClaimText(value) {
  return objectValue(value).verification === "verified" ? claimText(value) : "";
}

function claimEvidenceSources(value) {
  return arrayValue(objectValue(value).evidence).map((item) => String(objectValue(item).source || "").toLowerCase());
}

function normalizeStage(value, fallback) {
  const stage = String(value || "").toLowerCase();
  if (["queued", "download", "scan", "evidence", "content", "creative", "value", "review", "completed"].includes(stage)) return stage;
  if (["probe", "frames", "extract", "shot_detection"].includes(stage)) return "scan";
  if (["asr", "ocr", "transcript"].includes(stage)) return "evidence";
  if (["semantic", "understanding"].includes(stage)) return "content";
  if (["validate", "validation"].includes(stage)) return "review";
  return fallback || "scan";
}

// Preserve the complete result JSON and only project stable fields required for
// filtering. Supports material-v2 and existing legacy worker payloads.
function projectMaterialResult(result, fallbackReviewStatus) {
  const root = objectValue(result && result.result ? result.result : result);
  const creative = objectValue(root.creative);
  const content = objectValue(root.content);
  const review = objectValue(root.review);
  const value = objectValue(root.value);
  const hooks = arrayValue(creative.hooks);
  const segments = arrayValue(content.segments).length ? arrayValue(content.segments) : arrayValue(creative.timeline);
  const tierClaim = objectValue(creative.tier || root.tier);
  const rawTier = verifiedClaimText(tierClaim);
  const tierHasBusinessEvidence = claimEvidenceSources(tierClaim).some((source) => ["adx", "performance", "metrics", "manual_review"].includes(source));
  const tier = tierHasBusinessEvidence && ["T0", "T1", "T2", "T3"].includes(rawTier) ? rawTier : "TX";
  const bodyFormat = verifiedClaimText(creative.bodyFormat);
  const narrationCoverage = Number(objectValue(creative.narrationCoverage).value);
  const hookSourceStatus = verifiedClaimText(creative.hookSourceStatus);
  const hookAssemblyType = verifiedClaimText(creative.hookAssemblyType);
  let format = claimText(creative.format || root.material_format || root.materialFormat);
  if (["同剧外搭", "跨剧外搭", "外搭来源待确认"].includes(hookAssemblyType) || ["疑似外搭", "已确认外搭"].includes(hookSourceStatus)) format = "外搭钩子＋本剧正片";
  else if (bodyFormat === "解说主导") format = "正片剧集解说";
  else if (bodyFormat === "正片主导") format = "正片剧集拼接";
  else if (bodyFormat === "混合" && Number.isFinite(narrationCoverage)) format = narrationCoverage >= .5 ? "正片剧集解说" : "正片剧集拼接";
  else format = "未确定";
  const prototypeInputs = objectValue(root.prototypeClusteringInputs);
  if (!Object.keys(prototypeInputs).length) {
    prototypeInputs.format = format;
    prototypeInputs.tier = tier;
    prototypeInputs.hookCodes = hooks.map((item) => objectValue(item).code).filter(Boolean);
    prototypeInputs.timelineCodes = arrayValue(creative.timeline).map((item) => objectValue(item).code).filter(Boolean);
    prototypeInputs.packaging = objectValue(creative.packaging);
    prototypeInputs.inspirations = arrayValue(value.inspirations);
    prototypeInputs.risks = arrayValue(value.risks);
  }
  return {
    schemaVersion: String(root.schemaVersion || root.schema_version || "legacy-v1"),
    reviewStatus: String(review.status || root.review_status || fallbackReviewStatus || "pending"),
    reviewFlags: arrayValue(review.flags).length ? arrayValue(review.flags) : arrayValue(review.reasons),
    tier,
    format,
    segmentCount: segments.length,
    hookCount: hooks.length,
    prototypeInputs,
    sourceAttribution: root.sourceAttribution || root.source_attribution || null,
    ontologyTags: arrayValue(content.tags),
    productionGate: {
      passed: hooks.length > 0 && String(review.status || "") === "ready",
      reviewRequired: String(review.status || "") !== "ready",
      reasons: arrayValue(review.reasons),
      hookCount: hooks.length,
      schemaVersion: String(root.schemaVersion || root.schema_version || "legacy-v1")
    }
  };
}

function resultValue(result, names, fallback) {
  const payload = result && result.result ? result.result : (result || {});
  for (let index = 0; index < names.length; index++) {
    const value = payload[names[index]];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return fallback;
}

function selectClaimValue(claim, aliases, fallback) {
  const row = objectValue(claim);
  const candidates = [row.code, row.value, row.label, claim].map((value) => String(value || "").trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(aliases, candidate)) return aliases[candidate];
  }
  return fallback;
}

function numberValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : (fallback || 0);
}

function resetMaterialPublishedAnalysis(material) {
  // A new attempt has no published result until its terminal success write.
  // Remove the prior projection so a failed retry cannot expose stale tier,
  // format or prototype values as if they came from the failed attempt.
  material.set("analysis_result", null);
  material.set("analysis_schema_version", "");
  material.set("segment_count", 0);
  material.set("hook_count", 0);
  material.set("creative_tier", "TX");
  material.set("material_format", "未确定");
  material.set("type", "未确定");
  material.set("prototype", "");
  material.set("review_flags", [{ id: "analysis-retry-pending", severity: "blocking", reason: "new analysis attempt has no published result" }]);
  material.set("prototype_inputs", null);
  material.set("source_attribution", { status: "pending", matches: [] });
  material.set("ontology_tags", null);
  material.set("production_gate", { status: "blocked", reasons: ["analysis_retry_pending"] });
  material.set("review_status", "pending");
}

function appendRetryLineage(logs, job, mode, forceSemanticRefresh) {
  const base = objectValue(logs);
  const history = arrayValue(base.retry_lineage).slice(-19);
  history.push({
    at: new Date().toISOString(),
    mode: String(mode || "retry"),
    from_status: job.getString("status"),
    from_attempt: job.getInt("attempt"),
    force_semantic_refresh: forceSemanticRefresh === true,
  });
  return { ...base, retry_lineage: history, force_semantic_refresh: forceSemanticRefresh === true };
}

function syncMaterialHookAssets(app, material, result, projection) {
  const collection = app.findCollectionByNameOrId("hook_assets");
  const existing = app.findRecordsByFilter(collection, "material = {:material}", "id", 500, 0, { material: material.id }).filter(Boolean);
  const root = objectValue(result && result.result ? result.result : result);
  const creative = objectValue(root.creative);
  const hookSourceStatus = selectClaimValue(creative.hookSourceStatus, {
    NO_INDEPENDENT_HOOK: "无独立钩子", SAME_DRAMA: "已确认同剧", SUSPECTED_EXTERNAL: "疑似外搭", CONFIRMED_EXTERNAL: "已确认外搭", UNKNOWN: "来源未知",
    "无独立钩子": "无独立钩子", "已确认同剧": "已确认同剧", "疑似外搭": "疑似外搭", "已确认外搭": "已确认外搭", "来源未知": "来源未知"
  }, "来源未知");
  const hookAssemblyType = selectClaimValue(creative.hookAssemblyType, {
    NONE: "无前置钩子", SAME_DRAMA_PREFACE: "同剧外搭", CROSS_DRAMA_PREFACE: "跨剧外搭", UNKNOWN_PREFACE: "外搭来源待确认",
    "无前置钩子": "无前置钩子", "同剧外搭": "同剧外搭", "跨剧外搭": "跨剧外搭", "外搭来源待确认": "外搭来源待确认"
  }, "无前置钩子");
  const content = objectValue(root.content);
  const evidenceRoot = objectValue(root.evidence);
  const hooks = arrayValue(creative.hooks);
  const sourceDuration = Math.max(0, numberValue(root.durationSeconds || objectValue(result).durationSeconds, 0));
  // Every localized hook from an uploaded paid-ad material is a material hook.
  // The creative format describes its relation to the body; it must not decide
  // whether the verified opening interval is persisted at all.
  const sourceClass = projection.format === "正片剧集解说" ? "narration_opening" : "external_material";
  if (!sourceClass) return [];

  const created = [], reusedIds = [];
  const labels = (value) => arrayValue(value).map((item) => {
    const row = objectValue(item);
    return claimText(row.label || row.value || row.name || item);
  }).filter(Boolean);
  const fallbackThemes = [...labels(content.themes), ...labels(content.genres)].slice(0, 8);
  const fallbackConflicts = labels(content.conflicts);
  const fallbackEmotions = labels(content.emotions);
  const fallbackRelationships = labels(content.relationships);
  const fallbackCharacters = arrayValue(content.characters).map((item) => claimText(objectValue(item).role || objectValue(item).label || objectValue(item).name)).filter(Boolean);
  hooks.forEach((rawHook) => {
    if (created.length >= 5) return;
    const hook = objectValue(rawHook);
    if (hook.start === undefined || hook.end === undefined) return;
    const start = Math.max(0, numberValue(hook.start, 0));
    const end = Math.max(start, numberValue(hook.end, start));
    const hookDuration = end - start;
    if (hookDuration < 5 || hookDuration > 60) return;
    if (sourceDuration > 8 && start <= .5 && end >= sourceDuration - .5) return;
    // A paid-ad material may contain a usable hook after an opening slate or
    // another lead-in.  Source lineage is a label/diagnostic, not a reason to
    // discard an otherwise localized interval.  Boundary review below remains
    // mandatory, so persisting this candidate does not make it renderable.
    if (sourceClass === "narration_opening" && (start >= 60 || end > Math.min(60, sourceDuration || 60) + .5)) return;
    if (created.some((item) => Math.min(end, item.end) - Math.max(start, item.start) >= .8 * Math.min(hookDuration, item.end - item.start))) return;
    const startBoundary = objectValue(hook.safeStart || hook.safe_start || hook.startBoundary);
    const endBoundary = objectValue(hook.safeEnd || hook.safe_end || hook.endBoundary);
    const verified = claimText(startBoundary.status || startBoundary.verification) === "verified"
      && claimText(endBoundary.status || endBoundary.verification) === "verified";
    const scores = objectValue(hook.qualityScores || hook.quality_scores || hook.scores);
    const record = existing.find((candidate) => !reusedIds.includes(candidate.id)
      && candidate.getString("source_class") === sourceClass
      && Math.abs(candidate.getFloat("start_seconds") - start) <= .25
      && Math.abs(candidate.getFloat("end_seconds") - end) <= .25) || new Record(collection);
    reusedIds.push(record.id);
    const wasHumanApproved = record.getString("review_status") === "approved" && record.getString("boundary_status") === "verified";
    record.set("source_class", sourceClass);
    record.set("hook_source_status", hookSourceStatus);
    record.set("hook_assembly_type", hookAssemblyType);
    record.set("material", material.id);
    record.set("title", `${sourceClass === "narration_opening" ? "解说开场" : projection.format === "外搭钩子＋本剧正片" ? "外搭钩子" : "素材开场钩子"} - ${material.getString("title")} - 钩子${String(created.length + 1).padStart(2, "0")}`);
    record.set("start_seconds", start);
    record.set("end_seconds", end);
    record.set("start_frame", Math.max(0, Math.round(numberValue(hook.startFrame || hook.start_frame, 0))));
    record.set("end_frame", Math.max(0, Math.round(numberValue(hook.endFrame || hook.end_frame, 0))));
    record.set("fps", Math.max(0, numberValue(hook.fps, 0)));
    if (!wasHumanApproved) {
      record.set("boundary_status", verified ? "verified" : "unverified");
      record.set("safe_start", startBoundary);
      record.set("safe_end", endBoundary);
    }
    record.set("hook_type", claimText(hook.type || hook.mechanism || hook.hookType || hook.code || hook.label));
    const themes = arrayValue(hook.themes).length ? arrayValue(hook.themes) : fallbackThemes;
    const contentTags = arrayValue(hook.contentTags || hook.content_tags || hook.tags).length ? arrayValue(hook.contentTags || hook.content_tags || hook.tags) : [...fallbackConflicts, ...fallbackEmotions].slice(0, 8);
    const characterRoles = arrayValue(hook.characterRoles || hook.character_roles).length ? arrayValue(hook.characterRoles || hook.character_roles) : fallbackCharacters;
    const relationships = arrayValue(hook.relationships).length ? arrayValue(hook.relationships) : fallbackRelationships;
    const plotSummary = claimText(hook.plotSummary || hook.plot_summary || creative.externalHookSummary || objectValue(creative.openingAnalysis).plotSummary);
    record.set("themes", themes);
    record.set("content_tags", contentTags);
    record.set("character_roles", characterRoles);
    record.set("relationships", relationships);
    record.set("conflict", claimText(hook.conflict || fallbackConflicts[0] || plotSummary));
    record.set("emotion", claimText(hook.emotion || fallbackEmotions[0]));
    record.set("narrative_promise", claimText(hook.narrativePromise || hook.narrative_promise || hook.promise || plotSummary));
    record.set("information_gap", claimText(hook.informationGap || hook.information_gap || (plotSummary ? `这段关系冲突将如何发展：${plotSummary}` : "")));
    record.set("spoken_summary", claimText(hook.spokenSummary || hook.spoken_summary || hook.voiceover));
    record.set("visual_summary", claimText(hook.visualSummary || hook.visual_summary));
    record.set("quality_scores", scores);
    record.set("evidence", arrayValue(hook.evidence).length ? arrayValue(hook.evidence) : {
      transcript: arrayValue(evidenceRoot.transcript).filter((item) => numberValue(objectValue(item).end, 0) >= start && numberValue(objectValue(item).start, 0) <= end),
      ocr: arrayValue(evidenceRoot.ocr).filter((item) => {
        const timecode = objectValue(objectValue(item).timecode);
        const timestamp = numberValue(timecode.start, -1);
        return timestamp >= start && timestamp <= end;
      })
    });
    record.set("analysis", hook);
    record.set("ontology_tags", [...themes, ...contentTags, ...relationships]);
    record.set("production_gate", objectValue(hook.productionGate || hook.production_gate));
    record.set("rights_status", material.getString("rights_status"));
    if (!wasHumanApproved) record.set("review_status", verified ? "pending" : "needs_review");
    record.set("analysis_version", projection.schemaVersion || "material-v2");
    app.save(record);
    created.push({ id: record.id, start, end });
  });
  existing.filter((record) => !reusedIds.includes(record.id) && record.getString("review_status") !== "approved").forEach((record) => app.delete(record));
  return created.map((item) => item.id);
}

module.exports = { appendRetryLineage, authorize, authorizeLocalUi, createJob, resultValue, projectMaterialResult, normalizeStage, resetMaterialPublishedAnalysis, syncMaterialHookAssets };
