/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  projects.fields.add(new SelectField({ name: "ratio", maxSelect: 1, values: ["9:16", "16:9", "1:1"] }));
  projects.fields.add(new TextField({ name: "language", max: 80 }));
  return app.save(projects);
}, (app) => {
  const projects = app.findCollectionByNameOrId("factory_projects");
  ["ratio", "language"].forEach((name) => projects.fields.removeByName(name));
  return app.save(projects);
});
