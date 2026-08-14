function authorize(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
}

function authorizeLocalUi(e) {
  const origin = String(e.requestInfo().headers.origin || "");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):3001$/i.test(origin)) {
    throw new ForbiddenError("Drama retry is only available to the local Lumina UI");
  }
}

function createCoarseJob(app, episode) {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const key = `coarse:${episode.id}:v1`;
  try { return app.findFirstRecordByFilter(jobs, "idempotency_key = {:key}", { key }); } catch (_) {}
  const job = new Record(jobs);
  job.set("drama", episode.getString("drama"));
  job.set("episode", episode.id);
  job.set("stage", "coarse");
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("max_attempts", 3);
  job.set("idempotency_key", key);
  app.save(job);
  return job;
}

function refreshDrama(app, dramaId) {
  const drama = app.findRecordById("dramas", dramaId);
  const jobs = app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = 'coarse'", "id", 10000, 0, { drama: dramaId }).filter(Boolean);
  if (!jobs.length) return;
  const total = jobs.length;
  const succeeded = jobs.filter((job) => job.getString("status") === "succeeded").length;
  const running = jobs.some((job) => job.getString("status") === "running");
  const failed = jobs.filter((job) => job.getString("status") === "failed").length;
  const progress = Math.round(jobs.reduce((sum, job) => sum + job.getInt("progress"), 0) / total);
  const status = succeeded === total ? "succeeded" : running ? "running" : failed === total ? "failed" : "queued";
  drama.set("coarse_status", status);
  drama.set("coarse_progress", progress);
  drama.set("parse_state", status === "succeeded" ? "coarse_succeeded" : status === "failed" ? "coarse_failed" : status === "running" ? "coarse_running" : "queued");
  drama.set("analysis_error", status === "failed" ? "粗解析失败，请查看任务错误" : "");
  app.save(drama);
  if (succeeded === total) ensureDramaStageJob(app, dramaId, "detail");
}

function ensureDramaStageJob(app, dramaId, stage) {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const key = `${stage}:${dramaId}:v1`;
  try { return app.findFirstRecordByFilter(jobs, "idempotency_key = {:key}", { key }); } catch (_) {}
  const job = new Record(jobs);
  job.set("drama", dramaId);
  job.set("stage", stage);
  job.set("status", "queued");
  job.set("progress", 0);
  job.set("attempt", 0);
  job.set("max_attempts", 3);
  job.set("idempotency_key", key);
  app.save(job);
  const drama = app.findRecordById("dramas", dramaId);
  drama.set(`${stage}_status`, "queued");
  drama.set(`${stage}_progress`, 0);
  app.save(drama);
  return job;
}

function ensurePrecisionJobs(app, dramaId, envelope) {
  const payload = envelope && envelope.result ? envelope.result : {};
  const candidates = Array.isArray(payload.highlightCandidates) ? payload.highlightCandidates : Array.isArray(payload.highlights) ? payload.highlights : [];
  let created = 0;
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index] || {};
    const episodeNumber = Number(item.episode || item.episodeNumber);
    const range = item.timecode || item.interval || item;
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || !(start >= 0 && end > start)) continue;
    let episode;
    try { episode = app.findFirstRecordByFilter("drama_episodes", "drama = {:drama} && episode_number = {:episode}", { drama: dramaId, episode: episodeNumber }); } catch (_) { continue; }
    const key = `precision:${episode.id}:${start.toFixed(3)}:${end.toFixed(3)}:v1`;
    try { app.findFirstRecordByFilter("analysis_jobs", "idempotency_key = {:key}", { key }); continue; } catch (_) {}
    const job = new Record(app.findCollectionByNameOrId("analysis_jobs"));
    job.set("drama", dramaId); job.set("episode", episode.id); job.set("stage", "precision"); job.set("status", "queued");
    job.set("progress", 0); job.set("attempt", 0); job.set("max_attempts", 3); job.set("idempotency_key", key);
    job.set("logs", { interval: { start, end }, candidate_index: index });
    app.save(job); created++;
  }
  const drama = app.findRecordById("dramas", dramaId);
  drama.set("precision_status", created ? "queued" : "succeeded");
  drama.set("precision_progress", created ? 0 : 100);
  drama.set("parse_state", created ? "precision_queued" : "succeeded");
  app.save(drama);
  return created;
}

function refreshStage(app, dramaId, stage) {
  if (stage === "coarse") return refreshDrama(app, dramaId);
  const jobs = app.findRecordsByFilter("analysis_jobs", "drama = {:drama} && stage = {:stage}", "created", 10000, 0, { drama: dramaId, stage }).filter(Boolean);
  if (!jobs.length) return;
  const progress = Math.round(jobs.reduce((sum, job) => sum + job.getInt("progress"), 0) / jobs.length);
  const status = jobs.every((job) => job.getString("status") === "succeeded") ? "succeeded" : jobs.some((job) => job.getString("status") === "running") ? "running" : jobs.every((job) => job.getString("status") === "failed") ? "failed" : "queued";
  const drama = app.findRecordById("dramas", dramaId);
  drama.set(`${stage}_status`, status); drama.set(`${stage}_progress`, progress);
  drama.set("parse_state", status === "succeeded" && stage === "precision" ? "succeeded" : `${stage}_${status}`);
  drama.set("analysis_error", status === "failed" ? `${stage === "detail" ? "细解析" : "精解析"}失败，请查看任务错误` : "");
  app.save(drama);
}

module.exports = { authorize, authorizeLocalUi, createCoarseJob, refreshDrama, refreshStage, ensureDramaStageJob, ensurePrecisionJobs };
