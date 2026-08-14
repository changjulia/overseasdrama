function authorize(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
}

function authorizeLocalUi(e) {
  const origin = String(e.requestInfo().headers.origin || "");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):3001$/i.test(origin)) {
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
    return String(value.code || value.value || value.label || "");
  }
  return String(value || "");
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
  const tier = claimText(creative.tier || root.tier);
  const format = claimText(creative.format || root.material_format || root.materialFormat);
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
    sourceAttribution: root.sourceAttribution || root.source_attribution || null
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

module.exports = { authorize, authorizeLocalUi, createJob, resultValue, projectMaterialResult, normalizeStage };
