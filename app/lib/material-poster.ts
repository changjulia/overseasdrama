/** These source hosts support OSS video snapshots without downloading the video. */
const SNAPSHOT_HOSTS = new Set([
  "overseas-material.dataeye.com",
  "zqingalioss.wozhangwan.com",
]);

export function isExternalMaterialMedia(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password && SNAPSHOT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function externalMaterialPoster(source: string): string | undefined {
  try {
    const url = new URL(source);
    if (url.protocol !== "https:" || url.username || url.password || !SNAPSHOT_HOSTS.has(url.hostname)) return undefined;
    // Signed links must not have their query rewritten.
    if ([...url.searchParams.keys()].some(key => /signature|credential|security-token|expires/i.test(key))) return undefined;
    url.hash = "";
    url.searchParams.set("x-oss-process", "video/snapshot,t_1000,f_jpg,w_480,m_fast");
    return url.toString();
  } catch {
    return undefined;
  }
}
