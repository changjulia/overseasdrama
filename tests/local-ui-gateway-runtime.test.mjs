import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const pocketbase = resolve("tools/pocketbase/pocketbase");
const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

test("fresh locked PocketBase supports bounded local UI CRUD and file reads without a superuser", { timeout: 60_000 }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "lumina-local-ui-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const common = ["--dir", join(sandbox, "pb_data"), "--hooksDir", resolve("pb_hooks"), "--migrationsDir", resolve("pb_migrations"), "--hooksWatch=false"];
  assert.equal(spawnSync(pocketbase, [...common, "migrate", "up"], { cwd: root }).status, 0);
  const logFd = openSync(join(sandbox, "pb.log"), "w");
  const child = spawn(pocketbase, [...common, "serve", `--http=127.0.0.1:${port}`], {
    cwd: root,
    env: { ...process.env, LUMINA_UI_MODE: "local-loopback", LUMINA_UI_GATEWAY_TOKEN: "" },
    stdio: ["ignore", logFd, logFd],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    closeSync(logFd);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  const locked = await fetch(`${base}/api/collections/dramas/records`);
  assert.equal(locked.status, 403, "locked collection API must remain superuser-only");
  const forgedWithoutModeHeader = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records`);
  assert.equal(forgedWithoutModeHeader.status, 403);

  const headers = { "x-lumina-ui": "local" };
  const createdResponse = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ external_id: "local-gateway-runtime", title: "Gateway Runtime", cn: "本地网关验证", genre: "test", language: "zh-CN", total_episodes: 1, free_episodes: 1, parse_state: "pending" }),
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();
  assert.equal(created.title, "Gateway Runtime");
  const listedResponse = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records?perPage=10`, { headers });
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].id, created.id);

  const detailResponse = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records/${created.id}`, { headers });
  assert.equal(detailResponse.status, 200);
  assert.equal((await detailResponse.json()).title, "Gateway Runtime");

  const updatedResponse = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records/${created.id}`, {
    method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "Gateway Runtime Updated" }),
  });
  assert.equal(updatedResponse.status, 200, await updatedResponse.clone().text());
  assert.equal((await updatedResponse.json()).title, "Gateway Runtime Updated");

  const mediaPath = join(sandbox, "episode.mp4");
  const ffmpeg = resolve("node_modules/ffmpeg-static/ffmpeg");
  const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.2", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", mediaPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const media = readFileSync(mediaPath);
  // curl mirrors a browser/XHR multipart transport with a concrete file
  // handle; Node's in-memory FormData does not expose one to PocketBase hooks.
  const uploadedEpisode = spawnSync("curl", ["-sS", "-w", "\n%{http_code}", "-H", "x-lumina-ui: local", "-F", `drama=${created.id}`, "-F", "episode_number=1", "-F", "original_name=episode.mp4", "-F", "mime_type=video/mp4", "-F", `byte_size=${media.length}`, "-F", "duration_seconds=0.2", "-F", "analysis_status=pending", "-F", `video=@${mediaPath};type=video/mp4`, `${base}/api/lumina/local-ui/collections/drama_episodes/records`], { encoding: "utf8" });
  assert.equal(uploadedEpisode.status, 0, uploadedEpisode.stderr);
  const splitAt = uploadedEpisode.stdout.lastIndexOf("\n");
  const episodeStatus = Number(uploadedEpisode.stdout.slice(splitAt + 1));
  const episodeText = uploadedEpisode.stdout.slice(0, splitAt);
  assert.equal(episodeStatus, 201, episodeText);
  const episode = JSON.parse(episodeText);
  assert.ok(episode.video);

  const fileResponse = await fetch(`${base}/api/lumina/local-ui/files/${episode.collectionId}/${episode.id}/${encodeURIComponent(episode.video)}`, { headers });
  assert.equal(fileResponse.status, 200, await fileResponse.clone().text());
  assert.match(fileResponse.headers.get("content-type") || "", /^video\/mp4/);
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), media);

  // Re-importing an already-known episode uses multipart PATCH in the real
  // drama store. Exercise replacement, not just first-time POST, so a second
  // EP1 import cannot silently retain stale bytes while metadata advances.
  const replacementPath = join(sandbox, "episode-replacement.mp4");
  const replacementGenerated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=64x64:d=0.3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-shortest", "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", replacementPath]);
  assert.equal(replacementGenerated.status, 0, replacementGenerated.stderr?.toString());
  const replacement = readFileSync(replacementPath);
  assert.notDeepEqual(replacement, media);
  const replacedEpisode = spawnSync("curl", ["-sS", "-w", "\n%{http_code}", "-X", "PATCH", "-H", "x-lumina-ui: local", "-F", `drama=${created.id}`, "-F", "episode_number=1", "-F", "original_name=episode-replacement.mp4", "-F", "mime_type=video/mp4", "-F", `byte_size=${replacement.length}`, "-F", "duration_seconds=0.3", "-F", "analysis_status=pending", "-F", `video=@${replacementPath};type=video/mp4`, `${base}/api/lumina/local-ui/collections/drama_episodes/records/${episode.id}`], { encoding: "utf8" });
  assert.equal(replacedEpisode.status, 0, replacedEpisode.stderr);
  const replacementSplitAt = replacedEpisode.stdout.lastIndexOf("\n");
  const replacementStatus = Number(replacedEpisode.stdout.slice(replacementSplitAt + 1));
  const replacementText = replacedEpisode.stdout.slice(0, replacementSplitAt);
  assert.equal(replacementStatus, 200, replacementText);
  const replaced = JSON.parse(replacementText);
  assert.equal(replaced.id, episode.id);
  assert.equal(Number(replaced.byte_size), replacement.length);
  assert.ok(replaced.video);
  const replacementResponse = await fetch(`${base}/api/lumina/local-ui/files/${replaced.collectionId}/${replaced.id}/${encodeURIComponent(replaced.video)}`, { headers });
  assert.equal(replacementResponse.status, 200, await replacementResponse.clone().text());
  assert.deepEqual(Buffer.from(await replacementResponse.arrayBuffer()), replacement);

  const traversal = await fetch(`${base}/api/lumina/local-ui/files/${episode.collectionId}/${episode.id}/not-owned.mp4`, { headers });
  assert.equal(traversal.status, 404);
  const forbiddenCollection = await fetch(`${base}/api/lumina/local-ui/collections/_superusers/records`, { headers });
  assert.equal(forbiddenCollection.status, 403);

  const deletedResponse = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records/${created.id}`, { method: "DELETE", headers });
  assert.equal(deletedResponse.status, 204);
  const missing = await fetch(`${base}/api/lumina/local-ui/collections/dramas/records/${created.id}`, { headers });
  assert.equal(missing.status, 404);
});
