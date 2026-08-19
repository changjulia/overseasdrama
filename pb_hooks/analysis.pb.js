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
    let parameters = {};
    try { parameters = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
    if (stage === "precision" && (!parameters.interval || parameters.interval.start == null || parameters.interval.end == null)) {
      const parts = job.getString("idempotency_key").split(":");
      if (parts.length >= 5) parameters = { ...parameters, interval: { start: Number(parts[2]), end: Number(parts[3]) } };
    }
    claimed = { id: job.id, stage, drama: job.getString("drama"), episode: episode ? episode.id : "", episode_number: episode ? episode.getInt("episode_number") : 0, video: episode ? episode.getString("video") : "", collection_id: episode ? episode.collection().id : "", lease_token: token, lease_until: job.getString("lease_until"), attempt: job.getInt("attempt"), analysis_version: "highlight-attraction-v3", parameters };
    if (stage === "detail") {
      const freeEpisodes = Math.max(0, drama.getInt("free_episodes"));
      claimed.episode_assets = tx.findRecordsByFilter("drama_episodes", "drama = {:drama} && episode_number <= {:free} && video != ''", "episode_number", 10000, 0, { drama: job.getString("drama"), free: freeEpisodes }).filter(Boolean).map((item) => ({ id: item.id, episode_number: item.getInt("episode_number"), video: item.getString("video"), collection_id: item.collection().id }));
      claimed.coarse_results = tx.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'coarse' && status = 'succeeded'", "created", 10000, 0, { drama: job.getString("drama") }).filter(Boolean).filter((item) => {
        const episodeId = item.getString("episode");
        if (!episodeId) return false;
        try { return tx.findRecordById("drama_episodes", episodeId).getInt("episode_number") <= freeEpisodes; } catch (_) { return false; }
      }).map((item) => item.get("result"));
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
    // Ownership is defined by the rotating lease token. A long local ASR/OCR
    // call may miss a heartbeat; allow the same token to renew until another
    // worker actually reclaims the job and rotates that token.
    const progress = nextStatus === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress"))));
    job.set("status", nextStatus);
    job.set("progress", progress);
    job.set("error", nextStatus === "failed" ? String(body.error || "analysis failed").slice(0, 4000) : "");
    if (body.result != null) job.set("result", body.result);
    if (body.logs != null) {
      let existingLogs = {};
      let incomingLogs = {};
      try { existingLogs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
      try { incomingLogs = JSON.parse(JSON.stringify(body.logs || {})); } catch (_) {}
      if (!existingLogs || typeof existingLogs !== "object" || Array.isArray(existingLogs)) existingLogs = {};
      if (!incomingLogs || typeof incomingLogs !== "object" || Array.isArray(incomingLogs)) incomingLogs = {};
      job.set("logs", Object.assign(existingLogs, incomingLogs));
    }
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
  if (completedStage === "precision") {
    const completedJob = e.app.findRecordById("analysis_jobs", jobId);
    helpers.syncPrecisionHookAssets(e.app, completedJob, completedResult);
  }
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
  if (job.getString("stage") === "precision") {
    let logs = {};
    try { logs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
    if (!logs.interval || logs.interval.start == null || logs.interval.end == null) {
      const parts = job.getString("idempotency_key").split(":");
      if (parts.length >= 5) job.set("logs", Object.assign(logs, { interval: { start: Number(parts[2]), end: Number(parts[3]) } }));
    }
  }
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

routerAdd("POST", "/api/lumina/analysis/jobs/{id}/pause", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const job = e.app.findRecordById("analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") === "succeeded") throw new BadRequestError("completed jobs cannot be paused");
  job.set("status", "paused");
  job.set("worker_id", "");
  job.set("lease_token", "");
  job.set("lease_until", "");
  e.app.save(job);
  helpers.refreshStage(e.app, job.getString("drama"), job.getString("stage"));
  return e.json(200, { id: job.id, status: "paused" });
});

routerAdd("POST", "/api/lumina/analysis/jobs/{id}/resume", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const job = e.app.findRecordById("analysis_jobs", e.request.pathValue("id"));
  if (job.getString("status") !== "paused") throw new BadRequestError("only paused jobs can be resumed");
  job.set("status", "queued");
  job.set("error", "");
  e.app.save(job);
  helpers.refreshStage(e.app, job.getString("drama"), job.getString("stage"));
  return e.json(200, { id: job.id, status: "queued" });
});

