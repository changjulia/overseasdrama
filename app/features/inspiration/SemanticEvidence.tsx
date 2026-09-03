"use client";
import { useEffect, useState } from "react";
import { POCKETBASE_URL, pocketBaseUiHeaders } from "../../lib/pocketbase-url";
type Claim={id:string;value:unknown;assertionStatus:string;verificationStatus:string;evidenceRefs:string[];reason:string};
type Result={id?:string;state:string;identity?:{model:string;prompt:string;taxonomy:string;review?:{kind:string;humanApproved:false;videoVerified:false}};result?:{entities:{id:string;name:Claim}[];events:({id:string;action:Claim;actorIds:Claim;targetIds:Claim}&Record<string,unknown>)[];tags:Claim[];unmappedTags?:Claim[];continuation:Record<string,Claim>;evidence:{id:string;quote:string}[]}};
const stateLabel:Record<string,string>={explicit:"原文明确",inferred:"推断",missing:"缺失",conflicting:"证据冲突"};
const fieldLabel:Record<string,string>={actorIds:"行动主体",targetIds:"行动对象",action:"动作",goal:"目的",obstacle:"障碍",stakes:"失败后果",preconditions:"必要前因",stateBefore:"之前状态",stateAfter:"之后状态",outcome:"实际结果",setting:"场景",audienceKnows:"已知信息",openQuestions:"观众问题",promise:"钩子承诺",requiredPayoff:"所需兑现事件",entryState:"进入状态",exitState:"结束状态",requiredContext:"所需背景",forbiddenAssumptions:"不可假设"};
export function SemanticEvidence({sourceId,sceneIndex=0,sourceType="csv_script"}:{sourceId:string;sceneIndex?:number;sourceType?:"csv_script"|"episode_analysis"|"episode_checkpoint"}) {
  const [data,setData]=useState<Result|null>(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  useEffect(()=>{const controller=new AbortController();setData(null);setError("");
    fetch(`${POCKETBASE_URL}/api/lumina/script-semantics/read`,{method:"POST",headers:{...pocketBaseUiHeaders(),"Content-Type":"application/json"},body:JSON.stringify({sourceId,sceneIndex,sourceType}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])})
      .then(async response=>{if(!response.ok)throw new Error("语义读取失败");return response.json();})
      .then(value=>{if(!controller.signal.aborted)setData(value);}).catch(()=>{if(!controller.signal.aborted)setError("语义结果暂时无法读取，请重试");});
    return()=>controller.abort();},[sourceId,sceneIndex,sourceType,refresh]);
  const result=data?.result;
  function showValue(value:unknown):string {
    if(Array.isArray(value))return value.map(v=>typeof v==="string"?result?.entities.find(e=>e.id===v)?.name.value||v:v).map(v=>typeof v==="string"?v:JSON.stringify(v)).join("、");
    return value===null?"未提供":typeof value==="string"?value:JSON.stringify(value);
  }
  function claim(label:string,value:Claim){return <details key={value.id}><summary>{label} · {stateLabel[value.assertionStatus]||value.assertionStatus}：{showValue(value.value)}</summary><p>{value.reason} · 视频待核验</p>{value.evidenceRefs.map(ref=><blockquote key={ref}>{result?.evidence.find(e=>e.id===ref)?.quote||"引用缺失"}</blockquote>)}</details>;}
  return <section aria-label={sourceType==="csv_script"?"素材持久化事件语义":"正片持久化事件语义"} style={{border:"1px solid #dbe4f0",padding:16,borderRadius:12,marginTop:16}}>
    <h4>{sourceType==="csv_script"?`场景${sceneIndex+1} · 素材事件语义` :sourceType==="episode_checkpoint"?"整集证据 · 统一标签与事件语义":"正片高光 · 事件语义"}</h4>
    <button type="button" onClick={()=>setRefresh(v=>v+1)}>刷新语义结果</button>
    {error?<p role="alert">{error}</p>:!data?<p>正在读取已保存结果…</p>:!result?<p>{data.state==="missing"?"原脚本为空，保留缺失状态。":data.state==="unavailable"?"语义存储暂不可用。":"尚无当前版本的持久化语义；规则初筛不代表已分析。"}</p>:<>
      <p>{data.identity?.review?.kind==="AI-source-review"?"AI 已逐条对照原文复核并入库 · 非人工批准 · 原片与精确边界仍待核验":"模型提取已入库 · 内容正确性、视频及匹配仍待复核"} · 不可直接剪辑</p>
      {data.identity&&<small>分析版本：{data.identity.prompt} · {data.identity.taxonomy} · {data.identity.model}</small>}
      <p>“原文明确／推断”是模型对声明来源的分类，不等于人工确认真实。</p>
      <h5>分类标签（仅用于召回）</h5>{result.tags.map(tag=>claim("分类",tag))}
      {!!result.unmappedTags?.length&&<><h5>待映射的原始标签（不参与统一标签命中）</h5>{result.unmappedTags.map(tag=>claim("待映射",tag))}</>}
      {result.events.map(event=><article key={event.id}><h5>事件：{showValue(event.action.value)}</h5>{Object.entries(fieldLabel).filter(([field])=>event[field]&&typeof event[field]==="object").map(([field,label])=>claim(label,event[field] as Claim))}{(['relationships','emotionTrajectory','chronology'] as const).map(field=><div key={field}>{Array.isArray(event[field])&&(event[field] as Claim[]).map(c=>claim(({relationships:"方向性关系",emotionTrajectory:"情绪变化",chronology:"事件顺序"})[field],c))}</div>)}</article>)}
      {!result.events.length&&<p>没有提取到可辨认的事件；不补造情节。</p>}
      <h5>承接条件</h5>{Object.entries(result.continuation).map(([key,value])=>claim(fieldLabel[key]||key,value))}
    </>}
  </section>;
}
