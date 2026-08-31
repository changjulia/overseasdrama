/// <reference path="../pb_data/types.d.ts" />

onRecordAfterCreateSuccess((e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  if (e.record.getString("video") && e.record.getString("analysis_status") === "queued") helpers.createJob(e.app, e.record);
  e.next();
}, "ad_materials");

routerAdd("POST", "/api/lumina/material-analysis/claim", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorize(e);
  const body = e.requestInfo().body;
  const workerId = String(body.worker_id || "").trim();
  const requestedJobId = String(body.job_id || "").trim();
  const leaseSeconds = Math.max(30, Math.min(1800, Number(body.lease_seconds || 300)));
  if (!workerId) throw new BadRequestError("worker_id is required");
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const candidates = tx.findRecordsByFilter("material_analysis_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "-priority,id", 200, 0).filter(Boolean);
    const now = Date.now();
    const job = candidates.find((item) => {
      if (requestedJobId && item.id !== requestedJobId) return false;
      if (item.getString("status") === "queued") return true;
      if (item.getString("status") === "failed") {
        if (["permanent", "media", "validation"].includes(item.getString("error_kind"))) return false;
        const nextAttempt = Date.parse(item.getString("next_attempt_at"));
        return item.getInt("attempt") < item.getInt("max_attempts") && (!nextAttempt || nextAttempt <= now);
      }
      const lease = Date.parse(item.getString("lease_until"));
      return !lease || lease <= now;
    });
    if (!job) return;
    const token = $security.randomString(40);
    job.set("status", "running");
    job.set("progress", Math.max(1, job.getInt("progress")));
    job.set("attempt", job.getInt("attempt") + 1);
    job.set("worker_id", workerId);
    job.set("lease_token", token);
    job.set("lease_until", new Date(now + leaseSeconds * 1000).toISOString());
    job.set("error", "");
    job.set("result", null);
    job.set("result_schema_version", "material-v2");
    job.set("current_stage", "download");
    tx.save(job);
    const material = tx.findRecordById("ad_materials", job.getString("material"));
    material.set("analysis_status", "running");
    material.set("analysis_progress", job.getInt("progress"));
    material.set("analysis_error", "");
    material.set("analysis_schema_version", "material-v2");
    material.set("analysis_stage", "download");
    tx.save(material);
    claimed = {
      job: {
        id: job.id,
        stage: job.getString("stage"),
        lease_token: token,
        lease_until: job.getString("lease_until"),
        attempt: job.getInt("attempt"),
        analysis_version: "material-v2",
        result_contract: "material-v2",
        parameters: job.get("logs") || {}
      },
      material: {
        id: material.id,
        collection_id: material.collection().id,
        video: material.getString("video"),
        title: material.getString("title"),
        original_name: material.getString("original_name"),
        mime_type: material.getString("mime_type"),
        language: material.getString("language"),
        platform: material.getString("platform")
      }
    };
  });
  if (!claimed) return e.noContent(204);
  return e.json(200, claimed);
});

