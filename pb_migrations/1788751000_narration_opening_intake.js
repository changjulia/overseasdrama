migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.add(new JSONField({ name: "opening_analysis", maxSize: 200000 }));
  // Reference-only intake is intentional; full media is fetched on demand.
  materials.fields.getByName("video").required = false;
  app.save(materials);
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.fields.add(new SelectField({ name: "usage_role", maxSelect: 1, values: ["pre_roll"] }));
  hooks.fields.add(new TextField({ name: "import_key", max: 160 }));
  hooks.indexes = [...hooks.indexes, "CREATE UNIQUE INDEX idx_hook_import_key ON hook_assets (import_key) WHERE import_key != ''"];
  app.save(hooks);
}, (app) => {
  // Keep video optional: reference-only records may already exist.
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.removeByName("opening_analysis");
  app.save(materials);
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.indexes = hooks.indexes.filter((item) => !item.includes("idx_hook_import_key"));
  hooks.fields.removeByName("usage_role");
  hooks.fields.removeByName("import_key");
  app.save(hooks);
});
