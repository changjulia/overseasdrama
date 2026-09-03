import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url), "utf8");
const hookRouteSource = fs.readFileSync(new URL("../pb_hooks/hook_factory.pb.js", import.meta.url), "utf8");
const composeSource = fs.readFileSync(new URL("../docker-compose.tencent.yml", import.meta.url), "utf8");
const workerLauncherSource = fs.readFileSync(new URL("../scripts/start-analysis-worker.ps1", import.meta.url), "utf8");
const sandbox = { module: { exports: {} }, exports: {}, $os: { getenv: () => "" }, Math, JSON, String, Number, Array, Object, Set, Error };
vm.runInNewContext(source, sandbox);
const { summarizeHookMatch, deriveStoryNeed, generateStorylinePlans, generateStoryUnderstanding, generateTemplateAdaptationPlans, storyNeedFromPlans, scoreHookCandidate, compareOntologyProfiles, templateEvidenceLevel } = sandbox.module.exports;

test("server-side retrieval applies the ontology relation contract", () => {
  const exact=compareOntologyProfiles({ontology_tags:[{code:"theme.复仇",dimension:"theme"}]},{ontologyTags:[{code:"theme.复仇",dimension:"theme"}]});
  assert.equal(exact.relation,"exact");
  assert.equal(exact.decision,"allow_recall");
  assert.equal(exact.productionEligible,false);
  const bridgeable=compareOntologyProfiles({themes:["复仇"]},{conflict:"复仇对抗"});
  assert.equal(bridgeable.relation,"bridgeable");
  const unknown=compareOntologyProfiles({themes:["未收录甲"]},{themes:["未收录乙"]});
  assert.equal(unknown.relation,"unknown");
  assert.equal(unknown.decision,"needs_evidence");
  const blocked=compareOntologyProfiles({relationships:["盟友"]},{relationshipState:["敌对"]});
  assert.equal(blocked.relation,"contradictory");
  assert.equal(blocked.decision,"blocked");
  assert.ok(blocked.hardConflicts.length>0);
});

test("reverse hook scoring exposes recall-only ontology evidence", () => {
  const need={corePlot:"复仇",causalChain:[],comprehensionGaps:[],contentTags:[],relationshipState:[],ontologyTags:[{code:"theme.复仇",dimension:"theme",label:"复仇"}]};
  const result=scoreHookCandidate({ontology_tags:[{code:"theme.复仇",dimension:"theme",label:"复仇"}],boundary_status:"verified",evidence:[{source:"transcript"}]},need);
  assert.equal(result.tagRecall.relation,"exact");
  assert.equal(result.tagRecall.productionEligible,false);
  const blocked=scoreHookCandidate({relationships:["盟友"]},{corePlot:"",causalChain:[],comprehensionGaps:[],contentTags:[],relationshipState:["敌对"]});
  assert.equal(blocked.recallEligible,true);
  assert.ok(blocked.score >= 0);
  assert.match(blocked.reasons.join(" "), /标签冲突提示/);
  assert.equal(blocked.score,0);
});

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

test("prioritizes an attributable same-title hook over a generic thematic hook", () => {
  const need = deriveStoryNeed(
    { id: "lycan", title: "The Rise of the Lycan Queen" },
    [{ episode: 1, analysis: { episodeSummary: "狼族女王保护无狼婴儿并唤醒血脉力量" }, highlights: [] }],
    "停滑与点击",
  );
  const attributable = scoreHookCandidate({
    title: "The Rise of the Lycan Queen-20260827-13",
    hook_type: "身份反转",
    narrative_promise: "被点名的强者为何立即回应命令",
    evidence: [{ source: "transcript" }],
    boundary_status: "verified",
    review_status: "approved",
  }, need);
  const generic = scoreHookCandidate({
    title: "爽到外太空",
    content_tags: ["女性觉醒", "家庭伦理", "权力"],
    narrative_promise: "冲突如何升级",
    boundary_status: "unverified",
    review_status: "needs_review",
  }, need);
  assert.ok(attributable.titleAffinity > 0);
  assert.ok(attributable.score > generic.score);
});