routerAdd("PATCH", "/api/lumina/material-analysis/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorize(e);
  const body = e.requestInfo().body;
  const workerId = String(body.worker_id || "");
  const leaseToken = String(body.lease_token || "");
  const nextStatus = String(body.status || "running");
  if (!["running", "succeeded", "failed"].includes(nextStatus)) throw new BadRequestError("invalid status");
  const jobId = e.request.pathValue("id");
  e.app.runInTransaction((tx) => {
    const job = tx.findRecordById("material_analysis_jobs", jobId);
    if (job.getString("status") === nextStatus && nextStatus !== "running") return;
    if (job.getString("worker_id") !== workerId || job.getString("lease_token") !== leaseToken) throw new ForbiddenError("lease ownership mismatch");
    if (job.getString("status") !== "running") throw new BadRequestError("job is not running");
    const leaseUntil = Date.parse(job.getString("lease_until"));
    if (!leaseUntil || leaseUntil <= Date.now()) throw new ForbiddenError("lease expired");
    const progress = nextStatus === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress"))));
    job.set("status", nextStatus);
    job.set("progress", progress);
    job.set("error", nextStatus === "failed" ? String(body.error || "analysis failed").slice(0, 4000) : "");
    if (nextStatus === "failed") {
      const errorKind = String(body.error_kind || "permanent");
      job.set("error_kind", errorKind);
      const retryable = body.retryable === true && !["permanent", "media", "validation"].includes(errorKind);
      const delay = Math.max(0, Math.min(1800, Number(body.retry_after_seconds || 0)));
      job.set("next_attempt_at", retryable && delay ? new Date(Date.now() + delay * 1000).toISOString() : "");
      if (!retryable) job.set("max_attempts", job.getInt("attempt"));
    } else {
      job.set("error_kind", "");
      job.set("next_attempt_at", "");
    }
    if (body.result != null) job.set("result", body.result);
    if (body.logs != null) job.set("logs", body.logs);
    const reportedStage = String(body.current_stage || body.stage_name || "");
    const currentStage = nextStatus === "succeeded" ? "completed" : helpers.normalizeStage(reportedStage, job.getString("current_stage") || "scan");
    job.set("current_stage", currentStage);
    if (nextStatus === "running") job.set("lease_until", new Date(Date.now() + Math.max(30, Math.min(1800, Number(body.lease_seconds || 300))) * 1000).toISOString());
    else { job.set("lease_until", ""); job.set("lease_token", ""); }
    tx.save(job);

    const material = tx.findRecordById("ad_materials", job.getString("material"));
    material.set("analysis_status", nextStatus);
    material.set("analysis_progress", progress);
    material.set("analysis_error", job.getString("error"));
    material.set("analysis_stage", currentStage);
    if (nextStatus === "succeeded" && body.result != null) {
      const materialResult = body.material_result != null ? body.material_result : (body.result.result != null ? body.result.result : body.result);
      const materialFields = materialResult && materialResult.materialFields ? materialResult.materialFields : materialResult;
      material.set("analysis_result", materialResult);
      const projection = helpers.projectMaterialResult(materialResult, material.getString("review_status"));
      job.set("result_schema_version", projection.schemaVersion);
      job.set("segment_count", projection.segmentCount);
      tx.save(job);
      material.set("analysis_schema_version", projection.schemaVersion);
      material.set("segment_count", projection.segmentCount);
      material.set("hook_count", projection.hookCount);
      material.set("creative_tier", projection.tier);
      material.set("material_format", projection.format);
      material.set("type", projection.format);
      material.set("review_flags", projection.reviewFlags);
      material.set("prototype_inputs", projection.prototypeInputs);
      material.set("source_attribution", projection.sourceAttribution);
      material.set("ontology_tags", projection.ontologyTags);
      const detectedLanguage = String(helpers.resultValue(materialResult, ["detectedLanguage", "language"], helpers.resultValue(materialFields, ["detectedLanguage", "language"], "")) || "");
      if (detectedLanguage) material.set("language", detectedLanguage.slice(0, 80));
      material.set("production_gate", projection.productionGate);
      material.set("prototype", String(body.prototype || helpers.resultValue(materialFields, ["prototype", "hookPrototype", "hook_prototype"], material.getString("prototype")) || ""));
      material.set("review_status", String(body.review_status || projection.reviewStatus || helpers.resultValue(materialFields, ["reviewStatus", "review_status"], "pending")));
      const duration = Number(helpers.resultValue(materialResult, ["durationSeconds", "duration_seconds"], 0));
      if (duration > 0) material.set("duration_seconds", duration);
      helpers.syncMaterialHookAssets(tx, material, materialResult, projection);
    } else if (body.prototype != null) {
      material.set("prototype", String(body.prototype));
    }
    if (body.review_status != null) material.set("review_status", String(body.review_status));
    tx.save(material);
  });
  return e.json(200, { id: jobId, status: nextStatus });
});

