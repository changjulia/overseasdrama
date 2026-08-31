import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../pb_hooks/analysis_helpers.js", import.meta.url), "utf8");

class MockRecord {
  static nextId = 1;
  constructor(collection, id, values = {}) {
    this.collectionName = collection;
    this.id = id || `job-${MockRecord.nextId++}`;
    this.values = { ...values };
  }
  set(name, value) { this.values[name] = value; }
  get(name) { return this.values[name]; }
  getString(name) { return String(this.values[name] ?? ""); }
  getInt(name) { return Number(this.values[name] ?? 0); }
}

function loadHelpers() {
  const sandbox = {
    module: { exports: {} }, exports: {}, Record: MockRecord,
    UnauthorizedError: class extends Error {}, ForbiddenError: class extends Error {},
    $os: { getenv: () => "" }, Math, JSON, String, Number, Array, Object, Set, Error,
  };
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}

function fixture(existingJobs = []) {
  MockRecord.nextId = 1;
  const drama = new MockRecord("dramas", "drama-1", { free_episodes: 10 });
  const episode = new MockRecord("drama_episodes", "episode-1", { drama: drama.id, episode_number: 1 });
  const jobs = existingJobs;
  const app = {
    findCollectionByNameOrId(name) { return name; },
    findRecordById(collection, id) {
      if (collection === "dramas" && id === drama.id) return drama;
      if (collection === "drama_episodes" && id === episode.id) return episode;
      throw new Error(`missing ${collection}:${id}`);
    },
    findFirstRecordByFilter(collection, filter, parameters) {
      if (collection === "drama_episodes" && parameters.drama === drama.id && Number(parameters.episode) === 1) return episode;
      if (collection === "analysis_jobs" && parameters.key) {
        const found = jobs.find((job) => job.getString("idempotency_key") === parameters.key);
        if (found) return found;
      }
      throw new Error("not found");
    },
    findRecordsByFilter(collection, filter, _sort, _limit, _offset, parameters) {
      if (collection !== "analysis_jobs") return [];
      return jobs.filter((job) => job.getString("drama") === parameters.drama && job.getString("stage") === "precision");
    },
    save(record) {
      if (record.collectionName === "analysis_jobs" && !jobs.includes(record)) jobs.push(record);
    },
  };
  return { app, drama, jobs };
}

function eligibleEnvelope() {
  return {
    analysis_id: "detail-run-1",
    result: {
      highlightCandidates: [{
        episode: 1,
        start: 1,
        end: 4,
        timecode: { start: 5, end: 9 },
        interval: { start: 10, end: 14 },
        precisionInterval: { start: 20, end: 36 },
        precisionEligible: true,
      }],
    },
  };
}

test("precision jobs prefer precisionInterval over legacy candidate ranges", () => {
  const { ensurePrecisionJobs } = loadHelpers();
  const { app, drama, jobs } = fixture();
  assert.equal(ensurePrecisionJobs(app, drama.id, eligibleEnvelope()), 1);
  assert.equal(jobs[0].get("logs").interval.start, 20);
  assert.equal(jobs[0].get("logs").interval.end, 36);
  assert.match(jobs[0].getString("idempotency_key"), /:20\.000:36\.000:/);
  assert.equal(drama.getString("precision_status"), "queued");
  assert.equal(drama.getString("parse_state"), "precision_queued");
});

test("repeated ensure derives running state from existing precision jobs", () => {
  const { ensurePrecisionJobs } = loadHelpers();
  const { app, drama, jobs } = fixture();
  assert.equal(ensurePrecisionJobs(app, drama.id, eligibleEnvelope()), 1);
  jobs[0].set("status", "running");
  jobs[0].set("progress", 43);
  assert.equal(ensurePrecisionJobs(app, drama.id, eligibleEnvelope()), 0);
  assert.equal(jobs.length, 1);
  assert.equal(drama.getString("precision_status"), "running");
  assert.equal(drama.getInt("precision_progress"), 43);
  assert.equal(drama.getString("parse_state"), "precision_running");
});

test("repeated ensure preserves queued state instead of declaring success", () => {
  const { ensurePrecisionJobs } = loadHelpers();
  const { app, drama, jobs } = fixture();
  ensurePrecisionJobs(app, drama.id, eligibleEnvelope());
  assert.equal(ensurePrecisionJobs(app, drama.id, eligibleEnvelope()), 0);
  assert.equal(jobs.length, 1);
  assert.equal(drama.getString("precision_status"), "queued");
  assert.equal(drama.getInt("precision_progress"), 0);
  assert.equal(drama.getString("parse_state"), "precision_queued");
});

test("zero eligible candidates remain explicitly review-required", () => {
  const { ensurePrecisionJobs } = loadHelpers();
  const { app, drama, jobs } = fixture();
  const envelope = { result: { highlightCandidates: [{ episode: 1, start: 10, end: 20, precisionEligible: false }] } };
  assert.equal(ensurePrecisionJobs(app, drama.id, envelope), 0);
  assert.equal(jobs.length, 0);
  assert.equal(drama.getString("precision_status"), "queued");
  assert.equal(drama.getInt("precision_progress"), 0);
  assert.equal(drama.getString("parse_state"), "precision_review_required");
  assert.match(drama.getString("analysis_error"), /人工复核/);
});

test("repeated ensure derives completed state only from succeeded eligible jobs", () => {
  const { ensurePrecisionJobs } = loadHelpers();
  const { app, drama, jobs } = fixture();
  ensurePrecisionJobs(app, drama.id, eligibleEnvelope());
  jobs[0].set("status", "succeeded");
  jobs[0].set("progress", 100);
  assert.equal(ensurePrecisionJobs(app, drama.id, eligibleEnvelope()), 0);
  assert.equal(drama.getString("precision_status"), "succeeded");
  assert.equal(drama.getInt("precision_progress"), 100);
  assert.equal(drama.getString("parse_state"), "succeeded");
});
