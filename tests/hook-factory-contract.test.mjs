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

test("limits storyline generation to every explicitly selected highlight", () => {
  const episodeRows = Array.from({length:5},(_,episodeIndex)=>({
    episode:episodeIndex+1,
    durationSeconds:60,
    analysis:{},
    highlights:Array.from({length:2},(_,index)=>({id:`h${episodeIndex+1}-${index}`,start_seconds:5+index*20,end_seconds:15+index*20,spoken_summary:`第${episodeIndex+1}集事件${index}`,conflict:"关系冲突",information_gap:"接下来会怎样",evidence:[{source:"subtitle"}],analysis_version:"v1"}))
  }));
  const selected=["h1-0","h2-1"];
  const plans=generateStorylinePlans({id:"selected-drama"},episodeRows,"停滑与点击",300,selected);
  const openingIds=new Set(plans.map(plan=>String(plan.segments[0].highlightAssetId)));
  assert.ok(plans.length>=2);
  assert.ok(plans.every(plan=>selected.some(id=>plan.evidence.some(row=>row.sourceId===id))));
  assert.ok(selected.every(id=>plans.some(plan=>plan.evidence.some(row=>row.sourceId===id))));
  assert.ok(openingIds.size>=2);
});

test("storyline route accepts selected highlight ids as a generation constraint", () => {
  assert.match(hookRouteSource, /selected_highlight_ids/);
  assert.match(hookRouteSource, /selectedHighlightIds\.includes\(item\.id\)/);
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
  assert.match(source, /generateStorylinePlans/);
});
