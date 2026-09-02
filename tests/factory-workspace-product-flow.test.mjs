import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const factorySource = await readFile(
  new URL("../app/features/factory/FactoryWorkspace.tsx", import.meta.url),
  "utf8",
);
const librarySource = await readFile(
  new URL("../app/features/library/DramaLibraryWorkspace.tsx", import.meta.url),
  "utf8",
);

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
