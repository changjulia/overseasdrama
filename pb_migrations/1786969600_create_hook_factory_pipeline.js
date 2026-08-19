/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const materials = app.findCollectionByNameOrId("ad_materials");
  const dramas = app.findCollectionByNameOrId("dramas");
  const episodes = app.findCollectionByNameOrId("drama_episodes");

  const hooks = new Collection({
    id: "pbc_lumhooks001",
    name: "hook_assets",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "select", name: "source_class", required: true, maxSelect: 1, values: ["episode_highlight", "narration_opening", "external_material"] },
      { type: "relation", name: "material", maxSelect: 1, collectionId: materials.id, cascadeDelete: true },
      { type: "relation", name: "drama", maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "relation", name: "episode", maxSelect: 1, collectionId: episodes.id, cascadeDelete: true },
      { type: "text", name: "highlight_id", max: 160 },
      { type: "text", name: "title", required: true, max: 500 },
      { type: "number", name: "start_seconds", required: true, min: 0 },
      { type: "number", name: "end_seconds", required: true, min: 0 },
      { type: "number", name: "start_frame", onlyInt: true, min: 0 },
      { type: "number", name: "end_frame", onlyInt: true, min: 0 },
      { type: "number", name: "fps", min: 0 },
      { type: "select", name: "boundary_status", required: true, maxSelect: 1, values: ["unverified", "verified", "rejected"] },
      { type: "json", name: "safe_start", maxSize: 200000 },
      { type: "json", name: "safe_end", maxSize: 200000 },
      { type: "text", name: "hook_type", max: 160 },
      { type: "json", name: "themes", maxSize: 200000 },
      { type: "json", name: "content_tags", maxSize: 200000 },
      { type: "json", name: "character_roles", maxSize: 500000 },
      { type: "json", name: "relationships", maxSize: 500000 },
      { type: "text", name: "conflict", max: 2000 },
      { type: "text", name: "emotion", max: 500 },
      { type: "text", name: "narrative_promise", max: 2000 },
      { type: "text", name: "information_gap", max: 2000 },
      { type: "text", name: "spoken_summary", max: 4000 },
      { type: "text", name: "visual_summary", max: 4000 },
      { type: "json", name: "quality_scores", maxSize: 500000 },
      { type: "json", name: "evidence", maxSize: 1000000 },
      { type: "json", name: "analysis", maxSize: 3000000 },
      { type: "text", name: "rights_status", max: 160 },
      { type: "select", name: "review_status", required: true, maxSelect: 1, values: ["pending", "needs_review", "approved", "rejected"] },
      { type: "text", name: "analysis_version", max: 80 },
      { type: "file", name: "thumbnail", maxSelect: 1, maxSize: 8388608, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["360x640"] }
    ],
    indexes: [
      "CREATE INDEX idx_hook_assets_source ON hook_assets (source_class)",
      "CREATE INDEX idx_hook_assets_material ON hook_assets (material)",
      "CREATE INDEX idx_hook_assets_drama_episode ON hook_assets (drama, episode)",
      "CREATE INDEX idx_hook_assets_review ON hook_assets (review_status, boundary_status)"
    ]
  });
  app.save(hooks);

  const matches = new Collection({
    id: "pbc_lumhookmat1",
    name: "hook_story_matches",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "hook", required: true, maxSelect: 1, collectionId: hooks.id, cascadeDelete: true },
      { type: "relation", name: "drama", required: true, maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "json", name: "topics", maxSize: 200000 },
      { type: "json", name: "episode_scope", maxSize: 200000 },
      { type: "json", name: "story_arc", maxSize: 1000000 },
      { type: "json", name: "segments", maxSize: 2000000 },
      { type: "number", name: "match_score", min: 0, max: 100 },
      { type: "json", name: "dimension_scores", maxSize: 500000 },
      { type: "json", name: "evidence", maxSize: 1000000 },
      { type: "json", name: "risks", maxSize: 500000 },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["candidate", "needs_review", "approved", "rejected"] },
      { type: "text", name: "analysis_version", max: 80 }
    ],
    indexes: [
      "CREATE INDEX idx_hook_story_match_hook ON hook_story_matches (hook)",
      "CREATE INDEX idx_hook_story_match_drama ON hook_story_matches (drama)",
      "CREATE INDEX idx_hook_story_match_score ON hook_story_matches (match_score)"
    ]
  });
  app.save(matches);

  const matchJobs = new Collection({
    id: "pbc_lumhookjob1",
    name: "hook_match_jobs",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "hook", required: true, maxSelect: 1, collectionId: hooks.id, cascadeDelete: true },
      { type: "relation", name: "drama", required: true, maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "json", name: "topics", maxSize: 200000 },
      { type: "json", name: "episode_scope", maxSize: 200000 },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "running", "succeeded", "failed"] },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "text", name: "current_stage", max: 120 },
      { type: "number", name: "attempt", onlyInt: true, min: 0 },
      { type: "number", name: "max_attempts", required: true, onlyInt: true, min: 1, max: 20 },
      { type: "text", name: "worker_id", max: 120 },
      { type: "text", name: "lease_token", max: 120, hidden: true },
      { type: "date", name: "lease_until" },
      { type: "text", name: "error", max: 4000 },
      { type: "json", name: "result", maxSize: 5000000 },
      { type: "json", name: "logs", maxSize: 1000000 },
      { type: "text", name: "idempotency_key", required: true, max: 240 }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_hook_match_job_key ON hook_match_jobs (idempotency_key)",
      "CREATE INDEX idx_hook_match_job_claim ON hook_match_jobs (status, progress)"
    ]
  });
  app.save(matchJobs);

  const projects = new Collection({
    id: "pbc_lumfactory1",
    name: "factory_projects",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      { type: "text", name: "title", required: true, max: 500 },
      { type: "select", name: "mode", required: true, maxSelect: 1, values: ["external-hook", "episode-splice", "episode-narration"] },
      { type: "relation", name: "drama", required: true, maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "relation", name: "hook", maxSelect: 1, collectionId: hooks.id, cascadeDelete: false },
      { type: "relation", name: "story_match", maxSelect: 1, collectionId: matches.id, cascadeDelete: false },
      { type: "json", name: "selected_episodes", maxSize: 200000 },
      { type: "json", name: "topics", maxSize: 200000 },
      { type: "json", name: "transition", maxSize: 1000000 },
      { type: "json", name: "timeline", maxSize: 3000000 },
      { type: "json", name: "quality_report", maxSize: 2000000 },
      { type: "json", name: "review", maxSize: 1000000 },
      { type: "number", name: "version", required: true, onlyInt: true, min: 1 },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["draft", "ready", "rendering", "review", "approved", "rejected", "exported"] }
    ],
    indexes: [
      "CREATE INDEX idx_factory_project_status ON factory_projects (status)",
      "CREATE INDEX idx_factory_project_drama ON factory_projects (drama)"
    ]
  });
  app.save(projects);

  const renders = new Collection({
    id: "pbc_lumrenders1",
    name: "factory_renders",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "relation", name: "project", required: true, maxSelect: 1, collectionId: projects.id, cascadeDelete: true },
      { type: "number", name: "version", required: true, onlyInt: true, min: 1 },
      { type: "select", name: "status", required: true, maxSelect: 1, values: ["queued", "rendering", "succeeded", "failed"] },
      { type: "number", name: "progress", onlyInt: true, min: 0, max: 100 },
      { type: "text", name: "current_stage", max: 120 },
      { type: "json", name: "render_config", maxSize: 500000 },
      { type: "json", name: "boundary_ledger", maxSize: 3000000 },
      { type: "json", name: "validation", maxSize: 2000000 },
      { type: "text", name: "error", max: 4000 },
      { type: "json", name: "logs", maxSize: 1000000 },
      { type: "file", name: "preview", maxSelect: 1, maxSize: 2147483648, mimeTypes: ["video/mp4"] },
      { type: "file", name: "output", maxSelect: 1, maxSize: 2147483648, mimeTypes: ["video/mp4", "video/quicktime"] }
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_factory_render_version ON factory_renders (project, version)",
      "CREATE INDEX idx_factory_render_status ON factory_renders (status)"
    ]
  });
  return app.save(renders);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("factory_renders"));
  app.delete(app.findCollectionByNameOrId("factory_projects"));
  app.delete(app.findCollectionByNameOrId("hook_match_jobs"));
  app.delete(app.findCollectionByNameOrId("hook_story_matches"));
  return app.delete(app.findCollectionByNameOrId("hook_assets"));
});