test("builds production storylines from real highlights as consecutive full-episode routes", () => {
  const durations=[130,120,110,100,90];
  const episodeRows = durations.map((durationSeconds,episodeIndex)=>({
    episode:episodeIndex+1,
    durationSeconds,
    analysis:{},
    highlights:[{id:`h${episodeIndex+1}`,start_seconds:10,end_seconds:22,spoken_summary:`第${episodeIndex+1}集真实事件`,conflict:"关系冲突",emotion:"紧张",information_gap:"冲突将如何发展",narrative_promise:"下一集兑现结果",evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}]
  }));
  const plans=generateStorylinePlans({id:"d1",title:"任意剧名"},episodeRows,"停滑与点击",300);
  assert.ok(plans.length>0&&plans.length<=10);
  assert.ok(plans.every(item=>item.chronology==="chronological"));
  assert.ok(plans.every(item=>item.strategyType!=="事件图故事线"));
  assert.ok(plans.every(item=>item.scriptPlan&&item.scriptPlan.audiencePromise&&item.scriptPlan.openingEvent&&item.scriptPlan.endingCliffhanger));
  const routeSignatures=plans.map(plan=>plan.segments.map(segment=>`${segment.episode}:${segment.start}-${segment.end}`).join("|"));
  assert.equal(new Set(routeSignatures).size,plans.length);
  for(const plan of plans){
    assert.ok(plan.segments.length===3||plan.segments.length===4);
    assert.ok(plan.totalDurationSeconds>=300&&plan.totalDurationSeconds<=840);
    assert.ok(plan.totalDurationSeconds+60<=900);
    assert.equal(plan.entryPoints.length,1);
    assert.equal(plan.entryPoints[0].start,plan.segments[0].start);
    plan.segments.forEach((segment,index)=>{
      assert.equal(segment.episode,plan.segments[0].episode+index);
      assert.equal(segment.end,durations[segment.episode-1]);
      if(index>0) assert.equal(segment.start,0);
      assert.ok(segment.highlightAssetId&&segment.analysisVersion);
    });
  }
});

test("limits production generation to explicitly selected opening highlights", () => {
  const episodeRows = Array.from({length:5},(_,episodeIndex)=>({
    episode:episodeIndex+1,
    durationSeconds:120,
    analysis:{},
    highlights:Array.from({length:2},(_,index)=>({id:`h${episodeIndex+1}-${index}`,start_seconds:5+index*20,end_seconds:15+index*20,spoken_summary:`第${episodeIndex+1}集事件${index}`,conflict:"关系冲突",information_gap:"接下来会怎样",evidence:[{source:"subtitle"}],analysis_version:"v1"}))
  }));
  const selected=["h1-0","h2-1"];
  const plans=generateStorylinePlans({id:"selected-drama"},episodeRows,"停滑与点击",300,selected);
  const openingIds=new Set(plans.map(plan=>String(plan.segments[0].highlightAssetId)));
  assert.equal(plans.length,2);
  assert.deepEqual([...openingIds].sort(),selected.sort());
  assert.ok(plans.every(plan=>plan.segments.slice(1).some(segment=>!selected.includes(segment.highlightAssetId))));
});

test("storyline route accepts selected highlight ids as a generation constraint", () => {
  assert.match(hookRouteSource, /selected_highlight_ids/);
  assert.match(hookRouteSource, /selectedHighlightIds\.includes\(item\.id\)/);
});

