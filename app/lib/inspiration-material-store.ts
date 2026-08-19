"use client";

import { normalizeTag, type OntologyDimension } from "./ontology/normalization";

export type InspirationMaterialType = "未确定" | "正片剧集拼接" | "正片剧集解说" | "外搭钩子＋本剧正片";
export type InspirationAnalysisStatus = "queued" | "running" | "succeeded" | "failed" | "idle";

export type MaterialEvidence = {
  id?: string;
  kind: "asr" | "ocr" | "frame" | "shot" | "audio" | string;
  start: number;
  end: number;
  text?: string;
  translation?: string;
  confidence: number;
  verification?: "verified" | "needs_review" | "rejected" | string;
};

export type MaterialTag = {
  code: string;
  label: string;
  confidence: number;
  evidence?: string[];
  verification?: "verified" | "needs_review" | "rejected" | string;
};

export type MaterialSegment = {
  code: string;
  label: string;
  start: number;
  end: number;
  description?: string;
  confidence?: number;
  evidence?: string[];
};

export type MaterialAnalysisV2 = {
  schemaVersion: "material-v2" | string;
  evidence: MaterialEvidence[];
  content: {
    summary?: string;
    completeness?: string;
    genres: MaterialTag[];
    themes: MaterialTag[];
    characters: MaterialTag[];
    relations: MaterialTag[];
    emotions: MaterialTag[];
    conflicts: MaterialTag[];
    storyBeats: MaterialTag[];
    scenes: MaterialTag[];
  };
  creative: {
    materialType?: MaterialTag;
    tLevel?: MaterialTag;
    bodyFormat?: MaterialTag;
    hookSourceStatus?: MaterialTag;
    narrationCoverage?: number;
    hook?: { start?: number; end?: number; source?: string; mechanisms: MaterialTag[]; sensoryChannels: MaterialTag[] };
    timeline: MaterialSegment[];
    packaging: MaterialTag[];
    transitions: MaterialTag[];
  };
  value: {
    scores: Array<{ code: string; label: string; score: number; reason?: string; evidence?: string[] }>;
    inspirations: string[];
    avoid: string[];
    suitableGenres: string[];
    suitableAudiences: string[];
  };
  review: {
    status?: string;
    reviewRequired?: boolean;
    items: Array<{ id: string; field: string; label: string; reason?: string; proposedValue?: string; confidence?: number }>;
    note?: string;
  };
  sourceAttribution?: unknown;
};

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
  analysisStage?: string;
  analysisError?: string;
  analysisResult?: unknown;
  analysisV2?: MaterialAnalysisV2;
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
  contentHash?: string;
  sourceUrl?: string;
  rightsStatus?: string;
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
    const payload = await response.json().catch(() => null) as { message?: string; data?:Record<string,{message?:string}> } | null;
    const fieldMessage=payload?.data&&Object.values(payload.data).map(value=>value?.message).find(Boolean);
    throw new Error(fieldMessage || payload?.message || `PocketBase 请求失败（HTTP ${response.status}）`);
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

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
const languageNames:Record<string,string>={zh:"中文",en:"英语",ja:"日语",jp:"日语",ko:"韩语",es:"西班牙语",pt:"葡萄牙语",fr:"法语",de:"德语",it:"意大利语",ru:"俄语",ar:"阿拉伯语",hi:"印地语",tr:"土耳其语",vi:"越南语",th:"泰语",id:"印度尼西亚语"};
function normalizedLanguage(value:unknown){const raw=text(value).trim(),code=raw.toLowerCase().split(/[-_]/)[0];return languageNames[code]||raw}
function detectEvidenceLanguage(value:unknown){
  const root=object(value),evidence=object(root.evidence),sample=list(evidence.transcript).concat(list(evidence.ocr)).map(item=>text(object(item).text)).join(" ");
  if(/[\u3040-\u30ff]/u.test(sample))return"日语";
  if(/[\uac00-\ud7af]/u.test(sample))return"韩语";
  if(/[\u0400-\u04ff]/u.test(sample))return"俄语";
  if(/[\u0600-\u06ff]/u.test(sample))return"阿拉伯语";
  if(/[\u0e00-\u0e7f]/u.test(sample))return"泰语";
  if(/[\u4e00-\u9fff]/u.test(sample))return"中文";
  return"";
}
function tags(value: unknown, dimension: OntologyDimension = "theme"): MaterialTag[] {
  return list(value).map((raw, index) => {
    if (typeof raw === "string") return { code: `TAG_${index + 1}`, label: raw, confidence: Number.NaN };
    const item = object(raw);
    const relationLabel = text(item.from) && text(item.to) ? `${text(item.from)} · ${text(item.type, "关系")} · ${text(item.to)}` : "";
    const legacy = text(item.label, text(item.name, relationLabel || text(item.type, "未命名标签")));
    const canonical = normalizeTag({ ...item, label: legacy }, dimension);
    return {
      code: byLegacyCode(item.code, canonical.code, index), label: canonical.label,
      confidence: item.confidence === undefined || item.confidence === null ? Number.NaN : number(item.confidence), evidence: list(item.evidence).filter((v): v is string => typeof v === "string"),
      verification: text(item.verification) || undefined,
    };
  });
}

