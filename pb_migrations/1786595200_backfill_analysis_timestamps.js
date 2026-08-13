/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const jobs = app.findRecordsByFilter("analysis_jobs", "created = '' || updated = ''", "id", 10000, 0).filter(Boolean);
  const now = new Date().toISOString();
  for (const job of jobs) {
    if (!job.getString("created")) job.set("created", now);
    if (!job.getString("updated")) job.set("updated", now);
    app.save(job);
  }
}, () => {});
