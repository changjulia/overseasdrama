import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Lumina workbench shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Lumina Story Intelligence/);
  assert.match(html, /灵感大屏/);
  assert.match(html, /剧库/);
  assert.match(html, /内容工厂/);
  assert.match(html, /我的创作/);
  assert.match(html, /数据源管理/);
  assert.match(html, /任务中心/);
});

test("keeps the documented frontend modules integrated", async () => {
  const [page, inspiration, library, factory, creations, operations] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/inspiration/InspirationWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/library/DramaLibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/creations/MyCreations.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/operations/OperationsWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /usePersistentState/);
  assert.match(inspiration, /钩子原型/);
  assert.match(inspiration, /人工复核/);
  assert.match(library, /三级解析/);
  assert.match(library, /可投放区间/);
  assert.match(factory, /episode-narration/);
  assert.match(factory, /external-hook/);
  assert.match(creations, /我的收藏/);
  assert.match(creations, /我的草稿/);
  assert.match(operations, /字段与接口可用性/);
  assert.match(operations, /角色权限矩阵/);
});

test("keeps the external-hook production workflow explicit and evidence-backed", async () => {
  const factory = await readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8");

  for (const step of ["选择剧集", "筛选外搭钩子", "匹配完整故事线与投放区间", "设计钩子到正片的过渡", "编排成片时间线", "执行生成前质检", "生成并预览成片", "保存与导出成片"]) {
    assert.ok(factory.includes(step), `missing production workflow step: ${step}`);
  }
  assert.match(factory, /productionGate/);
  assert.match(factory, /真实数据驱动/);
  assert.match(factory, /高匹配分与结构证据不一致/);
});

test("keeps the real-video preview switchable by connected episode", async () => {
  const factory = await readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8");

  assert.match(factory, /<span>切换剧集<\/span><select value=\{previewEpisode \?\? ""\}/);
  assert.match(factory, /onChange=\{\(event\) => setPreviewEpisode\(Number\(event\.target\.value\)\)\}/);
  assert.match(factory, /connectedEpisodes\.map\(\(episode\) => <button[^>]+onClick=\{\(\) => setPreviewEpisode\(episode\)\}/);
  assert.match(factory, /<video key=\{previewMedia\.url\} src=\{previewMedia\.url\} controls preload="metadata" \/>/);
});
