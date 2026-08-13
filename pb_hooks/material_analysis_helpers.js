function authorize(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
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
  app.save(job);
  material.set("analysis_status", "queued");
  material.set("analysis_progress", 0);
  material.set("analysis_error", "");
  material.set("review_status", "pending");
  app.save(material);
  return job;
}

function resultValue(result, names, fallback) {
  const payload = result && result.result ? result.result : (result || {});
  for (let index = 0; index < names.length; index++) {
    const value = payload[names[index]];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return fallback;
}

module.exports = { authorize, createJob, resultValue };
