"use client";

export type StoredEpisodeMedia = {
  key: string;
  dramaId: string;
  episode: number;
  name: string;
  mimeType: string;
  size: number;
  updatedAt: string;
  blob: Blob;
};

const DATABASE_NAME = "lumina-media-v1";
const STORE_NAME = "episodes";

function mediaKey(dramaId: string | number, episode: number) {
  return `${String(dramaId)}:${episode}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("dramaId", "dramaId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地片源存储"));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("片源存储失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("片源存储已中止"));
  });
}

export async function storeEpisodeMedia(
  dramaId: string | number,
  episode: number,
  file: File,
): Promise<Omit<StoredEpisodeMedia, "blob">> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const record: StoredEpisodeMedia = {
    key: mediaKey(dramaId, episode),
    dramaId: String(dramaId),
    episode,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    updatedAt: new Date().toISOString(),
    blob: file,
  };
  transaction.objectStore(STORE_NAME).put(record);
  await waitForTransaction(transaction);
  database.close();
  return {
    key: record.key,
    dramaId: record.dramaId,
    episode: record.episode,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    updatedAt: record.updatedAt,
  };
}

export async function listEpisodeMedia(dramaId: string | number): Promise<StoredEpisodeMedia[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const hasDramaIndex = store.indexNames.contains("dramaId");
  const request = hasDramaIndex ? store.index("dramaId").getAll(String(dramaId)) : store.getAll();
  const records = await new Promise<StoredEpisodeMedia[]>((resolve, reject) => {
    request.onsuccess = () => resolve((request.result as StoredEpisodeMedia[])
      .filter((item) => hasDramaIndex || item.dramaId === String(dramaId))
      .sort((a, b) => a.episode - b.episode));
    request.onerror = () => reject(request.error ?? new Error("无法读取本地片源"));
  });
  await waitForTransaction(transaction);
  database.close();
  return records;
}

export function createEpisodePlaybackUrls(records: StoredEpisodeMedia[]) {
  const urls: Record<number, { episode: number; name: string; url: string; mimeType: string }> = {};
  for (const record of records) {
    urls[record.episode] = {
      episode: record.episode,
      name: record.name,
      mimeType: record.mimeType,
      url: URL.createObjectURL(record.blob),
    };
  }
  return urls;
}

export function revokeEpisodePlaybackUrls(records: Record<number, { url?: string }>) {
  Object.values(records).forEach((record) => {
    if (record.url?.startsWith("blob:")) URL.revokeObjectURL(record.url);
  });
}
