import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validLocalizedHook } from "../app/lib/hook-asset-store.ts";

const factorySource = await readFile(
  new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url),
  "utf8",
);
const librarySource = await readFile(
  new URL("../app/features/library/DramaLibraryWorkspace.tsx", import.meta.url),
  "utf8",
);

test("assembled hook preview hands off to the body only once", () => {
  assert.match(factorySource, /const handingOffToHighlightRef = useRef\(false\)/);
  assert.match(
    factorySource,
    /if \(handingOffToHighlightRef\.current\) return;\s*handingOffToHighlightRef\.current = true;\s*video\.pause\(\)/,
  );
  assert.doesNotMatch(
    factorySource,
    /video\.pause\(\);\s*video\.currentTime = safeHookEnd;\s*setCurrent\(hookDuration\)/,
  );
});

test("reload keeps a selected drama in the story-to-hook workflow", () => {
  assert.match(
    factorySource,
    /saved === "hook_to_story"[\s\S]*?: dramaSource\s*\? "story_to_hook"\s*: hookSourceInput\s*\? "hook_to_story"\s*: "story_to_hook"/,
  );
  assert.doesNotMatch(
    factorySource,
    /dramaSource && !hookSourceInput\s*\? "story_to_hook"/,
  );
});

test("keeps story-to-hook selection multi-select", () => {
  assert.match(
    factorySource,
    /current\.includes\(id\)[\s\S]*?current\.filter\([\s\S]*?: \[\.\.\.current, id\]/,
  );
  assert.match(factorySource, /已选 \{selectedStorylineIds\.length\}/);
  assert.match(factorySource, /const highlightSelectionKey/);
  assert.match(factorySource, /highlightCandidates: record\.highlightCandidates/);
  assert.doesNotMatch(factorySource, /highlightCandidates:\s*\[\]/);
  assert.match(
    factorySource,
    /String\(item\.id\).*item\.episode.*item\.start\.toFixed\(3\).*item\.end\.toFixed\(3\)/s,
  );
  assert.doesNotMatch(
    factorySource,
    /externalHighlights\.map\(\(item\) => String\(item\.id\)\)/,
  );
  assert.match(
    factorySource,
    /selectedExternalHighlightAssetIds\.has\([\s\S]*?String\(segment\.highlightAssetId\)[\s\S]*?\)/,
    "storyline filtering must use the stable highlight asset id because generated segment boundaries may expand",
  );
  assert.match(
    factorySource,
    /highlight\.episode === segment\.episode[\s\S]*?Math\.abs\(highlight\.start - segment\.start\) <= 0\.05/,
    "synthetic sequential segment ids must fall back to episode and source-highlight start",
  );
});

test("keeps candidate retrieval and verification internal to the established factory workflow", () => {
  assert.doesNotMatch(factorySource, /import\s+\{\s*ScriptHookCandidateFlow\s*\}/);
  assert.doesNotMatch(factorySource, /<ScriptHookCandidateFlow\b/);
  assert.match(
    factorySource,
    /mode === "external-hook"\s*\?\s*\(\s*externalWorkflow/,
  );
});

test("resolves semantic highlight ranges back to persisted hook assets", () => {
  assert.match(
    librarySource,
    /highlightAssetIds=record\.highlightCandidates\.filter\(asset=>asset\.episode===episode&&asset\.end>start&&asset\.start<end\)/,
  );
  assert.match(
    factorySource,
    /item\.highlightAssetIds\?\.length[\s\S]*?item\.highlightAssetIds[\s\S]*?item\.highlightAssetId \|\| String\(item\.id\)/,
  );
});

test("matches each selected storyline with an isolated semantic context", () => {
  assert.match(
    factorySource,
    /for \(const plan of selectedStorylinePlans\)[\s\S]*?listStoryDrivenHookRecommendations\([\s\S]*?\[plan\]/,
  );
  assert.match(
    factorySource,
    /startHookStoryMatch\([\s\S]*?strategy: "story_to_hook"[\s\S]*?selectedStorylines: \[plan\]/,
  );
  assert.doesNotMatch(
    factorySource,
    /startHookStoryMatch\([\s\S]{0,1200}?selectedStorylines:\s*selectedStorylinePlans/,
    "the matching request must not merge all selected storylines into one story need",
  );
});

test("bulk hook matching preserves explicit pairs and only fills missing stories", () => {
  assert.match(factorySource, /explicit editorial choice and must never be silently overwritten/);
  assert.match(factorySource, /if \(existingPairs\[plan\.id\]\?\.hookAssetId\) continue/);
  assert.match(factorySource, /const resolvedPairs = \{ \.\.\.existingPairs, \.\.\.pairs \}/);
});

test("material-library hooks may be localized later than the upload opening", () => {
  const base = {
    sourceClass: "external_material",
    boundaryStatus: "verified",
    reviewStatus: "approved",
  };
  assert.equal(validLocalizedHook({ ...base, start: 15.1, end: 23.9 }), true);
  assert.equal(validLocalizedHook({ ...base, start: 15.1, end: 76 }), false);
});

test("hook picker can search by source title as well as ontology labels", () => {
  assert.match(factorySource, /\[option\.title, option\.description\]/);
  assert.match(factorySource, /textMatch \|\|[\s\S]*dimensionLabels\.some/);
  assert.match(factorySource, /placeholder="搜索标题或所选标签维度"/);
});

test("persists per-storyline hook pairs and match caches", () => {
  assert.match(factorySource, /storylineHookPairs\[plan\.id\]/);
  assert.match(factorySource, /storylineMatchCache\[plan\.id\]/);
  assert.match(factorySource, /activeStorylineId/);
});

test("keeps polling a live match even if the request effect is remounted", () => {
  const restoredPoll = factorySource.slice(
    factorySource.indexOf("Switching between storylines restores"),
    factorySource.indexOf("entryPollAttemptsRef.current", factorySource.indexOf("Switching between storylines restores")),
  );
  assert.doesNotMatch(restoredPoll, /matchRequestToken !== 0/);
  assert.match(restoredPoll, /getHookMatchJob\(matchJob\.id/);
});

test("creates and exports an independent render for every ready storyline", () => {
  assert.match(
    factorySource,
    /for \(const plan of plansForProduction\)[\s\S]*?saveFactoryProject\([\s\S]*?storylineId: plan\.id[\s\S]*?startFactoryRender\(project\.id\)/,
  );
  assert.match(
    factorySource,
    /Object\.entries\(factoryRendersByStoryline\)[\s\S]*?for \(const \[planId, render\] of completed\)[\s\S]*?exportFactoryRender/,
  );
});

test("builds each selected storyline from its promised episode scope through the payoff episode", () => {
  const builderStart = factorySource.indexOf("const buildSequentialBodyTimeline");
  const builderEnd = factorySource.indexOf("const safeDownloadName", builderStart);
  const builderSource = factorySource.slice(builderStart, builderEnd);
  const batchStart = factorySource.indexOf("const requestStorylineBatchRenders");
  const batchEnd = factorySource.indexOf("const persistEpisodeSpliceProject", batchStart);
  const batchSource = factorySource.slice(batchStart, batchEnd);

  assert.ok(builderStart >= 0 && builderEnd > builderStart, "sequential timeline builder must exist");
  assert.match(builderSource, /plannedEpisodeScope\?: number\[\]/);
  assert.match(
    builderSource,
    /const requiredEpisodes = hasValidPlannedScope\s*\? scopedEpisodes\s*: \[anchor\.episode, anchor\.episode \+ 1, anchor\.episode \+ 2\]/,
    "a valid planned scope must replace the generic duration-derived episode range",
  );
  assert.match(
    builderSource,
    /for \(const episode of requiredEpisodes\) \{\s*if \(!appendEpisode\(episode\)\) return \[\];\s*\}/,
    "every episode in the selected scope, including its payoff endpoint, must be appended",
  );
  assert.doesNotMatch(
    builderSource,
    /scopedEpisodes\.slice\(0,\s*3\)/,
    "the payoff episode must not be silently truncated",
  );
  assert.match(
    batchSource,
    /buildSequentialBodyTimeline\(\{[\s\S]*?plannedEpisodeScope: plan\.episodeScope/,
    "each StorylinePlan must pass its own episodeScope to production assembly",
  );
  assert.match(batchSource, /selectedEpisodes: sequentialBody\.map\(\(item\) => Number\(item\.episode\)\)/);
});

test("keeps the entire requested production batch when any combination is unresolved", () => {
  const start = factorySource.indexOf("const startSelectedPairProduction");
  const end = factorySource.indexOf("const matchAllSelectedStorylines", start);
  const productionSource = factorySource.slice(start, end);

  assert.ok(start >= 0 && end > start, "selected-pair production handler must exist");
  assert.match(
    productionSource,
    /if \(unresolvedPlanIds\.length\) \{[\s\S]*?throw new Error\([\s\S]*?系统已保留全部选择/,
    "partial matching must stop and preserve the requested batch",
  );
  assert.match(productionSource, /const producibleIds = \[\.\.\.pairIds\]/);
  assert.doesNotMatch(
    productionSource,
    /const producibleIds = pairIds\.filter/,
    "the requested batch must never be silently reduced to its currently producible subset",
  );
  assert.match(productionSource, /catch \(error\) \{\s*setSelectedStorylineIds\(originalSelection\)/);
});

test("routes both transition confirmation controls through the real render creation handler", () => {
  const handlerStart = factorySource.indexOf("const confirmTransitionAndGenerate");
  const handlerEnd = factorySource.indexOf("const persistEpisodeSpliceProject", handlerStart);
  const handlerSource = factorySource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "shared transition confirmation handler must exist");
  assert.match(
    handlerSource,
    /if \(matchStrategy === "story_to_hook"\)\s*await requestStorylineBatchRenders\(selectedProductionPairIds\);\s*else await requestExternalRender\(\);\s*setActiveStep\(5\)/,
    "the handler may advance only after the appropriate render request resolves",
  );
  assert.match(factorySource, /onGeneratePreview=\{\(\) => void confirmTransitionAndGenerate\(\)\}/);
  assert.match(
    factorySource,
    /if \(matchStrategy === "story_to_hook" && activeStep === 3\) \{\s*void confirmTransitionAndGenerate\(\);/,
  );
  assert.doesNotMatch(
    factorySource,
    /onGeneratePreview=\{\(\) => setActiveStep\(5\)\}/,
    "the in-panel transition action must not bypass render creation",
  );
});

test("does not allow step five to advance to export until every selected render succeeds", () => {
  assert.match(
    factorySource,
    /const hasCompletedRender =[\s\S]*?selectedProductionPlanIds\.every\(\(planId\) => \{[\s\S]*?render\?\.status === "succeeded" && Boolean\(render\.outputUrl\)/,
    "batch completion requires every selected storyline render to have a real output",
  );
  assert.match(factorySource, /if \(targetStep === 6\) return hasCompletedRender/);
  assert.match(factorySource, /disabled=\{!canEnterExternalStep\(step\.internalStep\)\}/);
  assert.match(factorySource, /\(activeStep === 5 && !hasCompletedRender\)/);
});

test("continues polling retryable failed renders until their attempt budget is exhausted", () => {
  const match = factorySource.match(
    /const shouldPollFactoryRender = \(render: FactoryRenderRecord\) =>\s*([\s\S]*?);\s*const shouldPollHookMatchJob/,
  );
  assert.ok(match, "factory render polling predicate must exist");
  const shouldPollFactoryRender = new Function("render", `return (${match[1]});`);

  assert.equal(shouldPollFactoryRender({ status: "failed", attempt: 1, maxAttempts: 3 }), true);
  assert.equal(shouldPollFactoryRender({ status: "failed", attempt: 3, maxAttempts: 3 }), false);
  assert.equal(shouldPollFactoryRender({ status: "rendering", attempt: 3, maxAttempts: 3 }), true);
  assert.equal(shouldPollFactoryRender({ status: "succeeded", attempt: 1, maxAttempts: 3 }), false);
  assert.match(factorySource, /!factoryRender\?\.id \|\|\s*!shouldPollFactoryRender\(factoryRender\)/);
  assert.match(
    factorySource,
    /Object\.entries\(factoryRendersByStoryline\)\.filter\(\s*\(\[, render\]\) => shouldPollFactoryRender\(render\)/,
  );
});

test("passes the validated finished-film duration into the preview", () => {
  assert.match(
    factorySource,
    /const activeRenderDurationSeconds = Number\([\s\S]*?factoryRender\?\.validation[\s\S]*?actualDurationSeconds/,
  );
  assert.match(
    factorySource,
    /const activeRenderDuration =[\s\S]*?formatDurationZh\(activeRenderDurationSeconds, 2\)/,
  );
  assert.match(
    factorySource,
    /<ExternalHookDelivery[\s\S]*?previewUrl=\{factoryRender\?\.previewUrl\}[\s\S]*?duration=\{activeRenderDuration\}/,
  );
});

test("forces a new project and render when regenerating a storyline preview", () => {
  const start = factorySource.indexOf("const requestStorylineBatchRenders");
  const end = factorySource.indexOf("const persistEpisodeSpliceProject", start);
  const batchSource = factorySource.slice(start, end);

  assert.match(batchSource, /resolvedMatches: Record<string, HookStoryMatch> = \{\},\s*forceNew = false/);
  assert.match(batchSource, /existing && !forceNew && shouldPollFactoryRender\(existing\)/);
  assert.match(batchSource, /existing\?\.status === "succeeded" && !forceNew/);
  assert.match(batchSource, /forkFrom: forceNew && existing \? existing\.project : undefined/);
  assert.match(
    factorySource,
    /matchStrategy === "story_to_hook"\s*\? \(\) => requestStorylineBatchRenders\(undefined, \{\}, true\)/,
    "the preview's regenerate action must bypass existing successful or in-flight renders",
  );
});

test("does not label tag retrieval as the final story or production verdict", () => {
  assert.match(factorySource, /一对一钩子召回，不会把多个故事强行合并/);
  assert.match(factorySource, /matchingDimensions/);
  assert.match(factorySource, /productionGate/);
});

test("maps one event-graph storyline to one compact card with selectable entry points", () => {
  assert.match(factorySource, /storylinePlanGrid/);
  assert.match(factorySource, /plan\.entryPoints\.map/);
  assert.match(factorySource, /storylineEntryPointIds\[plan\.id\]/);
  assert.match(factorySource, /开场[\s\S]*发展[\s\S]*卡点/);
  assert.match(factorySource, /查看详细依据/);
  assert.match(factorySource, /片段证据[\s\S]*人物身份承接[\s\S]*语义因果承接/);
  assert.doesNotMatch(factorySource, /该独立支线在当前“高光起播＋顺序后续2–3集”/);
});
