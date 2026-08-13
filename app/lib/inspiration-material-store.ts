"use client";

export type InspirationMaterialType = "正片剧集拼接" | "正片剧集解说" | "外搭钩子＋本剧正片";
export type InspirationAnalysisStatus = "queued" | "running" | "succeeded" | "failed" | "idle";

export type InspirationMaterial = {
  id: string;
  title: string;
  type: InspirationMaterialType;
  source: "外部" | "内部";
  platform: string;
  market: string;
  language: string;
  theme: string;
  emotion: string;
  hookType: string;
  hookDuration: number;
  transition: string;
  episode: string;
  exposure: number;
  days: number;
  captured: string;
  prototype: string;
  reuse: number;
  confidence: number;
  review: string;
  analysis: string;
  analysisStatus?: InspirationAnalysisStatus;
  analysisProgress?: number;
  analysisError?: string;
  analysisResult?: unknown;
  color: "rose" | "blue" | "cyan" | "amber";
  sensory: string;
  relation: string;
  highlight: string;
  hookRelation: string;
  avLead: string;
  ageDays: number;
  highPerformanceRatio: number;
  media?: { name: string; type: string; size: number; duration: number; url?: string };
  createdAt?: string;
};

type PBRecord = Record<string, unknown> & {
  id: string;
  collectionId: string;
  collectionName: string;
  created?: string;
};

const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POCKETBASE_URL : undefined;
const PB_URL = (configuredUrl || "http://127.0.0.1:8090").replace(/\/$/, "");

