import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} }, exports: {}, $os: { getenv: () => "" }, Math, JSON, String, Number, Array, Object, Set, Error };
vm.runInNewContext(source, sandbox);
const { summarizeHookMatch } = sandbox.module.exports;

test("reports supplemental work instead of an ambiguous empty result", () => {
  const summary = summarizeHookMatch(
    { status: "queued", episode_scope: [1, 2] },
    [{ status: "succeeded", result: { highlights: [] } }, { status: "running", result: {} }],
    []
  );
  assert.equal(summary.outcome_status, "waiting_supplemental");
  assert.equal(summary.funnel.supplemental_jobs.running, 1);
  assert.equal(summary.incomplete, true);
});

test("distinguishes partial, failed, and completed no-candidate outcomes", () => {
  assert.equal(summarizeHookMatch({ status: "queued" }, [{ status: "failed" }], []).outcome_status, "partial");
  assert.equal(summarizeHookMatch({ status: "failed" }, [], []).outcome_status, "failed");
  assert.equal(summarizeHookMatch({ status: "succeeded" }, [], []).outcome_status, "no_candidates");
});

test("returns a diagnostic funnel and normalized rejection reasons", () => {
  const result = { highlights: [{ timecode: { start: 1, end: 8 }, qualityScores: { storyScore: 72 }, qualityGate: { reasons: ["story_score"] }, safeStart: {}, safeEnd: {} }] };
  const summary = summarizeHookMatch({ status: "succeeded", episode_scope: [1] }, [{ status: "succeeded", result }], []);
  assert.equal(summary.funnel.raw_candidates, 1);
  assert.equal(summary.funnel.editable_candidates, 1);
  assert.ok(summary.rejection_reasons.some((item) => item.code === "story_score"));
  assert.ok(summary.rejection_reasons.some((item) => item.code === "boundary_unverified"));
});
