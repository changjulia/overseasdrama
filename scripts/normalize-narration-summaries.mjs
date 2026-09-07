import {readFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile('.codex-runtime/narration-intake/all-applied.json','utf8'));
const token=(await readFile('.analysis-worker-token','utf8')).trim();
let changed=0;
for(let i=0;i<manifest.results.length;i+=100){
 const r=await fetch('http://127.0.0.1:8090/api/lumina/narration-intake/normalize-summaries',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({hookIds:manifest.results.slice(i,i+100).map(x=>x.hookId)})});
 if(!r.ok) throw new Error(await r.text());changed+=(await r.json()).changed;
}
console.log({changed,modelCalls:0});
