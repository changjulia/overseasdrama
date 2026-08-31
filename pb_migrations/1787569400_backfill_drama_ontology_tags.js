/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const dramas = app.findRecordsByFilter("dramas", "id != ''", "id", 100000, 0);
  // Fresh databases contain no records and must not try to load hook modules
  // from the migration VM (where __hooks isn't available). Existing installs
  // that already applied this migration are unchanged.
  if (!dramas.length) return;
  let helpers;
  try {
    helpers = require(`${__hooks}/analysis_helpers.js`);
  } catch (_) {
    // Ontology projection is also performed by normal analysis/reprojection;
    // do not make a deployment fail solely because the migration VM cannot
    // import runtime hook modules.
    return;
  }
  for (const drama of dramas) {
    const existing = helpers.storedJsonArray(drama, "ontology_tags");
    const analysis = drama.get("analysis");
    const projected = helpers.projectDramaOntologyTags(analysis, existing);
    const genre = drama.getString("genre").trim();
    if (genre && !projected.some((tag) => tag.dimension === "genre" && (tag.label === genre || tag.original === genre))) {
      projected.unshift({code:`genre.${genre.replace(/[^\w\u4e00-\u9fff]+/g,"-")}`,dimension:"genre",label:genre,original:genre,evidence:[],episodes:[],prominence:"primary",primaryScore:55,source:"migration",analysisVersion:"hook-ontology-v1.1"});
    }
    drama.set("ontology_tags", projected);
    app.save(drama);
    const episodes = app.findRecordsByFilter("drama_episodes", "drama = {:drama}", "episode_number", 10000, 0, {drama:drama.id});
    for (const episode of episodes) {
      const episodeTags = helpers.projectDramaOntologyTags(episode.get("analysis_result"), helpers.storedJsonArray(episode, "ontology_tags")).map((tag) => ({...tag,episodes:[episode.getInt("episode_number")]}));
      episode.set("ontology_tags", episodeTags);
      app.save(episode);
    }
  }
}, (app) => {
  // Data-only migration: keep normalized tags on rollback to avoid deleting
  // later human review work.
});
