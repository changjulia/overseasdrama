/** Revalidate already-paid responses against continuous ASR; zero model calls. */
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {candidateEnds} from './narration-boundary-budget.mjs';
const root='.codex-runtime/narration-intake',token=(await readFile('.analysis-worker-token','utf8')).trim();
let recovered=0;
for(const file of await readdir(root+'/boundary-ledger')) {
 if(!file.endsWith('.json')) continue;
 const path=root+'/boundary-ledger/'+file,ledger=JSON.parse(await readFile(path,'utf8'));
 if(ledger.payload?.boundary.status==='candidate') continue;
 const call=ledger.calls?.[0];if(call?.response?.choices?.[0]?.finish_reason==='length') continue;
 let parsed;try{parsed=JSON.parse(call.response.choices[0].message.content);}catch{continue;}
 const e=JSON.parse(await readFile(root+'/boundary-evidence/'+ledger.key+'.json','utf8'));
 const c=candidateEnds(e.segments,e.coverageEnd,e.duration).find(c=>c.row===parsed.end);
 if(!c||e.segments[c.row+1]?.text.trim()!==parsed.after)continue;
 const continuous=Array.from({length:c.row+2},(_,i)=>i).every(i=>call.evidenceRows?.includes(i));
 if(!continuous)continue;
 const semantic=['summary','conflict','promise','identity'].every(k=>typeof parsed[k]==='string'&&(!parsed[k]||/[\u3400-\u9fff]/.test(parsed[k])))?parsed:{};
 const payload={hookId:ledger.hookId,sourceCacheKey:ledger.sourceCacheKey,boundary:{status:'candidate',end:c.end,method:'continuous-semantic',reason:parsed.why},semantic,transcript:e.segments,scanCoverageEnd:e.coverageEnd,summaryCoverageEnd:semantic.summary?c.end:null,budget:{cap:2079,used:ledger.used,prior:ledger.priorTokens,modelCalls:ledger.calls.length},...(e.mediaDuration?{mediaDuration:e.mediaDuration}:{})};
 payload.resultKey=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const response=await fetch('http://127.0.0.1:8090/api/lumina/narration-intake/boundary',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
 if(!response.ok)throw new Error(await response.text());
 ledger.payload=payload;ledger.saved=true;await writeFile(path,JSON.stringify(ledger,null,2)+'\n');recovered++;
}
console.log({recovered,modelCalls:0});
