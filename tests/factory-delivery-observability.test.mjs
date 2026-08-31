import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const delivery = readFileSync("app/features/factory/components/ExternalHookDelivery.tsx", "utf8");
const workspace = readFileSync("app/features/factory/FactoryWorkspace.tsx", "utf8");
const css = readFileSync("app/features/factory/components/ExternalHookDelivery.module.css", "utf8");
const store = readFileSync("app/lib/factory-production-store.ts", "utf8");
const hook = readFileSync("pb_hooks/hook_factory.pb.js", "utf8");

test("final render failure exposes task id, structured failure codes, technical evidence, and actionable categories", () => {
  assert.match(delivery, /renderTaskId\?: string/);
  assert.match(delivery, /failureCodes\?: string\[\]/);
  assert.match(delivery, /technical\?: Record<string, unknown>/);
  assert.match(delivery, /任务 ID：\{renderTaskId\}/);
  for (const evidence of ["404", "CORRUPT", "NO_AUDIO", "AUDIO_SPEC", "QC", "QUALITY", "VALIDATION"])
    assert.match(delivery, new RegExp(evidence));
  assert.match(delivery, /技术探测证据/);
  assert.match(css, /\.failureEvidence/);
});

test("queue and worker timing can only produce a suspected-stall warning, never a client-side failure", () => {
  for (const field of ["queuedAt", "startedAt", "leaseUntil", "lastHeartbeatAt"])
    assert.match(delivery + workspace, new RegExp(field));
  assert.match(delivery, /任务疑似卡住，但尚未被服务端判定失败/);
  assert.match(delivery, /queueLooksStuck/);
  assert.match(delivery, /renderLooksStuck/);
  const stallBlock = delivery.slice(delivery.indexOf("const queueLooksStuck"), delivery.indexOf("const failureCodes"));
  assert.doesNotMatch(stallBlock, /setRenderStatus\("failed"\)/);
  assert.match(css, /\.stallWarning/);
  for (const field of ["queued_at", "last_heartbeat_at", "lease_until", "next_attempt_at"])
    assert.match(hook, new RegExp(field));
  for (const field of ["queuedAt", "lastHeartbeatAt", "leaseUntil", "nextAttemptAt"])
    assert.match(store, new RegExp(field));
});

test("launch UI has no locally incremented demo render and disconnected renderer cannot create a task", () => {
  assert.doesNotMatch(delivery, /isDemoRun|current \+ 8|演示任务已完成|演示生成流程/);
  assert.match(delivery, /if \(!renderConnected\)[\s\S]*不能创建真实任务/);
  assert.match(delivery, /disabled=\{disabled \|\| !renderConnected/);
  assert.match(delivery, /不会显示本地递增的演示进度或伪造完成状态/);
});

test("content-rule check copy is explicitly separated from real media QC", () => {
  assert.doesNotMatch(workspace, /`质检完成：/);
  assert.match(workspace, /内容规则检查已记录/);
  assert.match(workspace, /不代表真实成片媒体 QC 已通过/);
  assert.match(delivery, /只有真实渲染成功、媒体 QC 通过并返回播放地址后/);
});

test("both episode splice and external hook delivery receive the same server render evidence", () => {
  assert.equal((workspace.match(/renderTaskId=\{factoryRender\?\.id\}/g) || []).length, 2);
  assert.equal((workspace.match(/renderValidation=\{deliveryRenderEvidence\(factoryRender\)\.validation\}/g) || []).length, 2);
  assert.equal((workspace.match(/renderTelemetry=\{deliveryRenderEvidence\(factoryRender\)\.telemetry\}/g) || []).length, 2);
});
