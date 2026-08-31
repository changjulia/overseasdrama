/// <reference path="../pb_data/types.d.ts" />

// Reuse analysis_jobs so leases, retries and idempotency remain identical for
// coarse, detail shards and precision. The existing `detail` stage becomes the
// fan-in reconciliation parent; `detail_episode` is one independently leased
// checkpoint per episode.
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const stage = jobs.fields.getByName("stage");
  stage.values = ["coarse", "detail_episode", "detail", "precision"];
  jobs.indexes = jobs.indexes.filter((value) => !value.includes("idx_analysis_detail_shards"));
  jobs.indexes.push("CREATE INDEX idx_analysis_detail_shards ON analysis_jobs (drama, stage, status, created)");
  return app.save(jobs);
}, (app) => {
  const shards = app.findRecordsByFilter("analysis_jobs", "stage = 'detail_episode'", "id", 10000, 0).filter(Boolean);
  if (shards.length) throw new Error("Cannot remove detail_episode stage while shard checkpoints exist");
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const stage = jobs.fields.getByName("stage");
  stage.values = ["coarse", "detail", "precision"];
  jobs.indexes = jobs.indexes.filter((value) => !value.includes("idx_analysis_detail_shards"));
  return app.save(jobs);
});