routerAdd("DELETE", "/api/lumina/analysis/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const job = e.app.findRecordById("analysis_jobs", e.request.pathValue("id"));
  const dramaId = job.getString("drama");
  const stage = job.getString("stage");
  const episodeId = job.getString("episode");
  e.app.delete(job);
  if (episodeId && stage === "coarse") {
    const episode = e.app.findRecordById("drama_episodes", episodeId);
    episode.set("analysis_status", "idle"); episode.set("analysis_progress", 0); episode.set("analysis_worker", ""); episode.set("analysis_error", "");
    e.app.save(episode);
  }
  helpers.refreshStage(e.app, dramaId, stage);
  return e.noContent(204);
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
  if (job.getString("stage") === "precision") {
    let logs = {};
    try { logs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
    if (!logs.interval || logs.interval.start == null || logs.interval.end == null) {
      const parts = job.getString("idempotency_key").split(":");
      if (parts.length >= 5) job.set("logs", Object.assign(logs, { interval: { start: Number(parts[2]), end: Number(parts[3]) } }));
    }
  }
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
    job.set("logs", {});
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

routerAdd("POST", "/api/lumina/analysis/dramas/{id}/retry-detail", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const dramaId = e.request.pathValue("id");
  const drama = e.app.findRecordById("dramas", dramaId);
  const detailJobs = e.app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'detail'", "-id", 1, 0, { drama: dramaId }).filter(Boolean);
  let job = detailJobs[0];
  if (job && ["queued", "running"].includes(job.getString("status"))) {
    return e.json(200, { id: job.id, drama: dramaId, status: job.getString("status") });
  }
  const precisionJobs = e.app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'precision'", "id", 10000, 0, { drama: dramaId }).filter(Boolean);
  for (const precision of precisionJobs) e.app.delete(precision);
  if (!job) {
    job = helpers.ensureDramaStageJob(e.app, dramaId, "detail");
  } else {
    job.set("status", "queued");
    job.set("progress", 0);
    job.set("attempt", 0);
    job.set("worker_id", "");
    job.set("lease_token", "");
    job.set("lease_until", "");
    job.set("error", "");
    job.set("result", null);
    job.set("logs", {});
    e.app.save(job);
  }
  drama.set("analysis", null);
  drama.set("detail_status", "queued");
  drama.set("detail_progress", 0);
  drama.set("precision_status", "idle");
  drama.set("precision_progress", 0);
  drama.set("parse_state", "detail_queued");
  drama.set("analysis_error", "");
  e.app.save(drama);
  return e.json(200, { id: job.id, drama: dramaId, status: "queued", removed_precision: precisionJobs.length, output_language: "zh-CN" });
});

routerAdd("POST", "/api/lumina/analysis/dramas/{id}/retry-precision", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const dramaId = e.request.pathValue("id");
  const drama = e.app.findRecordById("dramas", dramaId);
  const jobs = e.app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'precision'", "created", 10000, 0, { drama: dramaId }).filter(Boolean);
  const generation = `highlight-v3:${dramaId}:${new Date().getTime()}`;
  for (const job of jobs) {
    let logs = {};
    try { logs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
    logs.generation = generation;
    job.set("logs", logs); job.set("status", "queued"); job.set("progress", 0); job.set("attempt", 0);
    job.set("worker_id", ""); job.set("lease_token", ""); job.set("lease_until", ""); job.set("error", ""); job.set("result", null);
    e.app.save(job);
  }
  drama.set("precision_status", jobs.length ? "queued" : "succeeded");
  drama.set("precision_progress", jobs.length ? 0 : 100); drama.set("parse_state", jobs.length ? "precision_queued" : "succeeded");
  e.app.save(drama);
  return e.json(200, { drama: dramaId, status: jobs.length ? "queued" : "succeeded", jobs: jobs.length, generation });
});

routerAdd("POST", "/api/lumina/analysis/dramas/{id}/reproject-precision-assets", (e) => {
  const helpers = require(`${__hooks}/analysis_helpers.js`);
  helpers.authorizeLocalUi(e);
  const dramaId = e.request.pathValue("id");
  const jobs = e.app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'precision' && status = 'succeeded'", "created", 10000, 0, { drama: dramaId }).filter(Boolean);
  const generation = `highlight-v3:${dramaId}:${new Date().getTime()}`;
  let assets = 0;
  const staleAssets = e.app.findRecordsByFilter("hook_assets", "drama = {:drama} && source_class = 'episode_highlight'", "id", 10000, 0, { drama: dramaId }).filter(Boolean);
  for (const asset of staleAssets) e.app.delete(asset);
  for (const job of jobs) {
    let logs = {};
    try { logs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
    logs.generation = generation; job.set("logs", logs); e.app.save(job);
    let result = {};
    try { result = JSON.parse(job.getString("result") || "{}"); } catch (_) {
      try { result = JSON.parse(JSON.stringify(job.get("result") || {})); } catch (_) {}
    }
    result.asset_generation = generation;
    assets += helpers.syncPrecisionHookAssets(e.app, job, result).length;
  }
  return e.json(200, { drama: dramaId, jobs: jobs.length, assets, retired: staleAssets.length, generation });
});