test("does not copy the opening highlight identity or ontology into evidence-free following episodes", () => {
  const rows=[1,2,3,4].map(episode=>({
    episode,
    durationSeconds:110,
    analysis:{},
    highlights:episode===1?[{id:"only-anchor",start_seconds:10,end_seconds:20,spoken_summary:"首集真实高光",conflict:"身份冲突",emotion:"紧张",information_gap:"身份如何揭晓",narrative_promise:"后续揭晓",ontology_tags:[{code:"theme.复仇",dimension:"theme"}],evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}]:[],
  }));
  const plan=generateStorylinePlans({id:"neutral-following"},rows,"停滑",300,["only-anchor"])[0];
  assert.equal(plan.segments[0].highlightAssetId,"only-anchor");
  assert.ok(plan.segments.slice(1).every(segment=>segment.highlightAssetId!=="only-anchor"));
  assert.ok(plan.segments.slice(1).every(segment=>Array.isArray(segment.ontologyTags)&&segment.ontologyTags.length===0));
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
  assert.equal(plans.length,1);
  assert.equal(new Set(plans.map(item=>item.title)).size,plans.length);
  assert.ok(plans.every(item=>!item.storylineSummary.includes(`${repeated}；${repeated}`)));
});

test("keeps card plots event-focused and prevents saturated storyline scores", () => {
  const rows=Array.from({length:4},(_,index)=>({
    episode:index+1,
    durationSeconds:120,
    analysis:{},
    highlights:[{id:`clean-${index}`,start_seconds:index?0:10,end_seconds:30,spoken_summary:`一位身穿华服的女性站在大厅，神情凝重；母亲发现女儿隐藏血脉后决定保护她`,conflict:"身份冲突",information_gap:"女儿的血脉会如何改变狼群",evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}],
  }));
  const plans=generateStorylinePlans({id:"clean-story"},rows,"停滑与点击",300);
  assert.ok(plans.length>0);
  assert.ok(plans.every(plan=>plan.acquisitionScore<=96));
  assert.ok(plans.every(plan=>plan.segments.every(segment=>!segment.plot.includes("一位身穿华服"))));
});

test("Lycan title does not switch production to canned plans or fixed scores", () => {
  const rows=Array.from({length:6},(_,index)=>({episode:index+1,durationSeconds:150,analysis:{},highlights:[{id:`live-${index+1}`,start_seconds:10,end_seconds:24,spoken_summary:`实时高光${index+1}推动新的事件`,conflict:index%2?"公开对抗":"身份揭示",emotion:index%2?"愤怒":"紧张",information_gap:`第${index+1}集问题`,narrative_promise:`第${index+1}集承诺`,evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"live-v2"}]}));
  const drama={id:"lycan",title:"The Rise of the Lycan Queen"};
  const plans=generateStorylinePlans(drama,rows,"停滑与点击",450,["live-1","live-2"]);
  const renamedPlans=generateStorylinePlans({...drama,title:"A Different Drama"},rows,"停滑与点击",450,["live-1","live-2"]);
  const productionView=(items)=>items.map(item=>({title:item.title,score:item.acquisitionScore,route:item.segments.map(segment=>`${segment.episode}:${segment.start}-${segment.end}`)}));
  assert.deepEqual(productionView(plans),productionView(renamedPlans));
  assert.ok(plans.every(plan=>plan.title.includes("实时高光")));
  assert.ok(!plans.some(plan=>/无狼继承人遭生父追杀|母亲以命护女/.test(plan.title)));
  const understanding=generateStoryUnderstanding(drama,rows,plans);
  const inferred=understanding.canonicalCharacters.find(item=>item.id==="wolfless_infant_arya");
  assert.equal(inferred.identityStatus,"high_confidence_inference");
  assert.equal(understanding.overview.terminology.Luna.includes("不是月亮女神"),true);
  assert.ok(understanding.narrativeEdges.some(edge=>edge.type==="time_jump"));
  assert.ok(understanding.narrativeEdges.some(edge=>edge.type==="identity_reveal"&&edge.status==="high_confidence_inference"));
});

