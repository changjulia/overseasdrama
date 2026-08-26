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
  const [page, inspiration, inspirationStore, library, factory, creations, operations] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/inspiration/InspirationWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/inspiration-material-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/features/library/DramaLibraryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/creations/MyCreations.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/operations/OperationsWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /usePersistentState/);
  assert.match(inspiration, /钩子原型/);
  assert.match(inspiration, /人工复核/);
  assert.match(inspiration, /进入人工复核/);
  assert.match(inspiration, /所有工作区成员均可操作/);
  assert.match(inspiration, /reviewHook/);
  assert.match(inspiration, /支撑结论/);
  assert.match(inspiration, /关键剧情证据/);
  assert.match(inspiration, /钩子原型库/);
  assert.match(inspiration, /同剧高光前置/);
  assert.match(inspiration, /跨剧／外部外搭/);
  assert.match(inspiration, /外搭来源待确认/);
  assert.match(inspiration, /钩子归属/);
  assert.match(inspiration, /ontologyValues\("relation"\)/);
  assert.match(inspiration, /ontologyValues\("emotion"\)/);
  assert.match(inspiration, /canonicalHookType/);
  assert.match(inspiration, /isKnownOntologyTag/);
  assert.match(inspiration, /compactTags=.*\["theme","relation","emotion"\]/);
  assert.doesNotMatch(inspiration, /\.slice\(0,7\)\.map/);
  assert.doesNotMatch(inspiration, /检测到镜头切换，回看片段确认/);
  assert.doesNotMatch(inspiration, /该素材已完成旧版分析，但尚未生成 material-v2/);
  assert.match(inspiration, /正在读取 material-v2 分析详情/);
  assert.match(inspiration, /detailRequests/);
  assert.match(inspiration, /existing\?\.analysisV2&&!item\.analysisV2/);
  assert.match(inspiration, /仅看分析完成/);
  assert.match(inspiration, /analysisFilter==="全部分析状态"\|\|item\.analysisStatus==="succeeded"/);
  assert.match(inspiration, /分段剧情时间线/);
  assert.match(inspiration, /全片剧情理解/);
  assert.doesNotMatch(inspiration, /详细剧情概况/);
  assert.doesNotMatch(inspiration, /客观事实台账/);
  assert.doesNotMatch(inspiration, /每条推断必须引用已验证事实/);
  assert.doesNotMatch(inspiration, /支撑上述结论的关键证据/);
  assert.match(inspiration, /拉片预览/);
  assert.match(inspiration, /video\.currentTime=target/);
  assert.match(inspiration, /钩子分析与拉片/);
  assert.match(inspiration, /剧情设定/);
  assert.match(inspiration, /声音与对白/);
  assert.match(inspiration, /画面与运镜/);
  assert.match(inspiration, /从钩子起点播放/);
  assert.match(inspiration, /time>=end/);
  assert.match(inspiration, /同一原片的限定钩子区间/);
  assert.match(inspiration, /aria-label="钩子区间进度"/);
  assert.match(inspiration, /Math\.max\(start,Math\.min\(end,seconds\)\)/);
  assert.match(inspiration, /duration\(relativeTime\).*duration\(hookLength\)/);
  assert.match(inspirationStore, /splitNarrativeClauses/);
  assert.match(inspirationStore, /opening=new Set\(\["“","‘","\\\""\]\)/);
  assert.doesNotMatch(inspiration, /buildStoryboardPhases/);
  assert.match(inspiration, /全片因果情节点/);
  assert.match(inspiration, /暂无可信结论/);
  assert.ok(inspirationStore.indexOf("pbFetch(`/api/collections/ad_materials/records/") < inspirationStore.indexOf("fetch(`/material-analysis/"), "material detail must prefer the live material-v2 record before static cache fallback");
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
  const [factory, analysis] = await Promise.all([
    readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/features/factory/components/ExternalHookAnalysis.tsx", import.meta.url), "utf8"),
  ]);

  for (const step of ["选择剧集", "生成并选择正片故事线", "按故事走向匹配外搭钩子", "设计过渡", "成片时间线", "质检", "预览和审核", "保存和导出"]) {
    assert.ok(factory.includes(step), `missing production workflow step: ${step}`);
  }
  assert.match(factory, /productionGate/);
  assert.match(factory, /真实数据驱动/);
  assert.match(factory, /高匹配分与结构证据不一致/);
  assert.match(analysis, /slice\(0, 3\)/);
  assert.match(analysis, /为什么从这里起播/);
  assert.match(analysis, /只处理必要连接，不生成多套相似过渡文案/);
  assert.match(analysis, /人物误认、事实冲突、承诺冲突与切点断裂/);
  assert.match(analysis, /确认连接并生成草稿/);
});

test("keeps the real-video preview switchable by connected episode", async () => {
  const factory = await readFile(new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url), "utf8");

  assert.match(factory, /<span>切换剧集<\/span>[\s\S]*?<select[\s\S]*?value=\{previewEpisode \?\? ""\}/);
  assert.match(factory, /onChange=\{\(event\) =>[\s\S]*?setPreviewEpisode\(Number\(event\.target\.value\)\)/);
  assert.match(factory, /connectedEpisodes\.map\(\(episode\) => \([\s\S]*?<button[\s\S]*?onClick=\{\(\) => setPreviewEpisode\(episode\)\}/);
  assert.match(factory, /<video[\s\S]*?key=\{previewMedia\.url\}[\s\S]*?src=\{previewMedia\.url\}[\s\S]*?controls[\s\S]*?preload="metadata"/);
});
