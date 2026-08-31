import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url), "utf8");
const hookRouteSource = fs.readFileSync(new URL("../pb_hooks/hook_factory.pb.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} }, exports: {}, $os: { getenv: () => "" }, Math, JSON, String, Number, Array, Object, Set, Error };
vm.runInNewContext(source, sandbox);
const { summarizeHookMatch, deriveStoryNeed, generateStorylinePlans, generateTemplateAdaptationPlans, storyNeedFromPlans, scoreHookCandidate, templateEvidenceLevel } = sandbox.module.exports;

test("includes persisted drama ontology tags in server-side reverse retrieval", () => {
  const need=deriveStoryNeed({id:"d1",ontologyTags:[{code:"theme.复仇",dimension:"theme",label:"复仇",prominence:"primary",evidence:["第1集立誓"]},{code:"theme.error",dimension:"theme",label:"错误标签",manualStatus:"rejected"}]},[],"停滑");
  assert.ok(need.contentTags.includes("复仇"));
  assert.ok(!need.contentTags.includes("错误标签"));
  assert.equal(need.contractVersion,"lumina-semantic-contract-v1.1");
});

test("reports supplemental work instead of an ambiguous empty result", () => {
  const summary = summarizeHookMatch(
    { status: "queued", episode_scope: [1, 2] },
    [{ status: "succeeded", result: { highlights: [] } }, { status: "running", result: {} }],
    []
  );
  assert.equal(summary.outcome_status, "waiting_supplemental");
  assert.equal(summary.funnel.supplemental_jobs.running, 1);
  assert.equal(summary.incomplete, true);
});

test("distinguishes partial, failed, and completed no-candidate outcomes", () => {
  assert.equal(summarizeHookMatch({ status: "queued" }, [{ status: "failed" }], []).outcome_status, "partial");
  assert.equal(summarizeHookMatch({ status: "failed" }, [], []).outcome_status, "failed");
  assert.equal(summarizeHookMatch({ status: "succeeded" }, [], []).outcome_status, "no_candidates");
});

test("returns a diagnostic funnel and normalized rejection reasons", () => {
  const result = { highlights: [{ timecode: { start: 1, end: 8 }, qualityScores: { storyScore: 72 }, qualityGate: { reasons: ["story_score"] }, safeStart: {}, safeEnd: {} }] };
  const summary = summarizeHookMatch({ status: "succeeded", episode_scope: [1] }, [{ status: "succeeded", result }], []);
  assert.equal(summary.funnel.raw_candidates, 1);
  assert.equal(summary.funnel.editable_candidates, 1);
  assert.ok(summary.rejection_reasons.some((item) => item.code === "story_score"));
  assert.ok(summary.rejection_reasons.some((item) => item.code === "boundary_unverified"));
});

test("derives a story need before reverse hook retrieval", () => {
  const need = deriveStoryNeed({}, [{ episode: 1, analysis: { episodeSummary: "女主发现未婚夫背叛并决定反击", contentTags: ["背叛", "反击"] }, highlights: [{ id: "h1", conflict: "背叛", narrative_promise: "她会如何反击", boundary_status: "verified" }] }], "停滑与点击");
  assert.match(need.corePlot, /背叛/);
  assert.ok(need.extendDirections.some((item) => item.type === "prequel"));
  assert.equal(need.contractVersion, "lumina-semantic-contract-v1.1");
});

test("scores reverse hook candidates with explicit retrieval evidence", () => {
  const need = deriveStoryNeed({}, [{ episode: 1, analysis: { episodeSummary: "女主发现背叛并反击", contentTags: ["背叛", "反击"] }, highlights: [] }], "停滑与点击");
  const result = scoreHookCandidate({ content_tags: ["背叛", "反击"], narrative_promise: "她将如何复仇", evidence: [{ source: "transcript" }], boundary_status: "verified", review_status: "approved" }, need);
  assert.ok(result.score >= 40);
  assert.ok(result.matchedSignals.includes("背叛"));
  assert.equal(typeof result.bridgeCost, "number");
});

test("generates only sequential plans from a highlight through the next 2-3 episodes", () => {
  const episodeRows = Array.from({length:4},(_,episodeIndex)=>({
    episode:episodeIndex+1,
    durationSeconds:60,
    analysis:{},
    highlights:Array.from({length:2},(_,index)=>({id:`h${episodeIndex+1}-${index}`,start_seconds:10+index*20,end_seconds:22+index*20,spoken_summary:`第${episodeIndex+1}集剧情事件${index}`,conflict:index%2?"关系冲突":"身份冲突",emotion:index%2?"紧张":"愤怒",information_gap:`事件${index}会如何发展`,narrative_promise:`事件${index}的阶段结果`,evidence:[{source:"subtitle"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}))
  }));
  const plans=generateStorylinePlans({id:"d1"},episodeRows,"停滑与点击",300);
  assert.ok(plans.length>0&&plans.length<=10);
  assert.ok(plans.every(item=>item.chronology==="chronological"));
  assert.ok(plans.every(item=>["爆点起播方案","前因完整方案","主角觉醒方案","悬念卡点方案"].includes(item.strategyType)));
  assert.ok(plans.every(item=>item.scriptPlan&&item.scriptPlan.audiencePromise&&item.scriptPlan.openingEvent&&item.scriptPlan.endingCliffhanger));
  assert.ok(plans.every(item=>item.episodeScope.length>=3&&item.episodeScope.length<=4));
  assert.equal(plans.map(item=>item.acquisitionScore).join(","),[...plans].map(item=>item.acquisitionScore).sort((a,b)=>b-a).join(","));
  for(const plan of plans){
    const intervals=plan.segments.map(item=>`${item.episode}:${item.start}-${item.end}`);
    assert.equal(new Set(intervals).size,intervals.length);
    assert.ok(plan.segments.every(item=>item.highlightAssetId&&item.analysisVersion));
  }
});

test("removes repeated plot clauses and does not return duplicate storyline content", () => {
  const repeated="人物发现背叛并决定离开；人物发现背叛并决定离开";
  const episodeRows=Array.from({length:4},(_,episodeIndex)=>({
    episode:episodeIndex+1,
    durationSeconds:120,
    analysis:{},
    highlights:[0,1].map(index=>({id:`dup-${episodeIndex}-${index}`,start_seconds:10+index*20,end_seconds:22+index*20,spoken_summary:repeated,conflict:"关系冲突",information_gap:"她会如何选择",evidence:[{source:"subtitle"}],analysis_version:"v1"}))
  }));
  const plans=generateStorylinePlans({id:"duplicate-drama"},episodeRows,"停滑与点击",300);
  assert.equal(plans.length,4);
  assert.equal(new Set(plans.map(item=>item.scriptPlan.mode)).size,4);
  assert.equal(new Set(plans.map(item=>item.scriptPlan.audiencePromise)).size,plans.length);
  assert.equal(new Set(plans.map(item=>item.title)).size,plans.length);
  assert.ok(plans.every(item=>!item.storylineSummary.includes(`${repeated}；${repeated}`)));
});

test("uses selected storylines as the retrieval story need", () => {
  const base=deriveStoryNeed({},[],"停滑与点击");
  const need=storyNeedFromPlans(base,[{id:"p1",storylineSummary:"母女误解后身份线索出现",segments:[{plot:"身份线索出现"}],hookNeed:{audienceQuestion:"她为何不被母亲承认",requiredSignals:["母女","身份悬念"],prohibitedReveals:["真实身份"]},evidence:[{sourceId:"h1"}]}]);
  assert.equal(need.selectedStorylineIds.join(","),"p1");
  assert.match(need.corePlot,/母女误解/);
  assert.ok(need.contentTags.includes("身份悬念"));
  assert.equal(need.protectedReveals.join(","),"真实身份");
});

test("does not treat exposure alone as strong template evidence", () => {
  assert.equal(templateEvidenceLevel({ exposure: 1000000, runDays: 30 }), "weak");
  assert.equal(templateEvidenceLevel({ spend: 1000, ctr: 0.04, cvr: 0.02 }), "strong");
});

test("maps historical template slots to evidence-backed current-drama plans", () => {
  const episodeRows=Array.from({length:3},(_,episodeIndex)=>({episode:episodeIndex+1,durationSeconds:60,analysis:{},highlights:[{id:`h${episodeIndex+1}`,start_seconds:12,end_seconds:24,spoken_summary:`第${episodeIndex+1}集剧情事件`,conflict:"家族冲突",emotion:episodeIndex%2?"紧张":"愤怒",information_gap:`事件${episodeIndex}会如何发展`,narrative_promise:`事件${episodeIndex}阶段兑现`,evidence:[{source:"subtitle"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v2"}]}));
  const template={id:"t1",version:"v3",performanceEvidence:{spend:1000,ctr:.04,cvr:.02},bodyStructure:[{role:"context",purpose:"建立受辱前因"},{role:"conflict",purpose:"升级家族冲突"},{role:"payoff",purpose:"阶段反击兑现"}],timelineSkeleton:[]};
  const plans=generateTemplateAdaptationPlans(template,{id:"d1"},episodeRows,"停滑与点击",300);
  assert.ok(plans.length>0&&plans.length<=10);
  assert.equal(plans[0].templateAdaptation.templateId,"t1");
  assert.equal(plans[0].templateAdaptation.totalSlots,3);
  assert.ok(plans[0].templateAdaptation.mappings.every(item=>Number.isFinite(item.episode)&&Number.isFinite(item.start)&&Number.isFinite(item.end)));
});

test("enforces sequential episode splice as highlight remainder plus 2-3 following episodes", () => {
  assert.match(hookRouteSource, /factory\/episode-splice\/projects/);
  assert.match(hookRouteSource, /clips\.length < 3 \|\| clips\.length > 4/);
  assert.match(hookRouteSource, /episode splice timeline must use consecutive episodes/);
  assert.match(hookRouteSource, /sequential splice duration must be between 5 and 15 minutes/);
  assert.match(hookRouteSource, /first splice segment must start at an approved verified highlight/);
  assert.match(hookRouteSource, /source_class = 'episode_highlight'.*boundary_status = 'verified'.*review_status = 'approved'/s);
  assert.match(hookRouteSource, /following splice segments must explicitly use the episode source start/);
  assert.match(hookRouteSource, /splice segments must explicitly continue to the episode source end/);
  assert.match(hookRouteSource, /project\.set\("timeline", normalizedClips\)/);
  assert.match(source, /generateStorylinePlans/);
});

test("factory render claim includes every sequential external-body episode", () => {
  assert.match(hookRouteSource, /sequentialExternalBody/);
  assert.match(hookRouteSource, /jsonArray\(project, "timeline"\)/);
  assert.match(
    hookRouteSource,
    /sequentialExternalBody[\s\S]*jsonArray\(project, "timeline"\)[\s\S]*item && item\.episode/,
  );
});

test("external production duration is derived from canonical timestamps", () => {
  const durationBlock = hookRouteSource.slice(
    hookRouteSource.indexOf("const timelineDurationSeconds"),
    hookRouteSource.indexOf("const transitionInput"),
  );
  assert.match(durationBlock, /end - start/);
  assert.doesNotMatch(durationBlock, /durationSeconds|duration_seconds|explicit/);
});

test("every interactive factory claim honors an explicit job id", () => {
  for (const endpoint of [
    "/api/lumina/entry-precision/claim",
    "/api/lumina/supplemental-highlights/claim",
    "/api/lumina/factory-render/claim",
  ]) {
    const start = hookRouteSource.indexOf(endpoint);
    const nextRoute = hookRouteSource.indexOf("routerAdd(", start + endpoint.length);
    const block = hookRouteSource.slice(start, nextRoute < 0 ? undefined : nextRoute);
    assert.match(block, /requestedJobId = String\(body\.job_id \|\| ""\)/);
    assert.match(block, /!requestedJobId \|\| (?:candidate|item)\.id === requestedJobId/);
  }
});

test("hook matching eligibility is source-agnostic but keeps material safety gates", () => {
  const recommendationStart = hookRouteSource.indexOf('/api/lumina/story-hook-recommendations');
  const recommendationEnd = hookRouteSource.indexOf('routerAdd(', recommendationStart + 1);
  const recommendationBlock = hookRouteSource.slice(recommendationStart, recommendationEnd);
  assert.match(recommendationBlock, /boundary_status = 'verified' && review_status = 'approved' && material != ''/);
  assert.doesNotMatch(recommendationBlock, /source_class = 'external_material'/);

  const jobStart = hookRouteSource.indexOf('/api/lumina/hook-matching/jobs');
  const jobEnd = hookRouteSource.indexOf('routerAdd(', jobStart + 1);
  const jobBlock = hookRouteSource.slice(jobStart, jobEnd);
  assert.match(jobBlock, /hook must belong to the material library/);
  assert.match(jobBlock, /hook source media is not playable/);
  assert.match(jobBlock, /hook must be approved before matching/);
  assert.doesNotMatch(jobBlock, /source_class.*external_material/);

  const projectStart = hookRouteSource.indexOf('/api/lumina/factory/projects');
  const projectEnd = hookRouteSource.indexOf('routerAdd(', projectStart + 1);
  const projectBlock = hookRouteSource.slice(projectStart, projectEnd);
  assert.match(projectBlock, /approved verified hook from the material library/);
  assert.match(projectBlock, /HOOK_SOURCE[\s\S]*sourceClass/);
  assert.doesNotMatch(projectBlock, /HOOK_SOURCE[\s\S]{0,180}source_class.*external_material/);
});

test("external-hook production records the initial semantic thresholds and severe mismatch veto", () => {
  const projectStart = hookRouteSource.indexOf('/api/lumina/factory/projects');
  const projectEnd = hookRouteSource.indexOf('routerAdd(', projectStart + 1);
  const block = hookRouteSource.slice(projectStart, projectEnd);
  assert.match(block, /story_score"\) < 80/);
  assert.match(block, /promise_fulfillment_score"\) < 75/);
  assert.match(block, /HOOK_RETENTION[\s\S]*threshold: 80/);
  assert.match(block, /CONNECTIVITY[\s\S]*threshold: 70/);
  assert.match(block, /SEVERE_MISMATCH_VETO[\s\S]*severity: "hard"/);
  assert.match(block, /HOOK_RIGHTS[\s\S]*severity: "hard"/);
});

test("factory transitions are formal production objects with an independent approval gate", () => {
  assert.match(hookRouteSource, /transition\.type must be direct_cut, transition_copy or continuous_narration/);
  assert.match(hookRouteSource, /projects\/\{id\}\/transition-review/);
  assert.match(hookRouteSource, /transition review must be approved before rendering, including direct_cut/);
  assert.match(hookRouteSource, /reviewStatus: "pending"/);
  assert.match(hookRouteSource, /projects\/\{id\}\/transition-preview/);
  assert.match(hookRouteSource, /transition approval must bind the latest preview hash and production version/);
  assert.match(hookRouteSource, /purpose: "transition_review"/);
});
