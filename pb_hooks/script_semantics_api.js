function canonical(value) {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function source(app,body) {
  if(!/^[a-z0-9]{15}$/.test(body.sourceId||''))throw new Error('Invalid source');
  let text,version;
  const index=body.sceneIndex==null?0:body.sceneIndex;
  if(!Number.isInteger(index)||index<0)throw new Error('Invalid scene');
  if(body.sourceType==='csv_script') {
    const material=app.findRecordById('ad_materials',body.sourceId);
    const meta=JSON.parse(material.getString('source_attribution'));
    if(meta.schema!=='csv-hook-reference-v1'||!meta.scenes[index]||typeof meta.scenes[index].script!=='string')throw new Error('Invalid script source');
    text=meta.scenes[index].script;
    version={sourceIdentity:material.getString('source_identity_hash'),sceneNumber:meta.scenes[index].sceneNumber};
  } else if(body.sourceType==='episode_analysis'&&index===0) {
    const target=require(`${__hooks}/script_hook_candidate_api.js`).highlight(app,body.sourceId);
    // Only evidence-bearing identity belongs in the semantic fingerprint.
    // Rights/review/safety gates remain live in highlight(), candidate versions,
    // and production checks; changing those must not rewrite evidence offsets.
    text=target.text;version={episodeId:target.episodeId,start:target.start,end:target.end,sourceVersion:target.semanticSourceVersion};
  } else if(body.sourceType==='episode_checkpoint'&&index===0) {
    const checkpoint=require(`${__hooks}/episode_semantic_source.js`).source(app,body.sourceId);
    text=checkpoint.text;version=checkpoint.version;
  } else throw new Error('Unsupported source');
  text=text.replace(/\r\n?/g,'\n').normalize('NFC');
  const key=`${body.sourceType}:${body.sourceId}:${index}`,scriptHash=$security.sha256(text);
  return {key,sourceType:body.sourceType,sourceId:body.sourceId,sceneIndex:index,text,scriptHash,sourceVersion:version,
    fingerprint:$security.sha256(canonical({key,scriptHash,version}))};
}
function read(app,body) {
  const input=source(app,body);
  let record;
  try {record=app.findRecordsByFilter('script_semantic_results','source_key = {:key} && source_fingerprint = {:fingerprint}','-created,-id',1,0,{key:input.key,fingerprint:input.fingerprint})[0];}catch(_){return {input,state:'unavailable',productionEligible:false};}
  if(!record)return {input,state:input.text.trim()?'not_extracted':'missing',productionEligible:false};
  const result=JSON.parse(record.getString('result'));
  require(`${__hooks}/global_semantics_helpers.js`).validate(result,input.text,input.sourceType);
  return {id:record.id,input,state:record.getString('state'),result,identity:JSON.parse(record.getString('identity')),
    contentVersion:record.getString('result_hash'),productionEligible:false};
}
function save(app,body,actor) {
  let out;
  app.runInTransaction(tx=>{
    const input=source(tx,body),identity=body.identity||{};
    if(body.sourceFingerprint!==input.fingerprint||identity.scriptHash!==input.scriptHash||identity.sourceType!==input.sourceType)throw new Error('Stale source');
    if(!/^[a-f0-9]{64}$/.test(body.cacheKey||'')||identity.schema!=='event-semantics-v1'||identity.taxonomy!=='global-taxonomy-v1'||typeof identity.model!=='string'||!identity.model||identity.model.length>100||typeof identity.prompt!=='string'||!/^script-events-v\d+$/.test(identity.prompt))throw new Error('Invalid identity');
    const result=require(`${__hooks}/global_semantics_helpers.js`).validate(body.result,input.text,input.sourceType);
    const hash=$security.sha256(canonical(result));
    let record;
    try {record=tx.findFirstRecordByFilter('script_semantic_results','source_key = {:key} && source_fingerprint = {:fingerprint} && cache_key = {:cache}',{key:input.key,fingerprint:input.fingerprint,cache:body.cacheKey});}catch(_){record=new Record(tx.findCollectionByNameOrId('script_semantic_results'));}
    if(record.getString('result_hash')) {
      if(record.getString('result_hash')!==hash)throw new Error('Immutable version differs');
    }else{
      record.set('source_key',input.key);record.set('source_fingerprint',input.fingerprint);record.set('cache_key',body.cacheKey);record.set('result_hash',hash);
      record.set('state','extracted_pending_video');record.set('identity',identity);record.set('result',result);
      record.set('provenance',{actor,sourceVersion:input.sourceVersion,sourceType:input.sourceType,sourceId:input.sourceId,sceneIndex:input.sceneIndex});tx.save(record);
    }
    out={id:record.id,state:'extracted_pending_video',contentVersion:hash,productionEligible:false};
  });return out;
}
function pair(app,body){
  const hook=read(app,{sourceType:'csv_script',sourceId:body.materialId,sceneIndex:body.sceneIndex});
  const highlight=read(app,{sourceType:'episode_analysis',sourceId:body.highlightId,sceneIndex:0});
  if(!hook.result||!highlight.result)return {state:'not_extracted',hook,highlight,productionEligible:false};
  const pairKey=$security.sha256(`${body.materialId}:${body.sceneIndex}:${body.highlightId}`);
  const inputVersion=$security.sha256(canonical([hook.contentVersion,highlight.contentVersion,hook.input.fingerprint,highlight.input.fingerprint]));
  let row;try{row=app.findRecordsByFilter('script_semantic_matches','pair_key = {:key} && input_version = {:version}','-created,-id',1,0,{key:pairKey,version:inputVersion})[0];}catch(_){}
  const result=row?JSON.parse(row.getString('result')):null;
  if(result)require(`${__hooks}/global_semantics_helpers.js`).validateMatch(result,hook.result,highlight.result);
  return {state:result?'matched_pending_review':'not_matched',pairKey,inputVersion,hook,highlight,result,matchId:row?.id,productionEligible:false};
}
function savePair(app,body,actor){
  let out;app.runInTransaction(tx=>{
    const current=pair(tx,body);
    if(!current.inputVersion||current.inputVersion!==body.inputVersion)throw new Error('Stale pair');
    if(typeof body.model!=='string'||!body.model||body.model.length>100||body.promptVersion!=='event-match-v1')throw new Error('Invalid model metadata');
    require(`${__hooks}/global_semantics_helpers.js`).validateMatch(body.result,current.hook.result,current.highlight.result);
    let row;try{row=tx.findFirstRecordByFilter('script_semantic_matches','pair_key = {:key} && input_version = {:version} && model = {:model} && prompt_version = {:prompt}',{key:current.pairKey,version:current.inputVersion,model:body.model,prompt:body.promptVersion});}catch(_){row=new Record(tx.findCollectionByNameOrId('script_semantic_matches'));}
    if(row.getString('pair_key')){if(canonical(JSON.parse(row.getString('result')))!==canonical(body.result))throw new Error('Immutable match version');}
    else {row.set('pair_key',current.pairKey);row.set('input_version',current.inputVersion);row.set('model',body.model);row.set('prompt_version',body.promptVersion);row.set('result',body.result);row.set('provenance',{actor,hookSemanticId:current.hook.id,highlightSemanticId:current.highlight.id});tx.save(row);}
    out={id:row.id,state:'matched_pending_review',productionEligible:false};
  });return out;
}
module.exports={source,read,save,pair,savePair};
