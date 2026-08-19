"use client";

import type { FactoryEpisodeMedia } from "../features/factory/types";
import { normalizeAnalysisPayload } from "./ontology/normalization";

const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POCKETBASE_URL : undefined;
const PB_URL = (configuredUrl || "http://127.0.0.1:8090").replace(/\/$/, "");

type PocketBaseRecord = Record<string, unknown> & { id: string; collectionId: string; collectionName: string };

export type PocketBaseDramaInput = {
  externalId: string;
  title: string;
  cn: string;
  genre: string;
  language: string;
  totalEpisodes: number;
  freeEpisodes: number;
  copyrightStatus: string;
  parseConfig: unknown;
  posterDataUrl?: string;
  episodes: Array<{ episode: number; file: File }>;
  onProgress?: (progress: { completed: number; total: number; episode?: number; loadedBytes?: number; totalBytes?: number; phase: "metadata" | "upload" | "complete" }) => void;
  signal?: AbortSignal;
};

export type PocketBaseEpisodeUpload = { episode: number; file: File };

export type PocketBaseDramaRecord = {
  recordId: string;
  externalId: string;
  title: string;
  cn: string;
  genre: string;
  language: string;
  totalEpisodes: number;
  freeEpisodes: number;
  copyrightStatus: string;
  parseState: string;
  parseConfig: unknown;
  analysis?: unknown;
  coarseStatus: string;
  coarseProgress: number;
  detailStatus: string;
  detailProgress: number;
  precisionStatus: string;
  precisionProgress: number;
  analysisError?: string;
  detailResult?: unknown;
  precisionResults: Array<{ episode: number; result: unknown; parameters?: unknown }>;
  posterUrl?: string;
  episodeMedia: Record<number, FactoryEpisodeMedia>;
};

async function pbFetch(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${PB_URL}${path}`, init);
  } catch (error) {
    throw new Error(`无法连接 PocketBase（${PB_URL}），请先启动本项目的 PocketBase 服务`);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string; data?: unknown } | null;
    throw new Error(payload?.message || `PocketBase 请求失败（HTTP ${response.status}）`);
  }
  return response;
}

function pbUpload(path: string, method: "POST" | "PATCH", body: FormData, onProgress?: (loaded:number,total:number)=>void, signal?:AbortSignal) {
  return new Promise<PocketBaseRecord>((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open(method,`${PB_URL}${path}`);
    request.upload.onprogress=event=>onProgress?.(event.loaded,event.lengthComputable?event.total:0);
    request.onerror=()=>reject(new Error(`上传连接中断（${PB_URL}）`));
    request.onabort=()=>reject(new DOMException("上传已取消","AbortError"));
    const abort=()=>request.abort();signal?.addEventListener("abort",abort,{once:true});
    request.onload=()=>{signal?.removeEventListener("abort",abort);let payload:unknown;try{payload=JSON.parse(request.responseText)}catch{payload=null}if(request.status<200||request.status>=300){const message=payload&&typeof payload==="object"&&"message" in payload?String((payload as {message:unknown}).message):`PocketBase 上传失败（HTTP ${request.status}）`;reject(new Error(message));return}resolve(payload as PocketBaseRecord)};
    if(signal?.aborted){reject(new DOMException("上传已取消","AbortError"));return}
    request.send(body);
  });
}

function fileUrl(record: PocketBaseRecord, filename: unknown, thumb?: string) {
  if (typeof filename !== "string" || !filename) return undefined;
  const query = thumb ? `?thumb=${encodeURIComponent(thumb)}` : "";
  return `${PB_URL}/api/files/${record.collectionId}/${record.id}/${encodeURIComponent(filename)}${query}`;
}

async function dataUrlToFile(dataUrl: string, name: string) {
  const blob = await fetch(dataUrl).then((response) => response.blob());
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

async function findDramaByExternalId(externalId: string) {
  const filter = encodeURIComponent(`external_id="${externalId.replace(/"/g, "\\\"")}"`);
  const response = await pbFetch(`/api/collections/dramas/records?perPage=1&filter=${filter}`);
  const payload = await response.json() as { items: PocketBaseRecord[] };
  return payload.items[0];
}

