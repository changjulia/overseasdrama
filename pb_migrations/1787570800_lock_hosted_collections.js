/// <reference path="../pb_data/types.d.ts" />

// Browser clients must use the authenticated Lumina gateway/custom APIs.  A
// null PocketBase API rule means superuser-only; it does not restrict hook code
// using e.app, nor the token-protected worker routes implemented in pb_hooks.
const LOCKED_COLLECTIONS = [
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

const PREVIOUS_RULES = {
  dramas: ["", "", "", "", ""],
  drama_episodes: ["", "", "", "", ""],
  ad_materials: ["", "", "", null, ""],
  analysis_jobs: ["", "", null, null, null],
  material_analysis_jobs: ["", "", null, null, null],
  hook_assets: ["", "", null, null, null],
  hook_story_matches: ["", "", null, null, null],
  hook_match_jobs: ["", "", null, null, null],
  entry_precision_jobs: ["", "", null, null, null],
  supplemental_highlight_jobs: ["", "", null, null, null],
  factory_projects: ["", "", "", "", ""],
  factory_renders: ["", "", null, null, null],
  historical_templates: ["", "", null, null, null],
};

function setRules(collection, rules) {
  [
    collection.listRule,
    collection.viewRule,
    collection.createRule,
    collection.updateRule,
    collection.deleteRule,
  ] = rules;
}

migrate((app) => {
  for (const name of LOCKED_COLLECTIONS) {
    const collection = app.findCollectionByNameOrId(name);
    setRules(collection, [null, null, null, null, null]);
    app.save(collection);
  }
}, (app) => {
  for (const name of LOCKED_COLLECTIONS) {
    const collection = app.findCollectionByNameOrId(name);
    setRules(collection, PREVIOUS_RULES[name]);
    app.save(collection);
  }
});