test("scores change with current highlight evidence instead of using fixed 93-96 values", () => {
  const rows=(strong)=>Array.from({length:4},(_,index)=>({episode:index+1,durationSeconds:120,analysis:{},highlights:[{id:`${strong?"strong":"weak"}-${index+1}`,start_seconds:10,end_seconds:20,spoken_summary:strong?`主角揭穿背叛并当众反击${index+1}`:`人物经过房间${index+1}`,conflict:strong?"公开对抗":"",emotion:strong?"愤怒":"",information_gap:strong?"真相会怎样揭晓":"",narrative_promise:strong?"下一集完成反击":"",evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}]}));
  const strong=generateStorylinePlans({id:"score-drama"},rows(true),"停滑",300,["strong-1"])[0];
  const weak=generateStorylinePlans({id:"score-drama"},rows(false),"停滑",300,["weak-1"])[0];
  assert.ok(strong.acquisitionScore>weak.acquisitionScore);
  assert.notEqual(strong.title,weak.title);
});

test("variation only reorders equally scored real candidates", () => {
  const rows=Array.from({length:5},(_,index)=>({episode:index+1,durationSeconds:120,analysis:{},highlights:[{id:`v${index+1}`,start_seconds:10,end_seconds:20,spoken_summary:`不同真实事件${index+1}`,conflict:"公开冲突",emotion:"紧张",information_gap:"接下来如何发展",narrative_promise:"后续给出结果",evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}]}));
  const selected=["v1","v2"];
  const first=generateStorylinePlans({id:"variation"},rows,"停滑",300,selected,0);
  const second=generateStorylinePlans({id:"variation"},rows,"停滑",300,selected,1);
  assert.deepEqual(first.map(item=>item.id).sort(),second.map(item=>item.id).sort());
  assert.deepEqual(Object.fromEntries(first.map(item=>[item.id,item.acquisitionScore])),Object.fromEntries(second.map(item=>[item.id,item.acquisitionScore])));
  assert.notDeepEqual(first.map(item=>item.id),second.map(item=>item.id));
  assert.ok(first.concat(second).every(plan=>selected.includes(plan.segments[0].highlightAssetId)));
});

