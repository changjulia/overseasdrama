/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const dramas = app.findCollectionByNameOrId("dramas");
  dramas.fields.getByName("free_episodes").required = false;
  return app.save(dramas);
}, (app) => {
  const dramas = app.findCollectionByNameOrId("dramas");
  dramas.fields.getByName("free_episodes").required = true;
  return app.save(dramas);
});
