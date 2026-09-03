import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
function load(name, globals={}) {const ctx={module:{exports:{}},...globals};vm.runInNewContext(fs.readFileSync(`pb_hooks/${name}.js`,'utf8'),ctx);return ctx.module.exports;}
const core=load('script_hook_candidate_helpers'), links=load('material_link_reference_helpers');
const sha256=s=>crypto.createHash('sha256').update(s).digest('hex');
class Record {constructor(value={}){this.data={...value};this.id=value.id||'newdecision0001';}getString(k){const v=this.data[k];return v&&typeof v==='object'?JSON.stringify(v):String(v??'');}getInt(k){return Number(this.data[k]||0);}getFloat(k){return Number(this.data[k]||0);}getBool(k){return this.data[k]===true;}set(k,v){this.data[k]=v;}collection(){return {id:'collection00001'};}}
const matchedSemantics={pair:()=>({matchId:'match0000000001',inputVersion:'semantic-input',hook:{id:'hook-semantic'},highlight:{id:'highlight-semantic'},result:{verdict:'candidate'}}),read:()=>({})};
const apiWithMatch=load('script_hook_candidate_api',{__hooks:'.',Record,$security:{sha256},require:n=>n.endsWith('script_hook_candidate_helpers.js')?core:n.endsWith('script_semantics_api.js')?matchedSemantics:links});
const api=load('script_hook_candidate_api',{__hooks:'.',Record,$security:{sha256},require:n=>n.endsWith('script_hook_candidate_helpers.js')?core:links});
const semantics=load('script_semantics_api',{__hooks:'.',$security:{sha256},require:n=>n.endsWith('script_hook_candidate_api.js')?api:null});
function fixture(size=1){
 const drama=new Record({id:'drama',free_episodes:1,copyright_status:'pending'}),episode=new Record({id:'episode',drama:'drama',episode_number:1,duration_seconds:100,video:'episode.mp4'});
 const hook=new Record({id:'highlight',drama:'drama',episode:'episode',source_class:'episode_highlight',start_seconds:1,end_seconds:10,spoken_summary:'公主反抗母亲',boundary_status:'unverified',review_status:'needs_review'});
 const materials=Array.from({length:size},(_,i)=>new Record({id:`mat${String(i).padStart(12,'0')}`,source_url:`https://zqingalioss.wozhangwan.com/${i}.mp4`,rights_status:'仅限内部分析',review_status:'待复核',source_attribution:{schema:'csv-hook-reference-v1',verification:'unverified',scenes:[{sceneNumber:1,script:'镜头描述：公主反抗命令。\n台词：母亲救命。\n[00:00--00:00]'}]}}));
 const decisions=[],semanticMatches=[],semanticResults=[];
 const tables={dramas:[drama],drama_episodes:[episode],hook_assets:[hook],ad_materials:materials,script_hook_decisions:decisions,script_semantic_matches:semanticMatches,script_semantic_results:semanticResults};
 const app={findRecordById:(table,id)=>{const r=tables[table].find(r=>r.id===id);if(!r)throw Error('not found');return r;},
 findRecordsByFilter:(table,filter,sort,limit,offset)=>tables[table].slice(offset,offset+limit),
 findFirstRecordByFilter:(table,filter,params)=>{const r=tables[table].find(r=>r.getString('decision_key')===params.key);if(!r)throw Error('not found');return r;},
 findCollectionByNameOrId:()=>({}),runInTransaction:fn=>fn(app),save:r=>{if(!decisions.includes(r))decisions.push(r);}};
 return {app,drama,episode,hook,materials,decisions,semanticMatches,semanticResults};
}
test('script explicit, inferred concepts and missing promises are distinct',()=>{const ex=core.extractScene({sceneNumber:1,script:'镜头描述：公主愤怒反抗。\n台词：不！'});assert.equal(ex.fields.events.status,'script_explicit');assert.equal(ex.fields.promise.status,'missing');assert.equal(ex.concepts[0].status,'inferred');assert.equal(core.rankCandidate(ex,'公主').promiseVerdict,'unknown');});
test('no lexical match never invents a recommendation or semantic score',()=>{const d=core.rankCandidate(core.extractScene({script:'镜头描述：菜地长出蔬菜'}),'狼族觉醒');assert.equal(d.state,'no_clear_signal');assert.equal(d.productionEligible,false);assert.equal(d.score,undefined);});
test('tentative wording is preserved as inferred per claim, not promoted to fact',()=>{const e=core.extractScene({script:'镜头描述：男子伸出手。\n镜头描述：女子似乎在归队。'});assert.equal(e.fields.events.claims[0].status,'script_explicit');assert.equal(e.fields.events.claims[1].status,'inferred');assert.equal(e.fields.events.status,'inferred');});
test('empty script cannot shortlist; invalid times are flagged',()=>{assert.throws(()=>core.validateDecision({action:'shortlist'},{},core.extractScene({script:''})));assert.ok(core.extractScene({script:'[00:03--00:03]'}).warnings.some(w=>w.includes('无效')));assert.ok(core.extractScene({script:'[00:61--01:03]'}).warnings.some(w=>w.includes('无效')));});
test('catalog scans beyond 500 records, paginates scenes and reports fail-closed coverage',()=>{const f=fixture(505),q=api.query(f.app,{dramaId:'drama',highlightId:'highlight',page:26});assert.equal(q.total,505);assert.equal(q.candidates.length,5);assert.deepEqual(JSON.parse(JSON.stringify(q.coverage)),{episodes:{total:1,current:0,events:0},highlights:{total:1,current:0},scripts:{total:505,nonEmpty:505,current:0},matches:{current:0},confirmed:{current:0},candidateSemantics:{total:505,withTagRecall:0,withEventMatch:0,rulesOnly:505}});});
test('cross-drama and paid highlights are rejected',()=>{const f=fixture();f.hook.set('drama','other');assert.throws(()=>api.query(f.app,{dramaId:'drama',highlightId:'highlight'}));f.hook.set('drama','drama');f.episode.set('episode_number',2);assert.throws(()=>api.query(f.app,{dramaId:'drama',highlightId:'highlight'}));});
test('unsupported sources are excluded',()=>{const f=fixture();f.materials[0].set('source_url','https://127.0.0.1/private');assert.equal(api.query(f.app,{dramaId:'drama',highlightId:'highlight'}).total,0);});
test('invalid explicit page values do not silently become page one',()=>{const f=fixture();for(const page of [0,-1,1.5,'1'])assert.throws(()=>api.query(f.app,{dramaId:'drama',highlightId:'highlight',page}));});
test('shortlist is idempotent, traceable and not production eligible; input changes invalidate context',()=>{const f=fixture(),c=api.query(f.app,{dramaId:'drama',highlightId:'highlight'}).candidates[0];const body={action:'shortlist',dramaId:'drama',highlightId:'highlight',materialId:c.materialId,sceneIndex:0,inputVersion:c.inputVersion};const actor={kind:'unit_fixture',id:'reviewer-fixture'};const a=api.decide(f.app,body,actor),b=api.decide(f.app,body,actor);assert.equal(a.id,b.id);assert.equal(f.decisions.length,1);assert.equal(f.decisions[0].data.history.length,0);assert.equal(a.storylineReady,false);assert.equal(a.productionEligible,false);assert.equal(api.readContext(f.app,a.id).actor.id,actor.id);f.materials[0].set('rights_status','授权待确认');assert.throws(()=>api.readContext(f.app,a.id));assert.throws(()=>api.decide(f.app,body,actor));});
test('unverified highlight, missing attestations and short hook cannot be confirmed',()=>{const ex=core.extractScene({script:'实际脚本'}),body={action:'confirm',start:0,end:6,mediaDuration:30,contentVerified:true,boundaryVerified:true,connectionVerified:true,promiseVerified:true,noSevereConflict:true,note:'合成测试的人工核验依据，仅用于组件测试'};assert.throws(()=>core.validateDecision(body,{boundaryStatus:'unverified',reviewStatus:'needs_review'},ex));const h={boundaryStatus:'verified',reviewStatus:'approved'};assert.throws(()=>core.validateDecision({...body,contentVerified:false},h,ex));assert.throws(()=>core.validateDecision({...body,end:4},h,ex));assert.equal(core.validateDecision(body,h,ex).storylineReady,true);});
test('confirm requires the documented material rights and approved review values',()=>{
 const bodyFor=(candidate)=>({action:'confirm',dramaId:'drama',highlightId:'highlight',materialId:candidate.materialId,sceneIndex:0,inputVersion:candidate.inputVersion,start:0,end:6,mediaDuration:30,contentVerified:true,boundaryVerified:true,connectionVerified:true,promiseVerified:true,noSevereConflict:true,note:'已逐项核验钩子内容、边界、承接关系和兑现依据'});
 const actor={kind:'unit_fixture',id:'reviewer-fixture'};
 for(const rights of ['已获授权可制作','已获授权可投放'])for(const review of ['已通过','已修改']){
   const f=fixture();f.hook.set('boundary_status','verified');f.hook.set('review_status','approved');f.materials[0].set('rights_status',rights);f.materials[0].set('review_status',review);f.semanticMatches.push(new Record({pair_key:sha256(`${f.materials[0].id}:0:${f.hook.id}`)}));
   const candidate=apiWithMatch.query(f.app,{dramaId:'drama',highlightId:'highlight'}).candidates[0];const result=apiWithMatch.decide(f.app,bodyFor(candidate),actor);
   assert.equal(result.storylineReady,true);assert.equal(result.productionEligible,false);assert.equal(result.candidate.rightsStatus,rights);assert.equal(result.candidate.materialReviewStatus,review);
 }
 for(const [rights,review,error] of [['仅限内部分析','已通过',/rights/],['授权待确认','已修改',/rights/],['已获授权可制作','待复核',/review/],['已获授权可投放','退回重分析',/review/]]){
   const f=fixture();f.hook.set('boundary_status','verified');f.hook.set('review_status','approved');f.materials[0].set('rights_status',rights);f.materials[0].set('review_status',review);f.semanticMatches.push(new Record({pair_key:sha256(`${f.materials[0].id}:0:${f.hook.id}`)}));
   const candidate=apiWithMatch.query(f.app,{dramaId:'drama',highlightId:'highlight'}).candidates[0];assert.throws(()=>apiWithMatch.decide(f.app,bodyFor(candidate),actor),error);
 }
});
test('authenticated gateway permits only exact candidate routes, collection CRUD stays locked',()=>{const code=fs.readFileSync('app/api/pocketbase/[...path]/route.ts','utf8');const lines=code.split('\n').filter(l=>l.includes('["POST", /^\\/api\\/lumina\\/script-hook-candidates')||l.includes('["GET", /^\\/api\\/lumina\\/script-hook-candidates'));assert.equal(lines.length,2);const pairs=vm.runInNewContext('['+lines.join('\n')+']');assert.ok(pairs.some(([method,r])=>method==='POST'&&r.test('/api/lumina/script-hook-candidates/query')));assert.ok(!pairs.some(([,r])=>r.test('/api/lumina/script-hook-candidates/query/anything')));assert.doesNotMatch(code.match(/const WRITABLE_COLLECTIONS[^;]+/)[0],/script_hook_decisions/);});

