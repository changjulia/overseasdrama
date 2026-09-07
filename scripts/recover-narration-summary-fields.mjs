/** Recover complete JSON string fields from a truncated, already-paid summary.
 * Never infers the missing suffix, reselects endpoints, or calls a model. */
import {readFile,readdir,writeFile,rename,open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function completeFields(content) {
 const fields={};
 for(const key of ['summary','conflict','promise','identity']) {
  const match=String(content).match(new RegExp('"'+key+'"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")'));
  try {fields[key]=match?JSON.parse(match[1]):'';}catch {fields[key]='';}
 }
 return fields;
}
async function main(){
 const dir='.codex-runtime/narration-intake/boundary-ledger';
 const lock=await open(dir+'/run.lock','wx');await lock.writeFile(String(process.pid));
 const token=(await readFile('.analysis-worker-token','utf8')).trim();
 const report={recovered:[],modelCalls:0};
 try {
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.json'))) {
   const path=dir+'/'+file,ledger=JSON.parse(await readFile(path,'utf8'));
   const p=ledger.payload,call=ledger.calls.find(c=>c.stage==='summary-zh-v1');
   if(p?.boundary.status!=='candidate'||p.summaryVersion==='hook-summary-zh-v1'||call?.error!=='summary truncated')continue;
   const fields=completeFields(call.response?.choices?.[0]?.message?.content);
   if(!/[\u3400-\u9fff]/.test(fields.summary))continue;
   p.semantic={...fields,tags:[]};p.summaryVersion='hook-summary-zh-v1';p.summaryCoverageEnd=p.boundary.end;
   delete p.resultKey;p.resultKey=createHash('sha256').update(JSON.stringify(p)).digest('hex');
   call.recoveredFields=Object.keys(fields).filter(k=>fields[k]);
   // Preserve the original truncation error and raw response for audit.
   await writeFile(path+'.tmp',JSON.stringify(ledger,null,2)+'\n');await rename(path+'.tmp',path);
   const r=await fetch('http://127.0.0.1:8090/api/lumina/narration-intake/boundary',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(p)});
   if(!r.ok)throw new Error('recovery save failed '+r.status+': '+await r.text());
   report.recovered.push({hookId:ledger.hookId,fields:call.recoveredFields});
  }
  await writeFile('.codex-runtime/narration-intake/summary-recovery.json',JSON.stringify(report,null,2)+'\n');
  console.log({recovered:report.recovered.length,modelCalls:0});
 } finally {await lock.close();await unlink(dir+'/run.lock');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
