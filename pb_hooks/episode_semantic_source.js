// Read-only projection of successful checkpoints. No model summaries, legacy
// rankings, URLs, file paths or inherited "verified" flags become source facts.
function project(coarse, detail, number) {
  if(coarse.status!=='succeeded'||detail.status!=='succeeded')throw new Error('Successful checkpoints required');
  const lines=[],seen=new Set();
  function add(kind,text,time,confidence,speaker){
    if(typeof text!=='string'||!text.trim())return;
    if(/https?:\/\//i.test(text))throw new Error('Unexpected link in checkpoint prose');
    const row={kind,text,time:time||null,confidence:typeof confidence==='number'?confidence:null,speaker:speaker||null};
    const key=JSON.stringify([kind,text,time]);
    if(!seen.has(key)){lines.push(row);seen.add(key);}
  }
  for(const t of coarse.result?.transcript||[])add('ASR转写（未人工核验）',t.text,{start:t.start,end:t.end},t.confidence,t.speaker);
  for(const t of coarse.result?.ocr||[])add('OCR识别（不证明当前人物或世界规则）',t.text,t.timecode,t.confidence,null);
  function frames(v){
    if(!v||typeof v!=='object')return;
    if(v.source==='frame'&&typeof v.text==='string')add('既有模型画面描述（非本次看图，待原片核验）',v.text,v.timecode,null,null);
    Object.values(v).forEach(frames);
  }
  frames(detail.result);
  lines.sort((a,b)=>(a.time?.start??Infinity)-(b.time?.start??Infinity));
  if(!lines.length)throw new Error('No checkpoint text evidence');
  return {text:lines.map((v,i)=>JSON.stringify({segment:i+1,...v})).join('\n'),counts:{segments:lines.length,asr:lines.filter(v=>v.kind.startsWith('ASR')).length,frameDescriptions:lines.filter(v=>v.kind.startsWith('既有')).length},episodeNumber:number};
}
function source(app,id){
  const episode=app.findRecordById('drama_episodes',id);
  const drama=app.findRecordById('dramas',episode.getString('drama'));
  const number=episode.getInt('episode_number');
  if(number<1||number>drama.getInt('free_episodes'))throw new Error('Paid episode requires separate consent');
  const jobs=app.findRecordsByFilter('analysis_jobs','episode = {:episode} && drama = {:drama} && stage = "detail_episode" && status = "succeeded"','-created,-id',1,0,{episode:id,drama:drama.id});
  if(!jobs.length)throw new Error('Successful episode checkpoint missing');
  const coarseRaw=episode.getString('analysis_result'),detailRaw=jobs[0].getString('result');
  const value=project(JSON.parse(coarseRaw),JSON.parse(detailRaw),number);
  return {text:value.text,version:{adapter:'episode-checkpoint-evidence-v1',episodeId:id,episodeNumber:number,jobId:jobs[0].id,coarseHash:$security.sha256(coarseRaw),checkpointHash:$security.sha256(detailRaw),counts:value.counts,freeEpisodes:drama.getInt('free_episodes'),copyright:drama.getString('copyright_status')}};
}
module.exports={project,source};
