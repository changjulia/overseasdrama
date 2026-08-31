"use client";

import { POCKETBASE_URL, pocketBaseUiHeaders } from "../../lib/pocketbase-url";

export type NarrationAudioAsset = {
  assetId: string;
  audioUrl: string;
  fileName: string;
  byteSize: number;
  mimeType: string;
  sha256: string;
  durationSeconds: number;
  uploadedAt: string;
};

const ALLOWED_AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
]);
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

function audioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    const cleanup = () => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      if (!Number.isFinite(duration) || duration <= 0) reject(new Error("无法读取音轨时长，请确认文件可解码"));
      else resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("音轨无法解码，请上传 MP3、M4A、WAV、AAC、OGG 或 WebM 音频"));
    };
    audio.src = objectUrl;
  });
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inspectNarrationAudio(file: File) {
  if (!file.size) throw new Error("音轨文件为空，请重新选择");
  if (file.size > MAX_AUDIO_BYTES) throw new Error("音轨超过 100 MB 上限");
  if (file.type && !ALLOWED_AUDIO_TYPES.has(file.type.toLowerCase())) throw new Error(`不支持的音频类型：${file.type}`);
  const [durationSeconds, contentHash] = await Promise.all([audioDuration(file), sha256(file)]);
  if (durationSeconds < 60 || durationSeconds > 100) throw new Error(`B 模式音轨需为 60–100 秒，当前约 ${durationSeconds.toFixed(1)} 秒`);
  return { durationSeconds, contentHash };
}

export function uploadNarrationAudio(
  projectId: string,
  file: File,
  inspected: { durationSeconds: number; contentHash: string },
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  replaceAssetId?: string,
) {
  return new Promise<NarrationAudioAsset>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const replacement = replaceAssetId ? `?replaceAssetId=${encodeURIComponent(replaceAssetId)}` : "";
    request.open("POST", `${POCKETBASE_URL}/api/lumina/factory/projects/${encodeURIComponent(projectId)}/narration-audio${replacement}`);
    Object.entries(pocketBaseUiHeaders()).forEach(([key, value]) => request.setRequestHeader(key, String(value)));
    request.upload.onprogress = (event) => onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0);
    request.onerror = () => reject(new Error("音轨上传连接中断，请重试"));
    request.onabort = () => reject(new DOMException("音轨上传已取消", "AbortError"));
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    request.onload = () => {
      signal?.removeEventListener("abort", abort);
      let payload: unknown;
      try { payload = JSON.parse(request.responseText); } catch { payload = null; }
      if (request.status < 200 || request.status >= 300) {
        const message = payload && typeof payload === "object" && "message" in payload ? String((payload as { message: unknown }).message) : `音轨上传失败（HTTP ${request.status}）`;
        reject(new Error(message));
        return;
      }
      const value = payload as Partial<NarrationAudioAsset> | null;
      if (!value?.assetId || !value.audioUrl || !value.fileName || !value.mimeType || !value.sha256 || !value.uploadedAt || !Number.isFinite(value.byteSize) || !Number.isFinite(value.durationSeconds)) {
        reject(new Error("音轨上传接口未返回完整的可追溯元数据"));
        return;
      }
      if (value.sha256.toLowerCase() !== inspected.contentHash.toLowerCase() || value.byteSize !== file.size || Math.abs(value.durationSeconds - inspected.durationSeconds) > 0.5) {
        reject(new Error("音轨上传后的哈希、字节数或时长与本地文件不一致"));
        return;
      }
      onProgress(100);
      resolve(value as NarrationAudioAsset);
    };
    if (signal?.aborted) {
      reject(new DOMException("音轨上传已取消", "AbortError"));
      return;
    }
    const body = new FormData();
    body.set("audio", file, file.name);
    body.set("sha256", inspected.contentHash);
    body.set("durationSeconds", String(inspected.durationSeconds));
    request.send(body);
  });
}

export async function deleteNarrationAudio(projectId: string, assetId: string): Promise<{ recoverable: boolean }> {
  const response = await fetch(
    `${POCKETBASE_URL}/api/lumina/factory/projects/${encodeURIComponent(projectId)}/narration-audio/${encodeURIComponent(assetId)}`,
    { method: "DELETE", headers: pocketBaseUiHeaders() },
  );
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? String((payload as { message: unknown }).message)
      : `音轨移除失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return { recoverable: Boolean(payload && typeof payload === "object" && (payload as { recoverable?: unknown }).recoverable) };
}
