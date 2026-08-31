/// <reference path="../pb_data/types.d.ts" />

// Keep retry policy durable across worker restarts and multiple worker lanes.
// max_attempts remains the authoritative attempt budget; these fields only
// control when a failed job may consume its next attempt.
migrate((app) => {
  [
    "analysis_jobs",
    "hook_match_jobs",
    "entry_precision_jobs",
    "supplemental_highlight_jobs",
    "factory_renders",
  ].forEach((name) => {
    const collection = app.findCollectionByNameOrId(name);
    collection.fields.add(new DateField({ name: "next_attempt_at" }));
    collection.fields.add(
      new SelectField({
        name: "error_kind",
        maxSelect: 1,
        values: ["transient", "permanent", "provider", "media", "validation"],
      }),
    );
    collection.indexes = collection.indexes.concat([
      `CREATE INDEX idx_${name}_retry ON ${name} (status, next_attempt_at)`,
    ]);
    app.save(collection);
  });
}, (app) => {
  [
    "analysis_jobs",
    "hook_match_jobs",
    "entry_precision_jobs",
    "supplemental_highlight_jobs",
    "factory_renders",
  ].forEach((name) => {
    const collection = app.findCollectionByNameOrId(name);
    ["next_attempt_at", "error_kind"].forEach((field) =>
      collection.fields.removeByName(field),
    );
    collection.indexes = collection.indexes.filter(
      (index) => !index.includes(`idx_${name}_retry`),
    );
    app.save(collection);
  });
});
