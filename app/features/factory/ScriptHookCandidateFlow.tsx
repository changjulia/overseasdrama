"use client";
import { useEffect, useRef, useState } from "react";
import { POCKETBASE_URL, pocketBaseUiHeaders } from "../../lib/pocketbase-url";
import styles from "./script-hook-candidates.module.css";
import { SemanticEvidence } from "../inspiration/SemanticEvidence";
import { summarizeWorkflowCoverage, type WorkflowCoverage } from "./script-hook-coverage";

type Claim={status:string;quotes:string[];note:string;claims?:{quote:string;status:string}[]};
type Highlight={id:string;dramaId:string;episodeNumber:number;title:string;text:string;content?:Record<string,string[]>;start:number;end:number;videoUrl:string;boundaryStatus:string;reviewStatus:string};
const highlightFields=[['spokenSummary','对白摘要'],['visualSummary','画面摘要'],['conflict','核心冲突'],['emotion','情绪'],['narrativePromise','叙事承诺'],['relationships','人物关系']];
const boundaryLabels:Record<string,string>={verified:'已核验',unverified:'待核验',rejected:'未通过'};
const reviewLabels:Record<string,string>={pending:'待审核',needs_review:'待复核',approved:'已通过',rejected:'未通过'};
type Candidate={id:string;materialId:string;sceneIndex:number;title:string;videoUrl:string;inputVersion:string;state:string;decisionId?:string;frameMismatch:boolean;
  rightsStatus:string;materialReviewStatus:string;
  tagRecall?:{method:string;matches:{code:string;label:string;dimension:string;hookClaims:{id:string;status:string}[];highlightClaims:{id:string;status:string}[]}[]}|null;
  eventComparison?:{matchId:string;result:{verdict:string;reason:string;connectionType:string;entityAlignment:string;eventPairs:{hookEventId:string;highlightEventId:string;reason:string}[];payoff:{status:string;reason:string};continuityChecks:{dimension:string;verdict:string;reason:string}[];bridgeRequirements:string[];risks:{kind:string;reason:string}[]}}|null;
  extracted:{sceneNumber:number;script:string;fields:Record<string,Claim>;concepts:{label:string;status:string;evidence:string[];note:string}[];warnings:string[];reportedDuration:number|null};
  diagnostic:{signalCount:number;connection:string;risks:string[];evidence:{dimension:string;hookQuotes:string[];highlightQuotes:string[]}[];missing:{field:string;reason:string}[]}};
