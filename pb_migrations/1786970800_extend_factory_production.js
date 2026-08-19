/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  projects.fields.add(new RelationField({ name: "hooks", collectionId: app.findCollectionByNameOrId("hook_assets").id, maxSelect: 20, cascadeDelete: false }));
  projects.fields.add(new RelationField({ name: "story_matches", collectionId: app.findCollectionByNameOrId("hook_story_matches").id, maxSelect: 20, cascadeDelete: false }));
  app.save(projects);
  const renders = app.findCollectionByNameOrId("factory_renders");
  renders.fields.add(new NumberField({ name: "attempt", onlyInt: true, min: 0 }));
  renders.fields.add(new NumberField({ name: "max_attempts", onlyInt: true, min: 1, max: 20 }));
  renders.fields.add(new TextField({ name: "worker_id", max: 120 }));
  renders.fields.add(new TextField({ name: "lease_token", max: 120, hidden: true }));
  renders.fields.add(new DateField({ name: "lease_until" }));
  renders.indexes = renders.indexes.concat(["CREATE INDEX idx_factory_render_claim ON factory_renders (status, progress)"]);
  return app.save(renders);
}, (app) => {
  const renders = app.findCollectionByNameOrId("factory_renders");
  ["attempt", "max_attempts", "worker_id", "lease_token", "lease_until"].forEach((name) => renders.fields.removeByName(name));
  renders.indexes = renders.indexes.filter((index) => !index.includes("idx_factory_render_claim"));
  app.save(renders);
  const projects = app.findCollectionByNameOrId("factory_projects");
  ["hooks", "story_matches"].forEach((name) => projects.fields.removeByName(name));
  return app.save(projects);
});
