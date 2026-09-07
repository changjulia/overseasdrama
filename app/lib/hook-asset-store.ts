"use client";
import { boundedFetch as fetch } from "./bounded-fetch";
import { isPreRollSource, PRE_ROLL_FILTER } from "./pre-roll-eligibility";

import { normalizeTags, normalizeTag, type OntologyTag } from "./ontology/normalization";

export type HookSourceClass = "episode_highlight" | "narration_opening" | "external_material";
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
  usageRole?: string;
  identityConstraints?: string;
  openingSemanticStatus?: string;
  boundarySelection?: { status?: string; end?: number; reason?: string; scanCoverageEnd?: number };
  tokenBudget?: { cap?: number; used?: number };
  materialAnalysisStatus?: string;
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

export function isSelectableExternalHook(hook: HookAsset): boolean {
  return isPreRollSource(hook.sourceClass, hook.usageRole)
    && hook.boundaryStatus !== "rejected"
    && hook.reviewStatus !== "rejected";
}

type PBRecord = Record<string, unknown> & { id: string; collectionId: string; expand?: Record<string, Record<string, unknown>> };
const configuredUrl = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_POCKETBASE_URL : undefined;
const PB_URL = (configuredUrl || (typeof window !== "undefined" ? "/pb" : "http://127.0.0.1:8090")).replace(/\/$/, "");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const strings = (value: unknown) => Array.isArray(value) ? value.map((item) => typeof item === "string" ? item : text(object(item).label, text(object(item).value))).filter(Boolean) : [];
const claimText = (value: unknown) => typeof value === "string" ? text(value) : text(object(value).value, text(object(value).label));

async function pbJson(path: string, init?: RequestInit) {
  const response = await fetch(`${PB_URL}${path}`, { cache: "no-store", ...init });
  if (!response.ok) throw new Error(`钩子资产请求失败（HTTP ${response.status}）`);
  return response.json();
}

const HOOK_LIST_FIELDS = 'usage_role,analysis.identityConstraint,analysis.semanticStatus,expand.material.analysis_status,boundary_status,conflict,content_tags,drama,emotion,end_frame,end_seconds,episode,evidence,fps,hook_assembly_type,hook_source_status,hook_type,id,information_gap,material,narrative_promise,quality_scores,relationships,review_status,rights_status,safe_end,safe_start,source_class,spoken_summary,start_frame,start_seconds,themes,title,visual_summary,expand.material.id,expand.material.collectionId,expand.material.title,expand.material.video,expand.material.material_format,expand.material.type,expand.material.platform,expand.material.exposure,expand.material.days,expand.material.source_url,expand.material.analysis_result.result.creative.hookSourceStatus,expand.material.analysis_result.result.creative.hookAssemblyType,expand.episode.id,expand.episode.collectionId,expand.episode.video,expand.episode.episode_number,expand.episode.drama,expand.episode.expand.drama.id,expand.episode.expand.drama.title';
// The factory picker never displays raw ASR evidence, boundary attestations or
// quality payloads. Keeping those out makes 900+ narration hooks a small list
// request instead of downloading their complete 180-second transcripts.
const HOOK_PICKER_FIELDS = 'usage_role,analysis.identityConstraint,analysis.semanticStatus,boundary_status,conflict,content_tags,drama,emotion,end_seconds,episode,hook_assembly_type,hook_source_status,hook_type,id,information_gap,material,narrative_promise,relationships,review_status,rights_status,source_class,spoken_summary,start_seconds,themes,title,expand.material.analysis_status,expand.material.id,expand.material.collectionId,expand.material.title,expand.material.video,expand.material.material_format,expand.material.type,expand.material.platform,expand.material.exposure,expand.material.days,expand.material.source_url,expand.material.analysis_result.result.creative.hookSourceStatus,expand.material.analysis_result.result.creative.hookAssemblyType';

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
    usageRole: text(record.usage_role) || undefined,
    identityConstraints: text(object(record.analysis).identityConstraint) || undefined,
    openingSemanticStatus: text(object(record.analysis).semanticStatus) || undefined,
    boundarySelection: object(object(record.analysis).boundarySelection),
    tokenBudget: object(object(record.analysis).tokenBudget),
    materialAnalysisStatus: text(material.analysis_status, "idle"),
    hookSourceStatus: text(record.hook_source_status, claimText(materialCreative.hookSourceStatus)) as HookSourceStatus,
    hookAssemblyType: text(record.hook_assembly_type, claimText(materialCreative.hookAssemblyType)) as HookAssemblyType,
    materialId: materialId || undefined,
    materialTitle: text(material.title) || episodeSourceTitle,
    materialType: text(material.material_format, text(material.type)) || undefined,
    materialPlatform: text(material.platform) || undefined,
    materialExposure: number(material.exposure) || undefined,
    materialRunDays: number(material.days) || undefined,
    materialVideoUrl: materialId && videoName ? `${PB_URL}/api/files/${text(material.collectionId, "pbc_lumadmat001")}/${materialId}/${encodeURIComponent(videoName)}` : text(material.source_url) || episodeVideoUrl,
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

