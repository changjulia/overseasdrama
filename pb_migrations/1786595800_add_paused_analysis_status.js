/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const status = jobs.fields.getByName("status");
  status.values = ["queued", "running", "paused", "succeeded", "failed"];
  return app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const paused = app.findRecordsByFilter("analysis_jobs", "status = 'paused'", "id", 10000, 0).filter(Boolean);
  for (const job of paused) { job.set("status", "queued"); app.save(job); }
  const status = jobs.fields.getByName("status");
  status.values = ["queued", "running", "succeeded", "failed"];
  return app.save(jobs);
});
