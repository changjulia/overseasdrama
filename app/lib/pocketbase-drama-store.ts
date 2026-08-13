"use client";

import type { FactoryEpisodeMedia } from "../features/factory/types";

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
};

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
    for (const item of input.episodes) {
      const episodeForm = new FormData();
      episodeForm.set("drama", drama.id);
      episodeForm.set("episode_number", String(item.episode));
      episodeForm.set("original_name", item.file.name);
      episodeForm.set("mime_type", item.file.type || "application/octet-stream");
      episodeForm.set("byte_size", String(item.file.size));
      episodeForm.set("analysis_status", "queued");
      episodeForm.set("video", item.file, item.file.name);
      await pbFetch("/api/collections/drama_episodes/records", { method: "POST", body: episodeForm });
    }
  } catch (error) {
    if (!existing) await pbFetch(`/api/collections/dramas/records/${drama.id}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
  return getPocketBaseDrama(drama.id);
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
    analysis: drama.analysis,
    coarseStatus: coarse.status,
    coarseProgress: coarse.progress,
    detailStatus: detail.status,
    detailProgress: detail.progress,
    precisionStatus: precision.status,
    precisionProgress: precision.progress,
    analysisError: [coarse.status, detail.status, precision.status].includes("failed") ? String(drama.analysis_error || "") || undefined : undefined,
    detailResult: latestDetail?.result ?? drama.analysis,
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
  form.set("analysis", JSON.stringify(analysis));
  await pbFetch(`/api/collections/dramas/records/${recordId}`, { method: "PATCH", body: form });
  return getPocketBaseDrama(recordId);
}

export async function checkPocketBase() {
  const response = await pbFetch("/api/health");
  return response.ok;
}
