"use client";

import type { PipelineTask } from "../features/operations/types";

const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POCKETBASE_URL : undefined;
const PB_URL = (configuredUrl || "http://127.0.0.1:8090").replace(/\/$/, "");

type PBJob = {
  id:string; stage:"coarse"|"detail"|"precision"; status:"queued"|"running"|"succeeded"|"failed";
  progress:number; attempt:number; max_attempts:number; error?:string; logs?:unknown; worker_id?:string;
  expand?:{drama?:{title?:string;cn?:string};episode?:{episode_number?:number}};
};

const stageLabel = {coarse:"粗解析",detail:"细解析",precision:"高光精解析"} as const;
const statusLabel = {queued:"排队中",running:"处理中",succeeded:"已完成",failed:"失败"} as const;

export async function listPocketBaseAnalysisTasks(signal?:AbortSignal):Promise<PipelineTask[]> {
  const response=await fetch(`${PB_URL}/api/collections/analysis_jobs/records?perPage=500&expand=drama,episode`,{signal,cache:"no-store"});
  if(!response.ok)throw new Error(`PocketBase 任务读取失败（HTTP ${response.status}）`);
  const payload=await response.json() as {items:PBJob[]};
  return payload.items.map(job=>{
    const drama=job.expand?.drama;const episode=job.expand?.episode?.episode_number;
    const label=stageLabel[job.stage]??job.stage;
    return {id:job.id,backendId:job.id,title:`${drama?.title||drama?.cn||"未命名短剧"} · ${label}${episode?` · EP${String(episode).padStart(2,"0")}`:""}`,category:"剧集解析",status:statusLabel[job.status],progress:Math.max(0,Math.min(100,Number(job.progress)||0)),owner:job.worker_id||"分析 Worker",createdAt:`第 ${job.attempt}/${job.max_attempts} 次尝试`,cost:"本地 ASR / OCR + 云端语义",stage:job.stage,episodeNumber:episode,error:job.error||undefined,logs:job.logs};
  });
}
