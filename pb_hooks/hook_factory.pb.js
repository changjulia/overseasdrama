/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/lumina/materials/{id}/rights", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const body = e.requestInfo().body || {};
  const rights = String(body.rights_status || "");
  if (!["仅限内部分析", "授权待确认", "已获授权可制作", "已获授权可投放"].includes(rights)) throw new BadRequestError("invalid rights status");
  const material = e.app.findRecordById("ad_materials", e.request.pathValue("id"));
  material.set("rights_status", rights);
  e.app.save(material);
  const hooks = e.app.findRecordsByFilter("hook_assets", "material = {:material}", "id", 500, 0, { material: material.id }).filter(Boolean);
  for (const hook of hooks) { hook.set("rights_status", rights); e.app.save(hook); }
  return e.json(200, { id: material.id, rights_status: rights, updated_hooks: hooks.length });
});

routerAdd("POST", "/api/lumina/hooks/{id}/review", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  try {
  const body = e.requestInfo().body || {}, hook = e.app.findRecordById("hook_assets", e.request.pathValue("id"));
  const decision = String(body.decision || "");
  if (!["approve_boundaries", "reject_boundaries"].includes(decision)) throw new BadRequestError("invalid boundary review decision");
  const note = String(body.note || "").trim();
  if (!note) throw new BadRequestError("boundary review note is required");
  if (decision === "approve_boundaries") {
    const reviewedStart = body.start_seconds == null ? hook.getFloat("start_seconds") : Number(body.start_seconds);
    const reviewedEnd = body.end_seconds == null ? hook.getFloat("end_seconds") : Number(body.end_seconds);
    let sourceDuration = 0;
    if (hook.getString("episode")) sourceDuration = e.app.findRecordById("drama_episodes", hook.getString("episode")).getFloat("duration_seconds");
    else if (hook.getString("material")) sourceDuration = e.app.findRecordById("ad_materials", hook.getString("material")).getFloat("duration_seconds");
    const minimumDuration = hook.getString("source_class") === "external_material" ? 5 : 3;
    if (!Number.isFinite(reviewedStart) || !Number.isFinite(reviewedEnd) || reviewedStart < 0 || reviewedEnd <= reviewedStart || reviewedEnd - reviewedStart < minimumDuration || reviewedEnd - reviewedStart > 60 || (sourceDuration > 0 && reviewedEnd > sourceDuration + 0.05)) {
      throw new BadRequestError(`reviewed boundaries must be inside the source and ${minimumDuration}-60 seconds long`);
    }
    hook.set("start_seconds", Math.round(reviewedStart * 1000) / 1000);
    hook.set("end_seconds", Math.round(Math.min(reviewedEnd, sourceDuration || reviewedEnd) * 1000) / 1000);
    const reviewedAt = new Date().toISOString();
    // PocketBase exposes persisted JSON as raw bytes inside Goja hooks. Do not
    // spread/resave that value or it becomes an array of byte integers. A human
    // approval is authoritative evidence, so rebuild the boundary object.
    const start = { kind: "start", time: hook.getFloat("start_seconds"), status: "verified", dialogueStatus: "complete_human_verified", actionStatus: "complete_human_verified", shotStatus: "complete_human_verified", evidence: [{ source: "human_review", result: note }], reviewNote: note, reviewedAt };
    const end = { kind: "end", time: hook.getFloat("end_seconds"), status: "verified", dialogueStatus: "complete_human_verified", actionStatus: "complete_human_verified", shotStatus: "complete_human_verified", evidence: [{ source: "human_review", result: note }], reviewNote: note, reviewedAt };
    hook.set("safe_start", start); hook.set("safe_end", end); hook.set("boundary_status", "verified"); hook.set("review_status", "approved");
  } else { hook.set("boundary_status", "rejected"); hook.set("review_status", "rejected"); }
  e.app.save(hook);
  return e.json(200, { id: hook.id, boundary_status: hook.getString("boundary_status"), review_status: hook.getString("review_status") });
  } catch (error) {
    return e.json(422, { message: String(error && error.message ? error.message : error) });
  }
});

