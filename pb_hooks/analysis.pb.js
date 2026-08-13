/// <reference path="../pb_data/types.d.ts" />

onRecordAfterCreateSuccess((e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  if (e.record.getString("video")) helpers.createCoarseJob(e.app, e.record);
  e.next();
}, "drama_episodes");

routerAdd("POST", "/api/lumina/analysis/claim", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorize(e);
  const body = e.requestInfo().body;
  const workerId = String(body.worker_id || "").trim();
  const requestedJobId = String(body.job_id || "").trim();
  const leaseSeconds = Math.max(30, Math.min(1800, Number(body.lease_seconds || 300)));
  if (!workerId) throw new BadRequestError("worker_id is required");
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const candidates = tx.findRecordsByFilter("analysis_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "created", 200, 0).filter(Boolean);
    const stageOrder = { coarse: 0, detail: 1, precision: 2 };
    candidates.sort((a, b) => (stageOrder[a.getString("stage")] ?? 9) - (stageOrder[b.getString("stage")] ?? 9));
    const now = Date.now();
    const job = candidates.find((item) => {
      if (requestedJobId && item.id !== requestedJobId) return false;
      const stage = item.getString("stage");
      const dramaId = item.getString("drama");
      if (stage === "detail") {
        const dependencies = tx.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'coarse'", "created", 10000, 0, { drama: dramaId }).filter(Boolean);
        if (!dependencies.length || dependencies.some((dependency) => dependency.getString("status") !== "succeeded")) return false;
      }
      if (stage === "precision") {
        const dependencies = tx.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'detail'", "created", 10000, 0, { drama: dramaId }).filter(Boolean);
        if (!dependencies.some((dependency) => dependency.getString("status") === "succeeded")) return false;
      }
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
    tx.save(job);
    const stage = job.getString("stage");
    const episodeId = job.getString("episode");
    let episode = null;
    if (episodeId) {
      episode = tx.findRecordById("drama_episodes", episodeId);
    }
    if (episode && stage === "coarse") {
      episode.set("analysis_status", "running");
      episode.set("analysis_progress", job.getInt("progress"));
      episode.set("analysis_attempt", job.getInt("attempt"));
      episode.set("analysis_worker", workerId);
      episode.set("analysis_error", "");
      tx.save(episode);
    }
    const drama = tx.findRecordById("dramas", job.getString("drama"));
    drama.set(`${stage}_status`, "running");
    drama.set(`${stage}_progress`, job.getInt("progress"));
    tx.save(drama);
    claimed = { id: job.id, stage, drama: job.getString("drama"), episode: episode ? episode.id : "", episode_number: episode ? episode.getInt("episode_number") : 0, video: episode ? episode.getString("video") : "", collection_id: episode ? episode.collection().id : "", lease_token: token, lease_until: job.getString("lease_until"), attempt: job.getInt("attempt"), analysis_version: "evidence-first-v1", parameters: job.get("logs") || {} };
    if (stage === "detail") {
      claimed.coarse_results = tx.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'coarse' && status = 'succeeded'", "created", 10000, 0, { drama: job.getString("drama") }).filter(Boolean).map((item) => item.get("result"));
    } else if (stage === "precision" && episode) {
      try { claimed.coarse_result = tx.findFirstRecordByFilter("analysis_jobs", "episode = {:episode} && stage = 'coarse' && status = 'succeeded'", { episode: episode.id }).get("result"); } catch (_) {}
    }
  });
  if (!claimed) return e.noContent(204);
  helpers.refreshStage(e.app, claimed.drama, claimed.stage);
  return e.json(200, { job: claimed });
});

