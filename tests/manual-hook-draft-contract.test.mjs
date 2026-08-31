import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync("pb_hooks/hook_factory.pb.js", "utf8");
const materialHelpers = readFileSync(
  "pb_hooks/material_analysis_helpers.js",
  "utf8",
);

test("manual hook localization creates a review-only draft", () => {
  const start = hook.indexOf(
    'routerAdd("POST", "/api/lumina/materials/{id}/hook-drafts"',
  );
  const end = hook.indexOf(
    'routerAdd("POST", "/api/lumina/hooks/{id}/review"',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const route = hook.slice(start, end);
  assert.match(route, /authorizeReviewUi\(e\)/);
  assert.match(route, /hook draft source media is not playable/);
  assert.match(route, /end - start < 5/);
  assert.match(route, /end - start > 60/);
  assert.match(route, /hook draft localization note is required/);
  assert.match(route, /record\.set\("boundary_status", "unverified"\)/);
  assert.match(route, /record\.set\("review_status", "needs_review"\)/);
  assert.match(route, /reviewRequired: true/);
  assert.doesNotMatch(route, /"approved"/);
  assert.doesNotMatch(route, /status: "verified"/);
});

test("matching still requires independent verified boundary approval", () => {
  const start = hook.indexOf(
    'routerAdd("POST", "/api/lumina/hook-matching/jobs"',
  );
  const end = hook.indexOf(
    'routerAdd("GET", "/api/lumina/hook-matching/jobs/{id}/status"',
    start,
  );
  const route = hook.slice(start, end);
  assert.match(route, /boundary_status"\) !== "verified"/);
  assert.match(route, /review_status"\) !== "approved"/);
  assert.match(route, /hook source media is not playable/);
});

test("localized material hooks are not discarded solely for starting after five seconds", () => {
  assert.doesNotMatch(
    materialHelpers,
    /sourceClass === "external_material" && start > 5/,
  );
  assert.match(materialHelpers, /hookDuration < 5 \|\| hookDuration > 60/);
  assert.match(materialHelpers, /record\.set\("boundary_status", verified \? "verified" : "unverified"\)/);
  assert.match(
    materialHelpers,
    /record\.set\("review_status", verified \? "pending" : "needs_review"\)/,
  );
});
