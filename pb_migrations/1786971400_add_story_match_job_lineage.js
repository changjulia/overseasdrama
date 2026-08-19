/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const matches = app.findCollectionByNameOrId("hook_story_matches");
  matches.fields.add(new RelationField({ name: "source_job", collectionId: app.findCollectionByNameOrId("hook_match_jobs").id, maxSelect: 1, cascadeDelete: false }));
  matches.indexes = matches.indexes.concat(["CREATE INDEX idx_hook_story_source_job ON hook_story_matches (source_job)"]);
  return app.save(matches);
}, (app) => {
  const matches = app.findCollectionByNameOrId("hook_story_matches");
  matches.fields.removeByName("source_job");
  matches.indexes = matches.indexes.filter((index) => !index.includes("idx_hook_story_source_job"));
  return app.save(matches);
});
