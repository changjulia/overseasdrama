/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  jobs.fields.add(
    new AutodateField({ name: "created", onCreate: true, onUpdate: false }),
    new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
  );
  app.save(jobs);
  jobs.indexes = jobs.indexes.filter((value) => !value.includes("idx_analysis_claim"));
  jobs.indexes.push("CREATE INDEX idx_analysis_claim ON analysis_jobs (status, stage, created)");
  return app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  jobs.indexes = jobs.indexes.filter((value) => !value.includes("idx_analysis_claim"));
  jobs.indexes.push("CREATE INDEX idx_analysis_claim ON analysis_jobs (status, stage)");
  jobs.fields.removeByName("created");
  jobs.fields.removeByName("updated");
  return app.save(jobs);
});
