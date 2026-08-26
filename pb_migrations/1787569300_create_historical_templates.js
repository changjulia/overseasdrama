/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  const hooks = app.findCollectionByNameOrId("hook_assets");
  const templates = new Collection({
    id: "pbc_lumtemplate1",
    name: "historical_templates",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "title", required: true, max: 500 },
      { type: "relation", name: "source_material", required: true, maxSelect: 1, collectionId: materials.id, cascadeDelete: true },
      { type: "relation", name: "source_hook", required: true, maxSelect: 1, collectionId: hooks.id, cascadeDelete: true },
      { type: "text", name: "version", required: true, max: 120 },
      { type: "text", name: "contract_version", required: true, max: 120 },
      { type: "json", name: "performance_evidence", maxSize: 1000000 },
      { type: "json", name: "hook_structure", maxSize: 2000000 },
      { type: "json", name: "body_structure", maxSize: 3000000 },
      { type: "json", name: "connection_logic", maxSize: 1000000 },
      { type: "json", name: "timeline_skeleton", maxSize: 2000000 },
      { type: "json", name: "applicability", maxSize: 1000000 },
      { type: "json", name: "evidence_snapshot", maxSize: 2000000 },
      { type: "select", name: "evidence_level", required: true, maxSelect: 1, values: ["weak", "medium", "strong"] },
      { type: "select", name: "review_status", required: true, maxSelect: 1, values: ["pending", "approved", "rejected"] },
      { type: "text", name: "review_note", max: 4000 },
      { type: "date", name: "reviewed_at" }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_historical_template_version ON historical_templates (source_material, source_hook, version)",
      "CREATE INDEX idx_historical_template_review ON historical_templates (review_status, evidence_level)"
    ]
  });
  return app.save(templates);
}, (app) => app.delete(app.findCollectionByNameOrId("historical_templates")));
