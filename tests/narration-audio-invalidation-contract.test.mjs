import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync("pb_hooks/hook_factory.pb.js", "utf8");
const helper = readFileSync("pb_hooks/narration_audio_helpers.js", "utf8");
const gateway = readFileSync("app/api/pocketbase/[...path]/route.ts", "utf8");
const client = readFileSync("app/features/factory/narration-audio-upload.ts", "utf8");
const workspace = readFileSync("app/features/factory/FactoryWorkspace.tsx", "utf8");
const editor = readFileSync("app/features/factory/components/ExternalHookAnalysis.tsx", "utf8");

test("replace and delete are project-bound authenticated mutations routed through the CSRF gateway", () => {
  assert.match(hook, /DELETE.*projects\/\{id\}\/narration-audio\/\{assetId\}/);
  assert.match(hook, /helpers\.authorizeUi\(e\)/);
  assert.match(hook, /asset\.getString\("project"\) !== project\.id/);
  assert.match(gateway, /\["DELETE", \/\^\\\/api\\\/lumina\\\/factory/);
  assert.match(client, /method: "DELETE", headers: pocketBaseUiHeaders\(\)/);
});

test("asset mutation is rejected while any preview or final render is queued or rendering", () => {
  assert.match(helper, /function assertAssetMutable/);
  assert.match(helper, /status = 'queued' \|\| status = 'rendering'/);
  assert.match(helper, /preview or final render is queued or rendering/);
  assert.match(hook, /audioHelpers\.assertAssetMutable\(e\.app, project\)/);
});

test("server invalidates transition approval, exact preview lineage, project review, and version", () => {
  for (const field of ["reviewStatus", "reviewerNote", "reviewPreviewUrl", "reviewPreviewHash", "reviewPreviewVersion", "reviewPreviewTransitionVersion"])
    assert.match(helper, new RegExp(`transition\\.${field}`));
  assert.match(helper, /transition\.version = Math\.max[\s\S]*\+ 1/);
  assert.match(helper, /project\.set\("review", \{\}\)/);
  assert.match(helper, /project\.set\("status", "draft"\)/);
  assert.match(hook, /audioHelpers\.invalidateTransition\(e\.app, project, replaceAssetId\)/);
  assert.match(hook, /audioHelpers\.invalidateTransition\(e\.app, project, asset\.id\)/);
});

test("soft deletion blocks signed media immediately while preserving explicit recovery evidence", () => {
  assert.match(hook, /asset\.set\("status", "rejected"\)/);
  assert.match(hook, /record\.getString\("status"\) !== "ready"/);
  assert.match(hook, /recoverable: true/);
  assert.match(hook, /administrator may restore the asset after review/);
  assert.doesNotMatch(hook.slice(hook.indexOf('routerAdd("DELETE", "/api/lumina/factory/projects/{id}/narration-audio/{assetId}"')), /e\.app\.delete\(asset\)/);
});

test("UI replacement identifies the prior persisted asset and removal waits for server invalidation", () => {
  assert.match(client, /replaceAssetId \? `\?replaceAssetId=\$\{encodeURIComponent\(replaceAssetId\)\}`/);
  assert.match(editor, /transitionProduction\.voice\.assetId\)/);
  assert.match(editor, /await onDeleteNarrationAudio\(assetId\)[\s\S]*onUpdateTransitionProduction/);
  assert.match(workspace, /deleteNarrationAudio\(factoryProjectId, assetId\)/);
  assert.match(workspace, /旧审核片与批准已失效/);
});
