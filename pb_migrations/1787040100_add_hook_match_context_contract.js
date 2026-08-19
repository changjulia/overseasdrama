/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const jobs = app.findCollectionByNameOrId("hook_match_jobs");
  jobs.fields.add(new SelectField({ name: "scope_mode", maxSelect: 1, values: ["free_only", "custom"] }));
  jobs.fields.add(new BoolField({ name: "contains_paid_episodes" }));
  jobs.fields.add(new TextField({ name: "match_context_hash", max: 120 }));
  jobs.fields.add(new JSONField({ name: "match_context", maxSize: 1000000 }));
  jobs.indexes = jobs.indexes.concat(["CREATE INDEX idx_hook_match_context ON hook_match_jobs (match_context_hash)"]);
  app.save(jobs);

  const matches = app.findCollectionByNameOrId("hook_story_matches");
  matches.fields.add(new SelectField({ name: "scope_mode", maxSelect: 1, values: ["free_only", "custom"] }));
  matches.fields.add(new BoolField({ name: "contains_paid_episodes" }));
  matches.fields.add(new TextField({ name: "match_context_hash", max: 120 }));
  matches.fields.add(new JSONField({ name: "match_context", maxSize: 1000000 }));
  matches.fields.add(new NumberField({ name: "story_score", min: 0, max: 100 }));
  matches.fields.add(new NumberField({ name: "promise_fulfillment_score", min: 0, max: 100 }));
  matches.fields.add(new NumberField({ name: "causal_completeness_score", min: 0, max: 100 }));
  matches.fields.add(new NumberField({ name: "entry_score", min: 0, max: 100 }));
  matches.fields.add(new JSONField({ name: "business_gate", maxSize: 500000 }));
  matches.fields.add(new JSONField({ name: "tag_match_evidence", maxSize: 2000000 }));
  matches.indexes = matches.indexes.concat(["CREATE INDEX idx_hook_story_match_context ON hook_story_matches (match_context_hash)"]);
  app.save(matches);
}, (app) => {
  const remove = (collectionName, names, indexName) => {
    const collection = app.findCollectionByNameOrId(collectionName);
    collection.indexes = collection.indexes.filter((index) => index.indexOf(indexName) < 0);
    for (const name of names) collection.fields.removeById(collection.fields.getByName(name).id);
    app.save(collection);
  };
  remove("hook_story_matches", ["scope_mode", "contains_paid_episodes", "match_context_hash", "match_context", "story_score", "promise_fulfillment_score", "causal_completeness_score", "entry_score", "business_gate", "tag_match_evidence"], "idx_hook_story_match_context");
  remove("hook_match_jobs", ["scope_mode", "contains_paid_episodes", "match_context_hash", "match_context"], "idx_hook_match_context");
});