export async function saveDramaToPocketBase(input: PocketBaseDramaInput): Promise<PocketBaseDramaRecord> {
  const episodeNumbers = input.episodes.map((item) => item.episode);
  if (new Set(episodeNumbers).size !== episodeNumbers.length) throw new Error("上传列表中存在重复集数");
  if (input.episodes.some((item) => !Number.isInteger(item.episode) || item.episode < 1 || item.file.size === 0)) throw new Error("存在无效集数或空视频文件");
  input.onProgress?.({ completed: 0, total: input.episodes.length, phase: "metadata" });
  const dramaForm = new FormData();
  dramaForm.set("external_id", input.externalId);
  dramaForm.set("title", input.title);
  dramaForm.set("cn", input.cn);
  dramaForm.set("genre", input.genre);
  dramaForm.set("language", input.language);
  dramaForm.set("total_episodes", String(input.totalEpisodes));
  dramaForm.set("free_episodes", String(input.freeEpisodes));
  dramaForm.set("copyright_status", input.copyrightStatus);
  dramaForm.set("parse_state", "queued");
  dramaForm.set("parse_config", JSON.stringify(input.parseConfig));
  if (input.posterDataUrl) dramaForm.set("poster", await dataUrlToFile(input.posterDataUrl, `${input.externalId}-poster.jpg`));

  const existing = await findDramaByExternalId(input.externalId);
  const dramaResponse = await pbFetch(
    existing ? `/api/collections/dramas/records/${existing.id}` : "/api/collections/dramas/records",
    { method: existing ? "PATCH" : "POST", body: dramaForm },
  );
  const drama = await dramaResponse.json() as PocketBaseRecord;

  try {
    const totalBytes=input.episodes.reduce((sum,item)=>sum+item.file.size,0);let uploadedBytes=0;
    for (let index = 0; index < input.episodes.length; index += 1) {
      const item = input.episodes[index];
      input.onProgress?.({ completed: index, total: input.episodes.length, episode: item.episode, loadedBytes:uploadedBytes, totalBytes, phase: "upload" });
      const episodeForm = new FormData();
      episodeForm.set("drama", drama.id);
      episodeForm.set("episode_number", String(item.episode));
      episodeForm.set("original_name", item.file.name);
      episodeForm.set("mime_type", item.file.type || "application/octet-stream");
      episodeForm.set("byte_size", String(item.file.size));
      episodeForm.set("analysis_status", "queued");
      episodeForm.set("video", item.file, item.file.name);
      await pbUpload("/api/collections/drama_episodes/records","POST",episodeForm,(loaded)=>input.onProgress?.({completed:index,total:input.episodes.length,episode:item.episode,loadedBytes:uploadedBytes+loaded,totalBytes,phase:"upload"}),input.signal);
      uploadedBytes+=item.file.size;
      input.onProgress?.({ completed: index + 1, total: input.episodes.length, episode: item.episode, loadedBytes:uploadedBytes, totalBytes, phase: "upload" });
    }
  } catch (error) {
    if (!existing) await pbFetch(`/api/collections/dramas/records/${drama.id}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
  input.onProgress?.({ completed: input.episodes.length, total: input.episodes.length, loadedBytes:input.episodes.reduce((sum,item)=>sum+item.file.size,0), totalBytes:input.episodes.reduce((sum,item)=>sum+item.file.size,0), phase: "complete" });
  return getPocketBaseDrama(drama.id);
}

export async function upsertPocketBaseDramaEpisodes(
  recordId: string,
  episodes: PocketBaseEpisodeUpload[],
  onProgress?: PocketBaseDramaInput["onProgress"],
  signal?: AbortSignal,
): Promise<PocketBaseDramaRecord> {
  const numbers = episodes.map((item) => item.episode);
  if (new Set(numbers).size !== numbers.length) throw new Error("上传列表中存在重复集数");
  if (numbers.some((number) => !Number.isInteger(number) || number < 1)) throw new Error("集数必须是大于 0 的整数");
  const filter = encodeURIComponent(`drama="${recordId}"`);
  const existingResponse = await pbFetch(`/api/collections/drama_episodes/records?perPage=500&filter=${filter}`);
  const existingPayload = await existingResponse.json() as { items: PocketBaseRecord[] };
  const existingByEpisode = new Map(existingPayload.items.map((item) => [Number(item.episode_number), item]));
  onProgress?.({ completed: 0, total: episodes.length, phase: "metadata" });
  const totalBytes=episodes.reduce((sum,item)=>sum+item.file.size,0);let uploadedBytes=0;
  for (let index = 0; index < episodes.length; index += 1) {
    const item = episodes[index];
    const existing = existingByEpisode.get(item.episode);
    onProgress?.({ completed: index, total: episodes.length, episode: item.episode, loadedBytes:uploadedBytes, totalBytes, phase: "upload" });
    if(existing&&String(existing.original_name)===item.file.name&&Number(existing.byte_size)===item.file.size){uploadedBytes+=item.file.size;onProgress?.({completed:index+1,total:episodes.length,episode:item.episode,loadedBytes:uploadedBytes,totalBytes,phase:"upload"});continue}
    const form = new FormData();
    form.set("drama", recordId);
    form.set("episode_number", String(item.episode));
    form.set("original_name", item.file.name);
    form.set("mime_type", item.file.type || "application/octet-stream");
    form.set("byte_size", String(item.file.size));
    form.set("analysis_status", "queued");
    form.set("analysis_progress", "0");
    form.set("analysis_error", "");
    form.set("video", item.file, item.file.name);
    await pbUpload(existing ? `/api/collections/drama_episodes/records/${existing.id}` : "/api/collections/drama_episodes/records",existing ? "PATCH" : "POST",form,(loaded)=>onProgress?.({completed:index,total:episodes.length,episode:item.episode,loadedBytes:uploadedBytes+loaded,totalBytes,phase:"upload"}),signal);
    uploadedBytes+=item.file.size;
    onProgress?.({ completed: index + 1, total: episodes.length, episode: item.episode, loadedBytes:uploadedBytes, totalBytes, phase: "upload" });
  }
  const maxEpisode = Math.max(0, ...numbers);
  const dramaResponse = await pbFetch(`/api/collections/dramas/records/${recordId}`);
  const drama = await dramaResponse.json() as PocketBaseRecord;
  if (maxEpisode > Number(drama.total_episodes || 0)) {
    const form = new FormData();
    form.set("total_episodes", String(maxEpisode));
    await pbFetch(`/api/collections/dramas/records/${recordId}`, { method: "PATCH", body: form });
  }
  onProgress?.({ completed: episodes.length, total: episodes.length, loadedBytes:totalBytes, totalBytes, phase: "complete" });
  return getPocketBaseDrama(recordId);
}

async function getPocketBaseDrama(recordId: string): Promise<PocketBaseDramaRecord> {
  const dramaResponse = await pbFetch(`/api/collections/dramas/records/${recordId}`);
  const drama = await dramaResponse.json() as PocketBaseRecord;
  const filter = encodeURIComponent(`drama="${recordId}"`);
  const episodesResponse = await pbFetch(`/api/collections/drama_episodes/records?perPage=500&sort=episode_number&filter=${filter}`);
  const payload = await episodesResponse.json() as { items: PocketBaseRecord[] };
  const jobsResponse = await pbFetch(`/api/collections/analysis_jobs/records?perPage=500&sort=created&filter=${filter}&expand=episode`);
  const jobsPayload = await jobsResponse.json() as { items: PocketBaseRecord[] };
  const episodeNumberById = new Map(payload.items.map((item) => [item.id, Number(item.episode_number)]));
  const coarseJobs = jobsPayload.items.filter((item) => item.stage === "coarse");
  const coarseByEpisode = new Map(coarseJobs.map((item) => [String(item.episode || ""), item]));
  const normalizeJobStatus = (value: unknown): FactoryEpisodeMedia["analysisStatus"] => {
    const status = String(value || "idle");
    if (status === "succeeded" || status === "success" || status === "done") return "completed";
    if (status === "running") return "running";
    if (status === "queued" || status === "failed" || status === "processing" || status === "completed") return status;
    return "idle";
  };
  const episodeMedia: Record<number, FactoryEpisodeMedia> = {};
  for (const episode of payload.items) {
    const number = Number(episode.episode_number);
    const coarseJob = coarseByEpisode.get(episode.id);
    episodeMedia[number] = {
      episode: number,
      name: String(episode.original_name || episode.video || `EP${number}`),
      url: fileUrl(episode, episode.video),
      duration: Number(episode.duration_seconds) || undefined,
      mimeType: String(episode.mime_type || "video/mp4"),
      analysisStatus: normalizeJobStatus(coarseJob?.status ?? episode.analysis_status),
      analysisProgress: Number(coarseJob?.progress ?? episode.analysis_progress) || 0,
      analysisError: typeof (coarseJob?.error ?? episode.analysis_error) === "string" ? String(coarseJob?.error ?? episode.analysis_error) || undefined : undefined,
      analysisResult: coarseJob?.result ?? episode.analysis_result,
    };
  }
  const latestDetail = [...jobsPayload.items].reverse().find((item) => item.stage === "detail" && item.status === "succeeded");
  const precisionResults = jobsPayload.items
    .filter((item) => item.stage === "precision" && item.status === "succeeded" && item.result)
    .map((item) => ({ episode: episodeNumberById.get(String(item.episode || "")) || 0, result: item.result, parameters: item.logs }));
  const stageSnapshot = (stage: "coarse" | "detail" | "precision") => {
    const stageJobs = jobsPayload.items.filter((item) => item.stage === stage);
    if (!stageJobs.length) return { status: String(drama[`${stage}_status`] || "idle"), progress: Number(drama[`${stage}_progress`]) || 0 };
    const succeeded = stageJobs.filter((item) => item.status === "succeeded").length;
    const failed = stageJobs.filter((item) => item.status === "failed").length;
    const running = stageJobs.filter((item) => item.status === "running").length;
    const status = succeeded === stageJobs.length ? "succeeded" : running ? "running" : failed ? "failed" : "queued";
    const progress = Math.round(stageJobs.reduce((sum, item) => sum + (item.status === "succeeded" ? 100 : Number(item.progress) || 0), 0) / stageJobs.length);
    return { status, progress };
  };
  const coarse = stageSnapshot("coarse");
  const detail = stageSnapshot("detail");
  const precision = stageSnapshot("precision");
  return {
    recordId: drama.id,
    externalId: String(drama.external_id),
    title: String(drama.title),
    cn: String(drama.cn),
    genre: String(drama.genre),
    language: String(drama.language),
    totalEpisodes: Number(drama.total_episodes),
    freeEpisodes: Number(drama.free_episodes),
    copyrightStatus: String(drama.copyright_status || ""),
    parseState: String(drama.parse_state || "queued"),
    parseConfig: drama.parse_config,
    analysis: normalizeAnalysisPayload(drama.analysis),
    coarseStatus: coarse.status,
    coarseProgress: coarse.progress,
    detailStatus: detail.status,
    detailProgress: detail.progress,
    precisionStatus: precision.status,
    precisionProgress: precision.progress,
    analysisError: [coarse.status, detail.status, precision.status].includes("failed") ? String(drama.analysis_error || "") || undefined : undefined,
    detailResult: normalizeAnalysisPayload(latestDetail?.result ?? drama.analysis),
    precisionResults,
    posterUrl: fileUrl(drama, drama.poster, "300x400"),
    episodeMedia,
  };
}

export async function listPocketBaseDramas(): Promise<PocketBaseDramaRecord[]> {
  const response = await pbFetch("/api/collections/dramas/records?perPage=500");
  const payload = await response.json() as { items: PocketBaseRecord[] };
  return Promise.all(payload.items.map((item) => getPocketBaseDrama(item.id)));
}

export async function updatePocketBaseDramaPoster(recordId: string, posterDataUrl: string) {
  const form = new FormData();
  form.set("poster", await dataUrlToFile(posterDataUrl, `${recordId}-poster.jpg`));
  await pbFetch(`/api/collections/dramas/records/${recordId}`, { method: "PATCH", body: form });
  return getPocketBaseDrama(recordId);
}

export async function updatePocketBaseDramaAnalysis(recordId: string, analysis: unknown) {
  const form = new FormData();
  form.set("analysis", JSON.stringify(normalizeAnalysisPayload(analysis)));
  await pbFetch(`/api/collections/dramas/records/${recordId}`, { method: "PATCH", body: form });
  return getPocketBaseDrama(recordId);
}

export async function updatePocketBaseDramaParseConfig(recordId: string, parseConfig: { coarse: string; detail: string; precision: string }) {
  await pbFetch(`/api/collections/dramas/records/${recordId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parse_config: parseConfig }),
  });
  return getPocketBaseDrama(recordId);
}

export async function retryPocketBaseDramaDetail(recordId: string) {
  await pbFetch(`/api/lumina/analysis/dramas/${encodeURIComponent(recordId)}/retry-detail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return getPocketBaseDrama(recordId);
}

export async function checkPocketBase() {
  const response = await pbFetch("/api/health");
  return response.ok;
}
