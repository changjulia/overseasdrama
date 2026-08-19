function authorizeWorker(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!expected || supplied !== expected) throw new UnauthorizedError("Invalid analysis worker token");
}

function authorizeUi(e) {
  const origin = String(e.requestInfo().headers.origin || "");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):300[01]$/i.test(origin)) throw new ForbiddenError("Local UI only");
}

function decodeUtf8(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = Number(bytes[index++]);
    if (first < 0x80) { output += String.fromCharCode(first); continue; }
    if ((first & 0xe0) === 0xc0) {
      const second = Number(bytes[index++]);
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      const second = Number(bytes[index++]), third = Number(bytes[index++]);
      output += String.fromCharCode(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
      continue;
    }
    const second = Number(bytes[index++]), third = Number(bytes[index++]), fourth = Number(bytes[index++]);
    const codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
    const normalized = codePoint - 0x10000;
    output += String.fromCharCode(0xd800 + (normalized >> 10), 0xdc00 + (normalized & 0x3ff));
  }
  return output;
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    try { return JSON.parse(decodeUtf8(value)); } catch (_) { return fallback; }
  }
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (_) { return value; }
  }
  return value;
}

function jsonArray(record, field) {
  const value = jsonValue(record.get(field), []);
  return Array.isArray(value) ? value : [];
}

function jsonObject(record, field) {
  const value = jsonValue(record.get(field), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value == null ? null : value);
}

// Goja hooks do not expose Node's crypto module. FNV-1a is used here as a
// deterministic cache fingerprint, not as a security primitive.
function contextHash(value) {
  const input = canonicalJson(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
}

function productionGatePasses(gate, softOverride) {
  if (softOverride && softOverride.human_video_approval && softOverride.human_video_approval.overridden === true) return true;
  if (gate && gate.passed === true) return true;
  const reasons = gate && Array.isArray(gate.reasons) ? gate.reasons.map((value) => String(value).toLowerCase()) : [];
  if (!reasons.length) return false;
  const mappings = [
    { key: "story_score", tokens: ["storyscore", "story_score", "storycompleteness"] },
    { key: "understanding_cost", tokens: ["understandingcost", "understanding_cost"] },
    { key: "transition_difficulty", tokens: ["transitiondifficulty", "transition_difficulty"] }
  ];
  return reasons.every((reason) => mappings.some((mapping) => mapping.tokens.some((token) => reason.indexOf(token) >= 0) && softOverride && softOverride[mapping.key] && softOverride[mapping.key].overridden === true));
}

function rejectionReasons(item) {
  const reasons = [];
  const gate = item && (item.qualityGate || item.quality_gate || item.productionGate || item.production_gate) || {};
  const supplied = Array.isArray(gate.reasons) ? gate.reasons : Array.isArray(item && item.rejectionReasons) ? item.rejectionReasons : [];
  supplied.forEach((reason) => { const value = String(reason || "").trim(); if (value && !reasons.includes(value)) reasons.push(value); });
  const range = item && (item.timecode || item.interval || item) || {};
  const start = Number(range.start), end = Number(range.end);
  const safeStart = item && (item.safeStart || item.safe_start) || {}, safeEnd = item && (item.safeEnd || item.safe_end) || {};
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) reasons.push("invalid_media_boundary");
  else if (end - start < 10 || end - start > 60) reasons.push("duration_out_of_range");
  if (safeStart.status !== "verified" || safeEnd.status !== "verified") reasons.push("boundary_unverified");
  if (safeStart.actionStatus !== "complete" || safeEnd.actionStatus !== "complete") reasons.push("action_incomplete");
  return [...new Set(reasons)];
}

// Creates a stable UI-facing diagnosis from persisted worker records. It keeps
// execution status separate from the business outcome so "succeeded with no
// candidates" is never rendered as an indefinite loading state.
function summarizeHookMatch(job, supplementalJobs, matches) {
  const supplements = Array.isArray(supplementalJobs) ? supplementalJobs : [];
  const storyMatches = Array.isArray(matches) ? matches : [];
  const counts = { total: supplements.length, queued: 0, running: 0, succeeded: 0, failed: 0 };
  let rawCandidates = 0, editableCandidates = 0, productionCandidates = storyMatches.length;
  const reasonCounts = {};
  supplements.forEach((supplement) => {
    const status = String(supplement && supplement.status || "");
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    const root = supplement && supplement.result && supplement.result.result ? supplement.result.result : supplement && supplement.result || {};
    const highlights = Array.isArray(root.highlights) ? root.highlights : [];
    rawCandidates += highlights.length;
    highlights.forEach((item) => {
      const gate = item && (item.qualityGate || item.quality_gate) || {};
      const scores = item && (item.qualityScores || item.quality_scores) || {};
      const score = Number(scores.storyScore || scores.story_score || scores.hookScore || scores.hook_score || 0);
      if (score >= 65) editableCandidates += 1;
      rejectionReasons(item).forEach((reason) => { reasonCounts[reason] = (reasonCounts[reason] || 0) + 1; });
      if (gate.productionReady === true || gate.production_ready === true) productionCandidates += 1;
    });
  });
  const waiting = counts.queued + counts.running > 0;
  const executionStatus = String(job && job.status || "queued");
  let outcomeStatus = "ready";
  if (waiting) outcomeStatus = "waiting_supplemental";
  else if (executionStatus === "failed" && !storyMatches.length) outcomeStatus = "failed";
  else if (counts.failed > 0 || (executionStatus === "failed" && storyMatches.length)) outcomeStatus = "partial";
  else if (executionStatus === "succeeded" && !storyMatches.length) outcomeStatus = "no_candidates";
  return {
    outcome_status: outcomeStatus,
    funnel: {
      episodes_requested: Array.isArray(job && job.episode_scope) ? job.episode_scope.length : 0,
      supplemental_jobs: counts,
      raw_candidates: rawCandidates,
      editable_candidates: editableCandidates,
      production_candidates: productionCandidates,
      story_matches: storyMatches.length
    },
    rejection_reasons: Object.keys(reasonCounts).map((code) => ({ code, count: reasonCounts[code] })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    incomplete: waiting || counts.failed > 0 || executionStatus === "failed"
  };
}

module.exports = { authorizeWorker, authorizeUi, jsonValue, jsonArray, jsonObject, canonicalJson, contextHash, productionGatePasses, rejectionReasons, summarizeHookMatch };
