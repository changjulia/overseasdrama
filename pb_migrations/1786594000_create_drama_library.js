/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const dramas = new Collection({
    id: "pbc_lumdramas1",
    name: "dramas",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      { type: "text", name: "external_id", required: true, max: 80 },
      { type: "text", name: "title", required: true },
      { type: "text", name: "cn", required: true },
      { type: "text", name: "genre", required: true },
      { type: "text", name: "language", required: true },
      { type: "number", name: "total_episodes", required: true, onlyInt: true, min: 1 },
      { type: "number", name: "free_episodes", required: true, onlyInt: true, min: 0 },
      { type: "text", name: "copyright_status" },
      { type: "text", name: "parse_state", required: true },
      { type: "json", name: "parse_config", maxSize: 200000 },
      { type: "json", name: "analysis", maxSize: 5000000 },
      { type: "file", name: "poster", maxSelect: 1, maxSize: 8388608, mimeTypes: ["image/jpeg", "image/png", "image/webp"], thumbs: ["300x400"] }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_dramas_external_id ON dramas (external_id)"]
  });
  app.save(dramas);

  const episodes = new Collection({
    id: "pbc_lumepisodes",
    name: "drama_episodes",
    type: "base",
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    fields: [
      { type: "relation", name: "drama", required: true, maxSelect: 1, collectionId: dramas.id, cascadeDelete: true },
      { type: "number", name: "episode_number", required: true, onlyInt: true, min: 1 },
      { type: "text", name: "original_name", required: true },
      { type: "text", name: "mime_type" },
      { type: "number", name: "byte_size", required: true, onlyInt: true, min: 0 },
      { type: "number", name: "duration_seconds", onlyInt: false, min: 0 },
      { type: "text", name: "analysis_status", required: true },
      { type: "json", name: "analysis_result", maxSize: 5000000 },
      { type: "file", name: "video", required: true, maxSelect: 1, maxSize: 2147483648, mimeTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"] }
    ],
    indexes: ["CREATE UNIQUE INDEX idx_drama_episode ON drama_episodes (drama, episode_number)"]
  });
  return app.save(episodes);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("drama_episodes"));
  return app.delete(app.findCollectionByNameOrId("dramas"));
});
