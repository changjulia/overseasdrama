// The schema and taxonomy are loaded from the same artifacts used by TS/Python.
function definitions() {
  return {
    taxonomy: JSON.parse(toString($os.readFile(`${__hooks}/../shared/global-taxonomy.json`))),
    schema: JSON.parse(toString($os.readFile(`${__hooks}/../shared/event-semantics.schema.json`)))
  };
}
function checkSchema(value, schema, root) {
  if(schema.$ref)return checkSchema(value,root.$defs[schema.$ref.split('/').pop()],root);
  const type = value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type) {
    const types=Array.isArray(schema.type)?schema.type:[schema.type];
    if(!types.some(t=>t===type||(t==='integer'&&Number.isInteger(value))))throw new Error('Schema type');
  }
  if(schema.const!==undefined&&value!==schema.const)throw new Error('Schema constant');
  if(schema.enum&&!schema.enum.includes(value))throw new Error('Schema enum');
  if(typeof value==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)))throw new Error('Schema number');
  if(typeof value==='string'&&schema.minLength&&value.length<schema.minLength)throw new Error('Schema string');
  if(Array.isArray(value)) {
    if(schema.maxItems&&value.length>schema.maxItems)throw new Error('Schema length');
    if(schema.uniqueItems&&new Set(value.map(v=>JSON.stringify(v))).size!==value.length)throw new Error('Schema unique');
    if(schema.items)value.forEach(v=>checkSchema(v,schema.items,root));
  } else if(value&&typeof value==='object') {
    for(const key of schema.required||[])if(!(key in value))throw new Error('Schema required');
    for(const key of Object.keys(value)) {
      if(schema.additionalProperties===false&&!(key in (schema.properties||{})))throw new Error('Schema property');
      if(schema.properties&&schema.properties[key])checkSchema(value[key],schema.properties[key],root);
    }
  }
}
function validate(result,text,sourceType,defs) {
  const {schema,taxonomy}=defs||definitions();
  checkSchema(result,schema,schema);
  const evidence=new Map(), claims=new Map(), characters=Array.from(text);
  for(const e of result.evidence) {
    if(evidence.has(e.id)||e.sourceType!==sourceType||e.charStart>=e.charEnd||e.charEnd>characters.length||characters.slice(e.charStart,e.charEnd).join('')!==e.quote)throw new Error('Evidence binding');
    evidence.set(e.id,e);
  }
  function walk(v) {
    if(!v||typeof v!=='object')return;
    if(v.assertionStatus) {
      if(claims.has(v.id)||v.evidenceRefs.some(id=>!evidence.has(id)))throw new Error('Claim references');
      if(v.assertionStatus==='missing'?(v.value!==null||!v.reason.trim()):(v.value===null||!v.evidenceRefs.length))throw new Error('Claim value');
      if(v.assertionStatus==='inferred'&&!v.reason.trim())throw new Error('Inference reason');
      if(v.assertionStatus==='conflicting'&&v.evidenceRefs.length<2)throw new Error('Conflict evidence');
      claims.set(v.id,v);
    }
    Object.values(v).forEach(walk);
  }
  walk(result);
  function visit(id,path) {
    if(!claims.has(id)||path.has(id))throw new Error('Claim dependency');
    const next=new Set(path);next.add(id);claims.get(id).dependsOn.forEach(dep=>visit(dep,next));
  }
  claims.forEach((_,id)=>visit(id,new Set()));
  const entities=new Set(result.entities.map(e=>e.id)),events=new Set(result.events.map(e=>e.id)),codes=new Set(taxonomy.definitions.map(t=>t.code));
  if(entities.size!==result.entities.length||events.size!==result.events.length)throw new Error('Duplicate identity');
  for(const tag of result.tags)if(tag.assertionStatus!=='missing'&&!codes.has(tag.value))throw new Error('Unknown tag');
  for(const event of result.events) {
    for(const key of ['actorIds','targetIds']) {
      const ids=event[key].value;
      if(ids!==null&&(!Array.isArray(ids)||ids.some(id=>!entities.has(id))))throw new Error('Entity direction');
    }
    for(const claim of event.relationships) {
      const r=claim.value;
      if(r!==null&&(!r||!entities.has(r.subjectId)||!entities.has(r.objectId)||!r.relation))throw new Error('Relationship direction');
    }
    for(const claim of event.chronology) {
      const r=claim.value;
      if(r!==null&&(!r||!events.has(r.eventId)||!['before','after','simultaneous','causes','explains'].includes(r.kind)))throw new Error('Chronology');
    }
    const t=event.time;
    if((t.start===null)!==(t.end===null)||(t.start!==null&&t.end<=t.start))throw new Error('Relative interval');
  }
  return result;
}
function validateMatch(result,hook,highlight) {
  const schema=JSON.parse(toString($os.readFile(`${__hooks}/../shared/event-match.schema.json`)));
  checkSchema(result,schema,schema);
  const refs=new Set([...hook.evidence.map(e=>'hook:'+e.id),...highlight.evidence.map(e=>'highlight:'+e.id)]);
  const hids=new Set(hook.events.map(e=>e.id)),pids=new Set(highlight.events.map(e=>e.id));
  function walk(v){if(!v||typeof v!=='object')return;if(v.evidenceRefs&&v.evidenceRefs.some(id=>!refs.has(id)))throw new Error('Match evidence');Object.values(v).forEach(walk);}
  walk(result);
  if(!result.evidenceRefs.some(id=>id.startsWith('hook:'))||!result.evidenceRefs.some(id=>id.startsWith('highlight:')))throw new Error('Both sources required');
  for(const pair of result.eventPairs)if(!hids.has(pair.hookEventId)||!pids.has(pair.highlightEventId))throw new Error('Match event reference');
  if(result.payoff.eventRefs.some(id=>!pids.has(id)))throw new Error('Payoff event reference');
  if(result.payoff.status==='potential'&&!result.payoff.eventRefs.length)throw new Error('Payoff evidence missing');
  if(new Set(result.continuityChecks.map(c=>c.dimension)).size!==5)throw new Error('Missing continuity checks');
  for(const c of result.continuityChecks)if(c.verdict!=='unknown'&&(!c.evidenceRefs.some(r=>r.startsWith('hook:'))||!c.evidenceRefs.some(r=>r.startsWith('highlight:'))))throw new Error('Continuity needs both sources');
  if(result.verdict==='candidate'&&!result.eventPairs.length)throw new Error('Candidate requires aligned events');
  return result;
}
function tagRecall(hook,highlight,taxonomy) {
  taxonomy=taxonomy||definitions().taxonomy;
  const known=new Map(taxonomy.definitions.map(d=>[d.code,d]));
  const usable=r=>(r.tags||[]).filter(t=>known.has(t.value)&&['explicit','inferred'].includes(t.assertionStatus)&&t.evidenceRefs.length);
  const left=usable(hook),right=usable(highlight);
  const codes=[...new Set(left.map(t=>t.value).filter(code=>right.some(t=>t.value===code)))].sort();
  return {method:taxonomy.version,state:codes.length?'tag_candidates':'no_shared_tags',
    matches:codes.map(code=>({code,label:known.get(code).label||code,dimension:code.split('.')[0],
      hookClaims:left.filter(t=>t.value===code).map(t=>({id:t.id,status:t.assertionStatus,evidenceRefs:t.evidenceRefs})),
      highlightClaims:right.filter(t=>t.value===code).map(t=>({id:t.id,status:t.assertionStatus,evidenceRefs:t.evidenceRefs}))})),
    semanticVerdict:'unknown',productionEligible:false};
}
module.exports={definitions,validate,validateMatch,checkSchema,tagRecall};
