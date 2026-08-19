"use client";

import type { PipelineTask } from "../features/operations/types";

const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POCKETBASE_URL : undefined;
const PB_URL = (configuredUrl || "http://127.0.0.1:8090").replace(/\/$/, "");

type PBJob = {
  id:string; stage?:"coarse"|"detail"|"precision"; current_stage?:string; status:"queued"|"running"|"paused"|"succeeded"|"failed";
  progress:number; attempt:number; max_attempts:number; error?:string; logs?:unknown; worker_id?:string;
  expand?:{drama?:{title?:string;cn?:string};episode?:{episode_number?:number};match?:{expand?:{drama?:{title?:string;cn?:string}}};match_job?:{expand?:{drama?:{title?:string;cn?:string}}}};
};

const stageLabel = {coarse:"粗解析",detail:"细解析",precision:"高光精解析"} as const;
const statusLabel = {queued:"排队中",running:"处理中",paused:"已暂停",succeeded:"已完成",failed:"失败"} as const;

async function taskAction(id:string,action:"pause"|"resume") {
  const response=await fetch(`${PB_URL}/api/lumina/analysis/jobs/${encodeURIComponent(id)}/${action}`,{method:"POST"});
  if(!response.ok){const payload=await response.json().catch(()=>null) as {message?:string}|null;throw new Error(payload?.message||`任务操作失败（HTTP ${response.status}）`)}
}

export const pausePocketBaseAnalysisTask=(id:string)=>taskAction(id,"pause");
export const resumePocketBaseAnalysisTask=(id:string)=>taskAction(id,"resume");

export async function deletePocketBaseAnalysisTask(id:string) {
  const response=await fetch(`${PB_URL}/api/lumina/analysis/jobs/${encodeURIComponent(id)}`,{method:"DELETE"});
  if(!response.ok){const payload=await response.json().catch(()=>null) as {message?:string}|null;throw new Error(payload?.message||`任务删除失败（HTTP ${response.status}）`)}
}

export async function listPocketBaseAnalysisTasks(signal?:AbortSignal):Promise<PipelineTask[]> {
  const read=async(collection:string,expand:string)=>{const response=await fetch(`${PB_URL}/api/collections/${collection}/records?perPage=500&expand=${expand}`,{signal,cache:"no-store"});if(!response.ok)throw new Error(`PocketBase 任务读取失败（${collection}，HTTP ${response.status}）`);return (await response.json() as {items:PBJob[]}).items};
  const [analysis,matching,supplemental,entries]=await Promise.all([
    read("analysis_jobs","drama,episode"),read("hook_match_jobs","drama"),read("supplemental_highlight_jobs","episode,match_job,match_job.drama"),read("entry_precision_jobs","match,match.drama")
  ]);
  const dramaTasks=analysis.map(job=>{
    const drama=job.expand?.drama;const episode=job.expand?.episode?.episode_number;
    const stage=job.stage??"coarse",label=stageLabel[stage]??stage;
    return {id:job.id,backendId:job.id,title:`${drama?.title||drama?.cn||"未命名短剧"} · ${label}${episode?` · EP${String(episode).padStart(2,"0")}`:""}`,category:"剧集解析" as const,status:statusLabel[job.status],progress:Math.max(0,Math.min(100,Number(job.progress)||0)),owner:job.worker_id||"分析 Worker",createdAt:`第 ${job.attempt}/${job.max_attempts} 次尝试`,cost:"本地 ASR / OCR + 云端语义",stage,episodeNumber:episode,error:job.error||undefined,logs:job.logs};
  });
  const workflowTask=(job:PBJob,category:"故事线匹配"|"补充高光"|"接点精分析",stage:"hook_match"|"supplemental_highlight"|"entry_precision",drama?:{title?:string;cn?:string},episode?:number):PipelineTask=>({id:`${stage}:${job.id}`,backendId:job.id,title:`${drama?.title||drama?.cn||"未命名短剧"} · ${category}${episode?` · EP${String(episode).padStart(2,"0")}`:""}`,category,status:statusLabel[job.status],progress:Math.max(0,Math.min(100,Number(job.progress)||0)),owner:job.worker_id||"分析 Worker",createdAt:`第 ${job.attempt||0}/${job.max_attempts||3} 次尝试`,cost:"云端语义 + 媒体证据",stage,error:job.error||undefined,logs:job.logs});
  return [...matching.map(job=>workflowTask(job,"故事线匹配","hook_match",job.expand?.drama)),...supplemental.map(job=>workflowTask(job,"补充高光","supplemental_highlight",job.expand?.match_job?.expand?.drama,job.expand?.episode?.episode_number)),...entries.map(job=>workflowTask(job,"接点精分析","entry_precision",job.expand?.match?.expand?.drama)),...dramaTasks];
}