routerAdd("POST", "/api/lumina/hook-matching/jobs", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeUi(e);
  const body = e.requestInfo().body || {};
  const hook = e.app.findRecordById("hook_assets", String(body.hook_id || ""));
  const drama = e.app.findRecordById("dramas", String(body.drama_id || ""));
  if (hook.getString("source_class") !== "external_material") throw new BadRequestError("external-hook mode only accepts external_material hooks");
  const hookDuration = hook.getFloat("end_seconds") - hook.getFloat("start_seconds");
  if (hookDuration < 5 || hookDuration > 60) throw new BadRequestError("external hook duration must be between 5 and 60 seconds");
  if (hook.getString("boundary_status") !== "verified") throw new BadRequestError("hook boundaries must be verified before matching");
  const freeEpisodes = Math.max(0, drama.getInt("free_episodes"));
  const scopeMode = String(body.scope_mode || "free_only");
  if (!["free_only", "custom"].includes(scopeMode)) throw new BadRequestError("scope_mode must be free_only or custom");
  const rawRequested = Array.isArray(body.episode_scope) ? body.episode_scope : [];
  const requested = rawRequested.map(Number).filter((value) => Number.isInteger(value) && value >= 1 && value <= drama.getInt("total_episodes"));
  if (rawRequested.length !== requested.length) throw new BadRequestError("episode_scope contains an invalid episode number");
  if (scopeMode === "custom" && !requested.length) throw new BadRequestError("custom scope requires an explicit episode_scope");
  const scope = requested.length ? [...new Set(requested)].sort((a, b) => a - b) : Array.from({ length: freeEpisodes }, (_, index) => index + 1);
  if (!scope.length) throw new BadRequestError("episode scope is empty");
  if (scopeMode === "free_only" && scope.some((episode) => episode > freeEpisodes)) throw new BadRequestError("free_only scope cannot include paid episodes");
  const containsPaidEpisodes = scope.some((episode) => episode > freeEpisodes);
  const targetDurationBand = String(body.target_duration_band || "5_15m");
  if (!["5_15m", "15_25m"].includes(targetDurationBand)) throw new BadRequestError("target_duration_band must be 5_15m or 15_25m");
  const topics = [...new Set(Array.isArray(body.topics) ? body.topics.map((value) => String(value).trim()).filter(Boolean) : [])].sort();
  const episodeRecords = e.app.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: drama.id }).filter((episode) => scope.includes(episode.getInt("episode_number")));
  const assetVersions = [];
  for (const episode of episodeRecords) {
    const assets = e.app.findRecordsByFilter("hook_assets", "episode = {:episode} && source_class = 'episode_highlight' && boundary_status = 'verified' && review_status = 'approved'", "id", 500, 0, { episode: episode.id }).filter(Boolean);
    for (const asset of assets) assetVersions.push(`${asset.id}:${asset.getString("analysis_version")}:${asset.getString("updated")}`);
  }
  const matchContext = {
    ontologyVersion: "hook-ontology-v1",
    matcherVersion: "hook-match-v3",
    hookId: hook.id,
    hookAnalysisVersion: hook.getString("analysis_version"),
    hookUpdated: hook.getString("updated"),
    dramaId: drama.id,
    dramaAnalysisVersion: drama.getString("analysis_version"),
    dramaUpdated: drama.getString("updated"),
    scopeMode,
    targetDurationBand,
    episodeScope: scope,
    topics,
    highlightAssetVersions: assetVersions.sort()
  };
  const matchContextHash = helpers.contextHash(matchContext);
  const key = `hook-match:${hook.id}:${drama.id}:${matchContextHash}`;
  let job;
  try { job = e.app.findFirstRecordByFilter("hook_match_jobs", "idempotency_key = {:key}", { key }); } catch (_) {
    job = new Record(e.app.findCollectionByNameOrId("hook_match_jobs"));
    job.set("hook", hook.id); job.set("drama", drama.id); job.set("topics", topics); job.set("episode_scope", scope);
    job.set("scope_mode", scopeMode); job.set("target_duration_band", targetDurationBand); job.set("contains_paid_episodes", containsPaidEpisodes); job.set("match_context_hash", matchContextHash); job.set("match_context", matchContext);
    job.set("status", "queued"); job.set("progress", 0); job.set("current_stage", "queued"); job.set("attempt", 0); job.set("max_attempts", 3); job.set("idempotency_key", key);
    e.app.save(job);
  }
  if (body.force_retry === true && !["queued", "running"].includes(job.getString("status"))) { job.set("status", "queued"); job.set("progress", 0); job.set("current_stage", "queued"); job.set("error", ""); job.set("attempt", 0); e.app.save(job); }
  if (job.getString("status") === "queued") {
    for (const episode of episodeRecords) {
      const highlights = e.app.findRecordsByFilter("hook_assets", "episode = {:episode} && source_class = 'episode_highlight' && boundary_status = 'verified' && review_status = 'approved'", "id", 1, 0, { episode: episode.id }).filter(Boolean);
      if (highlights.length) continue;
      let supplemental = null;
      try { supplemental = e.app.findFirstRecordByFilter("supplemental_highlight_jobs", "match_job = {:job} && episode = {:episode}", { job: job.id, episode: episode.id }); } catch (_) {}
      if (!supplemental) { supplemental = new Record(e.app.findCollectionByNameOrId("supplemental_highlight_jobs")); supplemental.set("match_job", job.id); supplemental.set("episode", episode.id); supplemental.set("max_attempts", 3); supplemental.set("contract_version", "supplemental-highlight-v1"); }
      const supplementalStatus = supplemental.getString("status");
      // A force retry only requeues unfinished/failed work. Successful episode
      // analysis is immutable for this match context and must not be rerun.
      if (!supplementalStatus || (supplementalStatus === "failed" && (body.force_retry === true || supplemental.getInt("attempt") < supplemental.getInt("max_attempts")))) { supplemental.set("status", "queued"); supplemental.set("attempt", 0); supplemental.set("progress", 0); supplemental.set("current_stage", "queued"); supplemental.set("error", ""); supplemental.set("result", {}); supplemental.set("worker_id", ""); supplemental.set("lease_token", ""); supplemental.set("lease_until", ""); e.app.save(supplemental); }
    }
  }
  const supplementalRecords = e.app.findRecordsByFilter("supplemental_highlight_jobs", "match_job = {:job}", "id", 500, 0, { job: job.id }).filter(Boolean);
  const matchRecords = e.app.findRecordsByFilter("hook_story_matches", "source_job = {:job}", "-story_score", 500, 0, { job: job.id }).filter(Boolean);
  const diagnostics = helpers.summarizeHookMatch(
    { status: job.getString("status"), episode_scope: helpers.jsonArray(job, "episode_scope") },
    supplementalRecords.map((item) => ({ status: item.getString("status"), result: helpers.jsonObject(item, "result") })),
    matchRecords.map((item) => ({ id: item.id }))
  );
  job.set("outcome_status", diagnostics.outcome_status); job.set("diagnostics", diagnostics); job.set("outcome_version", "hook-outcome-v1"); e.app.save(job);
  return e.json(200, { id: job.id, status: job.getString("status"), outcome_status: diagnostics.outcome_status, diagnostics, progress: job.getInt("progress"), scope_mode: job.getString("scope_mode") || scopeMode, target_duration_band: job.getString("target_duration_band") || targetDurationBand, episode_scope: helpers.jsonArray(job, "episode_scope"), contains_paid_episodes: job.getBool("contains_paid_episodes"), match_context_hash: job.getString("match_context_hash") || matchContextHash });
});

routerAdd("GET", "/api/lumina/hook-matching/jobs/{id}/status", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeUi(e);
  const job = e.app.findRecordById("hook_match_jobs", e.request.pathValue("id"));
  const supplements = e.app.findRecordsByFilter("supplemental_highlight_jobs", "match_job = {:job}", "id", 500, 0, { job: job.id }).filter(Boolean);
  const matches = e.app.findRecordsByFilter("hook_story_matches", "source_job = {:job}", "-story_score", 500, 0, { job: job.id }).filter(Boolean);
  const diagnostics = helpers.summarizeHookMatch(
    { status: job.getString("status"), episode_scope: helpers.jsonArray(job, "episode_scope") },
    supplements.map((item) => ({ status: item.getString("status"), result: helpers.jsonObject(item, "result") })), matches.map((item) => ({ id: item.id }))
  );
  if (job.getString("outcome_status") !== diagnostics.outcome_status) { job.set("outcome_status", diagnostics.outcome_status); job.set("diagnostics", diagnostics); job.set("outcome_version", "hook-outcome-v1"); e.app.save(job); }
  return e.json(200, { id: job.id, status: job.getString("status"), progress: job.getInt("progress"), current_stage: job.getString("current_stage"), error: job.getString("error"), outcome_status: diagnostics.outcome_status, diagnostics, matches: matches.map((item) => item.publicExport()) });
});

routerAdd("POST", "/api/lumina/hook-matching/claim", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {};
  const workerId = String(body.worker_id || "");
  const leaseSeconds = Math.max(60, Math.min(1800, Number(body.lease_seconds || 600)));
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const now = Date.now();
    const jobs = tx.findRecordsByFilter("hook_match_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "id", 100, 0).filter(Boolean);
    const job = jobs.find((candidate) => {
      const supplemental = tx.findRecordsByFilter("supplemental_highlight_jobs", "match_job = {:job} && (status = 'queued' || status = 'running')", "id", 1, 0, { job: candidate.id }).filter(Boolean);
      if (supplemental.length) return false;
      if (candidate.getString("status") === "queued") return true;
      if (candidate.getString("status") === "failed") return candidate.getInt("attempt") < candidate.getInt("max_attempts");
      const lease = Date.parse(candidate.getString("lease_until"));
      return !lease || lease <= now;
    });
    if (!job) return;
    const token = $security.randomString(32);
    job.set("status", "running"); job.set("attempt", job.getInt("attempt") + 1); job.set("worker_id", workerId); job.set("lease_token", token);
    job.set("lease_until", new Date(now + leaseSeconds * 1000).toISOString()); job.set("progress", Math.max(1, job.getInt("progress"))); job.set("current_stage", "prepare"); job.set("error", "");
    tx.save(job);
    const hook = tx.findRecordById("hook_assets", job.getString("hook"));
    const drama = tx.findRecordById("dramas", job.getString("drama"));
    const scope = helpers.jsonArray(job, "episode_scope").map(Number);
    const episodes = tx.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: drama.id }).filter((episode) => scope.includes(episode.getInt("episode_number")));
    const episodePayloads = episodes.map((episode) => {
      const exported = episode.publicExport();
      const highlights = tx.findRecordsByFilter("hook_assets", "episode = {:episode} && source_class = 'episode_highlight' && boundary_status = 'verified' && review_status = 'approved'", "start_seconds", 500, 0, { episode: episode.id }).filter(Boolean).map((asset) => asset.publicExport());
      return Object.assign(exported, { highlights });
    });
    claimed = { job: { id: job.id, stage: "hook_match", status: "running", attempt: job.getInt("attempt"), lease_token: token }, hook: hook.publicExport(), drama: drama.publicExport(), episodes: episodePayloads, topics: helpers.jsonArray(job, "topics"), episode_scope: scope, scope_mode: job.getString("scope_mode") || "free_only", target_duration_band: job.getString("target_duration_band") || "5_15m", contains_paid_episodes: job.getBool("contains_paid_episodes"), match_context_hash: job.getString("match_context_hash"), match_context: helpers.jsonObject(job, "match_context") };
  });
  if (!claimed) return e.noContent(204);
  return e.json(200, claimed);
});

