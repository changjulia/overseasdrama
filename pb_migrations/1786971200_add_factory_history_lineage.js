/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  projects.fields.add(new RelationField({ name: "parent_project", collectionId: projects.id, maxSelect: 1, cascadeDelete: false }));
  projects.fields.add(new TextField({ name: "fork_reason", max: 500 }));
  projects.fields.add(new JSONField({ name: "revision_snapshot", maxSize: 3000000 }));
  projects.indexes = projects.indexes.concat(["CREATE INDEX idx_factory_parent_project ON factory_projects (parent_project)"]);
  return app.save(projects);
}, (app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  ["parent_project", "fork_reason", "revision_snapshot"].forEach((name) => projects.fields.removeByName(name));
  projects.indexes = projects.indexes.filter((index) => !index.includes("idx_factory_parent_project"));
  return app.save(projects);
});
