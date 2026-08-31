import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("task center dispatches each workflow retry with audit and optimistic lock fields", async () => {
  const store = await read("app/lib/pocketbase-analysis-store.ts");
  const ui = await read("app/features/operations/OperationsWorkspace.tsx");
  for (const route of ["hook-matching", "supplemental-highlights", "entry-precision"])
    assert.match(store, new RegExp(route));
  assert.match(store, /expected_status:task\.backendStatus/);
  assert.match(store, /expected_updated:task\.updatedAt/);
  assert.match(store, /idempotency_key:input\.idempotencyKey/);
  assert.match(ui, /window\.prompt\("\u8bf7\u586b\u5199\u91cd\u8bd5\u539f\u56e0/);
  assert.match(ui, /window\.confirm\(`\u8be5\u4efb\u52a1\u4e3a/);
  assert.match(ui, /selectedTask\.status !== "\u5931\u8d25"/);
});

test("factory UI retries failed renders as a new lineage version", async () => {
  const store = await read("app/lib/factory-production-store.ts");
  const workspace = await read("app/features/factory/FactoryWorkspace.tsx");
  const delivery = await read("app/features/factory/components/ExternalHookDelivery.tsx");
  assert.match(store, /factory\/renders\/\$\{encodeURIComponent\(render\.id\)\}\/retry/);
  assert.match(store, /expected_updated:render\.updated/);
  assert.match(workspace, /retryFactoryRender\(factoryRender, decision\)/);
  assert.match(workspace, /retryFactoryRender\(failed, decision\)/);
  assert.match(workspace, /\u65e7\u5ba1\u6279\u4e0d\u4f1a\u590d\u7528/);
  assert.match(delivery, /retryOfTaskId/);
  assert.match(delivery, /\u65b0\u7248\u672c\u91cd\u8bd5\u81ea\u5931\u8d25\u4efb\u52a1/);
});

test("hook match retry no longer invokes legacy force_retry from its retry button", async () => {
  const workspace = await read("app/features/factory/FactoryWorkspace.tsx");
  const start = workspace.indexOf("onRetryMatch={() =>");
  const end = workspace.indexOf("onChangeEpisodeScope", start);
  const block = workspace.slice(start, end);
  assert.match(block, /retryHookMatchJob/);
  assert.match(block, /expectedUpdated: matchJob\.updated/);
  assert.doesNotMatch(block, /setMatchRetryToken|setMatchRequestToken/);
});
