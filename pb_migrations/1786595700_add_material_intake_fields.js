/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.fields.add(new TextField({ name: "content_hash", max: 64 }));
  materials.fields.add(new TextField({ name: "source_url", max: 2000 }));
  materials.fields.add(new SelectField({ name: "rights_status", maxSelect: 1, values: ["仅限内部分析", "已获授权可制作", "已获授权可投放", "授权待确认"] }));
  materials.indexes = [...materials.indexes, "CREATE UNIQUE INDEX idx_ad_material_content_hash ON ad_materials (content_hash) WHERE content_hash != ''"];
  return app.save(materials);
}, (app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  materials.indexes = materials.indexes.filter((index) => !index.includes("idx_ad_material_content_hash"));
  materials.fields.removeByName("content_hash");
  materials.fields.removeByName("source_url");
  materials.fields.removeByName("rights_status");
  return app.save(materials);
});
