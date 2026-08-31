"use client";

import { normalizeTags, normalizeTag, type OntologyTag } from "./ontology/normalization";

export type HookSourceClass =
  | "episode_highlight"
  | "narration_opening"
  | "external_material"
  | "ai_generated"
  | "mixed_material";
export type HookBoundaryStatus = "unverified" | "verified" | "rejected";
export type HookSourceStatus = "无独立钩子" | "已确认同剧" | "疑似外搭" | "已确认外搭" | "来源未知" | "";
export type HookAssemblyType = "无前置钩子" | "同剧外搭" | "跨剧外搭" | "外搭来源待确认" | "";

export type HookBoundary = {
  kind?: "start" | "end";
  time?: number;
  status?: string;
  dialogueStatus?: string;
  actionStatus?: string;
  nearestShotBoundary?: number | null;
  evidence?: Array<{ source?: string; result?: string }>;
};

export type HookAsset = {
  id: string;
  sourceClass: HookSourceClass;
  hookSourceStatus: HookSourceStatus;
  hookAssemblyType: HookAssemblyType;
  materialId?: string;
  materialTitle?: string;
  materialType?: string;
  materialPlatform?: string;
  materialExposure?: number;
  materialRunDays?: number;
  materialVideoUrl?: string;
  dramaId?: string;
  dramaTitle?: string;
  episodeId?: string;
  episodeNumber?: number;
  title: string;
  start: number;
  end: number;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  boundaryStatus: HookBoundaryStatus;
  safeStart?: HookBoundary;
  safeEnd?: HookBoundary;
  hookType: string;
  themes: string[];
  contentTags: string[];
  relationships: string[];
  conflict: string;
  emotion: string;
  /** Canonical labels; legacy scalar fields above remain unchanged. */
  ontologyTags?: OntologyTag[];
  narrativePromise: string;
  informationGap: string;
  spokenSummary: string;
  visualSummary: string;
  qualityScores: Record<string, number>;
  evidence: unknown;
  rightsStatus: string;
  reviewStatus: "pending" | "needs_review" | "approved" | "rejected";
};

/**
 * Production selection is source-agnostic. Source class remains useful for
 * ranking and diagnostics, but must not exclude an otherwise safe hook.
 */
export function isSelectableProductionHook(hook: HookAsset): boolean {
  return Boolean(hook.materialVideoUrl)
    && hook.end > hook.start
    && hook.boundaryStatus === "verified"
    && hook.reviewStatus === "approved";
}

type PBRecord = Record<string, unknown> & { id: string; collectionId: string; expand?: Record<string, Record<string, unknown>> };
import { POCKETBASE_URL as PB_URL, pocketBaseUiHeaders } from "./pocketbase-url";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const strings = (value: unknown) => Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : text(object(item).label, text(object(item).value))).filter(Boolean) : [];
const claimText = (value: unknown) => typeof value === "string" ? text(value) : text(object(value).value, text(object(value).label));

async function pbJson(path: string, init?: RequestInit) {
  const response = await fetch(`${PB_URL}${path}`, { cache: "no-store", ...init, headers: { ...pocketBaseUiHeaders(), ...(init?.headers || {}) } });
  if (!response.ok) throw new Error(`钩子资产请求失败（HTTP ${response.status}）`);
  return response.json();
}

function fromRecord(record: PBRecord): HookAsset {
  const material = object(record.expand?.material);
  const materialResult = object(object(material.analysis_result).result);
  const materialCreative = object(materialResult.creative);
  const episode = object(record.expand?.episode);
  const episodeDrama = object(object(episode.expand).drama);
  const materialId = text(record.material);
  const episodeId = text(record.episode);
  const videoName = text(material.video);
  const episodeVideoName = text(episode.video);
  const episodeNumber = number(episode.episode_number);
  const episodeVideoUrl = episodeId && episodeVideoName
    ? `${PB_URL}/api/files/${text(episode.collectionId, "pbc_lumepisodes")}/${episodeId}/${encodeURIComponent(episodeVideoName)}`
    : undefined;
  const episodeSourceTitle = episodeId
    ? `${text(episodeDrama.title, "剧集正片")} · 第 ${episodeNumber || "?"} 集`
    : undefined;
  return {
    id: record.id,
    sourceClass: text(record.source_class, "external_material") as HookSourceClass,
    hookSourceStatus: text(record.hook_source_status, claimText(materialCreative.hookSourceStatus)) as HookSourceStatus,
    hookAssemblyType: text(record.hook_assembly_type, claimText(materialCreative.hookAssemblyType)) as HookAssemblyType,
    materialId: materialId || undefined,
    materialTitle: text(material.title) || episodeSourceTitle,
    materialType: text(material.material_format, text(material.type)) || undefined,
    materialPlatform: text(material.platform) || undefined,
    materialExposure: number(material.exposure) || undefined,
    materialRunDays: number(material.days) || undefined,
    materialVideoUrl: materialId && videoName ? `${PB_URL}/api/files/${text(material.collectionId, "pbc_lumadmat001")}/${materialId}/${encodeURIComponent(videoName)}` : episodeVideoUrl,
    dramaId: text(record.drama, text(episode.drama, text(episodeDrama.id))) || undefined,
    dramaTitle: text(episodeDrama.title) || undefined,
    episodeId: episodeId || undefined,
    episodeNumber: episodeNumber || undefined,
    title: text(record.title, "未命名钩子"),
    start: number(record.start_seconds), end: number(record.end_seconds),
    startFrame: number(record.start_frame) || undefined, endFrame: number(record.end_frame) || undefined, fps: number(record.fps) || undefined,
    boundaryStatus: text(record.boundary_status, "unverified") as HookBoundaryStatus,
    safeStart: object(record.safe_start) as HookBoundary, safeEnd: object(record.safe_end) as HookBoundary,
    hookType: text(record.hook_type, "待分析"), themes: strings(record.themes), contentTags: strings(record.content_tags), relationships: strings(record.relationships),
    conflict: text(record.conflict), emotion: text(record.emotion), ontologyTags: [
      ...normalizeTags(record.themes, "theme"), ...normalizeTags(record.content_tags, "acquisition"),
      ...normalizeTags(record.relationships, "relation"), ...((text(record.conflict) ? [normalizeTag(record.conflict, "conflict")] : [])),
      ...((text(record.emotion) ? [normalizeTag(record.emotion, "emotion")] : [])),
    ], narrativePromise: text(record.narrative_promise), informationGap: text(record.information_gap),
    spokenSummary: text(record.spoken_summary), visualSummary: text(record.visual_summary), qualityScores: object(record.quality_scores) as Record<string, number>,
    evidence: record.evidence, rightsStatus: text(record.rights_status, "授权待确认"), reviewStatus: text(record.review_status, "pending") as HookAsset["reviewStatus"],
  };
}

