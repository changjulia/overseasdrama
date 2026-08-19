function authorize(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
}

function authorizeLocalUi(e) {
  const origin = String(e.requestInfo().headers.origin || "");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):300[01]$/i.test(origin)) {
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
  const drama = app.findRecordById("dramas", dramaId);
  const freeEpisodes = Math.max(0, drama.getInt("free_episodes"));
  const payload = envelope && envelope.result ? envelope.result : {};
  const candidates = Array.isArray(payload.highlightCandidates) ? payload.highlightCandidates : Array.isArray(payload.highlights) ? payload.highlights : [];
  let created = 0;
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index] || {};
    // High confidence only means the model can identify the event. Precision
    // work is reserved for candidates that also pass the V2 attraction and
    // production-usability gate. Legacy candidates remain visible for review
    // but no longer consume precision jobs automatically.
    if (item.precisionEligible === false || item.precision_eligible === false) continue;
    const episodeNumber = Number(item.episode || item.episodeNumber);
    const range = item.timecode || item.interval || item;
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > freeEpisodes || !(start >= 0 && end > start)) continue;
    let episode;
    try { episode = app.findFirstRecordByFilter("drama_episodes", "drama = {:drama} && episode_number = {:episode}", { drama: dramaId, episode: episodeNumber }); } catch (_) { continue; }
    // Version precision work independently from the interval.  A detail V2
    // rerun must not be suppressed by a V1 job for the same time range.
    const generation = String((envelope && (envelope.analysis_id || envelope.analysisId)) || `highlight-v3:${dramaId}`);
    const key = `precision:${episode.id}:${start.toFixed(3)}:${end.toFixed(3)}:highlight-v3`;
    try { app.findFirstRecordByFilter("analysis_jobs", "idempotency_key = {:key}", { key }); continue; } catch (_) {}
    const job = new Record(app.findCollectionByNameOrId("analysis_jobs"));
    job.set("drama", dramaId); job.set("episode", episode.id); job.set("stage", "precision"); job.set("status", "queued");
    job.set("progress", 0); job.set("attempt", 0); job.set("max_attempts", 3); job.set("idempotency_key", key);
    job.set("logs", { interval: { start, end }, candidate_index: index, generation });
    app.save(job); created++;
  }
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

function syncPrecisionHookAssets(app, job, envelope) {
  const episodeId = job.getString("episode");
  if (!episodeId) return [];
  const episode = app.findRecordById("drama_episodes", episodeId);
  const drama = app.findRecordById("dramas", job.getString("drama"));
  const root = envelope && envelope.result ? envelope.result : (envelope || {});
  const hooks = Array.isArray(root.hookCandidates) ? root.hookCandidates : Array.isArray(root.hooks) ? root.hooks : [];
  const collection = app.findCollectionByNameOrId("hook_assets");
  let logs = {};
  try { logs = JSON.parse(job.getString("logs") || "{}"); } catch (_) {
    try { logs = JSON.parse(JSON.stringify(job.get("logs") || {})); } catch (_) {}
  }
  const generation = String((envelope && envelope.asset_generation) || (root && root.asset_generation) || logs.generation || `highlight-v3:${job.getString("drama")}`);
  // Precision output is a generated projection, not an append-only asset feed.
  // Replace older generations for this episode so stale V1/V2 hooks cannot be
  // mixed with the current analysis in the inspiration screen.
  app.findRecordsByFilter(collection, "episode = {:episode} && source_class = 'episode_highlight'", "id", 500, 0, { episode: episodeId }).filter(Boolean).forEach((record) => {
    if (record.getString("analysis_version") !== generation) app.delete(record);
  });
  const created = [];
  hooks.slice(0, 8).forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const range = item.timecode || item.interval || item;
    const start = Number(range.start), end = Number(range.end);
    if (!(start >= 0 && end > start && end - start >= 10 && end - start <= 60)) return;
    const safeStart = item.safeStart || item.safe_start || {}, safeEnd = item.safeEnd || item.safe_end || {};
    const verified = safeStart.status === "verified" && safeEnd.status === "verified" && safeStart.actionStatus === "complete" && safeEnd.actionStatus === "complete";
    const record = new Record(collection);
    record.set("source_class", "episode_highlight"); record.set("drama", drama.id); record.set("episode", episode.id);
    record.set("title", `剧集高光 - ${drama.getString("title")} - 第${episode.getInt("episode_number")}集 - 钩子${String(index + 1).padStart(2, "0")}`);
    record.set("start_seconds", start); record.set("end_seconds", end); record.set("boundary_status", verified ? "verified" : "unverified");
    record.set("safe_start", safeStart); record.set("safe_end", safeEnd); record.set("hook_type", String(item.hookType || item.hook_type || item.type || "剧情高光"));
    record.set("themes", Array.isArray(item.themes) ? item.themes : []); record.set("content_tags", Array.isArray(item.contentTags) ? item.contentTags : []);
    record.set("character_roles", Array.isArray(item.characterRoles) ? item.characterRoles : []); record.set("relationships", Array.isArray(item.relationships) ? item.relationships : []);
    record.set("conflict", String(item.conflict || "")); record.set("emotion", String(item.emotion || "")); record.set("narrative_promise", String(item.narrativePromise || ""));
    record.set("information_gap", String(item.informationGap || "")); record.set("spoken_summary", String(item.spokenSummary || "")); record.set("visual_summary", String(item.visualSummary || ""));
    record.set("quality_scores", item.qualityScores || {}); record.set("evidence", item.evidence || []); record.set("analysis", item);
    record.set("rights_status", drama.getString("copyright_status")); record.set("review_status", verified ? "pending" : "needs_review"); record.set("analysis_version", generation);
    app.save(record); created.push(record.id);
  });
  return created;
}

module.exports = { authorize, authorizeLocalUi, createCoarseJob, refreshDrama, refreshStage, ensureDramaStageJob, ensurePrecisionJobs, syncPrecisionHookAssets };
