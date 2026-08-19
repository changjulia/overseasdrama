/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.fields.getByName("start_seconds").required = false;
  hooks.fields.getByName("start_frame").required = false;
  return app.save(hooks);
}, (app) => {
  const hooks = app.findCollectionByNameOrId("hook_assets");
  hooks.fields.getByName("start_seconds").required = true;
  hooks.fields.getByName("start_frame").required = true;
  return app.save(hooks);
});