routerAdd("PATCH", "/api/lumina/hook-matching/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {};
  const nextStatus = String(body.status || "running");
  if (!["running", "succeeded", "failed"].includes(nextStatus)) throw new BadRequestError("invalid status");
  const jobId = e.request.pathValue("id");
  e.app.runInTransaction((tx) => {
    const job = tx.findRecordById("hook_match_jobs", jobId);
    if (job.getString("worker_id") !== String(body.worker_id || "") || job.getString("lease_token") !== String(body.lease_token || "")) throw new ForbiddenError("lease ownership mismatch");
    job.set("status", nextStatus); job.set("progress", nextStatus === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress")))));
    job.set("current_stage", nextStatus === "succeeded" ? "completed" : String(body.current_stage || body.stage_name || job.getString("current_stage") || "matching"));
    job.set("error", nextStatus === "failed" ? String(body.error || "matching failed").slice(0, 4000) : "");
    if (body.result != null) job.set("result", body.result);
    if (body.logs != null) job.set("logs", body.logs);
    if (nextStatus === "running") job.set("lease_until", new Date(Date.now() + Math.max(60, Math.min(1800, Number(body.lease_seconds || 600))) * 1000).toISOString());
    else { job.set("lease_until", ""); job.set("lease_token", ""); }
    tx.save(job);
    if (nextStatus !== "succeeded" || body.result == null) return;
    const envelope = body.result && body.result.result ? body.result.result : body.result;
    const matches = Array.isArray(envelope.matches) ? envelope.matches : [];
    tx.findRecordsByFilter("hook_story_matches", "source_job = {:job}", "id", 500, 0, { job: job.id }).filter(Boolean).forEach((record) => tx.delete(record));
    matches.forEach((item, matchIndex) => {
      if (!item || typeof item !== "object" || !Array.isArray(item.segments) || !item.segments.length) return;
      const allowedScope = helpers.jsonArray(job, "episode_scope").map(Number);
      const resultEpisodes = item.segments.map((segment) => Number(segment && segment.episode));
      if (resultEpisodes.some((episode) => !Number.isInteger(episode) || !allowedScope.includes(episode))) throw new BadRequestError("matching result contains an episode outside the requested scope");
      if ((job.getString("scope_mode") || "free_only") === "free_only" && resultEpisodes.some((episode) => episode > tx.findRecordById("dramas", job.getString("drama")).getInt("free_episodes"))) throw new BadRequestError("matching result contains a paid episode in free_only mode");
      const record = new Record(tx.findCollectionByNameOrId("hook_story_matches"));
      record.set("source_job", job.id);
      record.set("hook", job.getString("hook")); record.set("drama", job.getString("drama")); record.set("topics", item.topics || helpers.jsonArray(job, "topics")); record.set("episode_scope", helpers.jsonArray(job, "episode_scope"));
      record.set("scope_mode", job.getString("scope_mode") || "free_only"); record.set("target_duration_band", job.getString("target_duration_band") || "5_15m"); record.set("contains_paid_episodes", job.getBool("contains_paid_episodes")); record.set("match_context_hash", job.getString("match_context_hash")); record.set("match_context", helpers.jsonObject(job, "match_context"));
      record.set("story_arc", item.storyArc || item.story_arc || {}); record.set("segments", item.segments); record.set("match_score", Math.max(0, Math.min(100, Number(item.matchScore || item.match_score || 0))));
      record.set("story_score", Math.max(0, Math.min(100, Number(item.storyScore || item.story_score || item.matchScore || item.match_score || 0))));
      record.set("promise_fulfillment_score", Math.max(0, Math.min(100, Number(item.promiseFulfillmentScore || item.promise_fulfillment_score || 0))));
      record.set("causal_completeness_score", Math.max(0, Math.min(100, Number(item.causalCompletenessScore || item.causal_completeness_score || 0))));
      const entryPoints = item.entryPoints || item.entry_points || [];
      const entryScore = Number(item.entryScore || item.entry_score || (Array.isArray(entryPoints) ? entryPoints.reduce((best, entry) => Math.max(best, Number(entry && (entry.entryScore || entry.entry_score || entry.score) || 0)), 0) : 0));
      record.set("entry_score", Math.max(0, Math.min(100, entryScore))); record.set("business_gate", item.businessGate || item.business_gate || {}); record.set("tag_match_evidence", item.tagMatchEvidence || item.tag_match_evidence || item.tagMatches || item.tag_matches || []);
      record.set("dimension_scores", item.dimensionScores || item.dimension_scores || {}); record.set("evidence", item.evidence || []); record.set("risks", item.risks || []);
      record.set("story_graph", item.storyGraph || item.story_graph || {}); record.set("entry_points", entryPoints); record.set("completeness", item.completeness || {});
      record.set("calibration", item.calibration || {}); record.set("production_gate", item.productionGate || item.production_gate || {});
      record.set("status", item.reviewRequired ? "needs_review" : "candidate"); record.set("analysis_version", String(envelope.schemaVersion || "hook-match-v1")); record.set("contract_version", "hook-match-contract-v2"); record.set("legacy_mapping", { matchScore: item.matchScore || item.match_score || 0, schemaVersion: envelope.schemaVersion || "hook-match-v1" }); tx.save(record);
      if (matchIndex < 3) { const entryJob = new Record(tx.findCollectionByNameOrId("entry_precision_jobs")); entryJob.set("match", record.id); entryJob.set("status", "queued"); entryJob.set("attempt", 0); entryJob.set("max_attempts", 3); entryJob.set("progress", 0); entryJob.set("current_stage", "queued"); entryJob.set("contract_version", "entry-precision-v1"); tx.save(entryJob); }
    });
    const supplements = tx.findRecordsByFilter("supplemental_highlight_jobs", "match_job = {:job}", "id", 500, 0, { job: job.id }).filter(Boolean);
    const diagnostics = helpers.summarizeHookMatch(
      { status: nextStatus, episode_scope: helpers.jsonArray(job, "episode_scope") },
      supplements.map((item) => ({ status: item.getString("status"), result: helpers.jsonObject(item, "result") })),
      matches
    );
    job.set("outcome_status", diagnostics.outcome_status); job.set("diagnostics", diagnostics); job.set("outcome_version", "hook-outcome-v1"); tx.save(job);
  });
  return e.json(200, { id: jobId, status: nextStatus });
});

