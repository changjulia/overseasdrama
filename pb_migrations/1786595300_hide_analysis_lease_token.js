/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const field = jobs.fields.getByName("lease_token");
  field.hidden = true;
  jobs.fields.add(field);
  return app.save(jobs);
}, (app) => {
  const jobs = app.findCollectionByNameOrId("analysis_jobs");
  const field = jobs.fields.getByName("lease_token");
  field.hidden = false;
  jobs.fields.add(field);
  return app.save(jobs);
});
