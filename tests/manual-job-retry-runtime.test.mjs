import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const pocketbase = resolve("tools/pocketbase/pocketbase");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

test("fresh PocketBase enforces safe manual queue retry semantics", { timeout: 60_000 }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "lumina-manual-retry-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const common = ["--dir", join(sandbox, "pb_data"), "--hooksDir", resolve("pb_hooks"), "--migrationsDir", resolve("pb_migrations"), "--hooksWatch=false"];
  assert.equal(spawnSync(pocketbase, [...common, "migrate", "up"], { cwd: root }).status, 0);
  assert.equal(spawnSync(pocketbase, [...common, "superuser", "upsert", "retry@example.test", "Retry-Test-Password-123!"], { cwd: root }).status, 0);
  const logFd = openSync(join(sandbox, "pb.log"), "w");
  const gatewayToken = "manual-retry-ui-token";
  const child = spawn(pocketbase, [...common, "serve", `--http=127.0.0.1:${port}`], {
    cwd: root, env: { ...process.env, LUMINA_UI_GATEWAY_TOKEN: gatewayToken, LUMINA_UI_MODE: "" }, stdio: ["ignore", logFd, logFd],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    closeSync(logFd);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const auth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "retry@example.test", password: "Retry-Test-Password-123!" }),
  });
  assert.equal(auth.status, 200);
  const adminToken = (await auth.json()).token;
  const admin = async (collection, body) => {
    const response = await fetch(`${base}/api/collections/${collection}/records`, { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json();
  };
  const drama = await admin("dramas", { external_id: "manual-retry", title: "Retry", cn: "重试", genre: "test", language: "zh-CN", total_episodes: 1, free_episodes: 1, parse_state: "pending" });
  const hook = await admin("hook_assets", { source_class: "external_material", title: "Retry hook", start_seconds: 0, end_seconds: 10, boundary_status: "verified", review_status: "approved" });
  const match = await admin("hook_story_matches", { hook: hook.id, drama: drama.id, status: "candidate", match_score: 80 });
  const failedFields = { status: "failed", progress: 71, current_stage: "failed", attempt: 3, max_attempts: 3, worker_id: "old-worker", lease_token: "old-secret", error: "boom", error_kind: "transient", next_attempt_at: new Date(Date.now() + 60_000).toISOString(), result: { stale: true } };
  const entry = await admin("entry_precision_jobs", { ...failedFields, match: match.id, contract_version: "entry-precision-v1" });
  const active = await admin("entry_precision_jobs", { ...failedFields, match: (await admin("hook_story_matches", { hook: hook.id, drama: drama.id, status: "candidate", match_score: 79 })).id, status: "running", attempt: 1, worker_id: "live-worker", lease_token: "live-secret", lease_until: new Date(Date.now() + 60_000).toISOString() });
  const uiRetry = async (route, record, extra = {}) => fetch(`${base}${route}`, {
    method: "POST", headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json", "x-lumina-user-id": "runtime-operator" },
    body: JSON.stringify({ reason: "operator verified transient recovery", idempotency_key: `retry-${record.id}`, expected_status: record.status, expected_updated: record.updated, ...extra }),
  });
  const anonymous = await fetch(`${base}/api/lumina/entry-precision/jobs/${entry.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 403);
  const activeRetry = await uiRetry(`/api/lumina/entry-precision/jobs/${active.id}/retry`, active);
  assert.equal(activeRetry.status, 409, await activeRetry.text());
  const activeRead = await fetch(`${base}/api/collections/entry_precision_jobs/records/${active.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  const activeAfter = await activeRead.json();
  assert.equal(activeAfter.status, "running");
  assert.equal(activeAfter.worker_id, "live-worker");
  assert.equal(activeAfter.attempt, 1);

  const retried = await uiRetry(`/api/lumina/entry-precision/jobs/${entry.id}/retry`, entry);
  assert.equal(retried.status, 200, await retried.clone().text());
  const retriedPayload = await retried.json();
  assert.equal(retriedPayload.status, "queued");
  const duplicate = await uiRetry(`/api/lumina/entry-precision/jobs/${entry.id}/retry`, entry);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).idempotent, true);
  const entryRead = await fetch(`${base}/api/collections/entry_precision_jobs/records/${entry.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  const entryAfter = await entryRead.json();
  assert.equal(entryAfter.attempt, 0);
  assert.equal(entryAfter.error, "");
  assert.equal(entryAfter.error_kind, "");
  assert.deepEqual(entryAfter.result, {});
  assert.equal(entryAfter.manual_retry_audit.length, 1);

  const hookJob = await admin("hook_match_jobs", { ...failedFields, hook: hook.id, drama: drama.id, idempotency_key: "runtime-hook-retry", episode_scope: [1], topics: [], result: { stale: true }, logs: ["stale"] });
  const hookRetry = await uiRetry(`/api/lumina/hook-matching/jobs/${hookJob.id}/retry`, hookJob);
  assert.equal(hookRetry.status, 200, await hookRetry.clone().text());
  const hookRead = await fetch(`${base}/api/collections/hook_match_jobs/records/${hookJob.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  const hookAfter = await hookRead.json();
  assert.deepEqual(hookAfter.result, {});
  assert.deepEqual(hookAfter.logs, []);
  assert.deepEqual(hookAfter.diagnostics, {});

  const permanent = await admin("hook_match_jobs", { ...failedFields, hook: hook.id, drama: drama.id, idempotency_key: "runtime-permanent-retry", episode_scope: [1], topics: [], error_kind: "validation" });
  const deniedOverride = await uiRetry(`/api/lumina/hook-matching/jobs/${permanent.id}/retry`, permanent);
  assert.equal(deniedOverride.status, 400);
  const allowedOverride = await uiRetry(`/api/lumina/hook-matching/jobs/${permanent.id}/retry`, permanent, { override_non_retryable: true, override_reason: "source media repaired and validated" });
  assert.equal(allowedOverride.status, 200, await allowedOverride.clone().text());

  const project = await admin("factory_projects", { title: "Retry render", mode: "episode-splice", drama: drama.id, selected_episodes: [], topics: [], transition: { type: "direct_cut", reviewStatus: "approved", version: 1 }, timeline: [], quality_report: {}, review: { decision: "approved", renderId: "obsolete" }, version: 1, status: "ready" });
  const failedRender = await admin("factory_renders", { ...failedFields, project: project.id, version: 1, render_config: { purpose: "final" }, validation: { passed: false }, logs: ["stale"] });
  const renderRetry = await uiRetry(`/api/lumina/factory/renders/${failedRender.id}/retry`, failedRender);
  assert.equal(renderRetry.status, 201, await renderRetry.clone().text());
  const fork = await renderRetry.json();
  assert.notEqual(fork.id, failedRender.id);
  assert.equal(fork.version, 2);
  assert.equal(fork.retry_of, failedRender.id);
  const projectRead = await fetch(`${base}/api/collections/factory_projects/records/${project.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  const projectAfter = await projectRead.json();
  assert.deepEqual(projectAfter.review, {});
  assert.equal(projectAfter.status, "rendering");
});
