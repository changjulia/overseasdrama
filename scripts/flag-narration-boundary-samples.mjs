/** Zero-API text QA: reject observed continuation cuts; never approve a cut. */
import {readFile,readdir,writeFile,rename,open,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const reasons={
 babyp6_6_9:'抽查发现下一句继续描述同一人物的保护行为，不能把情绪停顿当作解说结束；需人工核对完整钩子',
 babyp6_6_8:'抽查发现终点行末仍含 since 引导的铺垫从句，未确认完整句与画面结束；需人工核对',
 march_10_6:'抽查发现下一句仍接续同一身份声明，未能证实已转入独立新场景；需人工核对',
};
const dir='.codex-runtime/narration-intake/boundary-ledger';
const lock=await open(dir+'/run.lock','wx');await lock.writeFile(String(process.pid));
try {
 const token=(await readFile('.analysis-worker-token','utf8')).trim();let changed=0;
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.json'))){
  const path=dir+'/'+file,l=JSON.parse(await readFile(path,'utf8'));
  if(!reasons[l.key]||l.payload?.boundary.status!=='candidate')continue;
  l.qaRejectedPayload=l.payload;
  l.payload={...l.payload,boundary:{status:'needs_context',reason:reasons[l.key],method:'transcript-QA'},semantic:{},summaryVersion:null,summaryCoverageEnd:null};
  delete l.payload.resultKey;l.payload.resultKey=createHash('sha256').update(JSON.stringify(l.payload)).digest('hex');
  await writeFile(path+'.tmp',JSON.stringify(l,null,2)+'\n');await rename(path+'.tmp',path);
  const r=await fetch('http://127.0.0.1:8090/api/lumina/narration-intake/boundary',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(l.payload)});
  if(!r.ok)throw new Error('QA save failed '+r.status);changed++;
 }
 console.log({changed,modelCalls:0});
}finally{await lock.close();await unlink(dir+'/run.lock');}