routerAdd("POST", "/api/lumina/material-analysis/jobs/{id}/retry", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorize(e);
  const job = e.app.findRecordById("material_analysis_jobs", e.request.pathValue("id"));
  const status = job.getString("status");
  const leaseUntil = Date.parse(job.getString("lease_until"));
  const staleRunning = status === "running" && (!leaseUntil || leaseUntil <= Date.now());
  if (status !== "failed" && !staleRunning) throw new BadRequestError("only failed or lease-expired running jobs can be retried");
  job.set("logs", helpers.appendRetryLineage(job.get("logs"), job, "worker_job_retry", true));
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  job.set("error", "");
  job.set("result", null);
  job.set("current_stage", "queued");
  e.app.save(job);
  const material = e.app.findRecordById("ad_materials", job.getString("material"));
  helpers.resetMaterialPublishedAnalysis(material);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("analysis_stage", "queued");
  e.app.save(material);
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});

routerAdd("POST", "/api/lumina/material-analysis/materials/{id}/reproject", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const material = e.app.findRecordById("ad_materials", e.request.pathValue("id"));
  const decodeJson = (value) => {
    let decodedValue = value;
    for (let index = 0; index < 3 && typeof decodedValue === "string"; index++) decodedValue = JSON.parse(decodedValue || "{}");
    return typeof decodedValue === "object" && decodedValue ? JSON.parse(JSON.stringify(decodedValue)) : {};
  };
  const requestBody = e.requestInfo().body || {};
  let storedResult = requestBody.analysis_result || material.getString("analysis_result");
  let decoded = decodeJson(storedResult);
  if (!decoded || !decoded.creative) {
    const job = e.app.findFirstRecordByFilter("material_analysis_jobs", "material = {:material}", { material: material.id });
    storedResult = job.getString("result");
    const envelope = decodeJson(storedResult);
    decoded = decodeJson(envelope && envelope.result ? envelope.result : envelope);
  }
  const result = decoded;
  if (!result || typeof result !== "object") throw new BadRequestError("material has no analysis result");
  const creative = result.creative && typeof result.creative === "object" ? result.creative : {};
  const bodyFormat = helpers.resultValue({ result: creative.bodyFormat || {} }, ["value", "label", "code"], "");
  const narrationCoverage = Number(helpers.resultValue({ result: creative.narrationCoverage || {} }, ["value"], NaN));
  const hookSourceStatus = helpers.resultValue({ result: creative.hookSourceStatus || {} }, ["value", "label", "code"], "");
  const hookAssemblyType = helpers.resultValue({ result: creative.hookAssemblyType || {} }, ["value", "label", "code"], "");
  const hasPreface = ["同剧外搭", "跨剧外搭", "外搭来源待确认"].includes(String(hookAssemblyType));
  let format = "未确定";
  if (hasPreface || ["疑似外搭", "已确认外搭"].includes(String(hookSourceStatus))) format = "外搭钩子＋本剧正片";
  else if (String(bodyFormat) === "解说主导") format = "正片剧集解说";
  else if (String(bodyFormat) === "正片主导") format = "正片剧集拼接";
  else if (String(bodyFormat) === "混合" && Number.isFinite(narrationCoverage)) format = narrationCoverage >= .5 ? "正片剧集解说" : "正片剧集拼接";
  const basis = hasPreface ? creative.hookAssemblyType : ["疑似外搭", "已确认外搭"].includes(String(hookSourceStatus)) ? creative.hookSourceStatus : creative.bodyFormat;
  creative.format = {
    code: { "正片剧集拼接": "EPISODE_SPLICE", "正片剧集解说": "EPISODE_NARRATION", "外搭钩子＋本剧正片": "EXTERNAL_HOOK_BODY", "未确定": "UNDETERMINED" }[format],
    label: format,
    value: format,
    confidence: basis && typeof basis.confidence === "number" ? basis.confidence : 0,
    evidence: basis && Array.isArray(basis.evidence) ? basis.evidence : [],
    verification: basis && basis.verification ? basis.verification : "unverified"
  };
  result.creative = creative;
  if (result.semantic && typeof result.semantic === "object") result.semantic.creative = creative;
  material.set("analysis_result", result);
  const projection = helpers.projectMaterialResult(result, material.getString("review_status"));
  material.set("material_format", projection.format);
  material.set("type", projection.format);
  material.set("creative_tier", ["T0", "T1", "T2", "T3", "TX"].includes(projection.tier) ? projection.tier : "TX");
  material.set("segment_count", projection.segmentCount);
  material.set("hook_count", projection.hookCount);
  material.set("review_flags", projection.reviewFlags);
  material.set("ontology_tags", projection.ontologyTags);
  material.set("production_gate", projection.productionGate);
  material.set("analysis_status", "succeeded");
  material.set("analysis_progress", 100);
  material.set("analysis_stage", "completed");
  material.set("analysis_error", "");
  const hookAssetIds = helpers.syncMaterialHookAssets(e.app, material, result, projection);
  e.app.save(material);
  return e.json(200, { id: material.id, material_format: projection.format, creative_tier: material.getString("creative_tier"), hook_asset_ids: hookAssetIds });
});

