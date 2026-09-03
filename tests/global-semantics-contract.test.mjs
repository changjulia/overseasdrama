import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DIMENSIONS,TAXONOMY_VERSION,normalizeTag} from '../app/lib/ontology/normalization.ts';
const taxonomy=JSON.parse(fs.readFileSync('shared/global-taxonomy.json','utf8'));
const schema=JSON.parse(fs.readFileSync('shared/event-semantics.schema.json','utf8'));
const ctx={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync('pb_hooks/global_semantics_helpers.js','utf8'),ctx);
const validate=(r,t)=>ctx.module.exports.validate(r,t,'csv_script',{taxonomy,schema});
function sample(){
 const claim=(id,value=null)=>({id,value,assertionStatus:value===null?'missing':'explicit',verificationStatus:'unverified',evidenceRefs:value===null?[]:['e'],reason:value===null?'输入未说明':'',dependsOn:[]});
 return {schemaVersion:'event-semantics-v1',taxonomyVersion:TAXONOMY_VERSION,entities:[],events:[],tags:[claim('tag','theme.复仇')],evidence:[{id:'e',sourceType:'csv_script',quote:'复仇',charStart:1,charEnd:3}],continuation:Object.fromEntries(schema.properties.continuation.required.map(k=>[k,claim(k)]))};
}
test('all runtimes share dimensions, canonical codes and legacy identity mappings',()=>{
 assert.deepEqual([...DIMENSIONS],taxonomy.dimensions);assert.equal(TAXONOMY_VERSION,taxonomy.version);
 for(const d of taxonomy.definitions){assert.equal(normalizeTag({code:d.code}).code,d.code);assert.equal(taxonomy.legacyCodeMap[d.code],d.code);}
});

test('persisted taxonomy recall preserves inference and cannot certify an event match',()=>{
 const a=sample(),b=sample();b.tags[0].assertionStatus='inferred';
 let recall=ctx.module.exports.tagRecall(a,b,taxonomy);
 assert.equal(recall.matches.length,1);assert.equal(recall.matches[0].highlightClaims[0].status,'inferred');
 assert.equal(recall.semanticVerdict,'unknown');assert.equal(recall.productionEligible,false);
 b.tags[0].assertionStatus='conflicting';assert.equal(ctx.module.exports.tagRecall(a,b,taxonomy).matches.length,0);
 b.tags[0].value='unknown';a.tags[0].value='unknown';assert.equal(ctx.module.exports.tagRecall(a,b,taxonomy).matches.length,0);
});
test('PB schema validates Unicode codepoint evidence, never fabricated verification',()=>{
 const r=sample();validate(r,'😀复仇');
 for(const mutate of [r=>r.tags[0].verificationStatus='verified',r=>r.evidence[0].charStart=2,r=>r.tags[0].value='theme.未收录',r=>r.continuation.promise.value='编造结果',r=>r.tags[0].dependsOn=['tag']]){
  const bad=structuredClone(r);mutate(bad);assert.throws(()=>validate(bad,'😀复仇'));
 }
});
