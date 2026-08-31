import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const pocketbase = resolve("tools/pocketbase/pocketbase");

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForHealth(base, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`PocketBase exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("fresh PocketBase did not become healthy");
}

test("fresh locked PocketBase remains usable through hosted identity gateway and worker API", { timeout: 120_000 }, async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "lumina-hosted-gateway-e2e-"));
  const dataDir = join(sandbox, "pb_data");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const adminEmail = "gateway-e2e@example.test";
  const adminPassword = "Gateway-E2E-Password-123!";
  const gatewayToken = "gateway-e2e-ui-token";
  const workerToken = "gateway-e2e-worker-token";
  const common = [
    "--dir", dataDir,
    "--hooksDir", resolve("pb_hooks"),
    "--migrationsDir", resolve("pb_migrations"),
    "--hooksWatch=false",
  ];
  const migrated = spawnSync(pocketbase, [...common, "migrate", "up"], { cwd: root, encoding: "utf8" });
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  const superuser = spawnSync(pocketbase, [...common, "superuser", "upsert", adminEmail, adminPassword], { cwd: root, encoding: "utf8" });
  assert.equal(superuser.status, 0, superuser.stderr || superuser.stdout);

  const logPath = join(sandbox, "pocketbase.log");
  const logFd = openSync(logPath, "w");
  const child = spawn(pocketbase, [...common, "serve", `--http=127.0.0.1:${port}`], {
    cwd: root,
    env: { ...process.env, LUMINA_UI_GATEWAY_TOKEN: gatewayToken, LUMINA_WORKER_TOKEN: workerToken, LUMINA_POCKETBASE_WORKER_BASE_URL: base, LUMINA_FFPROBE_PATH: resolve("node_modules/@ffprobe-installer/darwin-arm64/ffprobe"), LUMINA_SHA256_PATH: "/usr/bin/shasum", LUMINA_UI_MODE: "" },
    stdio: ["ignore", logFd, logFd],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    closeSync(logFd);
    rmSync(sandbox, { recursive: true, force: true });
  });
  await waitForHealth(base, child);

  const anonymousCollection = await fetch(`${base}/api/collections/dramas/records`);
  assert.equal(anonymousCollection.status, 403, "fresh migration must lock direct anonymous collection reads");

  const workerClaim = await fetch(`${base}/api/lumina/factory-render/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ worker_id: "hosted-e2e-worker" }),
  });
  assert.equal(workerClaim.status, 204, "collection lockdown must not block token-protected worker hooks");

  process.env.POCKETBASE_URL = base;
  process.env.LUMINA_UI_GATEWAY_TOKEN = gatewayToken;
  process.env.LUMINA_POCKETBASE_SUPERUSER_IDENTITY = adminEmail;
  process.env.LUMINA_POCKETBASE_SUPERUSER_PASSWORD = adminPassword;
  const workerUrl = new URL(`../dist/server/index.js?hosted-runtime-e2e=${process.pid}-${Date.now()}`, import.meta.url);
  const { default: web } = await import(workerUrl.href);
  const identity = {
    "oai-authenticated-user-id": "user_gateway_e2e",
    "oai-authenticated-user-email": "gateway-e2e@example.test",
  };
  const withTransportContentLength = async (request) => {
    const body = Buffer.from(await request.arrayBuffer());
    const headers = new Headers(request.headers);
    headers.set("content-length", String(body.length));
    return new Request(request.url, { method: request.method, headers, body });
  };

  const anonymousGateway = await web.fetch(new Request("https://lumina.example/api/pocketbase/api/collections/dramas/records"));
  assert.equal(anonymousGateway.status, 401);

  const collectionViaGateway = await web.fetch(new Request("https://lumina.example/api/pocketbase/api/collections/dramas/records", { headers: identity }));
  const collectionError = collectionViaGateway.status === 200 ? "" : await collectionViaGateway.clone().text();
  assert.equal(collectionViaGateway.status, 200, collectionError);
  const collectionPayload = await collectionViaGateway.json();
  assert.deepEqual(collectionPayload.items, []);

  const adminAuth = await fetch(`${base}/api/collections/_superusers/auth-with-password`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: adminEmail, password: adminPassword }),
  });
  assert.equal(adminAuth.status, 200, await adminAuth.clone().text());
  const adminToken = (await adminAuth.json()).token;
  const adminCreate = async (collection, body) => {
    const response = await fetch(`${base}/api/collections/${collection}/records`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json();
  };
  const drama = await adminCreate("dramas", {
    external_id: "narration-upload-e2e", title: "Narration upload E2E", cn: "旁白上传验收", genre: "test", language: "zh-CN",
    total_episodes: 1, free_episodes: 1, parse_state: "pending",
  });
  const project = await adminCreate("factory_projects", {
    title: "Narration audio project", mode: "external-hook", drama: drama.id, selected_episodes: [], topics: [],
    transition: { type: "continuous_narration", start: 0, end: 60, script: "test", language: "zh-CN", voice: { mode: "manual_audio", speakingRate: 1 }, reviewStatus: "draft", version: 1 }, timeline: [],
    quality_report: {}, review: {}, version: 1, status: "draft", ratio: "9:16", language: "zh-CN",
  });
  const guardedTransitions = [
    { label: "A pending", status: "ready", transition: { type: "transition_copy", gapDiagnosis: ["time"], start: 10, end: 10, copy: "十年后", language: "zh-CN", evidence: [{ source: "runtime" }], renderConfig: { effect: "fade" }, reviewStatus: "pending", version: 2 } },
    { label: "B rejected", status: "rejected", transition: { type: "continuous_narration", gapDiagnosis: ["causal"], start: 0, end: 60, script: "runtime rejected narration", language: "zh-CN", voice: { mode: "manual_audio" }, renderConfig: { durationSeconds: 60 }, reviewStatus: "rejected", reviewerNote: "runtime rejection", version: 3 } },
    { label: "direct_cut draft", status: "ready", transition: { type: "direct_cut", gapDiagnosis: ["causal"], start: 0, end: 0, language: "zh-CN", evidence: [{ source: "runtime" }], renderConfig: { effect: "hard_cut" }, reviewStatus: "draft", version: 4 } },
  ];
  for (const scenario of guardedTransitions) {
    const guardedProject = await adminCreate("factory_projects", {
      title: `Transition gate ${scenario.label}`, mode: "episode-splice", drama: drama.id, selected_episodes: [], topics: [], transition: scenario.transition, timeline: [],
      quality_report: {}, review: {}, version: 1, status: scenario.status, ratio: "9:16", language: "zh-CN",
    });
    const succeeded = await adminCreate("factory_renders", {
      project: guardedProject.id, version: 1, status: "succeeded", progress: 100, current_stage: "completed", attempt: 1, max_attempts: 3,
      render_config: { purpose: "final" }, validation: { passed: true }, preview_url: "https://media.example/preview.mp4", output_url: "https://media.example/output.mp4", output_sha256: "b".repeat(64),
    });
    const staleApproval = await fetch(`${base}/api/collections/factory_projects/records/${guardedProject.id}`, {
      method: "PATCH", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ review: { decision: "approved", renderId: succeeded.id, renderVersion: 1, outputSha256: "b".repeat(64) } }),
    });
    assert.equal(staleApproval.status, 200, await staleApproval.clone().text());
    const finalRender = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${guardedProject.id}/renders`, {
      method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}",
    }));
    assert.equal(finalRender.status, 400, `${scenario.label} must not enter final rendering`);
    assert.match(await finalRender.text(), /transition review must be approved/i);
    const exportAttempt = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${guardedProject.id}/export`, {
      method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ render_id: succeeded.id }),
    }));
    assert.equal(exportAttempt.status, 400, `${scenario.label} must not export with a stale production review`);
    assert.match(await exportAttempt.text(), /export requires an approved human review/i);
  }
  const pcmBytes = 8_000 * 60;
  const wav = Buffer.alloc(44 + pcmBytes, 128);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8_000, 24); wav.writeUInt32LE(8_000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(pcmBytes, 40);
  const audioHash = createHash("sha256").update(wav).digest("hex");
  const unauthorizedForm = new FormData();
  unauthorizedForm.set("audio", new Blob([wav], { type: "audio/wav" }), "narration.wav");
  unauthorizedForm.set("sha256", audioHash); unauthorizedForm.set("durationSeconds", "60");
  const unauthorizedUpload = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
    method: "POST", headers: { origin: "https://lumina.example", "sec-fetch-site": "same-origin" }, body: unauthorizedForm,
  }));
  assert.equal(unauthorizedUpload.status, 401);
  const crossSiteForm = new FormData();
  crossSiteForm.set("audio", new Blob([wav], { type: "audio/wav" }), "narration.wav");
  crossSiteForm.set("sha256", audioHash); crossSiteForm.set("durationSeconds", "60");
  const crossSiteUpload = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
    method: "POST", headers: { ...identity, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: crossSiteForm,
  }));
  assert.equal(crossSiteUpload.status, 403);
  const uploadForm = new FormData();
  uploadForm.set("audio", new Blob([wav], { type: "audio/wav" }), "narration.wav");
  uploadForm.set("sha256", audioHash);
  uploadForm.set("durationSeconds", "60");
  const upload = await web.fetch(await withTransportContentLength(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" }, body: uploadForm,
  })));
  assert.equal(upload.status, 201, `${await upload.clone().text()}\nPocketBase log:\n${readFileSync(logPath, "utf8")}`);
  const uploaded = await upload.json();
  assert.equal(uploaded.projectId, project.id);
  assert.equal(uploaded.sha256, audioHash, "server must hash uploaded bytes rather than trust form metadata");
  assert.equal(uploaded.byteSize, wav.length);
  assert.equal(uploaded.mimeType, "audio/wav");
  assert.equal(uploaded.durationSeconds, 60);
  assert.match(uploaded.audioUrl, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/lumina/factory/narration-audio/${uploaded.assetId}/media\\?token=`));
  const media = await fetch(uploaded.audioUrl);
  assert.equal(media.status, 200, await media.clone().text());
  assert.equal(createHash("sha256").update(Buffer.from(await media.arrayBuffer())).digest("hex"), audioHash);
  const genericNarrationFile = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/files/pbc_lumnaraud01/${uploaded.assetId}/anything.wav`, { headers: identity }));
  assert.equal(genericNarrationFile.status, 403, "generic PocketBase file route must not bypass the signed narration media route");
  const rejectedUpload = async (fileName, sha256, durationSeconds) => {
    const form = new FormData();
    form.set("audio", new Blob([wav], { type: fileName.endsWith(".mp3") ? "audio/mpeg" : "audio/wav" }), fileName);
    form.set("sha256", sha256);
    form.set("durationSeconds", String(durationSeconds));
    return await web.fetch(await withTransportContentLength(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
      method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" }, body: form,
    })));
  };
  assert.equal((await rejectedUpload("narration.wav", "0".repeat(64), 60)).status, 400, "forged client digest must be rejected");
  assert.equal((await rejectedUpload("disguised.mp3", audioHash, 60)).status, 400, "container/extension mismatch must be rejected");
  assert.equal((await rejectedUpload("narration.wav", audioHash, 70)).status, 400, "client duration must not override ffprobe duration");

  const approvedTransition = {
    type: "continuous_narration", gapDiagnosis: ["causal"], start: 0, end: 60,
    script: "runtime lineage test", language: "zh-CN", evidence: ["runtime test"],
    voice: { mode: "manual_audio", assetId: uploaded.assetId, audioUrl: uploaded.audioUrl, sha256: uploaded.sha256, byteSize: uploaded.byteSize, mimeType: uploaded.mimeType, durationSeconds: uploaded.durationSeconds, speakingRate: 1 },
    renderConfig: { durationSeconds: 60 }, reviewStatus: "approved", reviewerNote: "runtime approved",
    reviewPreviewUrl: "https://preview.example/old.mp4", reviewPreviewHash: "a".repeat(64), reviewPreviewVersion: 9,
    reviewPreviewTransitionVersion: 7, version: 7,
  };
  const updateProject = async (body) => {
    const response = await fetch(`${base}/api/collections/factory_projects/records/${project.id}`, {
      method: "PATCH", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json();
  };
  const oldApprovedRender = await adminCreate("factory_renders", {
    project: project.id, version: 90, status: "succeeded", progress: 100, current_stage: "completed", attempt: 1, max_attempts: 3,
    render_config: { purpose: "final" }, validation: { passed: true }, preview_url: "https://media.example/old-preview.mp4", output_url: "https://media.example/old-output.mp4", output_sha256: "c".repeat(64),
  });
  await updateProject({ transition: approvedTransition, review: { decision: "approved", renderId: oldApprovedRender.id, renderVersion: 90, outputSha256: "c".repeat(64) }, status: "approved" });
  const replacementForm = new FormData();
  replacementForm.set("audio", new Blob([wav], { type: "audio/wav" }), "replacement.wav");
  replacementForm.set("sha256", audioHash); replacementForm.set("durationSeconds", "60");
  const replacementResponse = await web.fetch(await withTransportContentLength(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio?replaceAssetId=${uploaded.assetId}`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" }, body: replacementForm,
  })));
  assert.equal(replacementResponse.status, 201, await replacementResponse.clone().text());
  const replacement = await replacementResponse.json();
  assert.notEqual(replacement.assetId, uploaded.assetId);
  assert.equal((await fetch(uploaded.audioUrl)).status, 401, "replacement must deactivate old signed media immediately");
  const replacedProjectResponse = await fetch(`${base}/api/collections/factory_projects/records/${project.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(replacedProjectResponse.status, 200, await replacedProjectResponse.clone().text());
  const replacedProject = await replacedProjectResponse.json();
  assert.equal(replacedProject.transition.reviewStatus, "draft");
  assert.equal(replacedProject.transition.reviewPreviewHash, "");
  assert.equal(replacedProject.transition.version, 8);
  const renderAfterReplacement = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/renders`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(renderAfterReplacement.status, 400, "audio replacement must invalidate final-render approval");
  assert.match(await renderAfterReplacement.text(), /transition review must be approved/i);
  const exportAfterReplacement = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/export`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ render_id: oldApprovedRender.id }),
  }));
  assert.equal(exportAfterReplacement.status, 400, "audio replacement must invalidate the old exact-render export approval");
  const replacementTransition = {
    ...approvedTransition,
    voice: { ...approvedTransition.voice, assetId: replacement.assetId, audioUrl: replacement.audioUrl },
    reviewPreviewTransitionVersion: 8,
    version: 8,
  };
  const replacementApprovedRender = await adminCreate("factory_renders", {
    project: project.id, version: 91, status: "succeeded", progress: 100, current_stage: "completed", attempt: 1, max_attempts: 3,
    render_config: { purpose: "final" }, validation: { passed: true }, preview_url: "https://media.example/replacement-preview.mp4", output_url: "https://media.example/replacement-output.mp4", output_sha256: "d".repeat(64),
  });
  await updateProject({ transition: replacementTransition, review: { decision: "approved", renderId: replacementApprovedRender.id, renderVersion: 91, outputSha256: "d".repeat(64) }, status: "approved" });
  const secondProject = await adminCreate("factory_projects", {
    title: "Other narration project", mode: "external-hook", drama: drama.id, selected_episodes: [], topics: [], transition: {}, timeline: [],
    quality_report: {}, review: {}, version: 1, status: "draft", ratio: "9:16", language: "zh-CN",
  });
  const wrongProjectDelete = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${secondProject.id}/narration-audio/${replacement.assetId}`, {
    method: "DELETE", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" },
  }));
  assert.equal(wrongProjectDelete.status, 400, "a project must not deactivate another project's narration asset");
  const crossSiteDelete = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio/${replacement.assetId}`, {
    method: "DELETE", headers: { ...identity, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  }));
  assert.equal(crossSiteDelete.status, 403, "narration deletion must be CSRF-gated");
  const activeRender = await adminCreate("factory_renders", { project: project.id, version: 1, status: "queued", progress: 0, current_stage: "queued", attempt: 0, max_attempts: 3, render_config: { purpose: "transition_review" } });
  const busyDelete = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio/${replacement.assetId}`, {
    method: "DELETE", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" },
  }));
  assert.equal(busyDelete.status, 400, "narration deletion must not race a queued render");
  const stopRender = await fetch(`${base}/api/collections/factory_renders/records/${activeRender.id}`, {
    method: "PATCH", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ status: "failed", error: "runtime test" }),
  });
  assert.equal(stopRender.status, 200, await stopRender.clone().text());
  const deleteAsset = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio/${replacement.assetId}`, {
    method: "DELETE", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin" },
  }));
  assert.equal(deleteAsset.status, 200, await deleteAsset.clone().text());
  const deleted = await deleteAsset.json();
  assert.equal(deleted.recoverable, true);
  assert.equal(deleted.previewInvalidated, true);
  assert.equal(deleted.approvalInvalidated, true);
  const invalidatedProjectResponse = await fetch(`${base}/api/collections/factory_projects/records/${project.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(invalidatedProjectResponse.status, 200, await invalidatedProjectResponse.clone().text());
  const invalidatedProject = await invalidatedProjectResponse.json();
  assert.equal(invalidatedProject.status, "draft");
  assert.equal(invalidatedProject.transition.reviewStatus, "draft");
  assert.equal(invalidatedProject.transition.reviewPreviewHash, "");
  assert.equal(invalidatedProject.transition.version, 9);
  assert.equal(invalidatedProject.transition.voice.assetId, undefined);
  assert.equal((await fetch(replacement.audioUrl)).status, 401, "soft-deleted audio must become inaccessible immediately");
  const renderAfterDelete = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/renders`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}",
  }));
  assert.equal(renderAfterDelete.status, 400, "audio deletion must invalidate final-render approval");
  const exportAfterDelete = await web.fetch(new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/export`, {
    method: "POST", headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ render_id: replacementApprovedRender.id }),
  }));
  assert.equal(exportAfterDelete.status, 400, "audio deletion must invalidate the old exact-render export approval");

  const narrationRecords = async () => {
    const response = await fetch(`${base}/api/collections/narration_audio_assets/records?perPage=200`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).items;
  };
  const storageFiles = (directory) => {
    if (!existsSync(directory)) return [];
    const output = [];
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) output.push(...storageFiles(path));
      else output.push(path.slice(dataDir.length));
    }
    return output.sort();
  };
  const narrationStorage = join(dataDir, "storage", "pbc_lumnaraud01");
  const recordsBeforeOversize = await narrationRecords();
  const filesBeforeOversize = storageFiles(narrationStorage);
  const boundary = `lumina-oversize-${process.pid}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n${"0".repeat(64)}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="durationSeconds"\r\n\r\n60\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="oversize.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const oversizedBytes = 100 * 1024 * 1024 + 1;
  const explicitBody = Buffer.concat([prefix, Buffer.alloc(oversizedBytes), suffix]);
  const explicitRequest = new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
    method: "POST",
    headers: {
      ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin",
      "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(explicitBody.length),
    },
    body: explicitBody,
  });
  assert.equal(explicitRequest.headers.get("content-length"), String(explicitBody.length));
  process.stderr.write("[hosted-e2e] sending explicit Content-Length oversize multipart\n");
  const explicitOversize = await web.fetch(explicitRequest);
  assert.ok(explicitOversize.status >= 400, `explicit Content-Length oversize unexpectedly returned ${explicitOversize.status}`);
  process.stderr.write(`[hosted-e2e] explicit oversize rejected with ${explicitOversize.status}\n`);

  const streamingRequest = new Request(`https://lumina.example/api/pocketbase/api/lumina/factory/projects/${project.id}/narration-audio`, {
    method: "POST",
    headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": `multipart/form-data; boundary=${boundary}` },
    // The gateway rejects every body without a transport Content-Length before
    // reading it, so a bounded sentinel proves the same fail-closed branch
    // without making the in-process runtime drain a discarded 100+ MiB stream.
    body: Buffer.concat([prefix, Buffer.alloc(1024), suffix]),
  });
  assert.equal(streamingRequest.headers.get("content-length"), null);
  const streamingOversize = await web.fetch(streamingRequest);
  assert.equal(streamingOversize.status, 411, "chunked narration upload must fail closed before proxying an unbounded stream");

  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.deepEqual((await narrationRecords()).map((item) => item.id), recordsBeforeOversize.map((item) => item.id), "oversize requests must not create narration asset records");
  assert.deepEqual(storageFiles(narrationStorage), filesBeforeOversize, "oversize requests must not leave orphan or partial narration files");

  const previewViaGateway = await web.fetch(new Request("https://lumina.example/api/pocketbase/api/lumina/factory/projects/missing-project/transition-preview", { headers: identity }));
  assert.equal(previewViaGateway.status, 404, "authenticated preview request must reach the custom PocketBase route");

  const reviewViaGateway = await web.fetch(new Request("https://lumina.example/api/pocketbase/api/lumina/factory/projects/missing-project/transition-review", {
    method: "POST",
    headers: { ...identity, origin: "https://lumina.example", "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved", note: "contract only" }),
  }));
  assert.equal(reviewViaGateway.status, 404, "authenticated review request must pass CSRF/auth and reach PocketBase");
});