type QueryResult={target:Highlight;total:number;matched:number;page:number;totalPages:number;candidates:Candidate[];coverage?:WorkflowCoverage};
type SavedContext={id:string;decision:string;storylineReady:boolean;productionEligible:boolean;nextStage:string};
async function api<T>(body:unknown,action="query"):Promise<T>{
  const response=await fetch(`${POCKETBASE_URL}/api/lumina/script-hook-candidates/${action}`,{method:"POST",headers:{...pocketBaseUiHeaders(),"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!response.ok){const failure=await response.json().catch(()=>({}));throw new Error(failure.message||"候选服务暂不可用，请重试");}
  return response.json();
}
function mediaUrl(value:string){return value.startsWith("/api/files/")?`${POCKETBASE_URL}${value}`:value;}
function seconds(n:number){return Number.isFinite(n)?`${Math.floor(n/60)}:${(n%60).toFixed(2).padStart(5,"0")}`:"待核验";}

function RangePlayer({url,start,end,label,onDuration}:{url:string;start:number|null;end:number|null;label:string;onDuration?:(v:number)=>void}){
  const ref=useRef<HTMLVideoElement>(null),[rangePlaying,setRangePlaying]=useState(false),[isPlaying,setIsPlaying]=useState(false),[error,setError]=useState("");
  const valid=start!==null&&end!==null&&Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start;
  const mounted=useRef(true),cancelLoad=useRef<(()=>void)|null>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cancelLoad.current?.();};},[]);
  const playRange=async()=>{const v=ref.current;if(!v||!valid)return;setError("");try{if(v.readyState<1){await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);v.removeEventListener("loadedmetadata",ready);v.removeEventListener("error",fail);cancelLoad.current=null;};const ready=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error("Video unavailable"));};const timer=setTimeout(fail,20000);cancelLoad.current=fail;v.addEventListener("loadedmetadata",ready);v.addEventListener("error",fail);v.load();});}if(!mounted.current)return;if(!Number.isFinite(v.duration)||end!>v.duration)throw new Error();v.currentTime=start!;setRangePlaying(true);await v.play();}catch{if(mounted.current){setRangePlaying(false);setError("无法播放该区间，请核对视频链接与起止时间，稍后可重试");}}};
  return <div className={styles.player}><b>{label}</b><video aria-label={label} ref={ref} src={mediaUrl(url)} preload="none" controls playsInline
    onPlay={()=>setIsPlaying(true)} onPause={()=>setIsPlaying(false)} onLoadedMetadata={e=>{if(Number.isFinite(e.currentTarget.duration))onDuration?.(e.currentTarget.duration);}} onError={()=>setError("视频不可用，请核对链接")}
    onTimeUpdate={e=>{if(rangePlaying&&end!==null&&e.currentTarget.currentTime>=end){e.currentTarget.pause();e.currentTarget.currentTime=end;setRangePlaying(false);}}}/>
    <button onClick={()=>{setRangePlaying(false);setError("");if(isPlaying){ref.current?.pause();return;}void ref.current?.play().catch(()=>{if(mounted.current)setError("无法播放原视频，请重试");});}}>{isPlaying?"暂停视频":"播放原视频（不设边界）"}</button>
    <button disabled={!valid} onClick={()=>void playRange()}>播放当前区间 {valid?`${seconds(start!)}–${seconds(end!)}`:"（先填写边界）"}</button>
    <small>播放器区间预览用于人工核对，不代表逐帧剪辑精校通过。</small>{error&&<p role="alert">{error}</p>}</div>;
}

