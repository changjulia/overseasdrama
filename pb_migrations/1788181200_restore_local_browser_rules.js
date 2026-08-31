/// <reference path="../pb_data/types.d.ts" />

// This project is a localhost-only desktop deployment. Its browser client
// reads PocketBase collections directly through Vite's /pb proxy. A database
// that was previously opened by the hosted runtime may carry the hosted
// superuser-only rules, which makes the local UI fail with HTTP 403.
const LOCAL_RULES = {
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
  for (const [name, rules] of Object.entries(LOCAL_RULES)) {
    let collection;
    try {
      collection = app.findCollectionByNameOrId(name);
    } catch {
      continue;
    }
    setRules(collection, rules);
    app.save(collection);
  }
}, (app) => {
  for (const name of Object.keys(LOCAL_RULES)) {
    let collection;
    try {
      collection = app.findCollectionByNameOrId(name);
    } catch {
      continue;
    }
    setRules(collection, [null, null, null, null, null]);
    app.save(collection);
  }
});
