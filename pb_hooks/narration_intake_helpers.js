const SCHEMA = "narration-opening-v1";
function object(value) {
  try {
    // PocketBase JSON fields may be UTF-8 byte arrays in the JS runtime.
    if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      value = JSON.parse(decodeURIComponent(value.map((n) => "%" + n.toString(16).padStart(2, "0")).join("")));
    else if (typeof value === "string") value = JSON.parse(value);
    else if (value && typeof value.toJSON === "function") value = JSON.parse(JSON.stringify(value));
  } catch (_) { return {}; }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function validate(input) {
  const row = object(input);
  if (!/^[a-f0-9]{64}$/.test(String(row.sourceHash || ""))) throw new Error("invalid sourceHash");
  if (!/^[a-f0-9]{64}$/.test(String(row.cacheKey || ""))) throw new Error("invalid cacheKey");
  if (!/^https?:\/\/[^\s]+$/i.test(String(row.url || "")) || row.url.length > 2000) throw new Error("invalid source URL");
  if (!String(row.title || "").trim() || String(row.title).length > 450) throw new Error("invalid title");
  const coverageEnd = Number(row.coverageEnd);
  if (!Number.isFinite(coverageEnd) || coverageEnd <= 0 || coverageEnd > 60) throw new Error("invalid opening coverage");
  if (!Array.isArray(row.transcript) || !row.transcript.length || row.transcript.length > 200) throw new Error("opening transcript required");
  let previous = -1;
  const transcript = row.transcript.map((segment) => {
    const start = Number(segment.start), end = Number(segment.end), text = String(segment.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previous || start < 0 || end <= start || end > coverageEnd + .05 || !text || text.length > 2000) throw new Error("invalid transcript interval");
    previous = start;
    return { start, end, text };
  });
  const start = transcript[0].start, end = transcript[transcript.length - 1].end;
  if (end - start < 5 || end - start > 60) throw new Error("opening must contain 5–60 seconds of evidence");
  return { ...row, coverageEnd, transcript, start, end };
}

function importOpening(app, input) {
  const row = validate(input);
  let material;
  try { material = app.findFirstRecordByFilter("ad_materials", "source_identity_hash = {:hash} || source_url = {:url}", { hash: row.sourceHash, url: row.url }); } catch (_) {}
  const created = !material;
  if (!material) {
    material = new Record(app.findCollectionByNameOrId("ad_materials"));
    material.set("title", row.title);
    material.set("source_identity_hash", row.sourceHash);
    material.set("source_url", row.url);
    material.set("type", "正片剧集解说");
    material.set("material_format", "正片剧集解说");
    material.set("source", "外部");
    material.set("platform", "本地筛选清单");
    material.set("language", String(row.language || "未知语种").slice(0,120));
    material.set("duration_seconds", Math.max(row.end, Number(row.duration) || row.end));
    material.set("exposure", Math.max(0, Number(row.exposure) || 0));
    material.set("days", Math.max(0, Math.floor(Number(row.days) || 0)));
    material.set("rights_status", "仅限内部分析");
    material.set("review_status", "待复核");
    // Do not set analysis_status=queued/succeeded or trigger the full-video worker.
  }
  const previous = object(material.get("opening_analysis"));
  if (previous.cacheKey && previous.cacheKey !== row.cacheKey) throw new Error("opening evidence changed; explicit revision review required");
  // The user already classified this curated collection; analysis coverage is independent.
  material.set("type", "正片剧集解说");
  material.set("material_format", "正片剧集解说");
  const opening = {
    schemaVersion: SCHEMA, scope: "opening_only", status: "evidence_ready", cacheKey: row.cacheKey,
    coverage: { start: 0, end: row.coverageEnd }, sourceKey: row.key, group: row.group,
    openingType: String(row.openingType || "解说开头").slice(0,160),
    reviewReason: String(row.reason || "").slice(0,2000),
    verificationMethod: String(row.verified || "").slice(0,500),
    transcript: row.transcript, localMediaStatus: "not_verified", semanticStatus: "pending",
  };
  // Retrying an import must not erase a later semantic analysis or human review.
  if (!previous.cacheKey) material.set("opening_analysis", opening);
  app.save(material);
  const importKey = "narration:" + material.id + ":opening-v1";
  let hook;
  try { hook = app.findFirstRecordByFilter("hook_assets", "import_key = {:key}", { key: importKey }); } catch (_) {}
  if (!hook) {
    hook = new Record(app.findCollectionByNameOrId("hook_assets"));
    hook.set("import_key", importKey);
    hook.set("source_class", "narration_opening");
    hook.set("usage_role", "pre_roll");
    hook.set("material", material.id);
    hook.set("title", "解说开场 - " + row.title);
    hook.set("start_seconds", row.start);
    hook.set("end_seconds", row.end);
    hook.set("boundary_status", "unverified");
    hook.set("safe_start", { status: "unverified", time: row.start });
    hook.set("safe_end", { status: "unverified", time: row.end });
    hook.set("review_status", "needs_review");
    hook.set("hook_type", opening.openingType);
    hook.set("spoken_summary", "");
    hook.set("evidence", { transcript: row.transcript, coverage: opening.coverage });
    hook.set("analysis", { ...opening, identityConstraint: "保留原解说视角；跨剧须核对人物身份、关系与事实，不得仅凭标签判定可拼接" });
    hook.set("analysis_version", SCHEMA + ":" + row.cacheKey.slice(0,32));
    hook.set("rights_status", material.getString("rights_status"));
    app.save(hook);
  }
  return { materialId: material.id, hookId: hook.id, created, analysisQueued: false, cacheKey: row.cacheKey };
}
function saveSemantics(app, input) {
  const hook = app.findRecordById("hook_assets", String(input.hookId || ""));
  if (hook.getString("source_class") !== "narration_opening" || hook.getString("usage_role") !== "pre_roll") throw new Error("not an opted-in narration opening");
  const analysis = object(hook.get("analysis"));
  if (!analysis.cacheKey || analysis.cacheKey !== input.sourceCacheKey) throw new Error("source evidence changed");
  if (!/^[a-f0-9]{64}$/.test(String(input.semanticCacheKey || ""))) throw new Error("invalid semantic cache key");
  if (analysis.semanticCacheKey === input.semanticCacheKey) return { hookId: hook.id, reused: true };
  if (hook.getString("review_status") === "approved") throw new Error("human reviewed hook is immutable; create an explicit revision");
  const semantic = object(input.semantic), transcript = analysis.transcript || [];
  const indices = semantic.evidenceRows;
  if (!Array.isArray(indices) || !indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= transcript.length)) throw new Error("semantic claims must reference actual transcript rows");
  const mappings = { spokenSummary: "spoken_summary", conflict: "conflict", emotion: "emotion", narrativePromise: "narrative_promise", informationGap: "information_gap", hookType: "hook_type" };
  for (const key of Object.keys(mappings)) {
    if (typeof semantic[key] !== "string" || semantic[key].length > 1500) throw new Error("invalid semantic field: " + key);
    hook.set(mappings[key], semantic[key]);
  }
  for (const key of ["themes", "relationships", "contentTags"]) {
    if (!Array.isArray(semantic[key]) || semantic[key].length > 12 || semantic[key].some((s) => typeof s !== "string" || s.length > 100)) throw new Error("invalid tags");
    hook.set(key === "contentTags" ? "content_tags" : key, semantic[key]);
  }
  const constraints = String(semantic.identityConstraints || "").slice(0,2000);
  hook.set("analysis", { ...analysis, semanticCacheKey: input.semanticCacheKey, semanticStatus: "ready", semantic, identityConstraint: constraints || analysis.identityConstraint });
  hook.set("analysis_version", "narration-semantic-v1:" + input.semanticCacheKey.slice(0,40));
  // Semantic extraction never approves a frame boundary, source attribution or rights.
  app.save(hook);
  const material = app.findRecordById("ad_materials", hook.getString("material"));
  const opening = object(material.get("opening_analysis"));
  material.set("opening_analysis", { ...opening, semanticStatus: "ready", semanticCacheKey: input.semanticCacheKey });
  app.save(material);
  return { hookId: hook.id, reused: false, boundaryStatus: hook.getString("boundary_status") };
}
// Proper names may remain in their original spelling. Ordinary English prose
// is not a Chinese summary simply because the same string contains Han text.
function localizedSummary(text) {
  return typeof text === "string" && /[\u3400-\u9fff]/.test(text) &&
    !/\b[a-z]{2,}\b/.test(text) &&
    !/\b(?:Billionaire|Immortal|Mortal|Toddler|Gambler|Mute|Reveal|Divine)\b/.test(text);
}
function saveBoundary(app, input) {
  const hook = app.findRecordById("hook_assets", String(input.hookId || ""));
  const analysis = object(hook.get("analysis"));
  if (hook.getString("source_class") !== "narration_opening" || hook.getString("usage_role") !== "pre_roll") throw new Error("not an opted-in narration opening");
  if (analysis.cacheKey !== input.sourceCacheKey) throw new Error("source evidence changed");
  if (!/^[a-f0-9]{64}$/.test(String(input.resultKey || ""))) throw new Error("invalid boundary result key");
  if (analysis.boundaryResultKey === input.resultKey) return { hookId: hook.id, reused: true };
  if (["approved", "rejected"].includes(hook.getString("review_status")) || hook.getString("boundary_status") === "verified") throw new Error("human reviewed hook is immutable");
  const budget = object(input.budget);
  if (budget.cap !== 2079 || !Number.isInteger(budget.used) || budget.used < 0 || budget.used > 2079) throw new Error("invalid or exceeded token budget");
  const boundary = object(input.boundary);
  if (!["candidate", "needs_context", "budget_limited", "media_failed"].includes(boundary.status)) throw new Error("invalid boundary status");
  const material = app.findRecordById("ad_materials", hook.getString("material"));
  let transcript = analysis.transcript || [], coverage = analysis.coverage;
  if (Number.isFinite(input.mediaDuration) && input.mediaDuration > 0 && input.mediaDuration < 86400) material.set("duration_seconds", input.mediaDuration);
  if (boundary.status === "candidate") {
    const end = Number(boundary.end), duration = Number(material.get("duration_seconds"));
    const expanded = input.transcript;
    if (!Array.isArray(expanded) || !expanded.length || expanded.length > 1000) throw new Error("expanded transcript required");
    let previous = -1;
    transcript = expanded.map((s) => {
      const start = Number(s.start), stop = Number(s.end), text = String(s.text || "").trim();
      if (!Number.isFinite(start) || !Number.isFinite(stop) || start < 0 || start < previous || stop <= start || stop > 180.05 || !text || text.length > 2000) throw new Error("invalid expanded transcript");
      previous = start; return { start, end: stop, text };
    });
    if (!Number.isFinite(end) || end < 5 || end > 180 || (duration > 0 && end > duration + .05) || !transcript.some((s) => Math.abs(s.end-end) < .01)) throw new Error("candidate must end on observed ASR evidence");
    transcript = transcript.filter((s) => s.end <= end + .01);
    coverage = { start: 0, end };
    hook.set("start_seconds", 0);
    hook.set("end_seconds", end);
    hook.set("safe_start", { status: "unverified", time: 0 });
    hook.set("safe_end", { status: "unverified", time: end, evidence: [{ source: "budgeted-opening-asr", result: String(boundary.reason || "").slice(0,1000) }] });
    hook.set("boundary_status", "unverified");
    hook.set("review_status", "needs_review");
    hook.set("evidence", { transcript, coverage });
  }
  const semantic = object(input.semantic);
  const chinese = (text) => typeof text === "string" && /[\u3400-\u9fff]/.test(text) && !/^[A-Za-z\s,.?!'"-]+$/.test(text);
  const summaryReady = input.summaryVersion === "hook-summary-zh-v1" && boundary.status === "candidate" && input.summaryCoverageEnd === boundary.end && ["summary","conflict","promise","identity"].every((k) => !semantic[k] || localizedSummary(semantic[k])) && localizedSummary(semantic.summary);
  if (summaryReady) {
    for (const [key, field] of [["summary","spoken_summary"],["conflict","conflict"],["promise","narrative_promise"]]) {
      if (typeof semantic[key] !== "string" || semantic[key].length > 1500) throw new Error("invalid semantic output");
      hook.set(field, semantic[key]);
    }
    if (Array.isArray(semantic.tags) && semantic.tags.every((v) => typeof v === "string" && v.length < 100)) hook.set("content_tags", semantic.tags.slice(0,12));
  }
  const state = { ...analysis, transcript, coverage, boundarySelection: { ...boundary, reason: chinese(boundary.reason) ? String(boundary.reason).slice(0,1000) : "候选转写证据已保存，中文判断理由待补齐；请人工复核", scanCoverageEnd: Number(input.scanCoverageEnd) || null }, boundaryResultKey: input.resultKey, tokenBudget: budget, identityConstraint: String((summaryReady ? semantic.identity : analysis.identityConstraint) || "").slice(0,2000), summaryLanguage: "zh-CN", summaryStatus: summaryReady ? "ready" : "pending", summaryCoverageEnd: summaryReady ? boundary.end : null };
  if (summaryReady) state.semanticStatus = "ready";
  else {
    state.previousOpeningSemantic = state.previousOpeningSemantic || {summary:hook.getString("spoken_summary"),conflict:hook.getString("conflict"),promise:hook.getString("narrative_promise"),identity:state.identityConstraint};
    state.semanticStatus = "pending";state.identityConstraint = "";
    hook.set("spoken_summary", "");hook.set("conflict", "");hook.set("narrative_promise", "");
  }
  state.summaryVersion = summaryReady ? input.summaryVersion : null;
  hook.set("analysis", state);
  hook.set("analysis_version", "narration-boundary-v1:" + input.resultKey.slice(0,40));
  app.save(hook);
  material.set("opening_analysis", { ...object(material.get("opening_analysis")), boundarySelection: state.boundarySelection, tokenBudget: budget, semanticStatus: state.semanticStatus });
  app.save(material);
  return { hookId: hook.id, reused: false, status: boundary.status, end: boundary.status === "candidate" ? Number(boundary.end) : null };
}
function normalizeSummaries(app,input) {
  if(!Array.isArray(input.hookIds)||input.hookIds.length>100) throw new Error("at most 100 hooks");
  let changed=0;
  for(const id of input.hookIds){
    const hook=app.findRecordById("hook_assets",String(id));
    if(hook.getString("source_class")!=="narration_opening") throw new Error("not narration");
    if(["approved","rejected"].includes(hook.getString("review_status")) || hook.getString("boundary_status")==="verified") continue;
    const analysis=object(hook.get("analysis"));
    const ready=analysis.summaryVersion==="hook-summary-zh-v1" && analysis.summaryStatus==="ready" && analysis.summaryCoverageEnd===Number(hook.get("end_seconds")) && localizedSummary(hook.getString("spoken_summary")) && [hook.getString("conflict"),hook.getString("narrative_promise"),analysis.identityConstraint].every(v=>!v||localizedSummary(v));
    if(ready) continue;
    // Keep the former value as an audit artifact, not as an apparent Chinese summary.
    analysis.previousOpeningSummary=analysis.previousOpeningSummary||hook.getString("spoken_summary");
    analysis.previousOpeningSemantic=analysis.previousOpeningSemantic||{summary:hook.getString("spoken_summary"),conflict:hook.getString("conflict"),promise:hook.getString("narrative_promise"),identity:analysis.identityConstraint};
    analysis.summaryStatus="pending";analysis.summaryLanguage="zh-CN";
    analysis.summaryVersion=null;analysis.summaryCoverageEnd=null;
    if(hook.getString("spoken_summary")) hook.set("analysis_version",hook.getString("analysis_version")+":summary-pending");
    analysis.semanticStatus="pending";analysis.identityConstraint="";
    hook.set("conflict","");hook.set("narrative_promise","");
    hook.set("spoken_summary","");hook.set("analysis",analysis);app.save(hook);
    const material=app.findRecordById("ad_materials",hook.getString("material"));
    material.set("opening_analysis",{...object(material.get("opening_analysis")),semanticStatus:"pending"});app.save(material);changed++;
  }
  return {changed};
}
module.exports = { SCHEMA, validate, importOpening, saveSemantics, saveBoundary, normalizeSummaries };
