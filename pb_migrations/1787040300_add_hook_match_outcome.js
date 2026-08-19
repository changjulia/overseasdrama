/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const jobs = app.findCollectionByNameOrId("hook_match_jobs");
  jobs.fields.add(new SelectField({ name: "outcome_status", maxSelect: 1, values: ["waiting_supplemental", "partial", "failed", "no_candidates", "ready"] }));
  jobs.fields.add(new JSONField({ name: "diagnostics", maxSize: 2000000 }));
  jobs.fields.add(new TextField({ name: "outcome_version", max: 80 }));
  jobs.indexes = jobs.indexes.concat(["CREATE INDEX idx_hook_match_outcome ON hook_match_jobs (outcome_status)"]);
  app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("hook_match_jobs");
  jobs.fields.removeByName("outcome_status");
  jobs.fields.removeByName("diagnostics");
  jobs.fields.removeByName("outcome_version");
  jobs.indexes = jobs.indexes.filter((index) => !index.includes("idx_hook_match_outcome"));
  app.save(jobs);
});