test("selects two or three following episodes by duration and rejects invalid ranges", () => {
  const makeRows=(durations)=>durations.map((durationSeconds,index)=>({episode:index+1,durationSeconds,analysis:{},highlights:[{id:`range-${index+1}`,start_seconds:10,end_seconds:20,spoken_summary:`范围事件${index+1}`,conflict:"冲突",emotion:"紧张",information_gap:"后续如何",narrative_promise:"结果待揭晓",evidence:[{source:"subtitle",verification:"verified"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v1"}]}));
  const two=generateStorylinePlans({id:"two"},makeRows([110,110,110,110]),"停滑",300,["range-1"]);
  assert.equal(two.length,1);
  assert.equal(two[0].segments.length,3);
  const three=generateStorylinePlans({id:"three"},makeRows([70,100,100,100]),"停滑",300,["range-1"]);
  assert.equal(three.length,1);
  assert.equal(three[0].segments.length,4);
  assert.deepEqual(Array.from(three[0].episodeScope),[1,2,3,4]);
  const closerThree=generateStorylinePlans({id:"closer-three"},makeRows([150,150,150,150]),"停滑",600,["range-1"]);
  assert.equal(closerThree[0].segments.length,4);
  assert.equal(generateStorylinePlans({id:"short"},makeRows([50,70,70,70]),"停滑",300,["range-1"]).length,0);
  assert.equal(generateStorylinePlans({id:"long"},makeRows([400,250,250,250]),"停滑",840,["range-1"]).length,0);
  const invalid=makeRows([110,110,110,110]);
  invalid[0].highlights[0].start_seconds=-1;
  assert.equal(generateStorylinePlans({id:"invalid"},invalid,"停滑",300,["range-1"]).length,0);
});

test("storyline route exposes v2 graph contract without conflating clip and story validation", () => {
  assert.match(hookRouteSource,/lumina-storyline-plan-v2-event-graph/);
  for(const field of ["canonical_characters","story_events","narrative_edges","entry_points","continuity","warnings"])
    assert.match(hookRouteSource,new RegExp(field));
});

test("hook-driven ideation accepts traceable pending-review hooks but keeps production blocked", () => {
  assert.doesNotMatch(hookRouteSource,/hook-driven storylines require an approved verified hook/);
  assert.match(hookRouteSource,/hook_validation: hookValidation/);
  assert.match(hookRouteSource,/productionEligible/);
  assert.match(hookRouteSource,/当前钩子可用于故事方向生成/);
  assert.match(hookRouteSource,/进入生产前必须完成复核/);
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
  const episodeRows=Array.from({length:4},(_,episodeIndex)=>({episode:episodeIndex+1,durationSeconds:120,analysis:{},highlights:[{id:`h${episodeIndex+1}`,start_seconds:12,end_seconds:24,spoken_summary:`第${episodeIndex+1}集剧情事件`,conflict:"家族冲突",emotion:episodeIndex%2?"紧张":"愤怒",information_gap:`事件${episodeIndex}会如何发展`,narrative_promise:`事件${episodeIndex}阶段兑现`,evidence:[{source:"subtitle"}],safe_start:{status:"verified"},safe_end:{status:"verified"},analysis_version:"v2"}]}));
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

test("factory render claims every persisted sequential body episode", () => {
  assert.match(hookRouteSource, /jsonArray\(project, "selected_episodes"\)/);
  assert.match(hookRouteSource, /jsonArray\(match, "segments"\)/);
  assert.match(hookRouteSource, /\.concat\(/);
});

test("factory review and export revalidate the local artifact and SHA-256", () => {
  assert.equal(
    [...hookRouteSource.matchAll(/verifyFactoryRenderArtifact\(render\)/g)].length,
    2,
    "review and export must rehash the artifact; the high-frequency status endpoint must not rehash a large MP4",
  );
  assert.match(source, /render artifact is missing from local \/renders storage/);
  assert.match(source, /render artifact SHA-256 no longer matches/);
  assert.match(source, /\$os\.cmd\("sha256sum", path\)/);
  assert.match(source, /\$os\.cmd\("certutil", "-hashfile", path, "SHA256"\)/);
  assert.match(source, /fileName\.endsWith\(`-\$\{render\.id\}\.mp4`\)/);
  assert.match(hookRouteSource, /fileName\.endsWith\(`-\$\{id\}\.mp4`\)/);
});

test("factory worker success requires complete hard QC and explicit advisories", () => {
  for (const code of [
    "UNIQUE_OUTPUT_PATH",
    "OUTPUT_PRESENT",
    "PLAYABLE",
    "VIDEO_CODEC",
    "AUDIO_CODEC",
    "RESOLUTION",
    "DURATION_CONSISTENCY",
    "FLASH_TAIL_REMOVED",
  ])
    assert.match(hookRouteSource, new RegExp(`"${code}"`));
  assert.match(hookRouteSource, /validation\.technicalPassed !== true/);
  assert.match(hookRouteSource, /unsupported render features must be returned as advisories/);
  assert.match(hookRouteSource, /succeeded render output filename must contain its render id/);
});

test("interactive matching and rendering cannot be starved by ingestion", () => {
  assert.match(composeSource, /interactive-worker:/);
  assert.match(composeSource, /--queue\s*\n\s*- material/);
  assert.match(composeSource, /LUMINA_INTERACTIVE_MATERIAL_FALLBACK: "0"/);
  assert.match(workerLauncherSource, /Instance -eq "interactive"/);
  assert.match(workerLauncherSource, /LUMINA_INTERACTIVE_MATERIAL_FALLBACK = "0"/);
});
