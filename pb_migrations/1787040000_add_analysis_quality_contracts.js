/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const addJson = (collectionName, names, maxSize = 3000000) => {
    const collection = app.findCollectionByNameOrId(collectionName);
    for (const name of names) {
      collection.fields.add(new JSONField({ name, maxSize }));
    }
    app.save(collection);
  };

  addJson("ad_materials", ["ontology_tags", "calibration", "production_gate"]);
  addJson("dramas", ["ontology_tags", "story_graph", "calibration", "production_gate"]);
  addJson("drama_episodes", ["ontology_tags", "event_graph", "calibration", "production_gate"]);
  addJson("hook_assets", ["ontology_tags", "narrative_promise_struct", "calibration", "production_gate"]);
  addJson("hook_story_matches", ["story_graph", "entry_points", "completeness", "calibration", "production_gate"]);
}, (app) => {
  const remove = (collectionName, names) => {
    const collection = app.findCollectionByNameOrId(collectionName);
    for (const name of names) {
      collection.fields.removeById(collection.fields.getByName(name).id);
    }
    app.save(collection);
  };

  remove("ad_materials", ["ontology_tags", "calibration", "production_gate"]);
  remove("dramas", ["ontology_tags", "story_graph", "calibration", "production_gate"]);
  remove("drama_episodes", ["ontology_tags", "event_graph", "calibration", "production_gate"]);
  remove("hook_assets", ["ontology_tags", "narrative_promise_struct", "calibration", "production_gate"]);
  remove("hook_story_matches", ["story_graph", "entry_points", "completeness", "calibration", "production_gate"]);
});
