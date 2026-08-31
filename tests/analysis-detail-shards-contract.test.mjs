import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeRecord {
  constructor(collection, initial = {}) { this.collectionName = typeof collection === "string" ? collection : collection.name; this.values = { ...initial }; this.id = initial.id || `job-${FakeRecord.next++}`; }
  get(name) { return this.values[name]; }
  getString(name) { return String(this.values[name] || ""); }
  getInt(name) { return Number(this.values[name] || 0); }
  set(name, value) { this.values[name] = value; }
}
FakeRecord.next = 1;
const helperSource = readFileSync(new URL("../pb_hooks/analysis_helpers.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} }, exports: {}, Record: FakeRecord, UnauthorizedError: class extends Error {}, ForbiddenError: class extends Error {}, $os: { getenv: () => "" }, Math, JSON, String, Number, Array, Object, Set, Error };
vm.runInNewContext(helperSource, sandbox);
const helpers = sandbox.module.exports;

function fixture() {
  const drama = new FakeRecord("dramas", { id: "drama-1", free_episodes: 3 });
  const episodes = [1, 2, 3].map((number) => new FakeRecord("drama_episodes", { id: `episode-${number}`, drama: drama.id, episode_number: number, video: `episode-${number}.mp4` }));
  const jobs = [];
  const app = {
    findCollectionByNameOrId(name) { return { name }; },
    findRecordById(collection, id) { if (collection === "dramas" && id === drama.id) return drama; return episodes.find((item) => item.id === id); },
    findFirstRecordByFilter(_collection, _filter, parameters) { const found = jobs.find((job) => job.getString("idempotency_key") === parameters.key); if (!found) throw new Error("not found"); return found; },
    findRecordsByFilter(collection, filter, _sort, _limit, _offset, parameters) {
      if (collection === "drama_episodes") return episodes.filter((episode) => episode.getString("drama") === parameters.drama && episode.getInt("episode_number") <= parameters.free && episode.getString("video"));
      if (collection !== "analysis_jobs") return [];
      if (filter.includes("stage = 'detail_episode'")) return jobs.filter((job) => job.getString("drama") === parameters.drama && job.getString("stage") === "detail_episode");
      if (filter.includes("stage = 'detail'")) return jobs.filter((job) => job.getString("drama") === parameters.drama && job.getString("stage") === "detail");
      return [];
    },
    save(record) { if (record.collectionName === "analysis_jobs" && !jobs.includes(record)) jobs.push(record); },
  };
  return { app, drama, episodes, jobs };
}

test("detail parent fans out to one idempotent checkpoint job per episode", () => {
  const { app, jobs } = fixture();
  const parent = helpers.ensureDramaStageJob(app, "drama-1", "detail");
  const shards = jobs.filter((job) => job.getString("stage") === "detail_episode");
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map((job) => helpers.jobLogs(job).shard_key), ["episode:1", "episode:2", "episode:3"]);
  assert.ok(shards.every((job) => helpers.jobLogs(job).parent_job === parent.id));
  helpers.ensureDramaStageJob(app, "drama-1", "detail");
  assert.equal(jobs.filter((job) => job.getString("stage") === "detail_episode").length, 3, "idempotent re-entry must not duplicate shards");
});

test("fan-in remains blocked until every sibling checkpoint succeeds", () => {
  const { app, drama, jobs } = fixture();
  const parent = helpers.ensureDramaStageJob(app, "drama-1", "detail");
  const shards = jobs.filter((job) => job.getString("stage") === "detail_episode");
  shards[0].set("status", "succeeded"); shards[0].set("progress", 100);
  shards[1].set("status", "running"); shards[1].set("progress", 50);
  shards[2].set("status", "failed"); shards[2].set("progress", 25);
  let summary = helpers.detailShardSummary(app, drama.id, parent.id);
  assert.equal(summary.ready, false);
  assert.equal(summary.progress, 58);
  helpers.refreshDetailFanout(app, drama.id);
  assert.equal(drama.getString("detail_status"), "running");
  assert.equal(drama.getInt("detail_progress"), 52);
  shards[1].set("status", "succeeded"); shards[1].set("progress", 100);
  shards[2].set("status", "succeeded"); shards[2].set("progress", 100);
  summary = helpers.detailShardSummary(app, drama.id, parent.id);
  assert.equal(summary.ready, true);
  assert.equal(summary.progress, 100);
});

test("unique lease token remains the completion ownership boundary", () => {
  const source = readFileSync(new URL("../pb_hooks/analysis.pb.js", import.meta.url), "utf8");
  assert.match(source, /stage === "detail_episode"/);
  assert.match(source, /if \(!shards\.ready\) return false/);
  assert.match(source, /lease ownership mismatch/);
  assert.match(source, /episode_checkpoints/);
  assert.match(source, /checkpoint_only: true/);
});
