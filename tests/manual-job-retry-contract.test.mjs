import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("hosted gateway allows only the four exact UI retry routes", async () => {
  const gateway = await read("app/api/pocketbase/[...path]/route.ts");
  assert.match(gateway, /hook-matching\\\/jobs\\\/\[\^\/\]\+\\\/retry/);
  assert.match(gateway, /supplemental-highlights\\\/jobs\\\/\[\^\/\]\+\\\/retry/);
  assert.match(gateway, /entry-precision\\\/jobs\\\/\[\^\/\]\+\\\/retry/);
  assert.match(gateway, /factory\\\/renders\\\/\[\^\/\]\+\\\/retry/);
  assert.match(gateway, /if \(!csrfAllowed\(request\)\).*status: 403/);
});

test("manual retry helper enforces optimistic concurrency, leases and override audit", async () => {
  const helpers = await read("pb_hooks/hook_factory_helpers.js");
  assert.match(helpers, /manual retry reason is required/);
  assert.match(helpers, /expected_status and expected_updated are required/);
  assert.match(helpers, /job changed since it was inspected/);
  assert.match(helpers, /active or queued job cannot be manually retried/);
  assert.match(helpers, /override_non_retryable and override_reason/);
  for (const field of ["error_kind", "next_attempt_at", "worker_id", "lease_token", "lease_until", "manual_retry_audit", "last_manual_retry_key"])
    assert.match(helpers, new RegExp(`record\\.set\\("${field}"`));
});

test("entry precision create is idempotent and cannot revoke a running lease", async () => {
  const hook = await read("pb_hooks/hook_factory.pb.js");
  const start = hook.indexOf('routerAdd("POST", "/api/lumina/entry-precision/jobs"');
  const end = hook.indexOf('routerAdd("POST", "/api/lumina/entry-precision/jobs/{id}/retry"', start);
  const block = hook.slice(start, end);
  assert.match(block, /\["queued", "running"\]\.includes/);
  assert.match(block, /idempotent: true/);
  assert.doesNotMatch(block, /lease_token/);
  assert.match(block, /failed entry precision job requires explicit retry/);
});

test("legacy hook force_retry cannot bypass audited job-id retry", async () => {
  const hook = await read("pb_hooks/hook_factory.pb.js");
  assert.match(hook, /Legacy force_retry had no optimistic lock/);
  assert.match(hook, /manual retry requires \/api\/lumina\/hook-matching\/jobs\/\$\{job\.id\}\/retry/);
});

test("all manual retry routes are UI-authorized and render retry forks an immutable version", async () => {
  const hook = await read("pb_hooks/hook_factory.pb.js");
  for (const route of [
    "/api/lumina/hook-matching/jobs/{id}/retry",
    "/api/lumina/entry-precision/jobs/{id}/retry",
    "/api/lumina/supplemental-highlights/jobs/{id}/retry",
    "/api/lumina/factory/renders/{id}/retry",
  ]) {
    const start = hook.indexOf(route);
    const end = hook.indexOf("routerAdd(", start + route.length);
    assert.ok(start >= 0, `${route} missing`);
    assert.match(hook.slice(start, end < 0 ? undefined : end), /helpers\.authorizeUi\(e\)/);
  }
  const renderStart = hook.indexOf("/api/lumina/factory/renders/{id}/retry");
  const renderEnd = hook.indexOf("routerAdd(", renderStart + 1);
  const render = hook.slice(renderStart, renderEnd);
  assert.match(render, /new Record/);
  assert.match(render, /render\.set\("retry_of", failed\.id\)/);
  assert.match(render, /project\.set\("review", \{\}\)/);
  assert.match(render, /obsolete transition version/);
  assert.doesNotMatch(render, /failed\.set\("status", "queued"\)/);
});

test("manual retry migration adds durable audit and self lineage with documented rollback cost", async () => {
  const migration = await read("pb_migrations/1787571000_add_manual_retry_audit.js");
  for (const collection of ["hook_match_jobs", "entry_precision_jobs", "supplemental_highlight_jobs", "factory_renders"])
    assert.match(migration, new RegExp(`"${collection}"`));
  assert.match(migration, /name: "manual_retry_audit"/);
  assert.match(migration, /name: "last_manual_retry_key"/);
  assert.match(migration, /name: "retry_of"/);
  assert.match(migration, /new AutodateField\(\{ name: "updated", onCreate: true, onUpdate: true \}\)/);
  assert.match(migration, /auditability cost of downgrading/);
});