async function pbFetch(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${PB_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error(`无法连接 PocketBase（${PB_URL}），请先启动本项目的 PocketBase 服务`);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null;
    throw new Error(payload?.message || `PocketBase 请求失败（HTTP ${response.status}）`);
  }
  return response;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(result: Record<string, unknown>, names: string[], fallback: unknown = "") {
  for (const name of names) {
    if (result[name] !== undefined && result[name] !== null && result[name] !== "") return result[name];
  }
  return fallback;
}

function analysisLabel(status: InspirationAnalysisStatus, progress: number) {
  if (status === "succeeded") return "真实分析完成";
  if (status === "failed") return "分析失败";
  if (status === "running") return `真实分析中 ${Math.round(progress)}%`;
  if (status === "queued") return "等待真实分析";
  return "尚未分析";
}

function fileUrl(record: PBRecord, filename: unknown) {
  if (typeof filename !== "string" || !filename) return undefined;
  return `${PB_URL}/api/files/${record.collectionId}/${record.id}/${encodeURIComponent(filename)}`;
}

function fromRecord(record: PBRecord): InspirationMaterial {
  const envelope = object(record.analysis_result);
  const result = { ...envelope, ...object(envelope.result) };
  const structure = object(first(result, ["structure", "creativeStructure"], {}));
  const hook = object(first(result, ["hook", "hookAnalysis"], {}));
  const rawStatus = text(record.analysis_status, "idle");
  const status = (rawStatus === "completed" ? "succeeded" : rawStatus) as InspirationAnalysisStatus;
  const progress = Math.max(0, Math.min(100, number(record.analysis_progress)));
  const createdAt = text(record.created);
  const video = text(record.video);
  const duration = number(record.duration_seconds);
  return {
    id: record.id,
    title: text(record.title, text(record.original_name, "未命名素材")),
    type: text(record.type, "外搭钩子＋本剧正片") as InspirationMaterialType,
    source: text(record.source, "外部") === "内部" ? "内部" : "外部",
    platform: text(record.platform, "手动上传"),
    market: text(record.market, "未知市场"),
    language: text(record.language, "未知语种"),
    theme: text(record.theme, text(first(result, ["theme", "genre"]), "待分析")),
    emotion: text(first(result, ["emotion", "dominantEmotion"]), "待分析"),
    hookType: text(first(hook, ["type", "hookType"], first(result, ["hookType", "hook_type"], "待分析"))),
    hookDuration: number(first(hook, ["duration", "durationSeconds"], first(result, ["hookDuration", "hook_duration"], 0))),
    transition: text(first(structure, ["transition", "transitionType"], first(result, ["transition", "transitionType"], "待分析"))),
    episode: text(first(result, ["episode", "sourceEpisode"]), "上传素材"),
    exposure: number(record.exposure),
    days: number(record.days),
    captured: createdAt ? new Date(createdAt).toLocaleString("zh-CN") : "",
    prototype: text(record.prototype, text(first(result, ["prototype", "hookPrototype"]), "待分析")),
    reuse: number(first(result, ["reuse", "reuseCount"])),
    confidence: Math.round(number(first(result, ["confidence", "overallConfidence"])) * (number(first(result, ["confidence", "overallConfidence"])) <= 1 ? 100 : 1)),
    review: text(record.review_status, "待复核"),
    analysis: analysisLabel(status, progress),
    analysisStatus: status,
    analysisProgress: progress,
    analysisError: text(record.analysis_error) || undefined,
    analysisResult: record.analysis_result,
    color: "blue",
    sensory: text(first(result, ["sensory", "sensoryHook"]), "待分析"),
    relation: text(first(result, ["relation", "characterRelation"]), "待分析"),
    highlight: text(first(result, ["highlight", "highlightSummary"]), "待分析"),
    hookRelation: text(first(result, ["hookRelation", "hook_relation"]), "待分析"),
    avLead: text(first(result, ["avLead", "audioVisualLead"]), "待分析"),
    ageDays: number(first(result, ["ageDays", "age_days"])),
    highPerformanceRatio: number(first(result, ["highPerformanceRatio", "high_performance_ratio"])),
    media: video ? {
      name: text(record.original_name, video),
      type: text(record.mime_type, "video/mp4"),
      size: number(record.byte_size),
      duration,
      url: fileUrl(record, video),
    } : undefined,
    createdAt,
  };
}

export async function listInspirationMaterials(signal?: AbortSignal): Promise<InspirationMaterial[]> {
  const response = await pbFetch("/api/collections/ad_materials/records?perPage=500&sort=-id", { signal });
  const payload = await response.json() as { items?: PBRecord[] };
  return (payload.items ?? []).map(fromRecord);
}

export type InspirationMaterialInput = {
  title: string;
  type: InspirationMaterialType;
  source: "外部" | "内部";
  platform: string;
  market: string;
  language: string;
  theme: string;
  exposure: number;
  days: number;
  duration: number;
};

export async function saveInspirationMaterial(input: InspirationMaterialInput | InspirationMaterial, video: File): Promise<InspirationMaterial> {
  const form = new FormData();
  form.set("title", input.title);
  form.set("type", input.type);
  form.set("source", input.source);
  form.set("platform", input.platform);
  form.set("market", input.market);
  form.set("language", input.language);
  form.set("theme", input.theme);
  form.set("exposure", String(input.exposure));
  form.set("days", String(input.days));
  form.set("original_name", video.name);
  form.set("mime_type", video.type || "application/octet-stream");
  form.set("byte_size", String(video.size));
  form.set("duration_seconds", String("duration" in input ? input.duration : input.media?.duration ?? 0));
  form.set("analysis_status", "queued");
  form.set("analysis_progress", "0");
  form.set("review_status", "待复核");
  form.set("video", video, video.name);
  const response = await pbFetch("/api/collections/ad_materials/records", { method: "POST", body: form });
  const saved = fromRecord(await response.json() as PBRecord);
  // The upload modal keeps the submitted object until this promise resolves.
  // Synchronise that reference so its immediate optimistic row uses the PB id/file URL.
  if ("id" in input) Object.assign(input, saved);
  return saved;
}

export function createInspirationMaterialVideoUrl(material: InspirationMaterial): string | null {
  return material.media?.url ?? null;
}

export async function removeInspirationMaterial(id: string): Promise<void> {
  await pbFetch(`/api/collections/ad_materials/records/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => { const duration = Number.isFinite(video.duration) ? video.duration : 0; URL.revokeObjectURL(url); resolve(duration); };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取视频，请确认文件格式有效")); };
    video.src = url;
  });
}
