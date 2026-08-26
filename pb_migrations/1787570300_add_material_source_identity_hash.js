/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.add(new TextField({ name: "source_identity_hash", max: 64 }));
  materials.indexes = [
    ...materials.indexes,
    "CREATE UNIQUE INDEX idx_ad_material_source_identity_hash ON ad_materials (source_identity_hash) WHERE source_identity_hash != ''",
  ];
  return app.save(materials);
}, (app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.indexes = materials.indexes.filter((value) => !value.includes("idx_ad_material_source_identity_hash"));
  materials.fields.removeByName("source_identity_hash");
  return app.save(materials);
});