export function validLocalizedHook(hook: HookAsset) {
  const duration = hook.end - hook.start;
  if (!Number.isFinite(duration) || hook.start < 0) return false;
  if (hook.sourceClass === "episode_highlight") return duration >= 10 && duration <= 60;
  if (hook.sourceClass === "narration_opening") return hook.start < 60 && duration >= 5 && duration <= 180;
  // An external hook is a localized source fragment, not necessarily the
  // first fragment in its source upload.  Approved material-library hooks may
  // begin later in a benchmark/ad while still being the exact 5–60 second
  // range that production must trim and prepend.
  return duration >= 5 && duration <= 60;
}

export async function listHookAssets(signal?: AbortSignal, externalOnly = false): Promise<HookAsset[]> {
  const filter = externalOnly ? `&filter=${encodeURIComponent(PRE_ROLL_FILTER)}` : "";
  const items: PBRecord[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await pbJson(`/api/collections/hook_assets/records?page=${page}&perPage=50&sort=-id&fields=analysis.boundarySelection,analysis.tokenBudget,${HOOK_LIST_FIELDS}&expand=material,episode,episode.drama${filter}`, { signal }) as { items?: PBRecord[]; totalPages?: number };
    items.push(...(payload.items ?? []));
    totalPages = Math.max(1, number(payload.totalPages, 1));
    page += 1;
  } while (page <= totalPages);
  return normalizeHookTitles(items.map(fromRecord).filter(validLocalizedHook));
}

/** Inspiration screen only contains hooks extracted from imported ad materials. */
export async function listInspirationHookAssets(signal?: AbortSignal): Promise<HookAsset[]> {
  const filter = encodeURIComponent('source_class!="episode_highlight"');
  const items: PBRecord[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await pbJson(`/api/collections/hook_assets/records?page=${page}&perPage=50&sort=-id&fields=analysis.boundarySelection,analysis.tokenBudget,${HOOK_LIST_FIELDS}&expand=material&filter=${filter}`, { signal }) as { items?: PBRecord[]; totalPages?: number };
    items.push(...(payload.items ?? []));
    totalPages = Math.max(1, number(payload.totalPages, 1));
    page += 1;
  } while (page <= totalPages);
  return normalizeHookTitles(items.map(fromRecord).filter(validLocalizedHook));
}

/** Analysis picker query. Rights are displayed but intentionally do not block analysis. */
export async function listSelectableExternalHooks(signal?: AbortSignal): Promise<HookAsset[]> {
  const base = `/api/collections/hook_assets/records?perPage=500&sort=-id&skipTotal=0&fields=${HOOK_PICKER_FIELDS}&expand=material&filter=${encodeURIComponent(PRE_ROLL_FILTER)}`;
  const first = await pbJson(`${base}&page=1`, { signal }) as { items?: PBRecord[]; totalPages?: number };
  const totalPages = Math.max(1, number(first.totalPages, 1));
  const rest = totalPages > 1
    ? await Promise.all(Array.from({ length: totalPages - 1 }, (_, index) =>
        pbJson(`${base}&page=${index + 2}`, { signal }) as Promise<{ items?: PBRecord[] }>))
    : [];
  const records = [...(first.items ?? []), ...rest.flatMap((page) => page.items ?? [])];
  return normalizeHookTitles(records.map(fromRecord).filter(validLocalizedHook).filter(isSelectableExternalHook));
}

/** Fetch only the ranked IDs returned by the server-side story matcher. */
export async function listSelectableExternalHooksByIds(ids: string[], signal?: AbortSignal): Promise<HookAsset[]> {
  const unique = [...new Set(ids.filter((id) => /^[a-z0-9]{15}$/.test(id)))].slice(0, 50);
  if (!unique.length) return [];
  const idFilter = unique.map((id) => `id="${id}"`).join(" || ");
  const filter = `(${PRE_ROLL_FILTER}) && (${idFilter})`;
  const payload = await pbJson(`/api/collections/hook_assets/records?page=1&perPage=50&sort=-id&fields=${HOOK_PICKER_FIELDS}&expand=material&filter=${encodeURIComponent(filter)}`, { signal }) as { items?: PBRecord[] };
  const order = new Map(unique.map((id, index) => [id, index]));
  return normalizeHookTitles((payload.items ?? []).map(fromRecord).filter(validLocalizedHook).filter(isSelectableExternalHook))
    .sort((left, right) => (order.get(left.id) ?? 999) - (order.get(right.id) ?? 999));
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
