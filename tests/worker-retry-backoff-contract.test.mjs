import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("all non-material worker collections persist retry classification and due time", async () => {
  const migration = await read("pb_migrations/1787570700_add_worker_retry_backoff.js");
  for (const collection of [
    "analysis_jobs",
    "hook_match_jobs",
    "entry_precision_jobs",
    "supplemental_highlight_jobs",
    "factory_renders",
  ]) {
    assert.match(migration, new RegExp(`"${collection}"`));
  }
  assert.match(migration, /name: "next_attempt_at"/);
  assert.match(migration, /name: "error_kind"/);
});

test("drama queue gates failed claims and persists worker backoff", async () => {
  const hook = await read("pb_hooks/analysis.pb.js");
  assert.match(hook, /Date\.parse\(item\.getString\("next_attempt_at"\)\)/);
  assert.match(hook, /item\.getInt\("attempt"\) < item\.getInt\("max_attempts"\)/);
  assert.match(hook, /job\.set\("error_kind", errorKind\)/);
  assert.match(hook, /body\.retry_after_seconds/);
});

test("manual drama retry is a UI-authorized action, not a worker-only action", async () => {
  const hook = await read("pb_hooks/analysis.pb.js");
  const route = hook.slice(hook.indexOf('routerAdd("POST", "/api/lumina/analysis/jobs/{id}/retry"'), hook.indexOf('routerAdd("POST", "/api/lumina/analysis/jobs/{id}/pause"'));
  assert.match(route, /authorizeLocalUi\(e\)/);
  assert.doesNotMatch(route, /helpers\.authorize\(e\)/);
});

test("local material retry reads the raw request header without weakening loopback gates", async () => {
  const helper = await read("pb_hooks/material_analysis_helpers.js");
  assert.match(helper, /e\.request && e\.request\.header/);
  assert.match(helper, /rawHeader \? rawHeader\.get\(name\)/);
  assert.match(helper, /e\.request && e\.request\.host/, "Go promotes inbound Host out of the Header map");
  assert.match(helper, /LUMINA_UI_MODE/);
  assert.match(helper, /local-loopback/);
  assert.match(helper, /browserOriginAllowed/);
  assert.match(helper, /localHostAllowed/);
});

test("every material reset and retry clears stale published projections", async () => {
  const hook = await read("pb_hooks/material_analysis.pb.js");
  const helper = await read("pb_hooks/material_analysis_helpers.js");
  assert.equal((hook.match(/helpers\.resetMaterialPublishedAnalysis\(material\)/g) || []).length, 3);
  for (const field of ["analysis_result", "analysis_schema_version", "segment_count", "hook_count", "creative_tier", "material_format", "type", "prototype", "review_flags", "prototype_inputs", "source_attribution", "ontology_tags", "production_gate", "review_status"])
    assert.match(helper, new RegExp(`material\\.set\\(\\"${field}\\"`), `retry must invalidate ${field}`);
  assert.match(helper, /analysis_retry_pending/);
  assert.match(helper, /creative_tier\", \"TX\"/);
  assert.match(helper, /material_format\", \"未确定\"/);
});

test("material projection never promotes unverified source or dialogue-only T tier", async () => {
  const helper = await read("pb_hooks/material_analysis_helpers.js");
  assert.match(helper, /function verifiedClaimText/);
  assert.match(helper, /verification === "verified"/);
  assert.match(helper, /tierHasBusinessEvidence/);
  for (const source of ["adx", "performance", "metrics", "manual_review"])
    assert.match(helper, new RegExp(`\\"${source}\\"`));
  assert.match(helper, /verifiedClaimText\(creative\.hookSourceStatus\)/);
  assert.match(helper, /verifiedClaimText\(creative\.hookAssemblyType\)/);
});

test("material attempts persist model prompt and retry lineage without credentials", async () => {
  const worker = await read("processor/job_worker.py");
  const helper = await read("pb_hooks/material_analysis_helpers.js");
  const hook = await read("pb_hooks/material_analysis.pb.js");
  for (const field of ["semantic_model", "semantic_provider", "semantic_prompt_version", "python_version"])
    assert.match(worker, new RegExp(`\\"${field}\\"`));
  assert.match(worker, /material-v2-20260830\.1/);
  assert.match(helper, /function appendRetryLineage/);
  for (const field of ["retry_lineage", "from_status", "from_attempt", "force_semantic_refresh"])
    assert.match(helper, new RegExp(field));
  assert.equal((hook.match(/helpers\.appendRetryLineage\(/g) || []).length, 3);
  assert.doesNotMatch(worker, /DASHSCOPE_API_KEY.*logs/);
});

test("forced semantic refresh invalidates both long and short material model caches", async () => {
  const worker = await read("processor/job_worker.py");
  assert.match(worker, /semantic-segments-v6\.json/);
  assert.match(worker, /semantic-short-v1\.json/);
  assert.equal((worker.match(/\.unlink\(\)/g) || []).length >= 2, true);
});

test("manual queue force can explicitly reuse paid semantic cache", async () => {
  const hook = await read("pb_hooks/material_analysis.pb.js");
  assert.match(hook, /force && body\.force_semantic_refresh === undefined/);
  assert.match(hook, /appendRetryLineage\(job\.get\("logs"\), job, "ui_material_retry", forceSemanticRefresh\)/);
});

test("factory queues gate every failed claim and persist every failure backoff", async () => {
  const hook = await read("pb_hooks/hook_factory.pb.js");
  const claimRoutes = [
    "/api/lumina/hook-matching/claim",
    "/api/lumina/entry-precision/claim",
    "/api/lumina/supplemental-highlights/claim",
    "/api/lumina/factory-render/claim",
  ].map((route) => {
    const start = hook.indexOf(route);
    const end = hook.indexOf("routerAdd(", start + route.length);
    assert.ok(start >= 0, `${route} claim route missing`);
    return hook.slice(start, end < 0 ? undefined : end);
  });
  const dueChecks = claimRoutes.flatMap((block) => block.match(/getString\("next_attempt_at"\)/g) || []);
  const errorWrites = hook.match(/set\("error_kind", errorKind\)/g) || [];
  assert.equal(dueChecks.length, 8, "four claim gates each read next_attempt_at twice");
  assert.equal(errorWrites.length, 4, "hook, entry, supplemental and render PATCH persist classification");
  assert.match(hook, /Math\.min\(1800, Number\(body\.retry_after_seconds \|\| 0\)\)/);
});