routerAdd("PATCH", "/api/lumina/analysis/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorize(e);
  const body = e.requestInfo().body;
  const workerId = String(body.worker_id || "");
  const leaseToken = String(body.lease_token || "");
  const nextStatus = String(body.status || "running");
  if (!["running", "succeeded", "failed"].includes(nextStatus)) throw new BadRequestError("invalid status");
  const jobId = e.request.pathValue("id");
  let dramaId = "";
  let completedStage = "";
  let completedResult = null;
  let currentStage = "";
  e.app.runInTransaction((tx) => {
    const job = tx.findRecordById("analysis_jobs", jobId);
    if (job.getString("status") === nextStatus && nextStatus !== "running") return;
    if (job.getString("worker_id") !== workerId || job.getString("lease_token") !== leaseToken) throw new ForbiddenError("lease ownership mismatch");
    if (job.getString("status") !== "running") {
      throw new BadRequestError("job is not running");
    }
    const leaseUntil = Date.parse(job.getString("lease_until"));
    if (!leaseUntil || leaseUntil <= Date.now()) throw new ForbiddenError("lease expired");
    const progress = nextStatus === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress"))));
    job.set("status", nextStatus);
    job.set("progress", progress);
    job.set("error", nextStatus === "failed" ? String(body.error || "analysis failed").slice(0, 4000) : "");
    if (body.result != null) job.set("result", body.result);
    if (body.logs != null) job.set("logs", body.logs);
    if (nextStatus === "running") job.set("lease_until", new Date(Date.now() + Math.max(30, Math.min(1800, Number(body.lease_seconds || 300))) * 1000).toISOString());
    else { job.set("lease_until", ""); job.set("lease_token", ""); }
    tx.save(job);
    const stage = job.getString("stage");
    const episodeId = job.getString("episode");
    if (episodeId && stage === "coarse") {
      const episode = tx.findRecordById("drama_episodes", episodeId);
      episode.set("analysis_status", nextStatus);
      episode.set("analysis_progress", progress);
      episode.set("analysis_attempt", job.getInt("attempt"));
      episode.set("analysis_worker", workerId);
      episode.set("analysis_error", job.getString("error"));
      if (nextStatus === "succeeded" && body.result) {
        episode.set("analysis_result", body.result);
        const duration = Number((body.result.source || {}).durationSeconds || (body.result.result || {}).durationSeconds || body.result.durationSeconds || 0);
        if (duration > 0) episode.set("duration_seconds", duration);
      }
      tx.save(episode);
    }
    dramaId = job.getString("drama");
    currentStage = stage;
    const drama = tx.findRecordById("dramas", dramaId);
    drama.set(`${stage}_status`, nextStatus);
    drama.set(`${stage}_progress`, progress);
    if (nextStatus === "failed") drama.set("analysis_error", job.getString("error"));
    else if (nextStatus === "succeeded") drama.set("analysis_error", "");
    if (stage === "detail" && nextStatus === "succeeded" && body.result) drama.set("analysis", body.result);
    tx.save(drama);
    completedStage = nextStatus === "succeeded" ? stage : "";
    completedResult = body.result || null;
  });
  if (dramaId) helpers.refreshStage(e.app, dramaId, currentStage);
  if (completedStage === "detail") helpers.ensurePrecisionJobs(e.app, dramaId, completedResult);
  return e.json(200, { id: jobId, status: nextStatus });
});

routerAdd("POST", "/api/lumina/analysis/jobs/{id}/retry", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorize(e);
  const job = e.app.findRecordById("analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") !== "failed") throw new BadRequestError("only failed jobs can be retried");
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  job.set("error", "");
  job.set("result", null);
  // A manual retry starts a fresh attempt budget after an operator has fixed
  // the underlying failure (for example a local model/runtime mismatch).
  job.set("attempt", 0);
  e.app.save(job);
  const episodeId = job.getString("episode");
  if (episodeId && job.getString("stage") === "coarse") {
    const episode = e.app.findRecordById("drama_episodes", episodeId);
    episode.set("analysis_status", "queued"); episode.set("analysis_progress", 0); episode.set("analysis_worker", ""); episode.set("analysis_error", "");
    e.app.save(episode);
  }
  helpers.refreshStage(e.app, job.getString("drama"), job.getString("stage"));
  return e.json(200, { id: job.id, status: "queued", attempt: job.getInt("attempt") });
});

routerAdd("POST", "/api/lumina/analysis/jobs/{id}/reset", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorize(e);
  const job = e.app.findRecordById("analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") === "succeeded") throw new BadRequestError("succeeded jobs cannot be reset");
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  job.set("error", "");
  job.set("result", null);
  e.app.save(job);
  helpers.refreshStage(e.app, job.getString("drama"), job.getString("stage"));
  return e.json(200, { id: job.id, status: "queued", attempt: 0 });
});

routerAdd("POST", "/api/lumina/analysis/dramas/{id}/reanalyze", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorize(e);
  const dramaId = e.request.pathValue("id");
  const drama = e.app.findRecordById("dramas", dramaId);
  const jobs = e.app.findRecordsByFilter("analysis_jobs", "drama = {:drama}", "created", 10000, 0, { drama: dramaId }).filter(Boolean);
  let reset = 0;
  let removedPrecision = 0;
  for (const job of jobs) {
    if (job.getString("stage") === "precision") {
      e.app.delete(job);
      removedPrecision++;
      continue;
    }
    job.set("status", "queued");
    job.set("progress", 0);
    job.set("attempt", 0);
    job.set("worker_id", "");
    job.set("lease_token", "");
    job.set("lease_until", "");
    job.set("error", "");
    job.set("result", null);
    e.app.save(job);
    reset++;
  }
  const episodes = e.app.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: dramaId }).filter(Boolean);
  for (const episode of episodes) {
    episode.set("analysis_status", "queued");
    episode.set("analysis_progress", 0);
    episode.set("analysis_worker", "");
    episode.set("analysis_error", "");
    episode.set("analysis_result", null);
    e.app.save(episode);
  }
  drama.set("coarse_status", "queued");
  drama.set("coarse_progress", 0);
  drama.set("detail_status", "queued");
  drama.set("detail_progress", 0);
  drama.set("precision_status", "idle");
  drama.set("precision_progress", 0);
  drama.set("parse_state", "queued");
  drama.set("analysis_error", "");
  drama.set("analysis", null);
  e.app.save(drama);
  return e.json(200, { drama: dramaId, status: "queued", reset, removed_precision: removedPrecision, output_language: "zh-CN" });
});