routerAdd("POST", "/api/lumina/entry-precision/jobs", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const body = e.requestInfo().body || {}, match = e.app.findRecordById("hook_story_matches", String(body.match_id || ""));
  let job; try { job = e.app.findFirstRecordByFilter("entry_precision_jobs", "match = {:match}", { match: match.id }); } catch (_) { job = new Record(e.app.findCollectionByNameOrId("entry_precision_jobs")); job.set("match", match.id); job.set("attempt", 0); job.set("max_attempts", 3); job.set("contract_version", "entry-precision-v1"); }
  job.set("status", "queued"); job.set("progress", 0); job.set("current_stage", "queued"); job.set("error", ""); job.set("result", {}); job.set("worker_id", ""); job.set("lease_token", ""); job.set("lease_until", ""); e.app.save(job);
  return e.json(200, { id: job.id, status: "queued", match: match.id });
});

routerAdd("POST", "/api/lumina/entry-precision/claim", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {}, workerId = String(body.worker_id || ""), leaseSeconds = Math.max(60, Math.min(1800, Number(body.lease_seconds || 600)));
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const now = Date.now(), jobs = tx.findRecordsByFilter("entry_precision_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "id", 100, 0).filter(Boolean);
    const job = jobs.find((candidate) => candidate.getString("status") === "queued" || (candidate.getString("status") === "failed" && candidate.getInt("attempt") < candidate.getInt("max_attempts")) || (candidate.getString("status") === "running" && (!Date.parse(candidate.getString("lease_until")) || Date.parse(candidate.getString("lease_until")) <= now)));
    if (!job) return;
    const token = $security.randomString(32); job.set("status", "running"); job.set("attempt", job.getInt("attempt") + 1); job.set("worker_id", workerId); job.set("lease_token", token); job.set("lease_until", new Date(now + leaseSeconds * 1000).toISOString()); job.set("progress", Math.max(1, job.getInt("progress"))); job.set("current_stage", "prepare"); job.set("error", ""); tx.save(job);
    const match = tx.findRecordById("hook_story_matches", job.getString("match")), hook = tx.findRecordById("hook_assets", match.getString("hook")), drama = tx.findRecordById("dramas", match.getString("drama"));
    const episodeNumbers = [...new Set(helpers.jsonArray(match, "segments").map((segment) => Number(segment && segment.episode)).filter(Number.isInteger))];
    const episodes = tx.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: drama.id }).filter((episode) => episodeNumbers.includes(episode.getInt("episode_number"))).map((episode) => episode.publicExport());
    claimed = { job: { id: job.id, stage: "entry_precision", lease_token: token, attempt: job.getInt("attempt"), contract_version: job.getString("contract_version") || "entry-precision-v1" }, match: match.publicExport(), hook: hook.publicExport(), drama: drama.publicExport(), episodes, max_entry_points: 3 };
  });
  if (!claimed) return e.noContent(204); return e.json(200, claimed);
});

routerAdd("PATCH", "/api/lumina/entry-precision/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {}, status = String(body.status || "running"), id = e.request.pathValue("id");
  if (!["running", "succeeded", "failed"].includes(status)) throw new BadRequestError("invalid status");
  e.app.runInTransaction((tx) => {
    const job = tx.findRecordById("entry_precision_jobs", id);
    if (job.getString("worker_id") !== String(body.worker_id || "") || job.getString("lease_token") !== String(body.lease_token || "")) throw new ForbiddenError("lease ownership mismatch");
    const envelope = body.result && body.result.result ? body.result.result : body.result || {}, candidates = Array.isArray(envelope.candidates) ? envelope.candidates.slice(0, 3) : Array.isArray(envelope.entryPoints) ? envelope.entryPoints.slice(0, 3) : Array.isArray(envelope.entry_points) ? envelope.entry_points.slice(0, 3) : [];
    job.set("status", status); job.set("progress", status === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress"))))); job.set("current_stage", status === "succeeded" ? "completed" : String(body.current_stage || "entry_precision")); job.set("error", status === "failed" ? String(body.error || "entry precision failed").slice(0, 4000) : ""); if (body.result != null) job.set("result", Object.assign({}, envelope, { candidates }));
    if (status === "running") job.set("lease_until", new Date(Date.now() + Math.max(60, Math.min(1800, Number(body.lease_seconds || 600))) * 1000).toISOString()); else { job.set("lease_until", ""); job.set("lease_token", ""); } tx.save(job);
    if (status === "succeeded") { const match = tx.findRecordById("hook_story_matches", job.getString("match")); match.set("entry_points", candidates); match.set("entry_score", candidates.reduce((best, item) => Math.max(best, Number(item && (item.entryScore || item.entry_score || item.score) || 0)), 0)); tx.save(match); }
  });
  return e.json(200, { id, status });
});

routerAdd("POST", "/api/lumina/supplemental-highlights/claim", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {}, workerId = String(body.worker_id || ""), leaseSeconds = Math.max(60, Math.min(1800, Number(body.lease_seconds || 600)));
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const now = Date.now(), jobs = tx.findRecordsByFilter("supplemental_highlight_jobs", "status = 'queued' || status = 'running' || status = 'failed'", "id", 100, 0).filter(Boolean);
    const job = jobs.find((candidate) => candidate.getString("status") === "queued" || (candidate.getString("status") === "failed" && candidate.getInt("attempt") < candidate.getInt("max_attempts")) || (candidate.getString("status") === "running" && (!Date.parse(candidate.getString("lease_until")) || Date.parse(candidate.getString("lease_until")) <= now)));
    if (!job) return; const token = $security.randomString(32); job.set("status", "running"); job.set("attempt", job.getInt("attempt") + 1); job.set("worker_id", workerId); job.set("lease_token", token); job.set("lease_until", new Date(now + leaseSeconds * 1000).toISOString()); job.set("progress", Math.max(1, job.getInt("progress"))); job.set("current_stage", "prepare"); job.set("error", ""); tx.save(job);
    const matchJob = tx.findRecordById("hook_match_jobs", job.getString("match_job")), episode = tx.findRecordById("drama_episodes", job.getString("episode")), drama = tx.findRecordById("dramas", matchJob.getString("drama"));
    claimed = { job: { id: job.id, stage: "supplemental_highlight", lease_token: token, attempt: job.getInt("attempt"), contract_version: job.getString("contract_version") || "supplemental-highlight-v1" }, episode: episode.publicExport(), drama: drama.publicExport(), match_context_hash: matchJob.getString("match_context_hash") };
  });
  if (!claimed) return e.noContent(204); return e.json(200, claimed);
});

