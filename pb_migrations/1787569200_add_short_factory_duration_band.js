migrate((app) => {
  for (const collectionName of ["hook_match_jobs", "hook_story_matches"]) {
    const collection = app.findCollectionByNameOrId(collectionName);
    const field = collection.fields.getByName("target_duration_band");
    field.values = ["1_5m", "5_15m", "15_25m"];
    app.save(collection);
  }
}, (app) => {
  for (const collectionName of ["hook_match_jobs", "hook_story_matches"]) {
    const collection = app.findCollectionByNameOrId(collectionName);
    const field = collection.fields.getByName("target_duration_band");
    field.values = ["5_15m", "15_25m"];
    app.save(collection);
  }
});
