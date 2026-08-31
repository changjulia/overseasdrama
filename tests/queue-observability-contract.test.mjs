import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/check-worker-queues.sh");

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "queue-observer-"));
  const db = path.join(dir, "data.db");
  const tables = ["analysis_jobs", "material_analysis_jobs", "hook_match_jobs", "entry_precision_jobs", "supplemental_highlight_jobs", "factory_renders"];
  const sql = tables.map((name) => `CREATE TABLE ${name} (status TEXT, attempt INTEGER, max_attempts INTEGER, lease_until TEXT, next_attempt_at TEXT);`).join("\n") + `
    INSERT INTO analysis_jobs VALUES ('queued',0,3,'','');
    INSERT INTO analysis_jobs VALUES ('running',1,3,'2000-01-01 00:00:00Z','');
    INSERT INTO hook_match_jobs VALUES ('failed',1,3,'','2000-01-01 00:00:00Z');
    INSERT INTO entry_precision_jobs VALUES ('failed',3,3,'','2099-01-01 00:00:00Z');
    INSERT INTO factory_renders VALUES ('rendering',1,3,'2099-01-01 00:00:00Z','');`;
  execFileSync("sqlite3", [db, sql]);
  return db;
}

test("observer uses SQLite read-only WAL-aware mode and never exposes secrets", () => {
  const source = readFileSync(script, "utf8");
  assert.match(source, /db_uri="file:\$\{abs_db\}\?mode=ro"/);
  assert.doesNotMatch(source, /mode=ro&immutable=1/);
  assert.match(source, /sqlite3 -readonly/);
  assert.doesNotMatch(source, /lease_token|worker_token|LUMINA_WORKER_TOKEN/);
});

test("observer reports every queue and returns 1 for actionable conditions without changing DB", () => {
  const db = fixture();
  const before = statSync(db).mtimeMs;
  const result = spawnSync("bash", [script, "--db", db, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.queues.length, 6);
  assert.equal(report.attention_required, true);
  assert.deepEqual(report.queues.find((q) => q.queue === "analysis_jobs"), {
    queue: "analysis_jobs", queued: 1, active: 1, failed: 0,
    lease_expired: 1, backoff_due: 0, attempt_exhausted: 0,
  });
  assert.equal(report.queues.find((q) => q.queue === "hook_match_jobs").backoff_due, 1);
  assert.equal(report.queues.find((q) => q.queue === "entry_precision_jobs").attempt_exhausted, 1);
  assert.equal(report.queues.find((q) => q.queue === "factory_renders").active, 1);
  assert.equal(statSync(db).mtimeMs, before);
});

test("observer returns 0 for a healthy isolated queue and 2 for invalid input", () => {
  const db = fixture();
  execFileSync("sqlite3", [db, "DELETE FROM analysis_jobs WHERE status='running'; DELETE FROM hook_match_jobs; DELETE FROM entry_precision_jobs;"]);
  const healthy = spawnSync("bash", [script, "--db", db], { encoding: "utf8" });
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.match(healthy.stdout, /factory_renders\s+0\s+1\s+0/);
  const missing = spawnSync("bash", [script, "--db", path.join(tmpdir(), "definitely-missing-worker-db")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
});