function normalizeHookTitles(items: HookAsset[]) {
  const groups = new Map<string, HookAsset[]>();
  for (const hook of items) {
    const sourceId = hook.sourceClass === "episode_highlight" ? hook.episodeId : hook.materialId;
    const key = `${hook.sourceClass}:${sourceId || hook.id}`;
    groups.set(key, [...(groups.get(key) ?? []), hook]);
  }
  const sequence = new Map<string, number>();
  for (const [key, hooks] of groups) {
    [...hooks].sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id)).forEach((hook, index) => sequence.set(`${key}:${hook.id}`, index + 1));
  }
  return items.map((hook) => {
    const sourceId = hook.sourceClass === "episode_highlight" ? hook.episodeId : hook.materialId;
    const key = `${hook.sourceClass}:${sourceId || hook.id}:${hook.id}`;
    const index = String(sequence.get(key) ?? 1).padStart(2, "0");
    const sourceTitle = hook.sourceClass === "episode_highlight" ? hook.dramaTitle || "未关联剧目" : hook.materialTitle || "未关联素材";
    const prefix = hook.sourceClass === "episode_highlight" ? "剧集高光" : hook.sourceClass === "narration_opening" ? "解说开场" : hook.hookAssemblyType === "同剧外搭" || hook.hookSourceStatus === "已确认同剧" ? "同剧高光前置" : hook.hookAssemblyType === "跨剧外搭" || hook.hookSourceStatus === "已确认外搭" ? "外搭钩子" : "来源待确认钩子";
    const episode = hook.sourceClass === "episode_highlight" ? ` - 第${hook.episodeNumber || "?"}集` : "";
    return { ...hook, title: `${prefix} - ${sourceTitle}${episode} - 钩子${index}` };
  });
}

function validLocalizedHook(hook: HookAsset) {
  const duration = hook.end - hook.start;
  if (!Number.isFinite(duration) || hook.start < 0) return false;
  if (hook.sourceClass === "episode_highlight") return duration >= 10 && duration <= 60;
  if (hook.sourceClass === "narration_opening") return hook.start < 60 && duration >= 5 && duration <= 60;
  // External hooks are localized opening assets as well, and production
  // accepts the same 5–60 second hook window used by the analysis contract.
  // The previous 20 second cap hid already-reviewed 20–60 second hooks from
  // history restoration and made an otherwise valid draft look incomplete.
  return hook.start <= 5 && duration >= 5 && duration <= 60;
}

export async function listHookAssets(signal?: AbortSignal, externalOnly = false): Promise<HookAsset[]> {
  const filter = externalOnly ? `&filter=${encodeURIComponent('source_class="external_material"')}` : "";
  const payload = await pbJson(`/api/collections/hook_assets/records?perPage=500&sort=-id&expand=material,episode,episode.drama${filter}`, { signal }) as { items?: PBRecord[] };
  return normalizeHookTitles((payload.items ?? []).map(fromRecord).filter(validLocalizedHook));
}

/** Inspiration screen only contains hooks extracted from imported ad materials. */
export async function listInspirationHookAssets(signal?: AbortSignal): Promise<HookAsset[]> {
  const filter = encodeURIComponent('source_class!="episode_highlight"');
  const payload = await pbJson(`/api/collections/hook_assets/records?perPage=500&sort=-id&expand=material&filter=${filter}`, { signal }) as { items?: PBRecord[] };
  return normalizeHookTitles((payload.items ?? []).map(fromRecord).filter(validLocalizedHook));
}

/** Analysis picker query across every source class; provenance remains visible. */
export async function listSelectableProductionHooks(signal?: AbortSignal): Promise<HookAsset[]> {
  return (await listHookAssets(signal)).filter(isSelectableProductionHook);
}

export async function getHookAsset(id: string, signal?: AbortSignal): Promise<HookAsset> {
  const hook = (await listHookAssets(signal)).find((item) => item.id === id);
  if (!hook) throw new Error("钩子资产不存在或已被删除");
  return hook;
}

export async function reviewHookBoundary(id: string, status: "approved" | "rejected", note: string, range?: { start: number; end: number }): Promise<HookAsset> {
  if (!note.trim()) throw new Error("请填写边界复核依据");
  await pbJson(`/api/lumina/hooks/${encodeURIComponent(id)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: status === "approved" ? "approve_boundaries" : "reject_boundaries", note: note.trim(), ...(range ? { start_seconds: range.start, end_seconds: range.end } : {}) }),
  });
  return getHookAsset(id);
}
