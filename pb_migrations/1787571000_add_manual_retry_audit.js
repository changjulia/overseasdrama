/// <reference path="../pb_data/types.d.ts" />

// Manual retries are operator actions and must remain attributable even after
// the queue record is claimed again. Factory render retries additionally keep
// the failed render immutable and link the new version to it.
migrate((app) => {
  [
    "hook_match_jobs",
    "entry_precision_jobs",
    "supplemental_highlight_jobs",
    "factory_renders",
  ].forEach((name) => {
    const collection = app.findCollectionByNameOrId(name);
    collection.fields.add(
      new JSONField({ name: "manual_retry_audit", maxSize: 500000 }),
    );
    collection.fields.add(
      new TextField({ name: "last_manual_retry_key", max: 240 }),
    );
    // These legacy queue collections predate PocketBase's explicit system
    // timestamp fields. Optimistic retry locking needs a server-owned revision
    // timestamp, never a client-provided value.
    collection.fields.add(
      new AutodateField({ name: "updated", onCreate: true, onUpdate: true }),
    );
    app.save(collection);
  });

  const renders = app.findCollectionByNameOrId("factory_renders");
  renders.fields.add(
    new RelationField({
      name: "retry_of",
      collectionId: renders.id,
      maxSelect: 1,
      cascadeDelete: false,
    }),
  );
  app.save(renders);
}, (app) => {
  // Down migration intentionally removes only retry metadata. It never
  // deletes queue records or media; retry lineage becomes unavailable after
  // rollback, which is the explicit auditability cost of downgrading.
  const renders = app.findCollectionByNameOrId("factory_renders");
  renders.fields.removeByName("retry_of");
  app.save(renders);
  [
    "hook_match_jobs",
    "entry_precision_jobs",
    "supplemental_highlight_jobs",
    "factory_renders",
  ].forEach((name) => {
    const collection = app.findCollectionByNameOrId(name);
    collection.fields.removeByName("manual_retry_audit");
    collection.fields.removeByName("last_manual_retry_key");
    collection.fields.removeByName("updated");
    app.save(collection);
  });
});