export function ScriptHookCandidateFlow({initialDramaId}:{initialDramaId?:string}){
  const [dramas,setDramas]=useState<{id:string;title:string}[]>([]),[dramaId,setDramaId]=useState(initialDramaId||"");
  const [highlights,setHighlights]=useState<Highlight[]>([]),[highlightId,setHighlightId]=useState("");
  const [result,setResult]=useState<QueryResult|null>(null),[selected,setSelected]=useState<Candidate|null>(null),[page,setPage]=useState(1);
  const [semanticOnly,setSemanticOnly]=useState(false);
  const [tagOnly,setTagOnly]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[saved,setSaved]=useState<SavedContext|null>(null);
  const [start,setStart]=useState(""),[end,setEnd]=useState(""),[duration,setDuration]=useState<number|null>(null),[note,setNote]=useState("");
  const [checks,setChecks]=useState<Record<string,boolean>>({});
  const generation=useRef(0),selectedRef=useRef("");
  useEffect(()=>()=>{generation.current++;selectedRef.current="";},[]);
  useEffect(()=>{let cancelled=false;api<{dramas:typeof dramas}>({catalog:true}).then(data=>{if(!cancelled){setDramas(data.dramas);setDramaId(v=>v||data.dramas[0]?.id||"");}}).catch(e=>!cancelled&&setError(e.message));return()=>{cancelled=true;};},[]);
  useEffect(()=>{const stamp=++generation.current;selectedRef.current="";setBusy(false);setResult(null);setSelected(null);setSaved(null);setHighlights([]);setHighlightId("");setPage(1);setError("");if(!dramaId)return;let cancelled=false;
    void (async()=>{try{const data=await api<{highlights:Highlight[]}>({dramaId});if(cancelled||generation.current!==stamp)return;setHighlights(data.highlights);const first=data.highlights[0];if(!first)return;setHighlightId(first.id);setBusy(true);const query=await api<QueryResult>({dramaId,highlightId:first.id,page:1,semanticOnly:false,tagOnly:false});if(!cancelled&&generation.current===stamp)setResult(query);}catch(e){if(!cancelled&&generation.current===stamp)setError(e instanceof Error?e.message:"读取失败");}finally{if(!cancelled&&generation.current===stamp)setBusy(false);}})();return()=>{cancelled=true;};},[dramaId]);
  const resetSelection=()=>{selectedRef.current="";setSelected(null);setSaved(null);setStart("");setEnd("");setDuration(null);setNote("");setChecks({});};
  const changeHighlight=(id:string)=>{generation.current++;setBusy(false);setHighlightId(id);setResult(null);setPage(1);resetSelection();};
  const load=async(nextPage=1,only=semanticOnly,tags=tagOnly)=>{const stamp=++generation.current;setSemanticOnly(only);setTagOnly(tags);setBusy(true);setError("");resetSelection();try{const data=await api<QueryResult>({dramaId,highlightId,page:nextPage,semanticOnly:only,tagOnly:tags});if(generation.current===stamp){setResult(data);setPage(nextPage);}}catch(e){if(generation.current===stamp)setError(e instanceof Error?e.message:"读取失败");}finally{if(generation.current===stamp)setBusy(false);}};
  const choose=(candidate:Candidate)=>{resetSelection();selectedRef.current=candidate.id;setSelected(candidate);setError("");};
  const readSaved=async()=>{if(!selected?.decisionId)return;const stamp=generation.current,id=selected.id;setBusy(true);try{const response=await fetch(`${POCKETBASE_URL}/api/lumina/script-hook-candidates/contexts/${selected.decisionId}`,{headers:pocketBaseUiHeaders(),signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok)throw new Error(data.message||"回读失败");if(generation.current===stamp&&selectedRef.current===id)setSaved(data);}catch(e){if(generation.current===stamp&&selectedRef.current===id)setError(e instanceof Error?e.message:"回读失败");}finally{if(generation.current===stamp)setBusy(false);}};
  const decide=async(action:"shortlist"|"reject"|"confirm")=>{if(!selected)return;const stamp=generation.current,id=selected.id;setBusy(true);setError("");try{
    const data=await api<SavedContext>({dramaId,highlightId,materialId:selected.materialId,sceneIndex:selected.sceneIndex,inputVersion:selected.inputVersion,action,
      start:start.trim()?Number(start):null,end:end.trim()?Number(end):null,mediaDuration:duration,...checks,note},"decision");
    if(generation.current!==stamp||selectedRef.current!==id)return;
    setSaved(data);setSelected(v=>v?{...v,state:data.decision,decisionId:data.id}:v);setResult(r=>r?{...r,candidates:r.candidates.map(v=>v.id===id?{...v,state:data.decision,decisionId:data.id}:v)}:r);
  }catch(e){if(generation.current===stamp&&selectedRef.current===id)setError(e instanceof Error?e.message:"保存失败");}finally{if(generation.current===stamp)setBusy(false);}};
  const target=result?.target||highlights.find(v=>v.id===highlightId);
  const coverage=summarizeWorkflowCoverage(result?.coverage);
  const materialRightsReady=Boolean(selected&&["已获授权可制作","已获授权可投放"].includes(selected.rightsStatus));
  const materialReviewReady=Boolean(selected&&["已通过","已修改"].includes(selected.materialReviewStatus));
  const reviewFields=[['contentVerified','已对照视频核实脚本内容'],['boundaryVerified','已核实起止点，未截断对白或动作'],['connectionVerified','已核实双方剧情承接关系'],['promiseVerified','正片能够兑现钩子承诺'],['noSevereConflict','无严重事实冲突或虚假承诺']];
  return <section className={styles.flow} aria-label="正片高光到脚本钩子候选流程">
    <ol className={styles.steps}><li>1 选择剧集高光</li><li>2 初筛脚本候选</li><li>3 对照拉片与核验</li><li>4 保存故事线输入</li></ol>
    <div className={styles.selectors}><label>剧库剧目<select value={dramaId} onChange={e=>setDramaId(e.target.value)}>{dramas.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
      <label>正片高光（仅免费集）<select value={highlightId} onChange={e=>changeHighlight(e.target.value)}><option value="">请选择具体高光片段</option>{highlights.map(h=><option key={h.id} value={h.id}>第{h.episodeNumber}集 {seconds(h.start)}–{seconds(h.end)} · {h.title}</option>)}</select></label>
      <div className={styles.queryAction}><button disabled={busy||!highlightId} onClick={()=>void load(1,false,false)}>根据此高光规则初筛</button><small>始终可用 · 共同词义只用于召回</small></div>
      <div className={styles.queryAction}><button disabled={busy||!highlightId||!coverage.tagEnabled} onClick={()=>void load(1,false,true)}>按统一标签缩小候选范围</button><small data-ready={coverage.tagEnabled||undefined}>{coverage.tagReason}</small></div>
      <div className={styles.queryAction}><button disabled={busy||!highlightId||!coverage.eventEnabled} onClick={()=>void load(1,true,false)}>只看当前有效事件匹配</button><small data-ready={coverage.eventEnabled||undefined}>{coverage.eventReason}</small></div></div>
    {target&&<article className={styles.target}><b>所选正片证据 · 第{target.episodeNumber}集 · {seconds(target.start)}–{seconds(target.end)}</b>
      {target.content?<dl className={styles.targetFields}>{highlightFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{target.content?.[key]?.length?target.content[key].map((text,index)=><p key={index}>{text}</p>):<span className={styles.missing}>未提供</span>}</dd></div>)}</dl>:<p>{target.text||"高光剧情描述缺失，请先复核正片分析。"}</p>}
      <small>边界：{boundaryLabels[target.boundaryStatus]||'状态未知'} · 审核：{reviewLabels[target.reviewStatus]||'状态未知'}；未通过时仅用于候选检索。</small></article>}
    {error&&<p role="alert" className={styles.error}>{error}</p>}{busy&&<p role="status">正在读取或保存真实数据…</p>}
    {target&&!selected&&<details><summary>查看所选高光的统一标签与事件分析</summary><SemanticEvidence sourceId={target.id} sourceType="episode_analysis"/></details>}
    {result&&<><header className={styles.resultsHeader}><h3>候选初筛 · {result.total} 个脚本场景</h3><span>{tagOnly?'已按双方持久化的统一标签筛选；标签相同不代表事件适合':`${result.matched} 个存在共同词义信号；不是适配通过数量`}</span></header>
      <p className={styles.notice}>{semanticOnly?"当前只读取已持久化的事件匹配；包含不适合和证据不足结果，不代表全部推荐。":tagOnly?"仅展示双方已提取且有共同统一标签的候选；尚未提取、未命中不代表内容不适合。":"当前为文本规则召回，持久化统一标签与事件匹配参与排序；共同词义不证明因果承接。"} 所有结论仍需视频与人工核验。</p>
      {!result.total&&<p>{tagOnly||semanticOnly?"当前筛选没有结果；可返回全部脚本候选查看未提取项。":"灵感大屏尚无可读取的 CSV 脚本候选。"}</p>}
      <div className={styles.candidates}>{result.candidates.map(c=><button disabled={busy} className={selected?.id===c.id?styles.active:""} key={c.id} onClick={()=>choose(c)}><span>{c.eventComparison?({candidate:"事件匹配候选",unsuitable:"事件不适合",unknown:"事件证据不足"} as Record<string,string>)[c.eventComparison.result.verdict]:c.diagnostic.signalCount?"规则候选 · 待核验":"未命中 · 仅供查看"} · {({unverified:"待核验",shortlist:"已入围",reject:"已排除",confirmed:"已确认输入"} as Record<string,string>)[c.state]||c.state}</span><b>{c.title}</b><small>场景{c.extracted.sceneNumber} · {c.diagnostic.signalCount} 个共同维度</small><small>统一标签：{c.tagRecall?"当前有效":"未生成或已失效（规则召回）"} · 事件匹配：{c.eventComparison?"当前有效":"未生成或已失效（规则召回）"}</small></button>)}</div>
      {result.totalPages>1&&<div><button disabled={busy||page<=1} onClick={()=>void load(page-1)}>上一页</button> {page}/{result.totalPages} <button disabled={busy||page>=result.totalPages} onClick={()=>void load(page+1)}>下一页</button></div>}
    </>}
    {selected&&target&&<section className={styles.review} aria-label="候选双片对照与核验"><h3>候选对照 · {selected.title}</h3>
      <p>素材授权：{selected.rightsStatus||"未提供"} · 素材复核：{selected.materialReviewStatus||"未提供"}</p>
      {(!materialRightsReady||!materialReviewReady)&&<p className={styles.error}>此候选可继续查看与入围，但授权或素材人工复核尚未满足，不能确认成故事线输入。</p>}
      {selected.tagRecall&&<article aria-label="统一标签召回依据"><h4>统一标签召回依据 · {selected.tagRecall.method}</h4><p>仅用于缩小候选范围，事件适配仍待判断。</p>{selected.tagRecall.matches.length?selected.tagRecall.matches.map(t=><p key={t.code}>{t.code} · 钩子：{t.hookClaims.some(c=>c.status==='inferred')?'含推断':'脚本明确'} · 正片：{t.highlightClaims.some(c=>c.status==='inferred')?'含推断':'已有分析明确'}；原文见下方语义证据。</p>):<p>双方未命中共同统一标签；不据此否定其他事件类比。</p>}</article>}
      {selected.eventComparison&&<article aria-label="已保存事件匹配"><h4>已保存事件匹配 · 待视频与人工核验</h4><p>{selected.eventComparison.result.reason}</p><p>实体对应：{selected.eventComparison.result.entityAlignment} · 承接假设：{selected.eventComparison.result.connectionType}</p>{selected.eventComparison.result.eventPairs.map((p,i)=><p key={i}>{p.hookEventId} → {p.highlightEventId}：{p.reason}</p>)}<p>兑现：{selected.eventComparison.result.payoff.status} · {selected.eventComparison.result.payoff.reason}</p>{selected.eventComparison.result.continuityChecks.map(c=><p key={c.dimension}>{c.dimension} · {c.verdict}：{c.reason}</p>)}{selected.eventComparison.result.risks.map((r,i)=><p key={i}>风险：{r.reason}</p>)}</article>}
      <div className={styles.players}><RangePlayer key={target.id} label="正片高光" url={target.videoUrl} start={target.start} end={target.end}/>
        <RangePlayer key={selected.id} label="素材原视频（手动核验钩子边界）" url={selected.videoUrl} start={start.trim()?Number(start):null} end={end.trim()?Number(end):null} onDuration={setDuration}/></div>
      <div className={styles.players}><SemanticEvidence sourceId={target.id} sourceType="episode_analysis"/><SemanticEvidence sourceId={selected.materialId} sceneIndex={selected.sceneIndex}/></div>
      <div className={styles.evidence}><article><h4>匹配依据与承接假设</h4><p>{selected.diagnostic.connection}</p>{selected.diagnostic.evidence.map(e=><p key={e.dimension}><b>{e.dimension}（推断）</b><br/>正片原文词：{e.highlightQuotes.join('、')}<br/>钩子原文词：{e.hookQuotes.join('、')}</p>)}
        <h4>缺失项</h4>{selected.diagnostic.missing.map(m=><p key={m.field}>{m.reason}</p>)}<h4>风险待核验</h4>{selected.diagnostic.risks.map(r=><p key={r}>{r}</p>)}{selected.frameMismatch&&<p className={styles.error}>此素材抽帧已标记与原视频不一致，必须复核来源。</p>}</article>
        <article><h4>脚本结构化信息</h4>{Object.entries(selected.extracted.fields).map(([key,claim])=><details key={key}><summary>{({events:'事件',dialogue:'对白',relationships:'人物关系',conflict:'冲突',emotion:'情绪',promise:'悬念承诺'} as Record<string,string>)[key]} · {claim.status==='script_explicit'?'脚本明确描述':claim.status==='inferred'?'含推断':'缺失'}</summary>{claim.claims?.length?claim.claims.map((entry,index)=><p key={index}><b>{entry.status==='inferred'?'推断':'脚本明确描述'}：</b>{entry.quote}</p>):<p>{claim.note}</p>}</details>)}
          <details><summary>原始脚本 · 场景{selected.extracted.sceneNumber}</summary><pre>{selected.extracted.script||"未提供"}</pre></details>{selected.extracted.warnings.map(w=><small key={w}>{w}<br/></small>)}</article></div>
      <div className={styles.actions}><button disabled={busy||!selected.extracted.script.trim()} onClick={()=>void decide('shortlist')}>加入入围清单（不代表审核通过）</button><button disabled={busy} onClick={()=>void decide('reject')}>排除此候选</button>{selected.decisionId&&<button disabled={busy} onClick={()=>void readSaved()}>回读已保存记录</button>}</div>
      <fieldset disabled={busy}><legend>人工核验后确认 · 不自动代勾</legend><div className={styles.ranges}><label>钩子原片起点（秒）<input type="number" min="0" step="0.01" value={start} onChange={e=>{setStart(e.target.value);setChecks({});setSaved(null);}}/></label><label>钩子原片终点（秒）<input type="number" min="0" step="0.01" value={end} onChange={e=>{setEnd(e.target.value);setChecks({});setSaved(null);}}/></label><span>整片时长：{duration===null?'播放后读取':seconds(duration)}</span></div>
        <p>表单时长 {selected.extracted.reportedDuration??'未知'} 秒仅作参考，不自动转为原片边界。可用钩子仍要求5–60秒。</p>
        {reviewFields.map(([key,label])=><label className={styles.check} key={key}><input type="checkbox" checked={checks[key]||false} onChange={e=>{setChecks(v=>({...v,[key]:e.target.checked}));setSaved(null);}}/>{label}</label>)}
        <label>内容、承接及风险核验依据<textarea value={note} onChange={e=>{setNote(e.target.value);setSaved(null);}} placeholder="填写实际看到的事件、准确时间，以及正片如何兑现钩子承诺"/></label>
        <button disabled={busy||selected.eventComparison?.result.verdict!=='candidate'||!materialRightsReady||!materialReviewReady||duration===null||!reviewFields.every(([k])=>checks[k])||note.trim().length<10||target.boundaryStatus!=="verified"||target.reviewStatus!=="approved"} onClick={()=>void decide('confirm')}>确认并保存后续故事线输入</button>
        {(target.boundaryStatus!=="verified"||target.reviewStatus!=="approved")&&<small>正片高光尚未通过原有审核，请先在剧库完成复核。</small>}
        {(!materialRightsReady||!materialReviewReady)&&<small>素材必须具备制作或投放授权，并在灵感大屏完成“已通过”或“已修改”的人工复核。</small>}
      </fieldset>
      {saved&&<div role="status" className={styles.saved}>已保存：{saved.decision==='shortlist'?'入围待核验':saved.decision==='reject'?'已排除':'已确认故事线输入'} · 记录 {saved.id}<br/>{saved.storylineReady?'高光、钩子区间、匹配依据和人工核验已保存；供后续故事线生成使用。':'当前不能作为已确认故事线输入。'}<br/>未生成完整故事线，也未获得生产或导出授权。</div>}
    </section>}
  </section>;
}
