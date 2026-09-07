/** Read-only snapshot: coverage, language, lifetime budget, production gates. */
import {readFile,readdir,writeFile} from 'node:fs/promises';
const root='.codex-runtime/narration-intake',ledgerDir=root+'/boundary-ledger';
const entries=await Promise.all((await readdir(ledgerDir)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(ledgerDir+'/'+f,'utf8'))));
const hooks=[];
for(let page=1,pages=1;page<=pages;page++) {
 const url=new URL('http://127.0.0.1:8090/api/collections/hook_assets/records');
 url.searchParams.set('page',String(page));url.searchParams.set('perPage','500');url.searchParams.set('filter','source_class="narration_opening"');url.searchParams.set('fields','id,material,start_seconds,end_seconds,boundary_status,safe_start,safe_end,spoken_summary,analysis.boundarySelection,analysis.summaryStatus,analysis.summaryVersion,analysis.summaryCoverageEnd,analysis.tokenBudget');
 const r=await fetch(url);if(!r.ok)throw new Error('cannot audit hooks');const data=await r.json();hooks.push(...data.items);pages=data.totalPages;
}
const states={},errors=[];
const byHook=new Map(entries.map(l=>[l.hookId,l]));
const pendingSummaryReasons={},endRanges={upTo15:0,over15To60:0,over60:0};
for(const h of hooks){const state=h.analysis?.boundarySelection?.status||'pending';states[state]=(states[state]||0)+1;
 if(h.analysis?.summaryStatus==='ready'&&(!/[\u3400-\u9fff]/.test(h.spoken_summary)||h.analysis.summaryCoverageEnd!==h.end_seconds||h.analysis.summaryVersion!=='hook-summary-zh-v1'))errors.push({id:h.id,error:'summary scope/language mismatch'});
 if(h.analysis?.summaryStatus==='ready') {
  const ledger=byHook.get(h.id),p=ledger?.payload,call=ledger?.calls.find(c=>c.stage==='summary-zh-v1');
  const selected=p?.transcript?.filter(s=>s.end<=h.end_seconds+.01).map(s=>s.text).join(' ');
  if(!selected||!call?.prompt?.endsWith('\n'+selected))errors.push({id:h.id,error:'summary request did not use exactly the selected hook transcript'});
 }
 if(state==='candidate'&&h.analysis.boundarySelection.end!==h.end_seconds)errors.push({id:h.id,error:'candidate interval mismatch'});
 if(h.boundary_status==='verified'||h.safe_end?.status==='verified')errors.push({id:h.id,error:'unexpected production approval; check human audit'});
 if(state==='candidate') {
  endRanges[h.end_seconds<=15?'upTo15':h.end_seconds<=60?'over15To60':'over60']++;
  if(h.analysis?.summaryStatus!=='ready') {
   const ledger=byHook.get(h.id),call=ledger?.calls.find(c=>c.stage==='summary-zh-v1');
   const reason=!call?'remaining_budget_insufficient':call.error?'provider_result_invalid':'language_or_scope_validation';
   pendingSummaryReasons[reason]=(pendingSummaryReasons[reason]||0)+1;
  }
 }
}
for(const l of entries){if(l.used>2079||l.used<l.priorTokens)errors.push({id:l.hookId,error:'budget breach'});}
const report={time:new Date().toISOString(),imported:hooks.length,uniqueMaterials:new Set(hooks.map(h=>h.material)).size,states,chineseSummaries:hooks.filter(h=>h.analysis?.summaryStatus==='ready').length,pendingSummaryReasons,endRanges,longCandidates:endRanges.over60,ledgerItems:entries.length,completed:entries.filter(l=>l.saved).length,totalAccountedTokens:entries.reduce((s,l)=>s+l.used,0),actualKnownTokens:entries.reduce((s,l)=>s+l.priorTokens+l.calls.reduce((sum,c)=>sum+(c.actual||0),0),0),unsettledReservations:entries.flatMap(l=>l.calls).filter(c=>c.actual===undefined).length,maxItemTokens:Math.max(0,...entries.map(l=>l.used)),maxCompletedItemTokens:Math.max(0,...entries.filter(l=>l.saved).map(l=>l.used)),errors};
await writeFile(root+'/batch-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
if(errors.length)process.exitCode=1;
