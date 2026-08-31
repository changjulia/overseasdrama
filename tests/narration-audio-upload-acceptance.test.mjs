import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const ui = readFileSync("app/features/factory/components/ExternalHookAnalysis.tsx", "utf8");
const workspace = readFileSync("app/features/factory/FactoryWorkspace.tsx", "utf8");
const uploadClient = readFileSync("app/features/factory/narration-audio-upload.ts", "utf8");
const gateway = readFileSync("app/api/pocketbase/[...path]/route.ts", "utf8");
const hook = readFileSync("pb_hooks/hook_factory.pb.js", "utf8");
const helper = readFileSync("pb_hooks/narration_audio_helpers.js", "utf8");
const migration = readFileSync("pb_migrations/1787570900_create_narration_audio_assets.js", "utf8");
const hostedE2e = readFileSync("tests/hosted-pocketbase-runtime-e2e.test.mjs", "utf8");
const workerLineageE2e = readFileSync("tests/e2e_external_hook/test_external_hook_queue_e2e.py", "utf8");
const keyWindowsSource = readFileSync("app/features/factory/key-original-audio-windows.ts", "utf8");
const keyWindowsJavaScript = ts.transpileModule(keyWindowsSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const keyWindows = await import(`data:text/javascript;base64,${Buffer.from(keyWindowsJavaScript).toString("base64")}`);

test("B-mode UI uploads an actual File and has no arbitrary URL input", () => {
  assert.match(ui, /<input type="file"[^>]+accept="audio\//);
  assert.match(ui, /void uploadNarration\(file\)/);
  assert.doesNotMatch(ui, /<input type="url"/);
  assert.match(uploadClient, /body\.set\("audio", file, file\.name\)/);
  assert.match(uploadClient, /XMLHttpRequest/);
});

test("upload persists a project-scoped PB file and returns server-issued identity plus signed media URL", () => {
  assert.match(migration, /name: "narration_audio_assets"/);
  assert.match(migration, /name: "project"[\s\S]*cascadeDelete: true/);
  assert.match(migration, /name: "audio"[\s\S]*required: true/);
  assert.match(hook, /record\.set\("project", project\.id\)/);
  for (const field of ["assetId", "collection", "recordId", "projectId", "fileName", "byteSize", "detectedMime", "sha256", "durationSeconds", "createdAt"]) assert.match(hook, new RegExp(`${field}:`));
  assert.match(hostedE2e, /assert\.equal\(uploaded\.projectId, project\.id\)/);
  assert.match(hostedE2e, /media\.status, 200/);
  assert.match(hostedE2e, /createHash\("sha256"\)[\s\S]*media\.arrayBuffer/);
});

test("preview worker downloads uploaded bytes and a real B-mode preview records that same asset hash", () => {
  assert.match(workerLineageE2e, /narration-audio/);
  assert.match(workerLineageE2e, /process_available[\s\S]*transition_preview_job/);
  assert.match(workerLineageE2e, /preview_validation\[key\][\s\S]*expected_lineage/);
});

test("fresh hosted E2E rejects unauthenticated multipart upload", () => {
  assert.match(hostedE2e, /unauthorizedUpload\.status, 401/);
  assert.match(gateway, /if \(!user\).*status: 401/);
});

test("fresh hosted E2E rejects cross-site multipart upload through the CSRF gate", () => {
  assert.match(hostedE2e, /origin: "https:\/\/evil\.example"/);
  assert.match(hostedE2e, /crossSiteUpload\.status, 403/);
  assert.match(gateway, /origin === request\.nextUrl\.origin/);
});

test("fresh hosted E2E rejects format disguise using ffprobe rather than extension or Content-Type alone", () => {
  assert.match(hostedE2e, /rejectedUpload\("disguised\.mp3"[\s\S]*status, 400/);
  assert.match(helper, /uploaded file does not contain a decodable audio stream/);
  assert.match(helper, /ffprobe container signature does not match the file extension/);
});

test("client, PocketBase schema, and upload helper enforce the 100 MiB stored-file limit", () => {
  assert.match(uploadClient, /MAX_AUDIO_BYTES = 100 \* 1024 \* 1024/);
  assert.match(migration, /maxSize: 104857600/);
  assert.match(helper, /Number\(file\.size\) > 104857600/);
});

test("fresh multipart E2E rejects an explicit oversize body and fails closed without Content-Length without leaving records or files", () => {
  assert.match(gateway, /MAX_NARRATION_UPLOAD_REQUEST_BYTES = 101 \* 1024 \* 1024/);
  assert.match(gateway, /Narration audio upload requires Content-Length/);
  assert.match(gateway, /status: 411/);
  assert.match(gateway, /status: 413/);
  assert.match(hostedE2e, /const oversizedBytes = 100 \* 1024 \* 1024 \+ 1/);
  assert.match(hostedE2e, /explicitOversize\.status >= 400/);
  assert.match(hostedE2e, /streamingRequest\.headers\.get\("content-length"\), null/);
  assert.match(hostedE2e, /streamingOversize\.status, 411/);
  assert.match(hostedE2e, /oversize requests must not create narration asset records/);
  assert.match(hostedE2e, /oversize requests must not leave orphan or partial narration files/);
});

test("server contract rejects empty, undecodable, and no-audio uploads", () => {
  assert.match(helper, /!Number\(file\.size\)/);
  assert.match(helper, /audio could not be decoded by server ffprobe/);
  assert.match(helper, /!audioStreams\.length/);
  assert.match(helper, /uploaded file does not contain a decodable audio stream/);
});

test("project save and preview verify project ownership and immutable lineage fields", () => {
  assert.match(hook, /audioAsset\.getString\("project"\) !== narrationProject\.id/);
  assert.match(hook, /audioAsset\.getString\("project"\) !== project\.id/);
  for (const field of ["sha256", "byte_size", "mime_type", "duration_seconds"]) assert.match(hook, new RegExp(`audioAsset\\.get(?:String|Int|Float)\\("${field}"\\)`));
  assert.match(hook, /continuous narration preview requires matching project audio lineage/);
});

test("project save rejects arbitrary URL, forged/missing record, and stale asset metadata", () => {
  assert.match(hook, /findRecordById\("narration_audio_assets", String\(voice\.assetId/);
  assert.match(hook, /existing project and a valid uploaded audio asset/);
  assert.match(hook, /const expectedUrl = `\$\{audioHelpers\.workerBaseUrl\(\)\}/);
  assert.match(hook, /String\(voice\.audioUrl\) !== expectedUrl/);
  assert.match(hook, /narration audio lineage metadata does not match the uploaded asset/);
});

test("replacing or deleting an already persisted asset invalidates server-side preview hash and approval without relying only on unsaved UI state", () => {
  assert.match(hook, /audioHelpers\.invalidateTransition\(e\.app, project, replaceAssetId\)/);
  assert.match(hook, /audioHelpers\.invalidateTransition\(e\.app, project, asset\.id\)/);
  assert.match(hook, /DELETE.*projects\/\{id\}\/narration-audio\/\{assetId\}/);
  assert.match(hostedE2e, /deleted\.previewInvalidated, true/);
  assert.match(hostedE2e, /invalidatedProject\.transition\.reviewStatus, "draft"/);
  assert.match(hostedE2e, /invalidatedProject\.transition\.reviewPreviewHash, ""/);
});

test("all currently exposed transition editor changes invalidate approval and preview and increment transition version", () => {
  for (const field of ["script", "language", "speakingRate", "durationSeconds", "originalAudioDuckDb"]) assert.match(ui + workspace, new RegExp(field));
  assert.match(workspace, /onUpdateTransitionProduction=\{\(patch\) => \{[\s\S]*reviewStatus: "draft"[\s\S]*reviewPreviewHash: undefined[\s\S]*version: current\.version \+ 1/);
  assert.match(hook, /transition approval must bind the latest preview hash and production version/);
});

test("key-original-audio editor bounds, sorts, and de-overlaps at most 20 windows through the approval invalidation path", () => {
  assert.match(ui, /aria-label="关键原声窗口编辑器"/);
  assert.match(ui, /updateKeyOriginalAudioWindows/);
  assert.match(ui, /onUpdateTransitionProduction/);
  assert.match(ui, /durationSeconds,keyOriginalAudioWindows:transitionProduction\.type==="continuous_narration"\?normalizeKeyOriginalAudioWindows/);
  const noisy = Array.from({ length: 25 }, (_, index) => ({ start: 99 - index * 5, end: 102 - index * 5 }));
  const normalized = keyWindows.normalizeKeyOriginalAudioWindows(noisy, 90);
  assert.ok(normalized.length <= 20);
  assert.ok(normalized.every((window) => window.start >= 0 && window.end <= 90 && window.end > window.start));
  assert.ok(normalized.every((window, index) => index === 0 || window.start >= normalized[index - 1].end));
  assert.deepEqual(keyWindows.normalizeKeyOriginalAudioWindows([{ start: 12, end: 18 }, { start: 5, end: 14 }], 60), [{ start: 5, end: 14 }, { start: 14, end: 18 }]);
  assert.equal(keyWindows.appendKeyOriginalAudioWindow(Array.from({ length: 20 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })), 60).length, 20);
});

test("upload failure preserves current selection while successful selection updates once through the common invalidation path", () => {
  const uploadFunction = ui.slice(ui.indexOf("const uploadNarration = async"), ui.indexOf("const removeNarration = async"));
  assert.match(uploadFunction, /const asset = await onUploadNarrationAudio/);
  assert.equal((uploadFunction.match(/onUpdateTransitionProduction\?\.\(/g) || []).length, 1);
  assert.match(uploadFunction, /catch \(error\)[\s\S]*setNarrationUploadError/);
  assert.doesNotMatch(uploadFunction.slice(uploadFunction.indexOf("catch (error)")), /onUpdateTransitionProduction/);
});

test("approved B-mode preview and final render persist identical audio and transition lineage", () => {
  assert.match(workerLineageE2e, /"audioAssetId": audio_asset\["assetId"\]/);
  assert.match(workerLineageE2e, /"audioSha256": narration_sha256/);
  assert.match(workerLineageE2e, /"transitionVersion": 1/);
  assert.match(workerLineageE2e, /rendered\["validation"\]\[key\][\s\S]*preview_validation\[key\]/);
  assert.match(hook, /preview audio lineage to match the current narration asset/);
});

test("fresh hosted API rejects final render and export for unapproved A, B, and direct-cut transitions and after B asset edits", () => {
  for (const label of ["A pending", "B rejected", "direct_cut draft"]) assert.match(hostedE2e, new RegExp(label));
  assert.match(hostedE2e, /finalRender\.status, 400/);
  assert.match(hostedE2e, /transition review must be approved/i);
  assert.match(hostedE2e, /exportAttempt\.status, 400/);
  assert.match(hostedE2e, /renderAfterReplacement\.status, 400/);
  assert.match(hostedE2e, /exportAfterReplacement\.status, 400/);
  assert.match(hostedE2e, /renderAfterDelete\.status, 400/);
  assert.match(hostedE2e, /exportAfterDelete\.status, 400/);
});

test("generic narration file access is denied and only the HMAC-signed worker media route is readable", () => {
  const fileCollections = gateway.slice(gateway.indexOf("const FILE_COLLECTIONS"), gateway.indexOf("const UI_LUMINA_ROUTES"));
  assert.doesNotMatch(fileCollections, /narration_audio_assets|pbc_lumnaraud01/);
  assert.match(gateway, /FILE_COLLECTIONS\.has\(fileMatch\[1\]\)/);
  assert.match(hook, /narration-audio\/\{id\}\/media/);
  assert.match(hook, /constantTimeTextEqual\(supplied, expected\)/);
  assert.match(hostedE2e, /genericNarrationFile\.status, 403/);
  assert.match(hostedE2e, /media\.status, 200/);
});
