/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.add(new TextField({ name: "analysis_schema_version", max: 80 }));
  materials.fields.add(new SelectField({ name: "analysis_stage", maxSelect: 1, values: ["queued", "download", "scan", "evidence", "content", "creative", "value", "review", "completed"] }));
  materials.fields.add(new NumberField({ name: "segment_count", onlyInt: true, min: 0 }));
  materials.fields.add(new NumberField({ name: "hook_count", onlyInt: true, min: 0 }));
  materials.fields.add(new SelectField({ name: "creative_tier", maxSelect: 1, values: ["T0", "T1", "T2", "T3", "TX"] }));
  materials.fields.add(new TextField({ name: "material_format", max: 120 }));
  materials.fields.add(new JSONField({ name: "review_flags", maxSize: 500000 }));
  materials.fields.add(new JSONField({ name: "prototype_inputs", maxSize: 1000000 }));
  materials.fields.add(new JSONField({ name: "source_attribution", maxSize: 1000000 }));
  materials.indexes = materials.indexes.concat([
    "CREATE INDEX idx_ad_material_schema_version ON ad_materials (analysis_schema_version)",
    "CREATE INDEX idx_ad_material_analysis_stage ON ad_materials (analysis_stage)",
    "CREATE INDEX idx_ad_material_review_status ON ad_materials (review_status)",
    "CREATE INDEX idx_ad_material_creative_tier ON ad_materials (creative_tier)",
    "CREATE INDEX idx_ad_material_format ON ad_materials (material_format)"
  ]);
  app.save(materials);

  const jobs = app.findCollectionByNameOrId("material_analysis_jobs");
  jobs.fields.add(new TextField({ name: "result_schema_version", max: 80 }));
  jobs.fields.add(new SelectField({ name: "current_stage", maxSelect: 1, values: ["queued", "download", "scan", "evidence", "content", "creative", "value", "review", "completed"] }));
  jobs.fields.add(new NumberField({ name: "segment_count", onlyInt: true, min: 0 }));
  jobs.indexes = jobs.indexes.concat([
    "CREATE INDEX idx_material_analysis_current_stage ON material_analysis_jobs (current_stage)",
    "CREATE INDEX idx_material_analysis_schema_version ON material_analysis_jobs (result_schema_version)"
  ]);
  return app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("material_analysis_jobs");
  ["result_schema_version", "current_stage", "segment_count"].forEach((name) => jobs.fields.removeByName(name));
  jobs.indexes = jobs.indexes.filter((index) => !index.includes("idx_material_analysis_current_stage") && !index.includes("idx_material_analysis_schema_version"));
  app.save(jobs);

  const materials = app.findCollectionByNameOrId("ad_materials");
  ["analysis_schema_version", "analysis_stage", "segment_count", "hook_count", "creative_tier", "material_format", "review_flags", "prototype_inputs", "source_attribution"].forEach((name) => materials.fields.removeByName(name));
  materials.indexes = materials.indexes.filter((index) => !index.includes("idx_ad_material_schema_version") && !index.includes("idx_ad_material_analysis_stage") && !index.includes("idx_ad_material_review_status") && !index.includes("idx_ad_material_creative_tier") && !index.includes("idx_ad_material_format"));
  return app.save(materials);
});