function byLegacyCode(raw: unknown, canonical: string, index: number) {
  const legacy = text(raw);
  return legacy && /^TAG_|^[A-Z0-9_-]+$/.test(legacy) ? legacy : canonical || `TAG_${index + 1}`;
}

const evidenceGroupForStore = (kind: string) => /ocr|subtitle/i.test(kind) ? "ocr" : /asr|transcript/i.test(kind) ? "asr" : "other";

function parseV2(value: unknown): MaterialAnalysisV2 | undefined {
  const root = object(value);
  const candidate = text(root.schemaVersion) === "material-v2" ? root : object(root.materialV2);
  if (text(candidate.schemaVersion) !== "material-v2") return undefined;
  const evidenceGroup = object(candidate.evidence);
  const translatedEvidence:Array<{source:string;start:number;end:number;text:string}>=[];
  const collectTranslations=(value:unknown,insideRawEvidence=false)=>{
    if(Array.isArray(value)){for(const item of value)collectTranslations(item,insideRawEvidence);return}
    const item=object(value);if(!Object.keys(item).length)return;
    const source=text(item.source),timecode=object(item.timecode),translated=text(item.translation,text(item.text));
    if(!insideRawEvidence&&source&&translated&&/[\u4e00-\u9fff]/u.test(translated)&&(item.timecode||item.start!==undefined))translatedEvidence.push({source:evidenceGroupForStore(source),start:number(item.start,number(timecode.start)),end:number(item.end,number(timecode.end,number(item.start,number(timecode.start)))),text:translated});
    for(const [key,child] of Object.entries(item))collectTranslations(child,insideRawEvidence||key==="evidence"&&item===candidate);
  };
  collectTranslations(candidate);
  const groupedEvidence = [
    ["transcript", "asr"], ["asr", "asr"], ["ocr", "ocr"], ["keyframes", "frame"], ["shots", "shot"], ["audioEvents", "audio"],
  ] as const;
  const rawEvidence = Array.isArray(candidate.evidence)
    ? list(candidate.evidence).map(raw => ({ raw, kind: "frame" }))
    : groupedEvidence.flatMap(([field, kind]) => list(evidenceGroup[field]).map(raw => ({ raw, kind })));
  const allEvidence = rawEvidence.map(({ raw, kind }, index) => { const item = object(raw), timecode = object(item.timecode), shot = number(item.shot, -1), evidenceText=text(item.text, shot >= 0 ? `镜头 ${shot}` : text(item.type)),start=number(item.start,number(timecode.start)),end=number(item.end,number(timecode.end,start)),matched=translatedEvidence.find(candidate=>candidate.source===evidenceGroupForStore(kind)&&Math.abs(candidate.start-start)<.25&&Math.abs(candidate.end-end)<.5); return {
    id: text(item.id, `evidence-${kind}-${index + 1}`), kind: text(item.kind, text(item.source, kind)),
    start, end,
    text: evidenceText || undefined, translation: text(item.translation,matched?.text) || undefined,
    confidence: number(item.confidence), verification: kind === "ocr" ? "observed" : text(item.verification) || undefined,
  }; }).filter(item=>{
    if(evidenceGroupForStore(item.kind)!=="ocr")return true;
    const value=(item.translation||item.text||"").replace(/\s+/g," ").trim(),compact=value.replace(/[^\p{L}\p{N}]/gu,"");
    return compact.length>=2&&!/(?:,|;|:|\b(?:and|or|but|with|to|of|a|an|the))$/i.test(value);
  }).filter((item,index,array)=>array.findIndex(other=>other.kind===item.kind&&Math.abs(other.start-item.start)<.05&&(other.translation||other.text)===(item.translation||item.text))===index).sort((left, right) => left.start - right.start || left.end - right.end);
  const evidenceLimit = 48;
  const evidence = allEvidence.length <= evidenceLimit ? allEvidence : Array.from({ length: evidenceLimit }, (_, index) => allEvidence[Math.round(index * (allEvidence.length - 1) / (evidenceLimit - 1))]);
  const content = object(candidate.content), creative = object(candidate.creative), hook = object(creative.hook), valuePart = object(candidate.value), review = object(candidate.review);
  const timeline = list(creative.timeline).map((raw, index) => { const item = object(raw); return { code: text(item.code, `SEGMENT_${index + 1}`), label: text(item.label, "未命名段落"), start: number(item.start), end: number(item.end), description: text(item.description) || undefined, confidence: number(item.confidence), evidence: list(item.evidence).filter((v): v is string => typeof v === "string") }; });
  const tag = (raw: unknown): MaterialTag | undefined => tags(raw ? [raw] : [])[0];
  const reviewReasonItem = (reason: string, index: number) => {
    const sourceIssue = /外搭|外部钩子|来源差异|剪辑来源/.test(reason), speechIssue = /语音|听写|ASR|转录/.test(reason), contextIssue = /上下文|叙事链|完整叙事|背景/.test(reason);
    return { id: `review-reason-${index + 1}`, field: sourceIssue ? "creative.hookSourceStatus" : speechIssue ? "evidence.asr" : contextIssue ? "content.completeness" : "analysis", label: sourceIssue ? "素材来源待复核" : speechIssue ? "语音证据待复核" : contextIssue ? "叙事上下文待复核" : "分析结论待复核", reason };
  };
  const claimTextValue=(value:unknown)=>{const item=object(value);return text(item.value,text(item.label,text(item.code,text(value))))};
  return {
    schemaVersion: "material-v2", evidence,
    content: { summary: claimTextValue(content.summary) || undefined, completeness: claimTextValue(content.completeness) || undefined, genres: tags(content.genres, "genre"), themes: tags(content.themes??content.tags, "theme"), characters: tags(content.characters, "role"), relations: tags(content.relations??content.relationships, "relation"), emotions: tags(content.emotions, "emotion"), conflicts: tags(content.conflicts, "conflict"), storyBeats: tags(content.storyBeats??content.segments, "storyBeat"), scenes: tags(content.scenes, "scene") },
    creative: { materialType: tag(creative.materialType??creative.format), tLevel: tag(creative.tLevel??creative.tier), bodyFormat: tag(creative.bodyFormat), hookSourceStatus: tag(creative.hookSourceStatus), narrationCoverage: number(object(creative.narrationCoverage).value, number(creative.narrationCoverage)), hook: Object.keys(hook).length ? { start: number(hook.start), end: number(hook.end), source: text(hook.source) || undefined, mechanisms: tags(hook.mechanisms), sensoryChannels: tags(hook.sensoryChannels) } : undefined, timeline, packaging: tags(creative.packaging), transitions: tags(creative.transitions) },
    value: { scores: list(valuePart.scores).map(raw => { const item = object(raw); return { code: text(item.code), label: text(item.label), score: number(item.score), reason: text(item.reason) || undefined, evidence: list(item.evidence).filter((v): v is string => typeof v === "string") }; }), inspirations: list(valuePart.inspirations).filter((v): v is string => typeof v === "string"), avoid: list(valuePart.avoid).filter((v): v is string => typeof v === "string"), suitableGenres: list(valuePart.suitableGenres).filter((v): v is string => typeof v === "string"), suitableAudiences: list(valuePart.suitableAudiences).filter((v): v is string => typeof v === "string") },
    review: { status: text(review.status) || undefined, reviewRequired: Boolean(review.reviewRequired), items: [...list(review.items).map((raw, index) => { const item = object(raw); return { id: text(item.id, `review-${index + 1}`), field: text(item.field), label: text(item.label, "待复核项"), reason: text(item.reason) || undefined, proposedValue: text(item.proposedValue) || undefined, confidence: item.confidence === undefined || item.confidence === null ? undefined : number(item.confidence) }; }), ...list(review.reasons).filter((v):v is string=>typeof v==="string").map(reviewReasonItem)], note: text(review.note) || undefined },
    sourceAttribution: candidate.sourceAttribution,
  };
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

function fromRecord(record: PBRecord, job?: PBRecord): InspirationMaterial {
  const envelope = object(record.analysis_result);
  const result = { ...envelope, ...object(envelope.materialFields), ...object(envelope.result) };
  const structure = object(first(result, ["structure", "creativeStructure"], {}));
  const hook = object(first(result, ["hook", "hookAnalysis"], {}));
  const rawStatus = text(record.analysis_status, "idle");
  const status = (rawStatus === "completed" ? "succeeded" : rawStatus) as InspirationAnalysisStatus;
  const progress = Math.max(0, Math.min(100, number(record.analysis_progress)));
  const createdAt = text(record.created);
  const video = text(record.video);
  const duration = number(record.duration_seconds);
  const analysisV2 = parseV2(record.analysis_result);
  const analyzedType=text(record.material_format,analysisV2?.creative.materialType?.label||"");
  const effectiveType=(["正片剧集拼接","正片剧集解说","外搭钩子＋本剧正片"].includes(analyzedType)?analyzedType:"未确定") as InspirationMaterialType;
  return {
    id: record.id,
    title: text(record.title, text(record.original_name, "未命名素材")),
    type: status==="succeeded"?effectiveType:(text(record.type)==="待AI识别"?"未确定":text(record.type,"未确定")) as InspirationMaterialType,
    source: text(record.source, "外部") === "内部" ? "内部" : "外部",
    platform: text(record.platform, "手动上传"),
    market: text(record.market, "未知市场"),
    language: normalizedLanguage(first(result,["detectedLanguage","language"],detectEvidenceLanguage(record.analysis_result)))||normalizedLanguage(record.language)||"未知语种",
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
    analysisStage: text(object(job?.logs).stage, status === "queued" ? "等待素材 Worker" : status === "succeeded" ? "分析完成" : ""),
    analysisError: text(record.analysis_error) || undefined,
    analysisResult: record.analysis_result,
    analysisV2,
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
    contentHash: text(record.content_hash) || undefined,
    sourceUrl: text(record.source_url) || undefined,
    rightsStatus: text(record.rights_status, "仅限内部分析"),
  };
}


export async function submitInspirationReview(id: string, status: "已通过" | "已修改" | "退回重分析", note: string): Promise<void> {
  const response = await pbFetch(`/api/collections/ad_materials/records/${encodeURIComponent(id)}`);
  const record = await response.json() as PBRecord;
  const current = object(record.analysis_result);
  const v2 = parseV2(current);
  const nextResult = v2 ? { ...current, review: { ...v2.review, status, note, reviewedAt: new Date().toISOString() } } : current;
  await pbFetch(`/api/collections/ad_materials/records/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review_status: status, analysis_result: nextResult }),
  });
  if (status === "退回重分析") await retryInspirationMaterialAnalysis(id);
}

export async function listInspirationMaterials(signal?: AbortSignal): Promise<InspirationMaterial[]> {
  const [materialResponse, jobResponse] = await Promise.all([
    pbFetch("/api/collections/ad_materials/records?perPage=500&sort=-id", { signal }),
    pbFetch("/api/collections/material_analysis_jobs/records?perPage=500&sort=-id", { signal }),
  ]);
  const payload = await materialResponse.json() as { items?: PBRecord[] };
  const jobPayload = await jobResponse.json() as { items?: PBRecord[] };
  const jobByMaterial = new Map((jobPayload.items ?? []).map(job => [text(job.material), job]));
  return (payload.items ?? []).map(record => fromRecord(record, jobByMaterial.get(record.id)));
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
  contentHash: string;
  sourceUrl?: string;
  rightsStatus: string;
};

export async function saveInspirationMaterial(input: InspirationMaterialInput | InspirationMaterial, video: File, onProgress?: (percent:number)=>void): Promise<InspirationMaterial> {
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
  form.set("content_hash", input.contentHash ?? "");
  form.set("source_url", input.sourceUrl ?? "");
  form.set("rights_status", input.rightsStatus ?? "仅限内部分析");
  form.set("analysis_status", "queued");
  form.set("analysis_progress", "0");
  form.set("review_status", "待复核");
  form.set("video", video, video.name);
  const savedRecord = await new Promise<PBRecord>((resolve,reject)=>{
    const request=new XMLHttpRequest();request.open("POST",`${PB_URL}/api/collections/ad_materials/records`);
    request.upload.onprogress=event=>{if(event.lengthComputable)onProgress?.(Math.max(1,Math.min(99,Math.round(event.loaded/event.total*100))))};
    request.onerror=()=>reject(new Error(`上传连接中断（${PB_URL}）`));request.onabort=()=>reject(new DOMException("上传已取消","AbortError"));
    request.onload=()=>{let payload:unknown;try{payload=JSON.parse(request.responseText)}catch{payload=null}if(request.status<200||request.status>=300){const body=object(payload);const data=object(body.data);const fieldMessage=Object.values(data).map(value=>text(object(value).message)).find(Boolean);reject(new Error(fieldMessage||text(body.message,`PocketBase 上传失败（HTTP ${request.status}）`)));return}onProgress?.(100);resolve(payload as PBRecord)};
    request.send(form);
  });
  const saved = fromRecord(savedRecord);
  // The upload modal keeps the submitted object until this promise resolves.
  // Synchronise that reference so its immediate optimistic row uses the PB id/file URL.
  if ("id" in input) Object.assign(input, saved);
  return saved;
}

export async function findInspirationMaterialByHash(hash:string):Promise<InspirationMaterial|undefined>{
  if(!hash)return undefined;const filter=encodeURIComponent(`content_hash="${hash.replace(/"/g,'\\"')}"`);const response=await pbFetch(`/api/collections/ad_materials/records?perPage=1&filter=${filter}`);const payload=await response.json() as {items?:PBRecord[]};return payload.items?.[0]?fromRecord(payload.items[0]):undefined;
}

export async function hashInspirationVideo(file:File):Promise<string>{
  const buffer=await file.arrayBuffer();const digest=await crypto.subtle.digest("SHA-256",buffer);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}

export function createInspirationMaterialVideoUrl(material: InspirationMaterial): string | null {
  return material.media?.url ?? null;
}

export async function removeInspirationMaterial(id: string): Promise<void> {
  await pbFetch(`/api/collections/ad_materials/records/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function retryInspirationMaterialAnalysis(id: string): Promise<void> {
  await pbFetch(`/api/lumina/material-analysis/materials/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
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
