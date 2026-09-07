/// <reference path="../pb_data/types.d.ts" />

// PocketBase fires this hook after checking the record, filename and protected
// file permissions. Only the byte transfer moves to COS; authorization stays here.
onFileDownloadRequest((e) => {
  const endpoint = $os.getenv("LUMINA_MEDIA_SIGNING_URL");
  if (!endpoint || !/\.(mp4|mov|m4v|webm)$/i.test(e.servedName)) return e.next();
  try {
    const result = $http.send({
      url: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Media-Token": $os.getenv("LUMINA_WORKER_TOKEN") },
      body: JSON.stringify({ key: e.servedPath }),
      timeout: 5,
    });
    if (result.statusCode === 200 && typeof result.json.url === "string" && result.json.url.startsWith("https://")) {
      // File hooks expose the embedded HTTP event through requestEvent.
      // Unlike router handlers, e.response is not available in Goja here.
      e.requestEvent.response.header().set("Cache-Control", "private, no-store");
      e.requestEvent.response.header().set("Referrer-Policy", "no-referrer");
      return e.redirect(302, result.json.url);
    }
  } catch (_) {
    console.warn("COS video redirect unavailable; using standard file delivery");
  }
  return e.next();
}, "drama_episodes", "ad_materials");
