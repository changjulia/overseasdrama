/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const renders = app.findCollectionByNameOrId("factory_renders");
  renders.fields.add(new TextField({ name: "preview_url", max: 1000 }));
  renders.fields.add(new TextField({ name: "output_url", max: 1000 }));
  renders.fields.add(new TextField({ name: "output_sha256", max: 128 }));
  return app.save(renders);
}, (app) => {
  const renders = app.findCollectionByNameOrId("factory_renders");
  ["preview_url", "output_url", "output_sha256"].forEach((name) => renders.fields.removeByName(name));
  return app.save(renders);
});
