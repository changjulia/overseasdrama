import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture(){
 const box={module:{exports:{}},Math,Number,String,Object,Array,JSON,Error};
 vm.runInNewContext(fs.readFileSync(new URL('../pb_hooks/narration_intake_helpers.js',import.meta.url),'utf8'),box);
 const record=(id,values)=>({id,values,get:k=>values[k],getString:k=>String(values[k]||''),set:(k,v)=>values[k]=v});
 const h=record('hook',{source_class:'narration_opening',usage_role:'pre_roll',material:'material',analysis:{cacheKey:'a'.repeat(64),schemaVersion:'narration-opening-v1'},review_status:'needs_review'});
 const m=record('material',{duration_seconds:200,opening_analysis:{scope:'opening_only'},analysis_status:'idle'});
 const app={findRecordById:(c)=>c==='hook_assets'?h:m,save:()=>{}};
 const input={hookId:'hook',sourceCacheKey:'a'.repeat(64),resultKey:'b'.repeat(64),budget:{cap:2079,used:900},boundary:{status:'candidate',end:75,reason:'local text evidence'},transcript:[{start:0,end:75,text:'Actual narration.'},{start:77,end:80,text:'Dialogue.'}]};
 return {save:box.module.exports.saveBoundary,app,h,m,input};
}
test('long candidate persists to the existing hook, invalidates match version, never approves production',()=>{
 const {save,app,h,m,input}=fixture();save(app,input);
 assert.equal(h.values.end_seconds,75);assert.equal(h.values.safe_end.status,'unverified');
 assert.equal(h.values.review_status,'needs_review');assert.match(h.values.analysis_version,/narration-boundary-v1/);
 assert.equal(h.values.evidence.transcript.length,1);assert.equal(m.values.analysis_status,'idle');
 assert.equal(save(app,input).reused,true);
});
test('cannot exceed budget, invent an endpoint or overwrite human review',()=>{
 for(const mutate of [x=>x.input.budget.used=2080,x=>x.input.boundary.end=60,x=>x.h.values.review_status='approved',x=>x.h.values.boundary_status='verified']){
  const x=fixture();mutate(x);assert.throws(()=>x.save(x.app,x.input));
 }
});

test('only Chinese summaries scoped to the selected complete hook become ready',()=>{
 for(const invalid of [{summaryVersion:'old'}, {summaryCoverageEnd:15}, {semantic:{summary:'English only',conflict:'',promise:'',identity:''}}, {semantic:{summary:'女主嫁给 billionaire',conflict:'',promise:'',identity:''}}]) {
  const x=fixture();Object.assign(x.input,{summaryVersion:'hook-summary-zh-v1',summaryCoverageEnd:75,semantic:{summary:'主角遭遇危机',conflict:'身份受到质疑',promise:'等待主角回应',identity:'主角身份未明'}},invalid);
  x.save(x.app,x.input);assert.notEqual(x.h.values.analysis.summaryStatus,'ready');
 }
 const x=fixture();Object.assign(x.input,{summaryVersion:'hook-summary-zh-v1',summaryCoverageEnd:75,semantic:{summary:'主角遭遇危机',conflict:'身份受到质疑',promise:'等待主角回应',identity:'主角身份未明'}});
 x.save(x.app,x.input);assert.equal(x.h.values.analysis.summaryStatus,'ready');assert.equal(x.h.values.analysis.summaryCoverageEnd,75);assert.equal(x.h.values.spoken_summary,'主角遭遇危机');assert.equal(x.h.values.safe_end.status,'unverified');
 x.save(x.app,{...x.input,resultKey:'c'.repeat(64),boundary:{status:'needs_context',reason:'后续仍在铺垫'},semantic:{}});
 assert.equal(x.h.values.spoken_summary,'');assert.equal(x.h.values.conflict,'');assert.equal(x.h.values.analysis.semanticStatus,'pending');
});
