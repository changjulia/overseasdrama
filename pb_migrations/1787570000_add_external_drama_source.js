/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const dramas = app.findCollectionByNameOrId("dramas");
  dramas.fields.add(new SelectField({ name: "source_type", maxSelect: 1, values: ["内部", "外部"] }));
  dramas.fields.add(new TextField({ name: "source_platform", max: 120 }));
  dramas.fields.add(new TextField({ name: "source_record_id", max: 160 }));
  dramas.fields.add(new TextField({ name: "acquisition_method", max: 80 }));
  dramas.fields.add(new TextField({ name: "external_cover_url", max: 2000 }));
  dramas.fields.add(new JSONField({ name: "source_metadata", maxSize: 1000000 }));
  dramas.indexes = [...dramas.indexes, "CREATE INDEX idx_dramas_source ON dramas (source_type, source_platform, source_record_id)"];
  return app.save(dramas);
}, (app) => {
  const dramas = app.findCollectionByNameOrId("dramas");
  dramas.indexes = dramas.indexes.filter((index) => !index.includes("idx_dramas_source"));
  for (const name of ["source_type", "source_platform", "source_record_id", "acquisition_method", "external_cover_url", "source_metadata"]) {
    dramas.fields.removeById(dramas.fields.getByName(name).id);
  }
  return app.save(dramas);
});
