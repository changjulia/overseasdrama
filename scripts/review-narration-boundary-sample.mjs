/** One QA correction supported by the complete cached transcript, no API call. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const path='.codex-runtime/narration-intake/boundary-ledger/r398x66o3jm9ua5.json';
const ledger=JSON.parse(await readFile(path,'utf8'));
const evidence=JSON.parse(await readFile('.codex-runtime/narration-intake/boundary-evidence/local_c9m7nso2rsslugw.json','utf8'));
if(evidence.segments[13]?.end!==31.52||evidence.segments[14]?.text!=="What's your name?") throw new Error('QA evidence changed');
ledger.qaSupersededPayload ??= ledger.payload;
const payload={...ledger.payload,transcript:evidence.segments,boundary:{status:'candidate',end:31.52,reason:'转写抽检：0–31.52 秒持续铺垫富豪身世、归还手表及带走女孩；32.12 秒开始“What’s your name?”现场对白。仅为语音语义候选，动作与镜头尚待复核。',method:'transcript-QA'},budget:{...ledger.payload.budget,used:ledger.used}};
delete payload.resultKey;
payload.resultKey=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const token=(await readFile('.analysis-worker-token','utf8')).trim();
const r=await fetch('http://127.0.0.1:8090/api/lumina/narration-intake/boundary',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
if(!r.ok) throw new Error(await r.text());
ledger.payload=payload;await writeFile(path,JSON.stringify(ledger,null,2)+'\n');console.log(await r.json());
