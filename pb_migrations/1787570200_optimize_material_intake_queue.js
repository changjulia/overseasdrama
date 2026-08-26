/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.add(new SelectField({ name: "intake_status", maxSelect: 1, values: ["uploading", "validating", "stored", "duplicate", "failed"] }));
  materials.fields.add(new TextField({ name: "intake_batch_id", max: 120 }));
  materials.fields.add(new TextField({ name: "intake_error", max: 2000 }));
  materials.indexes = [...materials.indexes,
    "CREATE INDEX idx_ad_material_intake_batch ON ad_materials (intake_batch_id)",
  ];
  app.save(materials);

  const jobs = app.findCollectionByNameOrId("material_analysis_jobs");
  jobs.fields.add(new NumberField({ name: "priority", onlyInt: true, min: 0, max: 100 }));
  jobs.fields.add(new DateField({ name: "next_attempt_at" }));
  jobs.fields.add(new SelectField({ name: "error_kind", maxSelect: 1, values: ["transient", "permanent", "provider", "media", "validation"] }));
  jobs.fields.add(new JSONField({ name: "checkpoint", maxSize: 1000000 }));
  jobs.indexes = [...jobs.indexes,
    "CREATE INDEX idx_material_analysis_priority ON material_analysis_jobs (status, priority, next_attempt_at)",
  ];
  return app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("material_analysis_jobs");
  jobs.indexes = jobs.indexes.filter((value) => !value.includes("idx_material_analysis_priority"));
  ["priority", "next_attempt_at", "error_kind", "checkpoint"].forEach((name) => jobs.fields.removeByName(name));
  app.save(jobs);
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.indexes = materials.indexes.filter((value) => !value.includes("idx_ad_material_intake_batch"));
  ["intake_status", "intake_batch_id", "intake_error"].forEach((name) => materials.fields.removeByName(name));
  return app.save(materials);
});