routerAdd("PATCH", "/api/lumina/supplemental-highlights/jobs/{id}", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeWorker(e); const body = e.requestInfo().body || {}, status = String(body.status || "running"), id = e.request.pathValue("id");
  if (!["running", "succeeded", "failed"].includes(status)) throw new BadRequestError("invalid status");
  e.app.runInTransaction((tx) => {
    const job = tx.findRecordById("supplemental_highlight_jobs", id);
    if (job.getString("worker_id") !== String(body.worker_id || "") || job.getString("lease_token") !== String(body.lease_token || "")) throw new ForbiddenError("lease ownership mismatch");
    job.set("status", status); job.set("progress", status === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || job.getInt("progress"))))); job.set("current_stage", status === "succeeded" ? "completed" : String(body.current_stage || "supplemental_highlight")); job.set("error", status === "failed" ? String(body.error || "supplemental highlight failed").slice(0, 4000) : ""); if (body.result != null) job.set("result", body.result); if (status === "running") job.set("lease_until", new Date(Date.now() + Math.max(60, Math.min(1800, Number(body.lease_seconds || 600))) * 1000).toISOString()); else { job.set("lease_until", ""); job.set("lease_token", ""); } tx.save(job);
    if (status !== "succeeded" || !body.result) return;
    const root = body.result && body.result.result ? body.result.result : body.result;
    const highlights = Array.isArray(root.highlights) ? root.highlights : [];
    const matchJob = tx.findRecordById("hook_match_jobs", job.getString("match_job")), episode = tx.findRecordById("drama_episodes", job.getString("episode")), drama = tx.findRecordById("dramas", matchJob.getString("drama"));
    highlights.slice(0, 8).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const range = item.timecode || item.interval || item, start = Number(range.start), end = Number(range.end), safeStart = item.safeStart || item.safe_start || {}, safeEnd = item.safeEnd || item.safe_end || {};
      const verified = start >= 0 && end > start && end - start >= 10 && end - start <= 60 && safeStart.status === "verified" && safeEnd.status === "verified" && safeStart.actionStatus === "complete" && safeEnd.actionStatus === "complete";
      const qualityGate = item.qualityGate || item.quality_gate || {}, productionReady = qualityGate.productionReady === true || qualityGate.production_ready === true;
      if (!verified || !productionReady) return;
      const record = new Record(tx.findCollectionByNameOrId("hook_assets")); record.set("source_class", "episode_highlight"); record.set("drama", drama.id); record.set("episode", episode.id); record.set("title", `补充高光 - ${drama.getString("title")} - 第${episode.getInt("episode_number")}集 - ${String(index + 1).padStart(2, "0")}`); record.set("start_seconds", start); record.set("end_seconds", end); record.set("boundary_status", "verified"); record.set("safe_start", safeStart); record.set("safe_end", safeEnd); record.set("hook_type", String(item.hookType || item.hook_type || "剧情高光")); record.set("themes", Array.isArray(item.themes) ? item.themes : []); record.set("content_tags", Array.isArray(item.contentTags) ? item.contentTags : []); record.set("character_roles", Array.isArray(item.characterRoles) ? item.characterRoles : []); record.set("relationships", Array.isArray(item.relationships) ? item.relationships : []); record.set("conflict", String(item.conflict || "")); record.set("emotion", String(item.emotion || "")); record.set("narrative_promise", String(item.narrativePromise || "")); record.set("information_gap", String(item.informationGap || "")); record.set("quality_scores", item.qualityScores || {}); record.set("evidence", item.evidence || []); record.set("analysis", item); record.set("rights_status", drama.getString("copyright_status")); record.set("review_status", "approved"); record.set("analysis_version", `supplemental-v1:${matchJob.getString("match_context_hash")}`); tx.save(record);
    });
    const supplements = tx.findRecordsByFilter("supplemental_highlight_jobs", "match_job = {:job}", "id", 500, 0, { job: matchJob.id }).filter(Boolean);
    const storyMatches = tx.findRecordsByFilter("hook_story_matches", "source_job = {:job}", "id", 500, 0, { job: matchJob.id }).filter(Boolean);
    const diagnostics = helpers.summarizeHookMatch(
      { status: matchJob.getString("status"), episode_scope: helpers.jsonArray(matchJob, "episode_scope") },
      supplements.map((item) => ({ status: item.getString("status"), result: helpers.jsonObject(item, "result") })), storyMatches.map((item) => ({ id: item.id }))
    );
    matchJob.set("outcome_status", diagnostics.outcome_status); matchJob.set("diagnostics", diagnostics); matchJob.set("outcome_version", "hook-outcome-v1"); tx.save(matchJob);
  });
  return e.json(200, { id, status });
});

routerAdd("POST", "/api/lumina/hook-story-matches/{id}/soft-override", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeUi(e); const body = e.requestInfo().body || {}, match = e.app.findRecordById("hook_story_matches", e.request.pathValue("id"));
  const allowed = ["story_score", "understanding_cost", "transition_difficulty"], requested = Array.isArray(body.codes) ? [...new Set(body.codes.map(String))] : [];
  if (!requested.length || requested.some((code) => !allowed.includes(code))) throw new BadRequestError("only story_score, understanding_cost and transition_difficulty can be overridden");
  const current = helpers.jsonObject(match, "soft_override"), next = Object.assign({}, current); for (const code of requested) next[code] = { overridden: body.enabled !== false, updatedAt: new Date().toISOString() }; match.set("soft_override", next); e.app.save(match); return e.json(200, { id: match.id, soft_override: next });
});

routerAdd("POST", "/api/lumina/hook-story-matches/{id}/human-production-approval", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeUi(e);
  const match = e.app.findRecordById("hook_story_matches", e.request.pathValue("id"));
  const segments = helpers.jsonArray(match, "segments");
  if (!segments.length) throw new BadRequestError("a playable story segment is required");
  const episodes = e.app.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: match.getString("drama") }).filter(Boolean);
  const playable = segments.every((segment) => {
    const episode = episodes.find((item) => item.getInt("episode_number") === Number(segment && segment.episode));
    const start = Number(segment && segment.start), end = Number(segment && segment.end);
    return Boolean(episode && episode.getString("video") && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && (!episode.getFloat("duration_seconds") || end <= episode.getFloat("duration_seconds") + 0.05));
  });
  if (!playable) throw new BadRequestError("every selected story segment must have a playable source video and valid time range");
  const current = helpers.jsonObject(match, "soft_override"), next = Object.assign({}, current, { human_video_approval: { overridden: true, source: "human_review", updatedAt: new Date().toISOString() } });
  match.set("soft_override", next); match.set("status", "approved");
  match.set("evidence", helpers.jsonArray(match, "evidence").concat([{ source: "human_production_approval", result: "人工确认该可播放视频候选进入生产", reviewedAt: new Date().toISOString() }]));
  e.app.save(match);
  return e.json(200, { id: match.id, status: "approved", human_video_approval: true, soft_override: next });
});

routerAdd("POST", "/api/lumina/hook-story-matches/{id}/review", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeUi(e);
  const body = e.requestInfo().body || {}, decision = String(body.decision || ""), note = String(body.note || "").trim();
  if (!["approved", "rejected"].includes(decision) || !note) throw new BadRequestError("review decision and note are required");
  const match = e.app.findRecordById("hook_story_matches", e.request.pathValue("id"));
  if (decision === "approved") {
    const segments = helpers.jsonArray(match, "segments");
    if (!segments.length || segments.some((segment) => !segment?.safeStart || !segment?.safeEnd || segment.safeStart.status !== "verified" || segment.safeEnd.status !== "verified")) throw new BadRequestError("all story boundaries must be verified before approval");
    const gate = helpers.jsonObject(match, "production_gate");
    if (!helpers.productionGatePasses(gate, helpers.jsonObject(match, "soft_override"))) throw new BadRequestError("story match production gate has not passed");
  }
  match.set("status", decision); match.set("evidence", helpers.jsonArray(match, "evidence").concat([{ source: "human_review", result: note, reviewedAt: new Date().toISOString() }])); e.app.save(match);
  return e.json(200, { id: match.id, status: decision });
});

