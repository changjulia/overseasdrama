/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const dramas = app.findCollectionByNameOrId("dramas");
  dramas.fields.add(
    new TextField({ name: "coarse_status" }),
    new NumberField({ name: "coarse_progress", onlyInt: true, min: 0, max: 100 }),
    new TextField({ name: "detail_status" }),
    new NumberField({ name: "detail_progress", onlyInt: true, min: 0, max: 100 }),
    new TextField({ name: "precision_status" }),
    new NumberField({ name: "precision_progress", onlyInt: true, min: 0, max: 100 }),
    new TextField({ name: "analysis_error", max: 4000 }),
  );
  app.save(dramas);

  const episodes = app.findCollectionByNameOrId("drama_episodes");
  episodes.fields.add(
    new NumberField({ name: "analysis_progress", onlyInt: true, min: 0, max: 100 }),
    new NumberField({ name: "analysis_attempt", onlyInt: true, min: 0 }),
    new TextField({ name: "analysis_error", max: 4000 }),
    new TextField({ name: "analysis_worker", max: 120 }),
  );
  app.save(episodes);

  const jobs = new Collection({
    id: "pbc_lumanalysis",
    name: "analysis_jobs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "drama", required: true, maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "relation", name: "episode", maxSelect: 1, collectionId: episodes.id, cascadeDelete: true },
      { type: "select", name: "stage", required: true, maxSelect: 1, values: ["coarse", "detail", "precision"] },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "number", name: "attempt", onlyInt: true, min: 0 },
      { type: "number", name: "max_attempts", required: true, onlyInt: true, min: 1, max: 20 },
      { type: "text", name: "worker_id", max: 120 },
      { type: "text", name: "lease_token", max: 120 },
      { type: "date", name: "lease_until" },
      { type: "text", name: "error", max: 4000 },
      { type: "json", name: "result", maxSize: 5000000 },
      { type: "json", name: "logs", maxSize: 1000000 },
      { type: "text", name: "idempotency_key", required: true, max: 200 },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_analysis_idempotency ON analysis_jobs (idempotency_key)",
      "CREATE INDEX idx_analysis_claim ON analysis_jobs (status, stage)",
      "CREATE INDEX idx_analysis_episode ON analysis_jobs (episode)",
    ],
  });
  app.save(jobs);

  // Enqueue every already uploaded episode, including the current four files.
  const existing = app.findRecordsByFilter(episodes, "video != ''", "episode_number", 10000, 0);
  for (const episode of existing) {
    if (!episode) continue;
    const record = new Record(jobs);
    record.set("drama", episode.getString("drama"));
    record.set("episode", episode.id);
    record.set("stage", "coarse");
    record.set("status", "queued");
    record.set("progress", 0);
    record.set("attempt", 0);
    record.set("max_attempts", 3);
    record.set("idempotency_key", `coarse:${episode.id}:v1`);
    app.save(record);
    episode.set("analysis_status", "queued");
    episode.set("analysis_progress", 0);
    app.save(episode);
  }
}, (app) => {
  app.delete(app.findCollectionByNameOrId("analysis_jobs"));
  const episodes = app.findCollectionByNameOrId("drama_episodes");
  for (const name of ["analysis_progress", "analysis_attempt", "analysis_error", "analysis_worker"]) episodes.fields.removeByName(name);
  app.save(episodes);
  const dramas = app.findCollectionByNameOrId("dramas");
  for (const name of ["coarse_status", "coarse_progress", "detail_status", "detail_progress", "precision_status", "precision_progress", "analysis_error"]) dramas.fields.removeByName(name);
  return app.save(dramas);
});
