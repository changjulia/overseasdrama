/// <reference path="../pb_data/types.d.ts" />

// Select only scalar columns in SQL. The standard records API's fields option
// trims the response after loading records and expanding large JSON relations.
routerAdd("GET", "/api/lumina/task-summaries/{collection}", (e) => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const collection = e.request.pathValue("collection");
  const joins = {
    analysis_jobs: "LEFT JOIN dramas d ON d.id=j.drama LEFT JOIN drama_episodes ep ON ep.id=j.episode",
    hook_match_jobs: "LEFT JOIN dramas d ON d.id=j.drama",
    supplemental_highlight_jobs: "LEFT JOIN hook_match_jobs m ON m.id=j.match_job LEFT JOIN dramas d ON d.id=m.drama LEFT JOIN drama_episodes ep ON ep.id=j.episode",
    entry_precision_jobs: "LEFT JOIN hook_story_matches m ON m.id=j.match LEFT JOIN dramas d ON d.id=m.drama",
  };
  if (!Object.prototype.hasOwnProperty.call(joins, collection)) throw new NotFoundError();
  const page = Math.max(1, Math.min(100000, Math.floor(Number(e.request.url.query().get("page")) || 1)));
  const hasEpisode = collection === "analysis_jobs" || collection === "supplemental_highlight_jobs";
  const rows = arrayOf(new DynamicModel({id:"",stage:"",status:"",progress:0,attempt:0,max_attempts:0,error:"",worker_id:"",title:"",cn:"",episode_number:0}));
  e.app.concurrentDB().newQuery(
    `SELECT j.id, ${collection === "analysis_jobs" ? "j.stage" : "j.current_stage"} AS stage,
     j.status,j.progress,j.attempt,j.max_attempts,j.error,j.worker_id,
     COALESCE(d.title,'') AS title,COALESCE(d.cn,'') AS cn,
     ${hasEpisode ? "COALESCE(ep.episode_number,0)" : "0"} AS episode_number
     FROM ${collection} j ${joins[collection]} ORDER BY j.id DESC LIMIT 101 OFFSET {:offset}`
  ).bind({offset:(page-1)*100}).all(rows);
  const more = rows.length > 100;
  const items = rows.slice(0,100).map(row => {
    const drama = {title:row.title,cn:row.cn};
    return {id:row.id,stage:row.stage,status:row.status,progress:row.progress,attempt:row.attempt,max_attempts:row.max_attempts,error:row.error,worker_id:row.worker_id,
      expand:{drama,episode:{episode_number:row.episode_number},match:{expand:{drama}},match_job:{expand:{drama}}}};
  });
  return e.json(200,{items,page,totalPages:more?page+1:page});
});
