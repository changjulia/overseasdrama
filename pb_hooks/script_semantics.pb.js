routerAdd('POST','/api/lumina/script-semantics/read', e=>{
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  try{return e.json(200,require(`${__hooks}/script_semantics_api.js`).read(e.app,e.requestInfo().body||{}));}
  catch(_){return e.json(400,{message:'语义来源或证据无效，请刷新后重试'});}
});
routerAdd('POST','/api/lumina/script-semantics/pair',e=>{
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  try{return e.json(200,require(`${__hooks}/script_semantics_api.js`).pair(e.app,e.requestInfo().body||{}));}catch(_){return e.json(400,{message:'事件匹配来源无效'});}
});
routerAdd('POST','/api/lumina/script-semantics/save-pair',e=>{
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const gateway=$os.getenv('LUMINA_UI_GATEWAY_TOKEN');const actor={kind:gateway?'authenticated_gateway_user':'local_workstation',id:gateway?String(e.requestInfo().headers['x-lumina-user-id']||''):'local-workstation-operator'};
  if(!actor.id)throw new ForbiddenError('Authenticated operator required');
  try{return e.json(200,require(`${__hooks}/script_semantics_api.js`).savePair(e.app,e.requestInfo().body||{},actor));}catch(error){const allowed=['Match evidence','Both sources required','Match event reference','Payoff event reference','Payoff evidence missing','Missing continuity checks','Continuity needs both sources','Candidate requires aligned events','Stale pair','Invalid model metadata','Immutable match version'];return e.json(400,{message:'事件匹配未通过证据校验或输入已变化',safeCode:allowed.includes(error.message)?error.message:'schema_or_storage'});}
});
routerAdd('POST','/api/lumina/script-semantics/save', e=>{
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const headers=e.requestInfo().headers;
  const gateway=$os.getenv('LUMINA_UI_GATEWAY_TOKEN');
  const actor=gateway?{kind:'authenticated_gateway_user',id:String(headers['x-lumina-user-id']||'')}:{kind:'local_workstation',id:'local-workstation-operator'};
  if(!actor.id)throw new ForbiddenError('Authenticated operator required');
  try{return e.json(200,require(`${__hooks}/script_semantics_api.js`).save(e.app,e.requestInfo().body||{},actor));}
  catch(_){return e.json(400,{message:'保存失败：来源已变化或语义契约未通过；不会写入已核验结果'});}
});