routerAdd("POST", "/api/lumina/maintenance/clear-hook-review-data", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const body = e.requestInfo().body || {};
  if (body.confirm !== "CLEAR_HOOKS_AND_REVIEWS") throw new BadRequestError("explicit confirmation is required");
  const hooks = e.app.findRecordsByFilter("hook_assets", "id != ''", "id", 5000, 0);
  for (const hook of hooks) e.app.delete(hook);
  const materials = e.app.findRecordsByFilter("ad_materials", "id != ''", "id", 5000, 0);
  for (const material of materials) {
    let result = {};
    try {
      const stored = material.getString("analysis_result");
      result = stored ? JSON.parse(stored) : {};
      for (let index = 0; index < 2 && typeof result === "string"; index++) result = JSON.parse(result || "{}");
    } catch (_) { result = {}; }
    if (result && typeof result === "object") {
      result.review = { ...(result.review || {}), status: "ready", reviewRequired: false, items: [], reasons: [] };
      if (result.semantic && typeof result.semantic === "object") result.semantic.review = result.review;
      material.set("analysis_result", result);
    }
    material.set("review_status", "已通过");
    material.set("review_flags", []);
    const gate = material.get("production_gate") || {};
    if (gate && typeof gate === "object") material.set("production_gate", { ...gate, reviewRequired: false, reasons: [] });
    e.app.save(material);
  }
  return e.json(200, { deletedHookAssets: hooks.length, clearedMaterialReviews: materials.length });
});

routerAdd("POST", "/api/lumina/material-analysis/jobs/{id}/reset", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorize(e);
  const job = e.app.findRecordById("material_analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") === "succeeded") throw new BadRequestError("succeeded jobs cannot be reset");
  job.set("logs", helpers.appendRetryLineage(job.get("logs"), job, "worker_job_reset", true));
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  job.set("error", "");
  job.set("result", null);
  job.set("current_stage", "queued");
  e.app.save(job);
  const material = e.app.findRecordById("ad_materials", job.getString("material"));
  helpers.resetMaterialPublishedAnalysis(material);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("analysis_stage", "queued");
  e.app.save(material);
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});

routerAdd("POST", "/api/lumina/material-analysis/materials/{id}/retry", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const body = e.requestInfo().body || {};
  const force = body.force === true;
  // `force` controls queue state; semantic refresh is independently
  // overridable so deterministic post-processing fixes can reuse the paid
  // provider result. Existing clients that omit the field keep the old
  // force-implies-refresh behavior.
  const forceSemanticRefresh = body.force_semantic_refresh === true || (force && body.force_semantic_refresh === undefined);
  const material = e.app.findRecordById("ad_materials", e.request.pathValue("id"));
  const jobs = e.app.findRecordsByFilter("material_analysis_jobs", "material = {:material}", "-id", 1, 0, { material: material.id }).filter(Boolean);
  const job = jobs[0];
  if (!job) {
    if (!material.getString("video")) throw new BadRequestError("material has no uploaded video");
    const created = helpers.createJob(e.app, material);
    return e.json(200, { id: created.id, status: "queued", attempt: 0 });
  }
  if (["queued", "running"].includes(job.getString("status")) && !force) {
    return e.json(200, { id: job.id, status: job.getString("status"), attempt: job.getInt("attempt") });
  }
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  job.set("error", "");
  job.set("result", null);
  job.set("current_stage", "queued");
  job.set("logs", helpers.appendRetryLineage(job.get("logs"), job, "ui_material_retry", forceSemanticRefresh));
  e.app.save(job);
  helpers.resetMaterialPublishedAnalysis(material);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("analysis_stage", "queued");
  e.app.save(material);
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});
