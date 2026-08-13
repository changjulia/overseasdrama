/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = new Collection({
    id: "pbc_lumadmat001",
    name: "ad_materials",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: null,
    deleteRule: "",
    fields: [
      { type: "text", name: "title", required: true, max: 500 },
      { type: "text", name: "type", max: 120 },
      { type: "text", name: "source", max: 120 },
      { type: "text", name: "platform", max: 120 },
      { type: "text", name: "market", max: 120 },
      { type: "text", name: "language", max: 120 },
      { type: "text", name: "theme", max: 200 },
      { type: "number", name: "exposure", min: 0 },
      { type: "number", name: "days", onlyInt: true, min: 0 },
      { type: "text", name: "original_name", max: 500 },
      { type: "text", name: "mime_type", max: 120 },
      { type: "number", name: "byte_size", onlyInt: true, min: 0 },
      { type: "number", name: "duration_seconds", min: 0 },
      { type: "select", name: "analysis_status", maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "analysis_progress", onlyInt: true, min: 0, max: 100 },
      { type: "text", name: "analysis_error", max: 4000 },
      { type: "json", name: "analysis_result", maxSize: 5000000 },
      { type: "text", name: "prototype", max: 500 },
      { type: "text", name: "review_status", max: 120 },
      { type: "file", name: "video", required: true, maxSelect: 1, maxSize: 2147483648, mimeTypes: ["video/*"] },
      { type: "file", name: "cover", maxSelect: 1, maxSize: 8388608, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["640x360"] }
    ],
    indexes: ["CREATE INDEX idx_ad_material_analysis_status ON ad_materials (analysis_status)"]
  });
  app.save(materials);

  const jobs = new Collection({
    id: "pbc_lummatjobs1",
    name: "material_analysis_jobs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "material", required: true, maxSelect: 1, collectionId: materials.id, cascadeDelete: true },
      { type: "select", name: "stage", required: true, maxSelect: 1, values: ["material"] },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "number", name: "attempt", onlyInt: true, min: 0 },
      { type: "number", name: "max_attempts", required: true, onlyInt: true, min: 1, max: 20 },
      { type: "text", name: "worker_id", max: 120 },
      { type: "text", name: "lease_token", max: 120, hidden: true },
      { type: "date", name: "lease_until" },
      { type: "text", name: "error", max: 4000 },
      { type: "json", name: "result", maxSize: 5000000 },
      { type: "json", name: "logs", maxSize: 1000000 },
      { type: "text", name: "idempotency_key", required: true, max: 200 }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_material_analysis_idempotency ON material_analysis_jobs (idempotency_key)",
      "CREATE INDEX idx_material_analysis_claim ON material_analysis_jobs (status, stage)",
      "CREATE INDEX idx_material_analysis_material ON material_analysis_jobs (material)"
    ]
  });
  return app.save(jobs);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("material_analysis_jobs"));
  return app.delete(app.findCollectionByNameOrId("ad_materials"));
});
