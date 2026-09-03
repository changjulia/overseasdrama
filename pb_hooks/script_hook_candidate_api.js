function core() { return require(`${__hooks}/script_hook_candidate_helpers.js`); }
function json(record,field) { try { return JSON.parse(record.getString(field)); } catch (_) { return null; } }
function all(app,collection,filter,params) {
  const result=[];
  for(let offset=0;;offset+=200) {
    const batch=app.findRecordsByFilter(collection,filter,"id",200,offset,params||{}).filter(Boolean);
    result.push(...batch);if(batch.length<200)break;
  }
  return result;
}
function file(record) {
  const name=record.getString("video");
  return name?`/api/files/${record.collection().id}/${record.id}/${encodeURIComponent(name)}`:record.getString("source_url");
}
const STORYLINE_READY_RIGHTS = new Set([
  "已获授权可制作",
  "已获授权可投放",
]);
const STORYLINE_READY_REVIEWS = new Set(["已通过", "已修改"]);
// This is an evidence-addressed model input. Changing formatting can invalidate
// every evidence offset, so field order and flattening are an explicit versioned
// contract rather than an incidental Object.values/JSON serialization detail.
const HIGHLIGHT_TEXT_PROJECTION="episode-highlight-text-v2";
const HIGHLIGHT_TEXT_FIELDS=["spokenSummary","visualSummary","conflict","emotion","narrativePromise","relationships"];
function highlightText(content) {
  return HIGHLIGHT_TEXT_FIELDS.reduce((parts,field)=>parts.concat(Array.isArray(content[field])?content[field]:[]),[]).join("；");
}
function highlight(app,id) {
  const hook=app.findRecordById("hook_assets",String(id||""));
  if(hook.getString("source_class")!=="episode_highlight")throw new Error("Invalid highlight");
  const episode=app.findRecordById("drama_episodes",hook.getString("episode"));
  const drama=app.findRecordById("dramas",episode.getString("drama"));
  if(hook.getString("drama")!==drama.id || !episode.getString("video"))throw new Error("Highlight source mismatch");
  if(episode.getInt("episode_number")>drama.getInt("free_episodes"))throw new Error("Paid episode requires separate consent");
  if(hook.getFloat("start_seconds")<0 || hook.getFloat("end_seconds")<=hook.getFloat("start_seconds") || hook.getFloat("end_seconds")>episode.getFloat("duration_seconds"))throw new Error("Invalid highlight interval");
  const content=core().highlightContent(hook);
  // Retain plain text for lexical recall; the UI consumes the structured fields.
  const text=highlightText(content);
  const episodeAnalysisHash=$security.sha256(episode.getString("analysis_result"));
  return {id:hook.id,dramaId:drama.id,episodeId:episode.id,episodeNumber:episode.getInt("episode_number"),title:hook.getString("title"),
    text,content,start:hook.getFloat("start_seconds"),end:hook.getFloat("end_seconds"),videoUrl:file(episode),
    boundaryStatus:hook.getString("boundary_status"),reviewStatus:hook.getString("review_status"),
    evidence:json(hook,"evidence"),narrativePromise:hook.getString("narrative_promise"),
    sourceVersion:{analysisVersion:hook.getString("analysis_version"),episodeAnalysisHash,episodeDuration:episode.getFloat("duration_seconds"),freeEpisodes:drama.getInt("free_episodes"),rights:hook.getString("rights_status"),copyright:drama.getString("copyright_status"),safeStart:hook.getBool("safe_start"),safeEnd:hook.getBool("safe_end")},
    // analysisVersion is the durable upstream generation identity. The complete
    // episode result hash remains diagnostic above, but is intentionally excluded
    // here because unrelated checkpoint/review metadata can change its bytes.
    semanticSourceVersion:{projection:HIGHLIGHT_TEXT_PROJECTION,analysisVersion:hook.getString("analysis_version")},
    note:"复用现有正片分析结果；未审核高光可用于候选检索，不能作为已确认制作输入"};
}
function eventMatch(app,materialId,index,target){
  try {
    const pair=require(`${__hooks}/script_semantics_api.js`).pair(app,{materialId,sceneIndex:index,highlightId:target.id});
    return pair.result?{matchId:pair.matchId,inputVersion:pair.inputVersion,hookSemanticId:pair.hook.id,highlightSemanticId:pair.highlight.id,result:pair.result}:null;
  }catch(_){return null;}
}
function taxonomyRecall(app,materialId,index,target,knownHighlight) {
  try {
    const semantic=require(`${__hooks}/script_semantics_api.js`);
    const hook=semantic.read(app,{sourceType:'csv_script',sourceId:materialId,sceneIndex:index});
    const high=knownHighlight===undefined?semantic.read(app,{sourceType:'episode_analysis',sourceId:target.id,sceneIndex:0}):knownHighlight;
    if(!hook.result||!high?.result)return null;
    return {...require(`${__hooks}/global_semantics_helpers.js`).tagRecall(hook.result,high.result),hookSemanticId:hook.id,highlightSemanticId:high.id};
  }catch(_){return null;}
}
function candidate(app,material,index,target,knownMatch,knownRecall) {
  const meta=json(material,"source_attribution");
  if(!meta||meta.schema!=="csv-hook-reference-v1"||!Array.isArray(meta.scenes)||!meta.scenes[index])return null;
  try { require(`${__hooks}/material_link_reference_helpers.js`).validateReference(material.getString("source_url"),meta); } catch (_) { return null; }
  const scene=meta.scenes[index],extracted=core().extractScene(scene);
  const eventComparison=knownMatch===undefined?eventMatch(app,material.id,index,target):knownMatch;
  const tagRecall=knownRecall===undefined?taxonomyRecall(app,material.id,index,target):knownRecall;
  const version=$security.sha256(JSON.stringify([core().VERSION,material.id,file(material),material.getString("source_url"),material.getString("content_hash"),material.getString("rights_status"),material.getString("review_status"),material.getString("analysis_status"),meta,target,eventComparison,tagRecall]));
  return {id:`${material.id}:${index}`,materialId:material.id,sceneIndex:index,title:material.getString("title"),videoUrl:file(material),
    extracted,diagnostic:core().rankCandidate(extracted,target.text),inputVersion:version,eventComparison,tagRecall,
    frameMismatch:meta.frameMismatch===true,rightsStatus:material.getString("rights_status"),materialReviewStatus:material.getString("review_status"),state:"unverified",productionEligible:false};
}
function workflowCoverage(app,episodes,materials,semanticKeys,candidates) {
  const semantic=require(`${__hooks}/script_semantics_api.js`);
  const current=(sourceType,sourceId,sceneIndex)=>{
    const key=`${sourceType}:${sourceId}:${sceneIndex}`;
    if(!semanticKeys.has(key))return null;
    try{const value=semantic.read(app,{sourceType,sourceId,sceneIndex});return value.result?value:null;}catch(_){return null;}
  };
  const highlightRows=episodes.flatMap(episode=>all(app,"hook_assets","episode = {:episode} && source_class = 'episode_highlight'",{episode:episode.id}));
  let highlightCurrent=0;
  for(const row of highlightRows)if(current("episode_analysis",row.id,0))highlightCurrent++;
  let scriptMaterials=0,scriptNonEmpty=0,scriptCurrent=0;
  for(const material of materials){
    const meta=json(material,"source_attribution");
    if(!meta||meta.schema!=="csv-hook-reference-v1"||!Array.isArray(meta.scenes))continue;
    scriptMaterials++;
    meta.scenes.forEach((scene,index)=>{
      if(typeof scene?.script!=="string"||!scene.script.trim())return;
      scriptNonEmpty++;
      if(current("csv_script",material.id,index))scriptCurrent++;
    });
  }
  let episodeCurrent=0,episodeEvents=0;
  for(const episode of episodes){const value=current("episode_checkpoint",episode.id,0);if(value){episodeCurrent++;episodeEvents+=value.result.events.length;}}
  return {
    episodes:{total:episodes.length,current:episodeCurrent,events:episodeEvents},
    highlights:{total:highlightRows.length,current:highlightCurrent},
    scripts:{total:scriptMaterials,nonEmpty:scriptNonEmpty,current:scriptCurrent},
    matches:{current:candidates.filter(candidate=>Boolean(candidate.eventComparison)).length},
    confirmed:{current:candidates.filter(candidate=>candidate.state==="confirmed").length},
    candidateSemantics:{
      total:candidates.length,
      withTagRecall:candidates.filter(candidate=>Boolean(candidate.tagRecall)).length,
      withEventMatch:candidates.filter(candidate=>Boolean(candidate.eventComparison)).length,
      rulesOnly:candidates.filter(candidate=>!candidate.tagRecall&&!candidate.eventComparison).length
    }
  };
}
function query(app,body) {
  if(body.catalog===true) {
    const dramas=all(app,"dramas","id != ''").map(r=>({id:r.id,title:r.getString("title"),freeEpisodes:r.getInt("free_episodes")}));
    return {dramas};
  }
  const drama=app.findRecordById("dramas",String(body.dramaId||""));
  const episodes=all(app,"drama_episodes","drama = {:drama}",{drama:drama.id}).filter(r=>r.getInt("episode_number")<=drama.getInt("free_episodes"));
  if(!body.highlightId) {
    const highlights=episodes.flatMap(episode=>all(app,"hook_assets","episode = {:episode} && source_class = 'episode_highlight'",{episode:episode.id}).map(r=>highlight(app,r.id)));
    return {highlights:highlights.sort((a,b)=>a.episodeNumber-b.episodeNumber||a.start-b.start)};
  }
  const target=highlight(app,body.highlightId);
  if(target.dramaId!==drama.id)throw new Error("Highlight mismatch");
  const page=body.page==null?1:body.page;if(!Number.isInteger(page)||page<1)throw new Error("Invalid page");
  const decisions=new Map(all(app,"script_hook_decisions","highlight = {:highlight}",{highlight:target.id}).map(r=>[`${r.getString("material")}:${r.getInt("scene_index")}`,r]));
  let matchKeys=new Set();try{matchKeys=new Set(all(app,'script_semantic_matches',"id != ''").map(r=>r.getString('pair_key')));}catch(_){}
  let semanticKeys=new Set(),targetSemantic=null;
  try{semanticKeys=new Set(all(app,'script_semantic_results',"id != ''").map(r=>r.getString('source_key')));
    targetSemantic=require(`${__hooks}/script_semantics_api.js`).read(app,{sourceType:'episode_analysis',sourceId:target.id,sceneIndex:0});}catch(_){}
  const materialRows=all(app,"ad_materials","source_url != ''");
  const allCandidates=materialRows.flatMap(material=>{
    const meta=json(material,"source_attribution");
    return meta&&meta.schema==="csv-hook-reference-v1"&&Array.isArray(meta.scenes)?meta.scenes.map((_,index)=>candidate(app,material,index,target,matchKeys.has($security.sha256(`${material.id}:${index}:${target.id}`))?eventMatch(app,material.id,index,target):null,
      semanticKeys.has(`csv_script:${material.id}:${index}`)?taxonomyRecall(app,material.id,index,target,targetSemantic):null)):[];
  }).filter(Boolean).map(c=>{
    const decision=decisions.get(c.id);
    if(decision&&decision.getString("input_version")===c.inputVersion)return {...c,state:decision.getString("state"),decisionId:decision.id};
    return c;
  });
  const coverage=workflowCoverage(app,episodes,materialRows,semanticKeys,allCandidates);
  const candidates=allCandidates.filter(c=>(!body.semanticOnly||c.eventComparison)&&(!body.tagOnly||c.tagRecall?.matches.length)).sort((a,b)=>({candidate:2,unsuitable:-2}[b.eventComparison?.result.verdict]||0)-({candidate:2,unsuitable:-2}[a.eventComparison?.result.verdict]||0)||(b.tagRecall?.matches.length||0)-(a.tagRecall?.matches.length||0)||b.diagnostic.signalCount-a.diagnostic.signalCount||a.id.localeCompare(b.id));
  return {target,total:candidates.length,matched:candidates.filter(c=>c.diagnostic.signalCount>0).length,page,pageSize:20,totalPages:Math.max(1,Math.ceil(candidates.length/20)),candidates:candidates.slice((page-1)*20,page*20),coverage,method:core().VERSION,productionEligible:false};
}
function decide(app,body,actor) {
  let result;
  app.runInTransaction(tx=>{
    const target=highlight(tx,body.highlightId),material=tx.findRecordById("ad_materials",String(body.materialId||""));
    if(!Number.isInteger(body.sceneIndex)||body.sceneIndex<0)throw new Error("Invalid scene");
    const c=candidate(tx,material,body.sceneIndex,target);
    if(!c||c.inputVersion!==body.inputVersion)throw new Error("Stale candidate");
    if(body.dramaId!==target.dramaId)throw new Error("Highlight mismatch");
    if(body.action==='confirm'&&c.eventComparison?.result.verdict!=='candidate')throw new Error('Event match must be reviewed before confirmation');
    if(body.action==='confirm'&&!STORYLINE_READY_RIGHTS.has(material.getString("rights_status"))) {
      const error=new Error("Material rights do not allow storyline input");
      error.safeMessage="素材授权状态必须为“已获授权可制作”或“已获授权可投放”，当前不能确认故事线输入";
      throw error;
    }
    if(body.action==='confirm'&&!STORYLINE_READY_REVIEWS.has(material.getString("review_status"))) {
      const error=new Error("Material review is not approved");
      error.safeMessage="素材分析必须经人工复核并标记为“已通过”或“已修改”，当前不能确认故事线输入";
      throw error;
    }
    let status;
    try { status=core().validateDecision(body,target,c.extracted); }
    catch(error){error.safeMessage=error.message;throw error;}
    const key=$security.sha256(`${target.id}:${material.id}:${body.sceneIndex}`);
    let record;try{record=tx.findFirstRecordByFilter("script_hook_decisions","decision_key = {:key}",{key});}catch(_){record=new Record(tx.findCollectionByNameOrId("script_hook_decisions"));}
    const previous=json(record,"context");
    const decisionSignature=$security.sha256(JSON.stringify([c.inputVersion,status.state,actor,body.action==="confirm"?[body.start,body.end,body.mediaDuration,body.note.trim()]:null]));
    if(previous&&previous.decisionSignature===decisionSignature){result={id:record.id,...previous};return;}
    const context={version:core().VERSION,inputVersion:c.inputVersion,decisionSignature,highlight:target,actor,recordedAt:new Date().toISOString(),
      candidate:{materialId:material.id,sceneIndex:body.sceneIndex,title:c.title,sourceUrl:c.videoUrl,script:c.extracted.script,fields:c.extracted.fields,concepts:c.extracted.concepts,rightsStatus:c.rightsStatus,materialReviewStatus:c.materialReviewStatus},
      diagnostic:c.diagnostic,eventComparison:c.eventComparison,decision:status.state,storylineReady:status.storylineReady,productionEligible:false,
      humanReview:body.action==="confirm"?{start:body.start,end:body.end,mediaDuration:body.mediaDuration,contentVerified:true,boundaryVerified:true,connectionVerified:true,promiseVerified:true,noSevereConflict:true,note:body.note.trim(),at:new Date().toISOString()}:null,
      nextStage:status.storylineReady?"generate_storyline_from_confirmed_context":"verify_shortlisted_video_and_boundaries"};
    const history=json(record,"history")||[];
    if(previous)history.push(previous);
    record.set("history",history);
    record.set("decision_key",key);record.set("material",material.id);record.set("highlight",target.id);record.set("scene_index",body.sceneIndex);record.set("input_version",c.inputVersion);record.set("state",status.state);record.set("context",context);tx.save(record);
    result={id:record.id,...context};
  });return result;
}
function readContext(app,id) {
  const record=app.findRecordById("script_hook_decisions",id),target=highlight(app,record.getString("highlight"));
  const c=candidate(app,app.findRecordById("ad_materials",record.getString("material")),record.getInt("scene_index"),target);
  if(!c||c.inputVersion!==record.getString("input_version"))throw new Error("Stale context");
  return {id:record.id,...json(record,"context")};
}
module.exports={query,decide,readContext,highlight,HIGHLIGHT_TEXT_PROJECTION};
