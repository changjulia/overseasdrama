/// <reference path="../pb_data/types.d.ts" />

onRecordAfterCreateSuccess((e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  if (e.record.getString("video")) helpers.createJob(e.app, e.record);
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
    const candidates = tx.findRecordsByFilter("material_analysis_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "id", 200, 0).filter(Boolean);
    const now = Date.now();
    const job = candidates.find((item) => {
      if (requestedJobId && item.id !== requestedJobId) return false;
      if (item.getString("status") === "queued" || item.getString("status") === "failed") return item.getInt("attempt") < item.getInt("max_attempts");
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
      material.set("review_flags", projection.reviewFlags);
      material.set("prototype_inputs", projection.prototypeInputs);
      material.set("source_attribution", projection.sourceAttribution);
      material.set("prototype", String(body.prototype || helpers.resultValue(materialFields, ["prototype", "hookPrototype", "hook_prototype"], material.getString("prototype")) || ""));
      material.set("review_status", String(body.review_status || projection.reviewStatus || helpers.resultValue(materialFields, ["reviewStatus", "review_status"], "pending")));
      const duration = Number(helpers.resultValue(materialResult, ["durationSeconds", "duration_seconds"], 0));
      if (duration > 0) material.set("duration_seconds", duration);
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
  if (job.getString("status") !== "failed") throw new BadRequestError("only failed jobs can be retried");
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
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("analysis_stage", "queued");
  e.app.save(material);
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});

routerAdd("POST", "/api/lumina/material-analysis/jobs/{id}/reset", (e) => {
  const helpers = require(`${__hooks}/material_analysis_helpers.js`);
  helpers.authorize(e);
  const job = e.app.findRecordById("material_analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") === "succeeded") throw new BadRequestError("succeeded jobs cannot be reset");
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
  const material = e.app.findRecordById("ad_materials", e.request.pathValue("id"));
  const jobs = e.app.findRecordsByFilter("material_analysis_jobs", "material = {:material}", "-id", 1, 0, { material: material.id }).filter(Boolean);
  const job = jobs[0];
  if (!job) throw new BadRequestError("material analysis job not found");
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
  e.app.save(job);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("analysis_stage", "queued");
  e.app.save(material);
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});
