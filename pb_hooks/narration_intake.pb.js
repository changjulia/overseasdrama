routerAdd("POST", "/api/lumina/narration-intake", (e) => {
  // Batch tooling uses the existing worker credential, never a browser bypass.
  require(`${__hooks}/material_analysis_helpers.js`).authorize(e);
  const helpers = require(`${__hooks}/narration_intake_helpers.js`);
  let result;
  try {
    e.app.runInTransaction((tx) => { result = helpers.importOpening(tx, e.requestInfo().body); });
  } catch (error) { throw new BadRequestError(String(error.message || error)); }
  return e.json(200, result);
});

routerAdd("POST", "/api/lumina/narration-intake/semantics", (e) => {
  require(`${__hooks}/material_analysis_helpers.js`).authorize(e);
  const helpers = require(`${__hooks}/narration_intake_helpers.js`);
  let result;
  try { e.app.runInTransaction((tx) => { result = helpers.saveSemantics(tx, e.requestInfo().body); }); }
  catch (error) { throw new BadRequestError(String(error.message || error)); }
  return e.json(200, result);
});
routerAdd("POST", "/api/lumina/narration-intake/boundary", (e) => {
  require(`${__hooks}/material_analysis_helpers.js`).authorize(e);
  let result;
  try { e.app.runInTransaction((tx) => { result = require(`${__hooks}/narration_intake_helpers.js`).saveBoundary(tx, e.requestInfo().body); }); }
  catch (error) { throw new BadRequestError(String(error.message || error)); }
  return e.json(200, result);
});
routerAdd("POST", "/api/lumina/narration-intake/normalize-summaries", (e) => {
  require(`${__hooks}/material_analysis_helpers.js`).authorize(e);
  let result;
  try { e.app.runInTransaction((tx) => { result = require(`${__hooks}/narration_intake_helpers.js`).normalizeSummaries(tx, e.requestInfo().body); }); }
  catch(error) { throw new BadRequestError(String(error.message || error)); }
  return e.json(200,result);
});
