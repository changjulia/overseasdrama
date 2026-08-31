import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("pb_migrations/1787570800_lock_hosted_collections.js", "utf8");

const protectedCollections = [
  "dramas",
  "drama_episodes",
  "ad_materials",
  "analysis_jobs",
  "material_analysis_jobs",
  "hook_assets",
  "hook_story_matches",
  "hook_match_jobs",
  "entry_precision_jobs",
  "supplemental_highlight_jobs",
  "factory_projects",
  "factory_renders",
  "historical_templates",
];

test("hosted business and queue collections are locked behind custom APIs", () => {
  for (const name of protectedCollections) {
    assert.match(migration, new RegExp(`\\"${name}\\"`));
  }
  assert.match(migration, /setRules\(collection, \[null, null, null, null, null\]\)/);
  assert.doesNotMatch(migration, /listRule:\s*""/);
  assert.doesNotMatch(migration, /viewRule:\s*""/);
});

test("lockdown is an additive migration and documents the e.app worker boundary", () => {
  assert.match(migration, /Browser clients must use the authenticated Lumina gateway\/custom APIs/);
  assert.match(migration, /does not restrict hook code/);
  assert.match(migration, /PREVIOUS_RULES/);
  assert.match(migration, /migrate\(\(app\) =>/);
});