routerAdd("POST", "/api/lumina/hook-story-matches/restore", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`); helpers.authorizeUi(e);
  const body = e.requestInfo().body || {}, job = e.app.findRecordById("hook_match_jobs", String(body.job_id || ""));
  if (job.getString("status") !== "succeeded") throw new BadRequestError("only succeeded matching jobs can be restored");
  const envelope = helpers.jsonObject(job, "result"), result = envelope.result && typeof envelope.result === "object" ? envelope.result : envelope;
  const matches = Array.isArray(result.matches) ? result.matches : [];
  const item = matches[Math.max(0, Number(body.match_index || 0))];
  if (!item || !Array.isArray(item.segments) || !item.segments.length) throw new BadRequestError("matching result is unavailable");
  const record = new Record(e.app.findCollectionByNameOrId("hook_story_matches"));
  record.set("hook", job.getString("hook")); record.set("drama", job.getString("drama")); record.set("source_job", job.id); record.set("topics", item.topics || helpers.jsonArray(job, "topics")); record.set("episode_scope", helpers.jsonArray(job, "episode_scope")); record.set("scope_mode", job.getString("scope_mode") || "free_only"); record.set("target_duration_band", job.getString("target_duration_band") || "5_15m"); record.set("contains_paid_episodes", job.getBool("contains_paid_episodes")); record.set("match_context_hash", job.getString("match_context_hash")); record.set("match_context", helpers.jsonObject(job, "match_context")); record.set("story_arc", item.storyArc || item.story_arc || {}); record.set("segments", item.segments); record.set("match_score", Number(item.matchScore || item.match_score || 0)); record.set("story_score", Number(item.storyScore || item.story_score || item.matchScore || item.match_score || 0)); record.set("promise_fulfillment_score", Number(item.promiseFulfillmentScore || item.promise_fulfillment_score || 0)); record.set("causal_completeness_score", Number(item.causalCompletenessScore || item.causal_completeness_score || 0)); const restoredEntryPoints = item.entryPoints || item.entry_points || []; record.set("entry_score", Number(item.entryScore || item.entry_score || (Array.isArray(restoredEntryPoints) ? restoredEntryPoints.reduce((best, entry) => Math.max(best, Number(entry && (entry.entryScore || entry.entry_score || entry.score) || 0)), 0) : 0))); record.set("business_gate", item.businessGate || item.business_gate || {}); record.set("tag_match_evidence", item.tagMatchEvidence || item.tag_match_evidence || item.tagMatches || item.tag_matches || []); record.set("dimension_scores", item.dimensionScores || item.dimension_scores || {}); record.set("evidence", item.evidence || []); record.set("risks", item.risks || []); record.set("story_graph", item.storyGraph || item.story_graph || {}); record.set("entry_points", restoredEntryPoints); record.set("completeness", item.completeness || {}); record.set("calibration", item.calibration || {}); record.set("production_gate", item.productionGate || item.production_gate || {}); record.set("status", String(body.status || "approved") === "approved" ? "approved" : "candidate"); record.set("analysis_version", String(result.schemaVersion || "hook-match-v1")); record.set("contract_version", "hook-match-contract-v2"); record.set("legacy_mapping", { matchScore: item.matchScore || item.match_score || 0, schemaVersion: result.schemaVersion || "hook-match-v1" }); e.app.save(record);
  if (body.project_id) { const project = e.app.findRecordById("factory_projects", String(body.project_id)); project.set("story_match", record.id); project.set("story_matches", [record.id]); e.app.save(project); }
  return e.json(200, { id: record.id, project_id: String(body.project_id || ""), scope_mode: record.getString("scope_mode"), episode_scope: helpers.jsonArray(record, "episode_scope"), contains_paid_episodes: record.getBool("contains_paid_episodes"), match_context_hash: record.getString("match_context_hash") });
});

routerAdd("POST", "/api/lumina/factory/projects", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeUi(e);
  const body = e.requestInfo().body || {};
  const drama = e.app.findRecordById("dramas", String(body.drama_id || ""));
  const hook = e.app.findRecordById("hook_assets", String(body.hook_id || ""));
  const match = e.app.findRecordById("hook_story_matches", String(body.story_match_id || ""));
  if (hook.getString("source_class") !== "external_material" || hook.getString("boundary_status") !== "verified") throw new BadRequestError("a verified external hook asset is required");
  const hookDuration = hook.getFloat("end_seconds") - hook.getFloat("start_seconds");
  if (hookDuration < 5 || hookDuration > 60) throw new BadRequestError("external hook duration must be between 5 and 60 seconds");
  if (match.getString("hook") !== hook.id || match.getString("drama") !== drama.id) throw new BadRequestError("story match does not belong to the selected hook and drama");
  if (match.getString("status") === "rejected") throw new BadRequestError("story match was rejected and cannot enter production");
  const productionGate = helpers.jsonObject(match, "production_gate");
  const softOverride = helpers.jsonObject(match, "soft_override");
  const humanVideoApproved = Boolean(softOverride.human_video_approval && softOverride.human_video_approval.overridden === true);
  if (!helpers.productionGatePasses(productionGate, softOverride)) throw new BadRequestError("story match production gate has not passed");
  if (!humanVideoApproved && match.getFloat("story_score") < 75 && !(softOverride.story_score && softOverride.story_score.overridden === true)) throw new BadRequestError("story score must be at least 75 before production");
  if (!humanVideoApproved && match.getFloat("promise_fulfillment_score") < 70) throw new BadRequestError("promise fulfillment score must be at least 70 before production");
  const paidScopeConfirmed = body.paid_scope_confirmed === true;
  if (match.getBool("contains_paid_episodes") && !paidScopeConfirmed) throw new BadRequestError("paid episode scope requires paid_scope_confirmed=true");
  const segments = helpers.jsonArray(match, "segments");
  if (!segments.length || (!humanVideoApproved && segments.some((segment) => !segment || !segment.safeStart || !segment.safeEnd || segment.safeStart.status !== "verified" || segment.safeEnd.status !== "verified"))) throw new BadRequestError("all story segment boundaries must be verified before rendering");
  const timeline = Array.isArray(body.timeline) ? body.timeline : [];
  if (timeline.length < 2) throw new BadRequestError("production timeline is incomplete");
  const timelineEpisodes = timeline.filter((item) => item && Number(item.episode) > 0);
  if (!timelineEpisodes.length) throw new BadRequestError("production timeline must include at least one story clip");
  for (const item of timelineEpisodes) {
    const episode = Number(item.episode), start = Number(item.startSeconds == null ? item.start : item.startSeconds), end = Number(item.endSeconds == null ? item.end : item.endSeconds);
    const candidates = segments.filter((segment) => Number(segment.episode) === episode);
    const supported = candidates.some((segment) => (!Number.isFinite(start) || Math.abs(Number(segment.start) - start) <= 0.05) && (!Number.isFinite(end) || Math.abs(Number(segment.end) - end) <= 0.05));
    if (!supported) throw new BadRequestError(`timeline episode ${episode} is outside the approved story match`);
  }
  const calibration = helpers.jsonObject(match, "calibration");
  const completeness = helpers.jsonObject(match, "completeness");
  const calibratedProbability = Number(calibration.calibratedProbability || calibration.calibrated_probability || 0);
  const evidenceCoverage = Number(calibration.evidenceCoverage || calibration.evidence_coverage || 0);
  const boundaryReliability = Number(calibration.boundaryReliability || calibration.boundary_reliability || 0);
  const storyCompleteness = Number(completeness.score || completeness.confidence || completeness.completenessScore || completeness.completeness_score || 0), causalCoverage = Number(completeness.causalCoverage || completeness.causal_coverage || 0);
  const transitionInput = body.transition && typeof body.transition === "object" ? body.transition : {};
  const qualityChecks = [
    { code: "HOOK_SOURCE", label: "外搭钩子来源", passed: hook.getString("source_class") === "external_material", severity: "hard" },
    { code: "HOOK_RIGHTS", label: "钩子授权状态（当前不设门槛）", passed: true, severity: "advisory", metrics: { rightsStatus: hook.getString("rights_status") } },
    { code: "DRAMA_RIGHTS", label: "正片授权状态（当前不设门槛）", passed: true, severity: "advisory", metrics: { rightsStatus: drama.getString("copyright_status") } },
    { code: "HOOK_BOUNDARIES", label: "钩子安全边界", passed: hook.getString("boundary_status") === "verified" && hookDuration >= 5 && hookDuration <= 60, severity: "hard" },
    { code: "STORY_BOUNDARIES", label: "正片安全边界", passed: segments.length > 0 && segments.every((segment) => segment && segment.safeStart && segment.safeEnd && segment.safeStart.status === "verified" && segment.safeEnd.status === "verified"), severity: humanVideoApproved ? "advisory" : "hard" },
    { code: "TIMELINE_MATCH", label: "时间线与批准片段一致", passed: timelineEpisodes.length > 0 && timelineEpisodes.every((item) => { const episode = Number(item.episode), start = Number(item.startSeconds == null ? item.start : item.startSeconds), end = Number(item.endSeconds == null ? item.end : item.endSeconds); return segments.some((segment) => Number(segment.episode) === episode && (!Number.isFinite(start) || Math.abs(Number(segment.start) - start) <= 0.05) && (!Number.isFinite(end) || Math.abs(Number(segment.end) - end) <= 0.05)); }), severity: "hard" },
    { code: "MATCH_CALIBRATION", label: "匹配可信度", passed: calibratedProbability >= 0.7 && evidenceCoverage >= 0.65 && boundaryReliability >= 0.8, severity: "hard", metrics: { calibratedProbability, evidenceCoverage, boundaryReliability } },
    { code: "STORY_COMPLETENESS", label: "故事完整度", passed: storyCompleteness >= 0.6, severity: "advisory", metrics: { storyCompleteness } },
    { code: "MATCH_SCORE_CONSISTENCY", label: "匹配分数与结构证据一致性", passed: calibratedProbability < 0.9 || storyCompleteness >= 0.5 || causalCoverage >= 0.5, severity: "advisory", metrics: { calibratedProbability, storyCompleteness, causalCoverage } },
    { code: "TRANSITION_RATIONALE", label: "过渡方案依据", passed: Boolean(String(transitionInput.rationale || "").trim()), severity: "advisory" },
  ];
  const hardFailures = qualityChecks.filter((check) => check.severity === "hard" && !check.passed);
  const advisories = qualityChecks.filter((check) => check.severity === "advisory" && !check.passed).map((check) => ({ code: check.code, message: `${check.label}不足，可继续生产但建议人工预览确认。` }));
  if (hardFailures.length) throw new BadRequestError(`project quality check failed: ${hardFailures.map((item) => item.code).join(", ")}`);
  let project = null;
  if (body.id) { try { project = e.app.findRecordById("factory_projects", String(body.id)); } catch (_) {} }
  if (project && ["approved", "exported", "review"].includes(project.getString("status"))) throw new BadRequestError("approved history is immutable; create a fork instead");
  if (!project) project = new Record(e.app.findCollectionByNameOrId("factory_projects"));
  project.set("title", String(body.title || `${drama.getString("title")} · 外搭钩子版`).slice(0, 500)); project.set("mode", "external-hook"); project.set("drama", drama.id);
  project.set("hook", hook.id); project.set("hooks", [hook.id]); project.set("story_match", match.id); project.set("story_matches", [match.id]);
  project.set("selected_episodes", Array.isArray(body.selected_episodes) ? body.selected_episodes : []); project.set("topics", Array.isArray(body.topics) ? body.topics : []);
  project.set("ratio", ["9:16", "16:9", "1:1"].includes(String(body.ratio || "")) ? String(body.ratio) : "9:16"); project.set("language", String(body.language || "英语").slice(0, 80));
  project.set("transition", body.transition || {}); project.set("timeline", timeline); project.set("quality_report", { schemaVersion: "factory-self-qc-v1", status: advisories.length ? "advisory" : "passed", checkedAt: new Date().toISOString(), checks: qualityChecks, advisories, hardFailureCount: 0, advisoryCount: advisories.length }); project.set("review", body.review || {});
  if (body.fork_from) { const parent = e.app.findRecordById("factory_projects", String(body.fork_from)); project.set("parent_project", parent.id); project.set("fork_reason", String(body.fork_reason || "历史草稿参数修改自动副本").slice(0, 500)); project.set("revision_snapshot", { parentProjectId: parent.id, parentVersion: parent.getInt("version"), forkedAt: new Date().toISOString(), changedParameters: Array.isArray(body.changed_parameters) ? body.changed_parameters : [] }); }
  project.set("paid_scope_confirmed", paidScopeConfirmed); project.set("version", Math.max(1, Number(body.version || project.getInt("version") || 1))); project.set("status", "ready"); e.app.save(project);
  return e.json(200, { id: project.id, status: project.getString("status"), version: project.getInt("version") });
});

routerAdd("GET", "/api/lumina/factory/history", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  const projects = e.app.findRecordsByFilter("factory_projects", "", "-id", 500, 0).filter(Boolean).map((project) => {
    const renders = e.app.findRecordsByFilter("factory_renders", "project = {:project}", "-version", 100, 0, { project: project.id }).filter(Boolean);
    const latest = renders[0];
    return {
      id: project.id, title: project.getString("title"), mode: project.getString("mode"), drama: project.getString("drama"), hook: project.getString("hook"), story_match: project.getString("story_match"), parent_project: project.getString("parent_project"), fork_reason: project.getString("fork_reason"), revision_snapshot: helpers.jsonObject(project, "revision_snapshot"), ratio: project.getString("ratio") || "9:16", language: project.getString("language") || "英语",
      selected_episodes: helpers.jsonArray(project, "selected_episodes"), topics: helpers.jsonArray(project, "topics"), transition: helpers.jsonObject(project, "transition"), timeline: helpers.jsonArray(project, "timeline"), quality_report: helpers.jsonObject(project, "quality_report"), review: helpers.jsonObject(project, "review"),
      version: project.getInt("version"), status: project.getString("status"), created: "", updated: "",
      latest_render: latest ? { id: latest.id, version: latest.getInt("version"), status: latest.getString("status"), progress: latest.getInt("progress"), current_stage: latest.getString("current_stage"), preview_url: latest.getString("preview_url"), output_url: latest.getString("output_url"), validation: helpers.jsonObject(latest, "validation") } : null,
      render_versions: renders.map((render) => ({ id: render.id, version: render.getInt("version"), status: render.getString("status"), preview_url: render.getString("preview_url"), output_url: render.getString("output_url"), created: "" })),
    };
  });
  return e.json(200, { items: projects });
});

routerAdd("POST", "/api/lumina/factory/projects/{id}/renders", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const project = e.app.findRecordById("factory_projects", e.request.pathValue("id"));
  if (!['ready', 'rejected', 'approved'].includes(project.getString("status"))) throw new BadRequestError("project is not ready to render");
  const projectMatch = e.app.findRecordById("hook_story_matches", project.getString("story_match"));
  if (projectMatch.getBool("contains_paid_episodes") && !project.getBool("paid_scope_confirmed")) throw new BadRequestError("paid episode scope must be confirmed before rendering");
  const existing = e.app.findRecordsByFilter("factory_renders", "project = {:project}", "-version", 500, 0, { project: project.id }).filter(Boolean);
  const version = existing.length ? existing[0].getInt("version") + 1 : 1;
  const render = new Record(e.app.findCollectionByNameOrId("factory_renders"));
  render.set("project", project.id); render.set("version", version); render.set("status", "queued"); render.set("progress", 0); render.set("current_stage", "queued");
  render.set("attempt", 0); render.set("max_attempts", 3); render.set("render_config", (e.requestInfo().body || {}).render_config || { format: "MP4", resolution: "1080x1920", quality: "preview" }); e.app.save(render);
  project.set("status", "rendering"); e.app.save(project);
  return e.json(200, { id: render.id, project: project.id, version, status: "queued" });
});

routerAdd("POST", "/api/lumina/factory/projects/{id}/review", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeUi(e);
  const body = e.requestInfo().body || {};
  const decision = String(body.decision || "");
  if (!["approved", "rejected"].includes(decision)) throw new BadRequestError("invalid review decision");
  const note = String(body.note || "").trim();
  if (!note) throw new BadRequestError("review note is required");
  const project = e.app.findRecordById("factory_projects", e.request.pathValue("id"));
  const render = e.app.findRecordById("factory_renders", String(body.render_id || ""));
  if (render.getString("project") !== project.id || render.getString("status") !== "succeeded") throw new BadRequestError("review requires a succeeded render from this project");
  const validation = helpers.jsonObject(render, "validation");
  if (decision === "approved" && (validation.passed !== true || !render.getString("preview_url") || !render.getString("output_sha256"))) throw new BadRequestError("render validation must pass before approval");
  const review = { decision, note, renderId: render.id, renderVersion: render.getInt("version"), outputSha256: render.getString("output_sha256"), reviewedAt: new Date().toISOString() };
  project.set("review", review); project.set("status", decision); e.app.save(project);
  return e.json(200, { id: project.id, status: decision, review });
});

routerAdd("POST", "/api/lumina/factory/projects/{id}/export", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeUi(e);
  const body = e.requestInfo().body || {};
  const project = e.app.findRecordById("factory_projects", e.request.pathValue("id"));
  if (project.getString("status") !== "approved") throw new BadRequestError("project must be approved before export");
  const render = e.app.findRecordById("factory_renders", String(body.render_id || ""));
  if (render.getString("project") !== project.id || render.getString("status") !== "succeeded" || !render.getString("output_url")) throw new BadRequestError("a succeeded project render is required for export");
  const requestedName = String(body.file_name || "").trim().replace(/[\\/:*?\"<>|]+/g, "-");
  const fileName = requestedName || `factory-${project.id}-v${render.getInt("version")}.mp4`;
  const existingReview = helpers.jsonObject(project, "review");
  const exportRecord = { renderId: render.id, fileName, outputUrl: render.getString("output_url"), outputSha256: render.getString("output_sha256"), exportedAt: new Date().toISOString() };
  project.set("review", Object.assign({}, existingReview, { export: exportRecord })); e.app.save(project);
  return e.json(200, exportRecord);
});

routerAdd("POST", "/api/lumina/factory-render/claim", (e) => {
  const helpers = require(`${__hooks}/hook_factory_helpers.js`);
  helpers.authorizeWorker(e);
  const body = e.requestInfo().body || {}, workerId = String(body.worker_id || ""), leaseSeconds = Math.max(60, Math.min(1800, Number(body.lease_seconds || 600)));
  let claimed = null;
  e.app.runInTransaction((tx) => {
    const now = Date.now(), records = tx.findRecordsByFilter("factory_renders", "status = 'queued' || status = 'rendering' || status = 'failed'", "id", 100, 0).filter(Boolean);
    const render = records.find((item) => item.getString("status") === "queued" || (item.getString("status") === "failed" && item.getInt("attempt") < item.getInt("max_attempts")) || (item.getString("status") === "rendering" && (!Date.parse(item.getString("lease_until")) || Date.parse(item.getString("lease_until")) <= now)));
    if (!render) return;
    const token = $security.randomString(32); render.set("status", "rendering"); render.set("attempt", render.getInt("attempt") + 1); render.set("worker_id", workerId); render.set("lease_token", token); render.set("lease_until", new Date(now + leaseSeconds * 1000).toISOString()); render.set("progress", Math.max(1, render.getInt("progress"))); render.set("current_stage", "prepare"); render.set("error", ""); tx.save(render);
    const project = tx.findRecordById("factory_projects", render.getString("project")), hook = tx.findRecordById("hook_assets", project.getString("hook")), match = tx.findRecordById("hook_story_matches", project.getString("story_match")), material = tx.findRecordById("ad_materials", hook.getString("material"));
    const episodeNumbers = [...new Set(helpers.jsonArray(match, "segments").map((segment) => Number(segment.episode)).filter(Boolean))];
    const episodes = tx.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, { drama: project.getString("drama") }).filter((episode) => episodeNumbers.includes(episode.getInt("episode_number")));
    claimed = { job: { id: render.id, stage: "factory_render", lease_token: token, attempt: render.getInt("attempt") }, render: render.publicExport(), project: project.publicExport(), hook: hook.publicExport(), match: match.publicExport(), material: material.publicExport(), episodes: episodes.map((episode) => episode.publicExport()) };
  });
  if (!claimed) return e.noContent(204);
  return e.json(200, claimed);
});

routerAdd("PATCH", "/api/lumina/factory-render/jobs/{id}", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeWorker(e);
  const body = e.requestInfo().body || {}, nextStatus = String(body.status || "rendering"), id = e.request.pathValue("id");
  if (!["rendering", "succeeded", "failed"].includes(nextStatus)) throw new BadRequestError("invalid status");
  e.app.runInTransaction((tx) => {
    const render = tx.findRecordById("factory_renders", id);
    if (render.getString("worker_id") !== String(body.worker_id || "") || render.getString("lease_token") !== String(body.lease_token || "")) throw new ForbiddenError("lease ownership mismatch");
    render.set("status", nextStatus); render.set("progress", nextStatus === "succeeded" ? 100 : Math.max(1, Math.min(99, Number(body.progress || render.getInt("progress"))))); render.set("current_stage", nextStatus === "succeeded" ? "completed" : String(body.current_stage || "rendering")); render.set("error", nextStatus === "failed" ? String(body.error || "render failed").slice(0, 4000) : "");
    if (body.boundary_ledger != null) render.set("boundary_ledger", body.boundary_ledger); if (body.validation != null) render.set("validation", body.validation); if (body.preview_url != null) render.set("preview_url", String(body.preview_url)); if (body.output_url != null) render.set("output_url", String(body.output_url)); if (body.output_sha256 != null) render.set("output_sha256", String(body.output_sha256)); if (body.logs != null) render.set("logs", body.logs);
    if (nextStatus === "rendering") render.set("lease_until", new Date(Date.now() + Math.max(60, Math.min(1800, Number(body.lease_seconds || 600))) * 1000).toISOString()); else { render.set("lease_until", ""); render.set("lease_token", ""); }
    tx.save(render); const project = tx.findRecordById("factory_projects", render.getString("project")); project.set("status", nextStatus === "succeeded" ? "review" : nextStatus === "failed" ? "ready" : "rendering"); tx.save(project);
  });
  return e.json(200, { id, status: nextStatus });
});