test('highlight API separates evidence fields and decodes stored JSON relationships',()=>{
 const f=fixture();
 f.hook.set('spoken_summary','什么？！快走！');
 f.hook.set('visual_summary','人群进入山洞。');
 f.hook.set('relationships',['领袖与伴侣互相支持','信任关系面临危机']);
 const target=api.query(f.app,{dramaId:'drama',highlightId:'highlight'}).target;
 assert.deepEqual(Array.from(target.content.relationships),['领袖与伴侣互相支持','信任关系面临危机']);
 assert.deepEqual(Array.from(target.content.spokenSummary),['什么？！快走！']);
 assert.deepEqual(Array.from(target.content.conflict),[]);
 assert.equal(target.text,'什么？！快走！；人群进入山洞。；领袖与伴侣互相支持；信任关系面临危机');
 assert.equal(target.boundaryStatus,'unverified');
 assert.equal(target.reviewStatus,'needs_review');
 assert.deepEqual(f.hook.data.relationships,['领袖与伴侣互相支持','信任关系面临危机']);
});
test('text normalization preserves prose and only reads explicit text from claims',()=>{
 const values=['普通人物关系','["关系甲",{"value":"关系乙","verification":"verified"}]',{text:'保留“引号”与换行\n下一行'},null,42,{status:'verified'}];
 assert.deepEqual(Array.from(core.evidenceText(values)),['普通人物关系','关系甲','关系乙','保留“引号”与换行\n下一行']);
 assert.deepEqual(Array.from(core.evidenceText('[不完整但真实的原文')),['[不完整但真实的原文']);
});
test('highlight semantic projection is stable across equivalent JSON storage and operational review changes',()=>{
 const f=fixture();f.hook.id='hooksource00001';
 f.episode.set('analysis_result','stable episode analysis');
 f.hook.set('analysis_version','highlight-v3:fixture');
 f.hook.set('spoken_summary','公主反抗母亲');
 f.hook.set('relationships','[ "母女关系", {"value":"权力对抗", "verification":"verified"} ]');
 const first=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 assert.equal(first.text,'公主反抗母亲；母女关系；权力对抗');
 assert.equal(first.scriptHash,'0449825d582a693971550a66fa07296352140b4b016906a8f1168373d3af6012');
 assert.equal(first.sourceVersion.sourceVersion.projection,'episode-highlight-text-v2');
 f.hook.set('relationships',['母女关系',{verification:'unverified',value:'权力对抗'}]);f.episode.set('analysis_result','same generation with unrelated review metadata');
 f.hook.set('rights_status','授权待确认');f.hook.set('review_status','approved');f.hook.set('safe_start',true);f.drama.set('copyright_status','内部验收');
 const second=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 assert.equal(second.text,first.text);assert.equal(second.scriptHash,first.scriptHash);assert.equal(second.fingerprint,first.fingerprint);
});
test('highlight semantic projection fails closed when evidence content, interval or upstream generation changes',()=>{
 const f=fixture();f.hook.id='hooksource00001';f.episode.set('analysis_result','analysis-v1');f.hook.set('analysis_version','highlight-v3:fixture');
 const original=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 f.hook.set('spoken_summary','公主拒绝母亲');
 const contentChanged=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 assert.notEqual(contentChanged.scriptHash,original.scriptHash);assert.notEqual(contentChanged.fingerprint,original.fingerprint);
 f.hook.set('spoken_summary','公主反抗母亲');f.hook.set('start_seconds',2);
 const intervalChanged=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 assert.notEqual(intervalChanged.fingerprint,original.fingerprint);
 f.hook.set('start_seconds',1);f.hook.set('analysis_version','highlight-v4:new-generation');
 const analysisChanged=semantics.source(f.app,{sourceType:'episode_analysis',sourceId:f.hook.id,sceneIndex:0});
 assert.notEqual(analysisChanged.fingerprint,original.fingerprint);
});
