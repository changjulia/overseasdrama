/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const jobs = app.findCollectionByNameOrId("hook_match_jobs");
  jobs.fields.add(new SelectField({ name: "target_duration_band", maxSelect: 1, values: ["5_15m", "15_25m"] }));
  app.save(jobs);

  const matches = app.findCollectionByNameOrId("hook_story_matches");
  matches.fields.add(new SelectField({ name: "target_duration_band", maxSelect: 1, values: ["5_15m", "15_25m"] }));
  matches.fields.add(new JSONField({ name: "soft_override", maxSize: 200000 }));
  matches.fields.add(new TextField({ name: "contract_version", max: 80 }));
  matches.fields.add(new JSONField({ name: "legacy_mapping", maxSize: 500000 }));
  app.save(matches);

  const projects = app.findCollectionByNameOrId("factory_projects");
  projects.fields.add(new BoolField({ name: "paid_scope_confirmed" }));
  app.save(projects);

  const entryJobs = new Collection({
    id: "pbc_lumentryj01", name: "entry_precision_jobs", type: "base",
    listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "relation", name: "match", required: true, maxSelect: 1, collectionId: matches.id, cascadeDelete: true },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "attempt", onlyInt: true, min: 0 },
      { type: "number", name: "max_attempts", required: true, onlyInt: true, min: 1, max: 20 },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "text", name: "worker_id", max: 120 }, { type: "text", name: "lease_token", max: 120, hidden: true },
      { type: "date", name: "lease_until" }, { type: "text", name: "current_stage", max: 120 },
      { type: "text", name: "error", max: 4000 }, { type: "json", name: "result", maxSize: 3000000 },
      { type: "text", name: "contract_version", max: 80 }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_entry_precision_match ON entry_precision_jobs (match)", "CREATE INDEX idx_entry_precision_claim ON entry_precision_jobs (status, progress)"]
  });
  app.save(entryJobs);

  const supplementalJobs = new Collection({
    id: "pbc_lumsupphj01", name: "supplemental_highlight_jobs", type: "base",
    listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { type: "relation", name: "match_job", required: true, maxSelect: 1, collectionId: jobs.id, cascadeDelete: true },
      { type: "relation", name: "episode", required: true, maxSelect: 1, collectionId: app.findCollectionByNameOrId("drama_episodes").id, cascadeDelete: true },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "attempt", onlyInt: true, min: 0 }, { type: "number", name: "max_attempts", required: true, onlyInt: true, min: 1, max: 20 },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "text", name: "worker_id", max: 120 }, { type: "text", name: "lease_token", max: 120, hidden: true },
      { type: "date", name: "lease_until" }, { type: "text", name: "current_stage", max: 120 },
      { type: "text", name: "error", max: 4000 }, { type: "json", name: "result", maxSize: 3000000 },
      { type: "text", name: "contract_version", max: 80 }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_supplemental_match_episode ON supplemental_highlight_jobs (match_job, episode)", "CREATE INDEX idx_supplemental_claim ON supplemental_highlight_jobs (status, progress)"]
  });
  app.save(supplementalJobs);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("supplemental_highlight_jobs"));
  app.delete(app.findCollectionByNameOrId("entry_precision_jobs"));
  const projects = app.findCollectionByNameOrId("factory_projects"); projects.fields.removeById(projects.fields.getByName("paid_scope_confirmed").id); app.save(projects);
  const matches = app.findCollectionByNameOrId("hook_story_matches"); for (const name of ["target_duration_band", "soft_override", "contract_version", "legacy_mapping"]) matches.fields.removeById(matches.fields.getByName(name).id); app.save(matches);
  const jobs = app.findCollectionByNameOrId("hook_match_jobs"); jobs.fields.removeById(jobs.fields.getByName("target_duration_band").id); app.save(jobs);
});
