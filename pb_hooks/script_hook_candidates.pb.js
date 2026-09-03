routerAdd("POST", "/api/lumina/script-hook-candidates/query", e => {
  const h = require(`${__hooks}/script_hook_candidate_api.js`);
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  try { return e.json(200,h.query(e.app,e.requestInfo().body||{})); }
  catch (_) { return e.json(400,{message:"无法读取候选，请确认剧目、高光及分页参数有效"}); }
});
routerAdd("POST", "/api/lumina/script-hook-candidates/decision", e => {
  const h = require(`${__hooks}/script_hook_candidate_api.js`);
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  const expected=$os.getenv("LUMINA_UI_GATEWAY_TOKEN");
  const headers=e.requestInfo().headers;
  const gateway=expected&&String(headers.authorization||"")===`Bearer ${expected}`;
  const actor=gateway?{kind:"authenticated_gateway_user",id:String(headers["x-lumina-user-id"]||"")}:{kind:"local_workstation",id:"local-workstation-operator"};
  if(gateway&&!actor.id)throw new ForbiddenError("Authenticated user identity required");
  try { return e.json(200,h.decide(e.app,e.requestInfo().body||{},actor)); }
  catch (error) { return e.json(400,{message:error.safeMessage||"保存失败：输入可能已变化，请刷新候选后重试"}); }
});
routerAdd("GET", "/api/lumina/script-hook-candidates/contexts/{id}", e => {
  require(`${__hooks}/hook_factory_helpers.js`).authorizeUi(e);
  try { return e.json(200,require(`${__hooks}/script_hook_candidate_api.js`).readContext(e.app,e.request.pathValue("id"))); }
  catch (_) { return e.json(409,{message:"上下文已失效或源记录已变化，请重新核验"}); }
});
