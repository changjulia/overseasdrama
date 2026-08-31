import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const helpers = await readFile(new URL("../pb_hooks/analysis_helpers.js", import.meta.url), "utf8");

test("precision auto fan-out defaults to three and defers overflow", () => {
  assert.match(helpers, /LUMINA_PRECISION_AUTO_LIMIT/);
  assert.match(helpers, /\|\| 3/);
  assert.match(helpers, /Math\.max\(1, Math\.min\(20/);
  assert.match(helpers, /eligibleCandidates\.slice\(0, limit\)/);
  assert.match(helpers, /eligibleCandidates\.slice\(limit\)/);
  assert.match(helpers, /status: "deferred"/);
  assert.match(helpers, /auto_batch_limit/);
});

test("deferred precision is review-required and cannot masquerade as complete", () => {
  assert.match(helpers, /reviewRequired: true/);
  assert.match(helpers, /precision_review_required/);
  assert.match(helpers, /另有 \$\{deferred\.length\} 个候选延后等待人工复核或显式扩容/);
});
