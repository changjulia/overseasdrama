/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  const assets = new Collection({
    id: "pbc_lumnaraud01",
    name: "narration_audio_assets",
    type: "base",
    // Assets are only created by the authenticated custom upload endpoint and
    // read through the authenticated gateway file route.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "project", required: true, maxSelect: 1, collectionId: projects.id, cascadeDelete: true },
      { type: "file", name: "audio", required: true, maxSelect: 1, maxSize: 104857600, mimeTypes: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac"] },
      { type: "text", name: "original_name", required: true, max: 500 },
      { type: "text", name: "mime_type", required: true, max: 100 },
      { type: "number", name: "byte_size", required: true, onlyInt: true, min: 1, max: 104857600 },
      { type: "number", name: "duration_seconds", required: true, min: 1, max: 300 },
      { type: "text", name: "sha256", required: true, min: 64, max: 64, pattern: "^[a-f0-9]{64}$" },
      { type: "text", name: "uploaded_by", required: true, max: 500 },
      { type: "date", name: "uploaded_at", required: true },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["ready", "rejected"] },
      { type: "json", name: "probe_evidence", required: true, maxSize: 10000 }
    ],
    indexes: [
      "CREATE INDEX idx_narration_audio_project ON narration_audio_assets (project)",
      "CREATE INDEX idx_narration_audio_sha256 ON narration_audio_assets (sha256)"
    ]
  });
  app.save(assets);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("narration_audio_assets"));
});
