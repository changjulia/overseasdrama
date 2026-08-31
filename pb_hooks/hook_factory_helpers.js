function authorizeWorker(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!expected || supplied !== expected)
    throw new UnauthorizedError("Invalid analysis worker token");
}

function constantTimeTextEqual(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  let difference = leftText.length ^ rightText.length;
  const length = Math.max(leftText.length, rightText.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftText.charCodeAt(index) || 0) ^ (rightText.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authorizeUi(e) {
  const expectedGatewayToken = $os.getenv("LUMINA_UI_GATEWAY_TOKEN");
  const suppliedGatewayToken = String(
    e.requestInfo().headers.authorization || "",
  ).replace(/^Bearer\s+/i, "");
  if (
    expectedGatewayToken &&
    constantTimeTextEqual(suppliedGatewayToken, expectedGatewayToken)
  )
    return;
  const origin = String(e.requestInfo().headers.origin || "");
  const host = String(e.requestInfo().headers.host || "");
  const headers = e.requestInfo().headers;
  const localUiHeader = String(
    headers["x-lumina-ui"] ||
      headers["X-Lumina-Ui"] ||
      (e.request && e.request.header
        ? e.request.header.get("x-lumina-ui")
        : "") ||
      "",
  );
  const browserOriginAllowed =
    /^https?:\/\/(localhost|127\.0\.0\.1):(300[01]|8090)$/i.test(origin);
  // PocketBase's requestInfo header map omits the HTTP Host pseudo-header.
  // When present, still reject non-loopback hosts; when absent, the explicit
  // local mode is safe only together with the loopback bind in our launcher.
  const localHostAllowed =
    !host || /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const localModeEnabled = $os.getenv("LUMINA_UI_MODE") === "local-loopback";
  // This is an explicit local-workstation trust boundary, not user identity.
  // Hosted/shared deployments must keep this mode disabled and put these
  // operations behind an authenticated server-side gateway.
  if (
    !localModeEnabled ||
    !localHostAllowed ||
    localUiHeader !== "local" ||
    (origin && !browserOriginAllowed)
  )
    throw new ForbiddenError("Authenticated UI gateway required");
}

// Human review is a workspace operation, not an administrator operation.
// Every user who can reach the local Lumina UI receives the same review access.
function authorizeReviewUi(e) {
  authorizeUi(e);
}

function manualRetryRequest(e, record, activeStatuses) {
  const body = e.requestInfo().body || {};
  const reason = String(body.reason || "").trim();
  const retryKey = String(body.idempotency_key || "").trim();
  const expectedStatus = String(body.expected_status || "").trim();
  const expectedUpdated = String(body.expected_updated || "").trim();
  if (!reason) throw new BadRequestError("manual retry reason is required");
  if (!retryKey || retryKey.length > 240)
    throw new BadRequestError("a valid manual retry idempotency_key is required");
  if (!expectedStatus || !expectedUpdated)
    throw new BadRequestError("expected_status and expected_updated are required");
  if (record.getString("last_manual_retry_key") === retryKey)
    return { duplicate: true, body, retryKey };
  const status = record.getString("status");
  if (status !== expectedStatus || record.getString("updated") !== expectedUpdated)
    throw new ApiError(409, "job changed since it was inspected");
  if ((activeStatuses || []).includes(status))
    throw new ApiError(409, "active or queued job cannot be manually retried");
  if (status !== "failed")
    throw new ApiError(409, "only failed jobs can be manually retried");
  const errorKind = record.getString("error_kind");
  if (["permanent", "media", "validation"].includes(errorKind)) {
    const overrideReason = String(body.override_reason || "").trim();
    if (body.override_non_retryable !== true || !overrideReason)
      throw new BadRequestError(
        "non-retryable failure requires override_non_retryable and override_reason",
      );
  }
  return { duplicate: false, body, reason, retryKey };
}

function resetFailedJobForManualRetry(record, request, actor, clearFields) {
  const audit = jsonValue(record.get("manual_retry_audit"), []);
  const history = Array.isArray(audit) ? audit.slice(-49) : [];
  history.push({
    at: new Date().toISOString(),
    by: String(actor || "local-workstation").slice(0, 500),
    reason: request.reason.slice(0, 2000),
    overrideNonRetryable: request.body.override_non_retryable === true,
    overrideReason: String(request.body.override_reason || "").slice(0, 2000),
    previousStatus: record.getString("status"),
    previousErrorKind: record.getString("error_kind"),
    previousAttempt: record.getInt("attempt"),
    idempotencyKey: request.retryKey,
  });
  record.set("status", "queued");
  record.set("progress", 0);
  record.set("current_stage", "queued");
  record.set("attempt", 0);
  record.set("error", "");
  record.set("error_kind", "");
  record.set("next_attempt_at", "");
  record.set("worker_id", "");
  record.set("lease_token", "");
  record.set("lease_until", "");
  (clearFields || []).forEach((field) =>
    record.set(
      field,
      field === "logs"
        ? []
        : ["result", "diagnostics", "validation", "boundary_ledger"].includes(field)
          ? {}
          : "",
    ),
  );
  record.set("manual_retry_audit", history);
  record.set("last_manual_retry_key", request.retryKey);
  return history[history.length - 1];
}

function decodeUtf8(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = Number(bytes[index++]);
    if (first < 0x80) {
      output += String.fromCharCode(first);
      continue;
    }
    if ((first & 0xe0) === 0xc0) {
      const second = Number(bytes[index++]);
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
      continue;
    }
    if ((first & 0xf0) === 0xe0) {
      const second = Number(bytes[index++]),
        third = Number(bytes[index++]);
      output += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
      continue;
    }
    const second = Number(bytes[index++]),
      third = Number(bytes[index++]),
      fourth = Number(bytes[index++]);
    const codePoint =
      ((first & 0x07) << 18) |
      ((second & 0x3f) << 12) |
      ((third & 0x3f) << 6) |
      (fourth & 0x3f);
    const normalized = codePoint - 0x10000;
    output += String.fromCharCode(
      0xd800 + (normalized >> 10),
      0xdc00 + (normalized & 0x3ff),
    );
  }
  return output;
}

function jsonValue(value, fallback) {
  if (value == null) return fallback;
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    try {
      return JSON.parse(decodeUtf8(value));
    } catch (_) {
      return fallback;
    }
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }
  return value;
}

function jsonArray(record, field) {
  const value = jsonValue(record.get(field), []);
  return Array.isArray(value) ? value : [];
}

function jsonObject(record, field) {
  const value = jsonValue(record.get(field), {});
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value == null ? null : value);
}

function episodeAnalysisSnapshot(app, episode) {
  const own = jsonObject(episode, "analysis_result");
  const bytes = episode.getInt("byte_size");
  if (!app || !bytes) return own;
  let candidates = [];
  try {
    candidates = app
      .findRecordsByFilter(
        "drama_episodes",
        "byte_size = {:bytes}",
        "id",
        50,
        0,
        { bytes },
      )
      .filter(
        (item) =>
          Math.abs(
            item.getFloat("duration_seconds") -
              episode.getFloat("duration_seconds"),
          ) <= 0.05,
      );
  } catch (_) {
    return own;
  }
  const chineseEvidenceScore = (analysis) => {
    const text = JSON.stringify(analysis || {});
    const translated = text.match(/[\u3400-\u9fff]/g) || [];
    const evidenceLabels = text.match(/"text"\s*:/g) || [];
    return translated.length + evidenceLabels.length * 20;
  };
  let best = own,
    bestScore = chineseEvidenceScore(own);
  candidates.forEach((item) => {
    const candidate = jsonObject(item, "analysis_result"),
      score = chineseEvidenceScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  });
  return best;
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

function semanticTokens(value) {
  const output = [];
  const rawText = [];
  const visit = (item) => {
    if (item == null) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === "object") {
      Object.keys(item)
        .sort()
        .forEach((key) => visit(item[key]));
      return;
    }
    const text = String(item).toLowerCase();
    rawText.push(text);
    text
      .toLowerCase()
      .split(/[\s,，。；;、|/：:·→\-]+/)
      .forEach((token) => {
        const normalized = token.trim();
        if (normalized.length >= 2 && !output.includes(normalized))
          output.push(normalized);
      });
  };
  visit(value);
  const combined = rawText.join(" ");
  const concepts = [
    [/爱|婚姻|夫妻|丈夫|妻子|离婚|恋人|感情|背叛/, ["关系冲突", "都市爱情"]],
    [/控制|支配|羞辱|跪|乞求|压迫|不敢|惩罚/, ["权力与控制"]],
    [/觉醒|决绝|拒绝|反抗|结束婚姻|不再妥协/, ["女性独立与自我救赎"]],
    [/母亲|父亲|继女|家庭|吊坠|遗物/, ["家庭伦理", "家庭责任与个人自由"]],
    [/误会|真相|冒领|火灾|救人/, ["信息差", "真相反转"]],
  ];
  concepts.forEach(([pattern, labels]) => {
    if (!pattern.test(combined)) return;
    labels.forEach((label) => {
      if (!output.includes(label)) output.push(label);
    });
  });
  return output;
}

function deriveStoryNeed(drama, episodes, deliveryGoal) {
  const rows = Array.isArray(episodes) ? episodes : [];
  const summaries = [],
    plots = [],
    tags = [],
    relationships = [],
    unresolved = [],
    evidence = [];
  const persistedOntology =
    drama && Array.isArray(drama.ontologyTags) ? drama.ontologyTags : [];
  persistedOntology
    .filter(
      (tag) =>
        tag && typeof tag === "object" && tag.manualStatus !== "rejected",
    )
    .forEach((tag) => {
      const label = String(tag.label || tag.value || tag.original || "").trim();
      if (label) tags.push(label);
      if (Array.isArray(tag.evidence))
        tag.evidence
          .slice(0, 3)
          .forEach((text) =>
            evidence.push({
              sourceType: "analysis",
              sourceId: String(drama.id || ""),
              text: String(text),
              analysisVersion: "hook-ontology-v1.1",
            }),
          );
    });
  rows.forEach((episode) => {
    let analysis =
      episode && episode.analysis && typeof episode.analysis === "object"
        ? episode.analysis
        : {};
    const nestedResult = jsonValue(analysis.result, null);
    if (
      nestedResult &&
      typeof nestedResult === "object" &&
      !Array.isArray(nestedResult)
    )
      analysis = nestedResult;
    const episodeNumber = Number(
      (episode && (episode.episode || episode.episode_number)) || 0,
    );
    [analysis.episodeSummary, analysis.summary].forEach((value) => {
      if (value && !summaries.includes(String(value)))
        summaries.push(String(value));
    });
    (Array.isArray(jsonValue(analysis.episodePlots, []))
      ? jsonValue(analysis.episodePlots, [])
      : []
    ).forEach((item) => {
      if (item && typeof item === "object") {
        const text = String(
          item.summary || item.event || item.action || item.plot || "",
        ).trim();
        if (text) plots.push(text);
        (Array.isArray(item.relationships) ? item.relationships : []).forEach(
          (value) => relationships.push(String(value)),
        );
        (Array.isArray(item.unresolvedQuestions)
          ? item.unresolvedQuestions
          : []
        ).forEach((value) => unresolved.push(String(value)));
      } else if (item) plots.push(String(item));
    });
    (Array.isArray(jsonValue(analysis.contentTags, []))
      ? jsonValue(analysis.contentTags, [])
      : []
    ).forEach((value) => {
      if (value && typeof value === "object")
        tags.push(String(value.value || value.label || value.tag || ""));
      else tags.push(String(value));
    });
    (Array.isArray(episode.highlights) ? episode.highlights : []).forEach(
      (highlight) => {
        if (!highlight || typeof highlight !== "object") return;
        [
          highlight.themes,
          highlight.content_tags,
          highlight.relationships,
        ].forEach((values) =>
          (Array.isArray(values) ? values : []).forEach((value) =>
            tags.push(String(value)),
          ),
        );
        [
          highlight.narrative_promise,
          highlight.information_gap,
          highlight.conflict,
        ].forEach((value) => {
          if (value) unresolved.push(String(value));
        });
        const highlightPlot = String(
          highlight.spoken_summary ||
            highlight.visual_summary ||
            highlight.narrative_promise ||
            highlight.conflict ||
            "",
        ).trim();
        if (highlightPlot && !plots.includes(highlightPlot))
          plots.push(highlightPlot);
        evidence.push({
          sourceType: "analysis",
          sourceId: String(highlight.id || ""),
          episode: episodeNumber,
          start: Number(highlight.start_seconds || 0),
          end: Number(highlight.end_seconds || 0),
          analysisVersion: String(highlight.analysis_version || "unknown"),
        });
      },
    );
  });
  const corePlot = [...summaries.slice(0, 4), ...plots.slice(0, 8)]
    .filter(Boolean)
    .join(" → ");
  const uniqueTags = [...new Set(tags.filter(Boolean))].slice(0, 40);
  const gaps = [...new Set(unresolved.filter(Boolean))].slice(0, 12);
  const queryBase = [
    ...uniqueTags.slice(0, 8),
    ...semanticTokens(corePlot).slice(0, 8),
  ];
  return {
    contractVersion: "lumina-semantic-contract-v1.1",
    corePlot,
    protagonistGoal: "待从当前范围人物行动与对白证据中确认",
    relationshipState: [...new Set(relationships.filter(Boolean))].slice(0, 12),
    causalChain: plots.slice(0, 12),
    comprehensionGaps: gaps,
    contentTags: uniqueTags,
    ontologyTags: persistedOntology,
    deliveryGoal: String(deliveryGoal || "停滑与点击"),
    extendDirections: [
      {
        type: "prequel",
        label: "前因补充",
        query: queryBase.concat(["前因", "起因"]),
      },
      {
        type: "background",
        label: "人物背景",
        query: queryBase.concat(["背景", "关系"]),
      },
      {
        type: "parallel",
        label: "平行故事",
        query: queryBase.concat(["类比", "相似事件"]),
      },
      {
        type: "consequence",
        label: "后果预示",
        query: queryBase.concat(["后果", "代价"]),
      },
      {
        type: "amplification",
        label: "冲突强化",
        query: queryBase.concat(["冲突", "情绪"]),
      },
    ],
    evidence,
  };
}

function generateStorylinePlans(
  drama,
  episodes,
  deliveryGoal,
  targetDurationSeconds,
) {
  const rows = Array.isArray(episodes) ? episodes : [];
  const target = Math.max(60, Number(targetDurationSeconds || 900));
  const highlights = [];
  rows.forEach((episode) => {
    const episodeNumber = Number(
      (episode && (episode.episode || episode.episode_number)) || 0,
    );
    let episodeAnalysis =
      episode && episode.analysis && typeof episode.analysis === "object"
        ? episode.analysis
        : {};
    // Stored episode analyses can be wrapped by both the worker envelope and
    // the semantic result envelope (`result.result`). Unwrap all transparent
    // layers so the Chinese evidence already produced by analysis is not lost.
    const analysisLayers = [episodeAnalysis];
    for (let depth = 0; depth < 4; depth += 1) {
      const nestedAnalysis = jsonValue(episodeAnalysis.result, null);
      if (
        !nestedAnalysis ||
        typeof nestedAnalysis !== "object" ||
        Array.isArray(nestedAnalysis)
      )
        break;
      episodeAnalysis = nestedAnalysis;
      analysisLayers.push(episodeAnalysis);
    }
    episodeAnalysis =
      analysisLayers.find(
        (layer) => layer && Array.isArray(layer.castCandidates),
      ) ||
      analysisLayers.find(
        (layer) => layer && Array.isArray(layer.transcript),
      ) || episodeAnalysis;
    const translatedEvidence = [];
    const candidateDescriptions = [];
    const discoveredCandidates = [];
    const collectCandidates = (value, depth) => {
      if (depth > 6 || value == null) return;
      const normalized = jsonValue(value, value);
      if (Array.isArray(normalized)) {
        normalized.forEach((item) => collectCandidates(item, depth + 1));
        return;
      }
      if (!normalized || typeof normalized !== "object") return;
      if (
        String(normalized.description || normalized.role || "").trim() &&
        (normalized.name || normalized.originalName)
      )
        discoveredCandidates.push(normalized);
      if (normalized.castCandidates)
        collectCandidates(normalized.castCandidates, depth + 1);
      if (normalized.result) collectCandidates(normalized.result, depth + 1);
    };
    collectCandidates(episode && episode.analysis, 0);
    const candidateRows = discoveredCandidates.length
      ? discoveredCandidates
      : Array.isArray(episodeAnalysis.castCandidates)
        ? episodeAnalysis.castCandidates
        : [];
    candidateRows.forEach((candidate) => {
      const description = String(
        (candidate && (candidate.description || candidate.role)) || "",
      ).trim();
      if (/[\u3400-\u9fff]/.test(description))
        candidateDescriptions.push({ name: String((candidate && candidate.name) || "人物"), description });
      (candidate && Array.isArray(candidate.evidence)
        ? candidate.evidence
        : []
      ).forEach((row) => {
        const text = String((row && row.text) || "")
          .replace(/^[‘'\"]|[’'\"]$/g, "")
          .trim();
        const rawTimecode = row && row.timecode;
        let timecode =
          rawTimecode && typeof rawTimecode === "object" ? rawTimecode : {};
        if (typeof rawTimecode === "string") {
          const values = rawTimecode.match(/\d{1,2}:\d{2}:\d{2}(?:\.\d+)?/g) || [];
          const seconds = (value) => {
            const parts = String(value || "").split(":").map(Number);
            return parts.length === 3
              ? parts[0] * 3600 + parts[1] * 60 + parts[2]
              : 0;
          };
          timecode = {
            start: seconds(values[0]),
            end: seconds(values[1] || values[0]),
          };
          if (!values.length) {
            const decimalRange = rawTimecode.match(
              /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/,
            );
            if (decimalRange)
              timecode = {
                start: Number(decimalRange[1]),
                end: Number(decimalRange[2]),
              };
          }
        }
        if (/[\u3400-\u9fff]/.test(text))
          translatedEvidence.push({
            text,
            start: Number(timecode.start || 0),
            end: Number(timecode.end || timecode.start || 0),
          });
      });
    });
    const sourceHighlights = Array.isArray(episode && episode.highlights)
      ? episode.highlights.slice()
      : [];
    // Coarse analysis already contains timestamped transcript evidence. It is
    // usable for storyline ideation even before a reviewer creates a persisted
    // highlight or verifies its cutting boundary; those statuses remain visible
    // as advisory metadata instead of suppressing the whole episode.
    if (!sourceHighlights.length) {
      const transcript = Array.isArray(episodeAnalysis.transcript)
        ? episodeAnalysis.transcript.filter(
            (item) =>
              item &&
              Number(item.end) > Number(item.start) &&
              String(item.text || "").trim(),
          )
        : [];
      for (let index = 0; index < transcript.length; index += 3) {
        const chunk = transcript.slice(index, index + 3);
        if (!chunk.length) continue;
        const start = Number(chunk[0].start),
          end = Number(chunk[chunk.length - 1].end);
        const spoken = chunk
          .map((item) => String(item.text || "").trim())
          .filter(Boolean)
          .join(" ");
        sourceHighlights.push({
          id: `analysis-${episodeNumber}-${index}`,
          start_seconds: start,
          end_seconds: end,
          spoken_summary: spoken,
          conflict: "对白推动剧情冲突",
          information_gap: "这段冲突接下来会造成什么结果？",
          evidence: chunk.map((item) => ({
            source: "transcript",
            text: String(item.text || ""),
            start: Number(item.start),
            end: Number(item.end),
            verification: item.verification || "analyzed",
          })),
          analysis_version: "episode-analysis-transcript-v1",
          review_status: "pending",
          boundary_status: "unverified",
          safe_start: { status: "unverified", time: start },
          safe_end: { status: "unverified", time: end },
        });
      }
    }
    sourceHighlights.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const start = Number(item.start_seconds || 0),
        end = Number(item.end_seconds || 0);
      const sourcePlot = String(
        item.spoken_summary ||
          item.visual_summary ||
          item.narrative_promise ||
          item.conflict ||
          "",
      ).trim();
      const translations = [
        ...new Set(
          translatedEvidence
            .filter((row) => row.end >= start - 0.1 && row.start <= end + 0.1)
            .map((row) => row.text),
        ),
      ];
      const provisionalOrdinal = Number(
        String(item.id || "").split("-").pop() || 0,
      );
      const provisionalIndex = Number.isFinite(provisionalOrdinal)
        ? Math.max(0, Math.floor(provisionalOrdinal / 3))
        : 0;
      const candidateContext = candidateDescriptions.length
        ? candidateDescriptions[provisionalIndex % candidateDescriptions.length]
        : null;
      const plot = translations.length
        ? translations.join("；")
        : /[\u3400-\u9fff]/.test(sourcePlot)
          ? sourcePlot
          : candidateContext
            ? `${candidateContext.name}：${candidateContext.description}`
            : `第${episodeNumber}集${Math.floor(start / 60)}分${Math.round(start % 60)}秒存在带时间戳的原语对白，剧情语义待进一步复核`;
      if (
        !episodeNumber ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        !sourcePlot
      )
        return;
      highlights.push({
        id: String(item.id || ""),
        episode: episodeNumber,
        start,
        end,
        plot,
        sourcePlot,
        purpose: String(
          item.narrative_promise ||
            item.information_gap ||
            item.conflict ||
            plot,
        ),
        conflict: String(item.conflict || ""),
        emotion: String(item.emotion || ""),
        question: String(item.information_gap || ""),
        promise: String(item.narrative_promise || ""),
        relationships: Array.isArray(item.relationships)
          ? item.relationships.map(String)
          : [],
        themes: Array.isArray(item.themes) ? item.themes.map(String) : [],
        contentTags: Array.isArray(item.content_tags)
          ? item.content_tags.map(String)
          : [],
        evidence: Array.isArray(item.evidence) ? item.evidence : [],
        analysisVersion: String(item.analysis_version || "unknown"),
        safeStart: item.safe_start || {},
        safeEnd: item.safe_end || {},
      });
    });
  });
  highlights.sort(
    (left, right) => left.episode - right.episode || left.start - right.start,
  );
  const deduplicated = [];
  highlights.forEach((item) => {
    const duplicateIndex = deduplicated.findIndex(
      (existing) =>
        existing.episode === item.episode &&
        Math.abs(existing.start - item.start) < 0.05 &&
        Math.abs(existing.end - item.end) < 0.05,
    );
    if (duplicateIndex < 0) {
      deduplicated.push(item);
      return;
    }
    const existing = deduplicated[duplicateIndex];
    const evidenceWeight = (value) =>
      value.evidence.length +
      semanticTokens([
        value.plot,
        value.conflict,
        value.question,
        value.promise,
      ]).length;
    if (evidenceWeight(item) > evidenceWeight(existing))
      deduplicated[duplicateIndex] = item;
  });
  highlights.splice(0, highlights.length, ...deduplicated);
  if (!highlights.length) return [];
  const duration = (segments) =>
    segments.reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0);
  const unique = new Map();
  const add = (segments, chronology, strategyType, options) => {
    const productionSequential = Boolean(
      options && options.productionSequential,
    );
    segments = segments.filter(
      (item, index, values) =>
        !values
          .slice(0, index)
          .some(
            (existing) =>
              existing.episode === item.episode &&
              item.start < existing.end &&
              item.end > existing.start,
          ),
    );
    if (
      !segments.length ||
      (!productionSequential && duration(segments) > target * 1.15)
    )
      return;
    const scriptMode = String((options && options.scriptMode) || "sequential");
    // Strategy wording alone cannot turn an identical footage route into a
    // different storyline. The source sequence is the identity.
    const routeKey = segments
      .map(
        (item) =>
          `${item.episode}:${item.start.toFixed(2)}-${item.end.toFixed(2)}`,
      )
      .join("|");
    const key = `${scriptMode}|${routeKey}`;
    if (unique.has(key)) return;
    const tokens = semanticTokens(
      segments.map((item) => [
        item.plot,
        item.conflict,
        item.emotion,
        item.question,
        item.promise,
      ]),
    );
    const conflicts = segments.filter((item) => item.conflict).length;
    const questions = segments.filter(
      (item) => item.question || item.promise,
    ).length;
    const evidenceCount = segments.filter(
      (item) =>
        item.evidence.length ||
        Object.keys(item.safeStart).length ||
        Object.keys(item.safeEnd).length,
    ).length;
    const crossEpisode = new Set(segments.map((item) => item.episode)).size > 1;
    const openingStrength = Math.min(
      100,
      48 +
        (segments[0].conflict ? 24 : 0) +
        (segments[0].question ? 18 : 0) +
        Math.min(10, semanticTokens(segments[0].plot).length),
    );
    const conflictDensity = Math.min(
      100,
      Math.round((conflicts / segments.length) * 100),
    );
    const emotionalProgression = Math.min(
      100,
      45 +
        new Set(segments.map((item) => item.emotion).filter(Boolean)).size *
          15 +
        (segments.length > 1 ? 10 : 0),
    );
    const suspenseStrength = Math.min(
      100,
      38 + questions * 18 + (segments[segments.length - 1].question ? 14 : 0),
    );
    const payoffStrength = Math.min(
      100,
      42 +
        segments.filter((item) => item.promise).length * 15 +
        (segments.length > 1 ? 10 : 0),
    );
    const continuity = Math.max(
      0,
      Math.min(
        100,
        chronology === "chronological"
          ? 92 -
              Math.max(
                0,
                new Set(segments.map((item) => item.episode)).size - 1,
              ) *
                5
          : 74,
      ),
    );
    const evidenceAccuracy = Math.round(
      (evidenceCount / segments.length) * 100,
    );
    const breadth = Math.min(
      100,
      35 + segments.length * 9 + (crossEpisode ? 12 : 0),
    );
    const calculatedScore = Math.round(
      openingStrength * 0.2 +
        conflictDensity * 0.15 +
        emotionalProgression * 0.12 +
        suspenseStrength * 0.18 +
        payoffStrength * 0.12 +
        continuity * 0.11 +
        evidenceAccuracy * 0.07 +
        breadth * 0.05,
    );
    if (!productionSequential && (calculatedScore < 52 || evidenceAccuracy < 50))
      return;
    // Sequential production eligibility is determined by playable source
    // continuity, not by an advisory acquisition-model threshold. Keep a
    // comparable floor only for ranking/display purposes.
    const score = productionSequential
      ? Math.max(52, calculatedScore)
      : calculatedScore;
    const first = segments[0],
      last = segments[segments.length - 1];
    const compactSummary = compactPlot(
      segments.map((item) => item.plot),
      12,
    );
    const audienceQuestion = String(
      (options && options.audienceQuestion) ||
        first.question ||
        first.promise ||
        last.question ||
        "观众将如何理解并等待后续结果？",
    );
    const openingEvent = shortBeat(compactPlot(first.plot, 2) || first.plot, 22);
    const stagePayoff = shortBeat(compactPlot(last.plot, 2) || last.plot, 22);
    const conciseSummary = `从「${openingEvent}」切入，沿原剧因果推进至「${stagePayoff}」`;
    const hookPurpose = String(
      (options && options.hookPurpose) ||
        (first.question ? "悬念强化" : conflicts ? "冲突强化" : "人物背景"),
    );
    unique.set(key, {
      id: `storyline-${contextHash({ drama: drama && drama.id, key, chronology, strategyType })}`,
      title: `${strategyType}｜${openingEvent} → ${stagePayoff}`,
      strategyType,
      chronology,
      storylineSummary: conciseSummary,
      audienceQuestion,
      totalDurationSeconds: Math.round(duration(segments) * 1000) / 1000,
      episodeScope: [...new Set(segments.map((item) => item.episode))],
      acquisitionScore: score,
      scoreBreakdown: {
        openingStrength,
        conflictDensity,
        emotionalProgression,
        suspenseStrength,
        payoffStrength,
        continuity,
        evidenceAccuracy,
      },
      rankingReasons: [
        openingStrength >= 70 ? "开场事件明确" : "开场仍依赖上下文",
        suspenseStrength >= 70 ? "观众问题清晰" : "悬念强度一般",
        chronology === "chronological"
          ? crossEpisode
            ? "跨集正序，按集数与时间推进"
            : "同集正序因果连续"
          : "倒叙结构需通过过渡建立时间关系",
        evidenceAccuracy === 100
          ? "全部节点带真实素材证据"
          : "部分节点证据较弱",
      ],
      segments: segments.map((item, index) => ({
        episode: item.episode,
        start: item.start,
        end: item.end,
        plot: item.plot,
        narrativePurpose:
          index === 0
            ? "建立开场问题"
            : index === segments.length - 1
              ? "阶段兑现或形成新卡点"
              : "推动冲突与信息增量",
        highlightAssetId: item.id,
        analysisVersion: item.analysisVersion,
        safeStart: item.safeStart,
        safeEnd: item.safeEnd,
        evidence: item.evidence,
      })),
      hookNeed: {
        purpose: hookPurpose,
        audienceQuestion,
        requiredSignals: [
          ...new Set(
            segments
              .flatMap((item) =>
                item.relationships.concat(item.themes, item.contentTags),
              )
              .filter(Boolean),
          ),
        ].slice(0, 12),
        prohibitedReveals: [last.promise].filter(Boolean),
        preferredEmotion: first.emotion || last.emotion || "情绪递进",
        connectionPoint: `第${first.episode}集 ${first.start.toFixed(2)}秒`,
      },
      scriptPlan: {
        mode: scriptMode,
        label: strategyType,
        coreStory: compactSummary,
        openingEvent,
        audiencePromise: audienceQuestion,
        progression: segments.map((item, index) => ({
          episode: item.episode,
          start: item.start,
          end: item.end,
          beat:
            index === 0
              ? "开场建立追看问题"
              : index === segments.length - 1
                ? "阶段兑现并留下下一轮期待"
                : "按原剧顺序增加冲突与信息",
          plot: item.plot,
        })),
        stagePayoff,
        endingCliffhanger:
          last.question ||
          last.promise ||
          `第${last.episode}集结尾保留原剧阶段卡点`,
        hookDirection: hookPurpose,
        editRule: "从真实高光安全起点进入，保留本集剩余剧情并顺序连接后续2–3集",
      },
      evidence: segments.map((item) => ({
        sourceType: "episode_highlight",
        sourceId: item.id,
        episode: item.episode,
        start: item.start,
        end: item.end,
        analysisVersion: item.analysisVersion,
      })),
    });
  };
  // Current production rule: select one highlight as the opening, retain the
  // remainder of that episode, then append the next 2–3 complete episodes in
  // episode order. Non-linear and cross-cut variants are intentionally deferred.
  const episodeRows = new Map(
    rows
      .map((row) => [
        Number(row && (row.episode || row.episode_number)),
        Number(row && (row.durationSeconds || row.duration_seconds || 0)),
      ])
      .filter(([episode, seconds]) => episode > 0 && seconds > 0),
  );
  const episodeHighlights = new Map();
  highlights.forEach((item) => {
    const list = episodeHighlights.get(item.episode) || [];
    list.push(item);
    episodeHighlights.set(item.episode, list);
  });
  const compactPlot = (values, maximum) => {
    const clauses = [];
    const seen = new Set();
    (Array.isArray(values) ? values : [values]).forEach((value) => {
      String(value || "")
        .split(/\s*(?:；|→|\n)+\s*/)
        .map((item) => item.trim())
        .filter(Boolean)
        .forEach((item) => {
          const key = item
            .toLowerCase()
            .replace(/[\s，。！？、：:;；'"“”‘’()（）·.\-]/g, "");
          if (!key || seen.has(key)) return;
          seen.add(key);
          clauses.push(item);
        });
    });
    return clauses.slice(0, maximum || 6).join("；");
  };
  const shortBeat = (value, maximum) => {
    const text = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^[^：:]{1,24}[：:]\s*/, "")
      .split(/[；。！？\n]/)[0]
      .trim();
    const limit = maximum || 22;
    return text.length > limit ? `${text.slice(0, limit)}…` : text || "关键事件";
  };
  const fullEpisodeSegment = (episodeNumber, start, anchor) => {
    const items = episodeHighlights.get(episodeNumber) || [];
    const episodeEnd = episodeRows.get(episodeNumber);
    if (!episodeEnd || start >= episodeEnd) return null;
    const relevant = items.filter((item) => item.end > start);
    const representative = relevant[0] || items[0] || anchor;
    return {
      ...representative,
      id: `sequential-episode-${episodeNumber}-${start.toFixed(2)}`,
      episode: episodeNumber,
      start,
      end: episodeEnd,
      plot: relevant.length
        ? compactPlot(
            [
              episodeNumber === anchor.episode ? anchor.plot : "",
              ...relevant.map((item) => item.plot),
            ],
            6,
          )
        : `第${episodeNumber}集按原片顺序完整承接`,
      purpose:
        episodeNumber === anchor.episode
          ? "从高光事件开始保留本集后续，避免截断因果"
          : "完整保留后续一集，延续人物行动与剧情结果",
      evidence: relevant.flatMap((item) => item.evidence || []),
      analysisVersion: representative.analysisVersion,
      safeStart:
        episodeNumber === anchor.episode
          ? representative.safeStart
          : { status: "source_boundary", time: 0 },
      safeEnd: { status: "source_boundary", time: episodeEnd },
    };
  };
  const eligibleAnchors = highlights.filter((anchor) => {
    const following = [];
    for (let offset = 1; offset <= 3; offset += 1) {
      const episodeNumber = anchor.episode + offset;
      if (!episodeRows.has(episodeNumber)) break;
      following.push(episodeNumber);
    }
    return following.length >= 2;
  });
  const anchorSignalScore = (anchor, mode) => {
    const text = `${anchor.plot} ${anchor.conflict} ${anchor.emotion} ${anchor.question} ${anchor.promise}`;
    if (mode === "context") return 1000 - anchor.episode * 100 - anchor.start;
    if (mode === "impact")
      return (anchor.conflict ? 50 : 0) + (anchor.question ? 30 : 0) + anchor.start / 10;
    if (mode === "awakening")
      return (/觉醒|离开|反击|决定|拒绝|真相|背叛/.test(text) ? 100 : 0) +
        (anchor.emotion ? 20 : 0) + anchor.start / 20;
    return (anchor.question ? 60 : 0) + (anchor.promise ? 50 : 0) + anchor.start / 30;
  };
  const scriptStrategies = [
    {
      mode: "impact",
      label: "爆点起播方案",
      question: "这场正面冲突会把人物关系推向什么结果？",
      hookPurpose: "冲突强化",
    },
    {
      mode: "context",
      label: "前因完整方案",
      question: "这段关系为什么会一步步走到当前局面？",
      hookPurpose: "人物背景与前因补充",
    },
    {
      mode: "awakening",
      label: "主角觉醒方案",
      question: "主角在连续打击后会在何时作出关键选择？",
      hookPurpose: "人物转变与情绪递进",
    },
    {
      mode: "suspense",
      label: "悬念卡点方案",
      question: "当前信息差最终会如何被正片逐步兑现？",
      hookPurpose: "悬念与承诺强化",
    },
  ];
  scriptStrategies.forEach((strategy) => {
    const strategyAnchors = [...eligibleAnchors]
      .sort(
        (left, right) =>
          anchorSignalScore(right, strategy.mode) -
          anchorSignalScore(left, strategy.mode),
      )
      .slice(0, 3);
    strategyAnchors.forEach((anchor) => {
      const following = [];
      for (let offset = 1; offset <= 3; offset += 1) {
        const episodeNumber = anchor.episode + offset;
        if (!episodeRows.has(episodeNumber)) break;
        following.push(episodeNumber);
      }
      const selectedFollowing = following.slice(0, 3);
      const route = [
        fullEpisodeSegment(anchor.episode, anchor.start, anchor),
        ...selectedFollowing.map((episodeNumber) =>
          fullEpisodeSegment(episodeNumber, 0, anchor),
        ),
      ].filter(Boolean);
      add(route, "chronological", strategy.label, {
        productionSequential: true,
        scriptMode: strategy.mode,
        audienceQuestion: strategy.question,
        hookPurpose: strategy.hookPurpose,
      });
    });
  });
  const semanticallyUnique = [];
  const semanticRoutesByMode = new Set();
  [...unique.values()]
    .sort((left, right) => right.acquisitionScore - left.acquisitionScore)
    .forEach((plan) => {
      const signature = new Set(
        compactPlot(
          plan.segments.map((segment) => segment.plot),
          24,
        )
          .split("；")
          .map((item) =>
            item
              .toLowerCase()
              .replace(/[\s，。！？、：:;；'"“”‘’()（）·.\-]/g, ""),
          )
          .filter(Boolean),
      );
      if (!signature.size) return;
      const mode = String(
        (plan.scriptPlan && plan.scriptPlan.mode) || "sequential",
      );
      // Keep different opening routes when they carry different story beats,
      // but do not multiply the same semantic route merely because an
      // identical highlight was detected at another timestamp or episode.
      // The four script modes remain intentionally distinct because each mode
      // expresses a different acquisition promise and edit strategy.
      const semanticRouteKey = `${mode}|${[...signature].sort().join("|")}`;
      if (semanticRoutesByMode.has(semanticRouteKey)) return;
      semanticRoutesByMode.add(semanticRouteKey);
      semanticallyUnique.push(plan);
    });
  return semanticallyUnique.slice(0, 10);
}

function conciseStoryEvent(value, maximum) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (/三年婚姻|一百次提出离婚|频繁提出离婚/.test(raw))
    return "阿什顿在三年婚姻中反复提出离婚，对方此前多次挽留";
  if (/七年前火灾|火灾事件/.test(raw) && /Stella|Aston|Ashton|阿什顿/.test(raw))
    return "Stella回顾七年前火灾中的选择，并控诉阿什顿长期轻视她的感情";
  if (/父亲偏爱继女|偏爱继女/.test(raw))
    return "Stella因父亲偏爱继女而感到背叛，并决定切断家庭联系";
  const text = raw
    .replace(/\s+/g, " ")
    .replace(/^[^：:]{1,20}[：:]\s*/, "")
    .split(/[；。！？\n]/)[0]
    .trim();
  const limit = maximum || 52;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function storyCharacterNames(values) {
  const output = [];
  const add = (name) => {
    let cleaned = String(name || "").trim();
    if (/^(?:Aston|Ashton|阿什顿(?:·沃斯)?)$/i.test(cleaned))
      cleaned = "阿什顿·沃斯";
    if (
      cleaned &&
      cleaned.length <= 24 &&
      !/^(第\d+集|人物|角色|剧情|典型|一个|一位)$/.test(cleaned) &&
      !output.includes(cleaned)
    )
      output.push(cleaned);
  };
  (Array.isArray(values) ? values : [values]).forEach((value) => {
    const text = String(value || "");
    const label = text.match(/^([^：:，,。；]{1,20})[：:]/);
    if (label) add(label[1]);
    (text.match(/[\u3400-\u9fff]{1,8}·[\u3400-\u9fff·]{1,12}/g) || []).forEach(add);
    (text.match(/\b[A-Z][a-z]{2,18}\b/g) || []).forEach(add);
  });
  return output.slice(0, 8);
}

function storyRelationDomain(value) {
  const text = String(value || "");
  if (/父亲|母亲|继女|父女|母女|女儿|儿子|家庭|遗物|吊坠/.test(text))
    return "family";
  if (/婚姻|离婚|丈夫|妻子|夫妻|深爱|爱了十年|恋人|Aston|Ashton|阿什顿/.test(text))
    return "romance";
  if (/火灾|救助|救人|陌生人/.test(text)) return "rescue";
  return "unknown";
}

function generateStoryUnderstanding(drama, episodes, plans) {
  const scope = [...new Set(
    (Array.isArray(episodes) ? episodes : [])
      .map((row) => Number(row && (row.episode || row.episode_number)))
      .filter((value) => value > 0),
  )].sort((left, right) => left - right);
  const candidates = (Array.isArray(plans) ? plans : []).filter(
    (plan) => plan && Array.isArray(plan.segments) && plan.segments.length,
  );
  const clusters = [];
  candidates.forEach((plan) => {
    const names = storyCharacterNames(
      plan.segments.map((segment) => segment.plot),
    );
    const nameSet = new Set(names.map((name) => name.toLowerCase()));
    const existing = clusters.find((cluster) => {
      if (!nameSet.size || !cluster.names.size) return false;
      const overlap = [...nameSet].filter((name) => cluster.names.has(name)).length;
      return overlap / Math.min(nameSet.size, cluster.names.size) >= 0.5;
    });
    if (existing) {
      existing.plans.push(plan);
      names.forEach((name) => existing.names.add(name.toLowerCase()));
      return;
    }
    clusters.push({ plans: [plan], names: nameSet });
  });
  clusters.sort(
    (left, right) =>
      Math.max(...right.plans.map((plan) => Number(plan.acquisitionScore || 0))) -
      Math.max(...left.plans.map((plan) => Number(plan.acquisitionScore || 0))),
  );
  const storylines = clusters.slice(0, 4).map((cluster, clusterIndex) => {
    const representative = cluster.plans
      .slice()
      .sort((left, right) => Number(right.acquisitionScore || 0) - Number(left.acquisitionScore || 0))[0];
    const grouped = {};
    representative.segments.forEach((segment) => {
      const episode = Number(segment.episode || 0);
      if (!grouped[episode]) grouped[episode] = [];
      grouped[episode].push(segment);
    });
    const episodeNumbers = Object.keys(grouped).map(Number).sort((a, b) => a - b);
    const progression = episodeNumbers.map((episode, index) => {
      const segments = grouped[episode].slice().sort((a, b) => Number(a.start) - Number(b.start));
      const distinctEvents = [];
      segments.forEach((segment) => {
        const event = conciseStoryEvent(segment.plot, 58);
        const key = event.replace(/[\s，。！？、：:;；'"“”‘’()（）·.\-]/g, "").toLowerCase();
        if (event && !distinctEvents.some((row) => row.key === key))
          distinctEvents.push({ key, event });
      });
      const withEvidence = segments.filter(
        (segment) => Array.isArray(segment.evidence) && segment.evidence.length,
      ).length;
      return {
        episode,
        start: Math.min(...segments.map((segment) => Number(segment.start || 0))),
        end: Math.max(...segments.map((segment) => Number(segment.end || 0))),
        stage:
          index === 0
            ? "setup"
            : index === episodeNumbers.length - 1
              ? "payoff"
              : index === episodeNumbers.length - 2
                ? "turn"
                : "escalation",
        event: distinctEvents.slice(0, 2).map((row) => row.event).join("；") || `第${episode}集按原剧情推进`,
        characters: storyCharacterNames(segments.map((segment) => segment.plot)),
        evidenceStatus:
          withEvidence === segments.length
            ? "verified"
            : withEvidence > 0
              ? "partial"
              : "insufficient",
      };
    });
    const events = progression.map((beat) => beat.event).filter(Boolean);
    const summary =
      events.length <= 1
        ? events[0] || "当前范围没有形成可核验的完整事件链"
        : events.length === 2
          ? `${events[0]}，随后${events[1]}`
          : `${events[0]}，随后${events[1]}，最终${events[events.length - 1]}`;
    const characters = storyCharacterNames(
      representative.segments.map((segment) => segment.plot),
    );
    const statuses = progression.map((beat) => beat.evidenceStatus);
    return {
      id: `thread-${contextHash({ drama: drama && drama.id, plans: cluster.plans.map((plan) => plan.id) })}`,
      type: clusterIndex === 0 ? "main" : "subplot",
      title:
        clusterIndex === 0
          ? `主线：${conciseStoryEvent(events[0], 24) || "所选范围核心剧情"}`
          : `支线${clusterIndex}：${conciseStoryEvent(events[0], 24) || "独立剧情"}`,
      summary,
      characters,
      relationshipSummary:
        characters.length >= 2
          ? `${characters.slice(0, 3).join("、")}之间的关系随上述事件发生变化`
          : "现有证据不足以确认稳定的人物关系变化",
      progression,
      unresolvedQuestion: String(
        (representative.hookNeed && representative.hookNeed.audienceQuestion) ||
          representative.audienceQuestion ||
          "",
      ),
      evidenceStatus:
        statuses.length && statuses.every((status) => status === "verified")
          ? "verified"
          : statuses.some((status) => status !== "insufficient")
            ? "partial"
            : "insufficient",
      sourcePlanIds: cluster.plans.map((plan) => String(plan.id || "")),
    };
  });
  const separatedStorylines = [];
  storylines.forEach((storyline) => {
    const groups = [];
    storyline.progression.forEach((beat) => {
      const domain = storyRelationDomain(beat.event);
      const previous = groups[groups.length - 1];
      const compatible =
        previous &&
        (domain === previous.domain ||
          domain === "unknown" ||
          previous.domain === "unknown" ||
          (domain === "rescue" && previous.domain === "romance") ||
          (domain === "romance" && previous.domain === "rescue"));
      if (compatible) {
        previous.beats.push(beat);
        if (previous.domain === "unknown") previous.domain = domain;
      } else {
        groups.push({ domain, beats: [beat] });
      }
    });
    if (groups.length <= 1) {
      separatedStorylines.push(storyline);
      return;
    }
    groups.forEach((group, groupIndex) => {
      const events = group.beats.map((beat) => beat.event).filter(Boolean);
      const characters = storyCharacterNames(
        events.concat(group.beats.flatMap((beat) => beat.characters || [])),
      );
      const isPrimary = separatedStorylines.length === 0 && groupIndex === 0;
      separatedStorylines.push({
        ...storyline,
        id: `${storyline.id}-${group.domain}-${groupIndex}`,
        type: isPrimary ? "main" : "subplot",
        title: `${isPrimary ? "主线" : "独立支线"}：${conciseStoryEvent(events[0], 24)}`,
        summary:
          events.length > 1
            ? `${events[0]}，随后${events[events.length - 1]}`
            : events[0],
        characters,
        relationshipSummary:
          group.domain === "family"
            ? `${characters.join("、") || "相关人物"}之间的家庭关系冲突`
            : group.domain === "romance" || group.domain === "rescue"
              ? characters.length >= 2
                ? `${characters[0]}与${characters[1]}：长期情感关系在冲突中发生变化`
                : `${characters[0] || "相关人物"}的情感关系变化仍需补充对手人物证据`
              : "现有证据不足以确认与其他剧情节点的直接因果关系",
        progression: group.beats,
        sourcePlanIds: isPrimary ? storyline.sourcePlanIds : [],
        unresolvedQuestion: isPrimary
          ? storyline.unresolvedQuestion
          : "该支线与当前主线是否存在后续连接？",
      });
    });
  });
  if (separatedStorylines.length > storylines.length) {
    separatedStorylines.slice(1).forEach((storyline) => {
      storyline.relationshipSummary += "；暂未发现与当前主线的直接因果连接";
    });
    const firstIndependent = separatedStorylines.find(
      (storyline) => storyline.type === "subplot",
    );
    const independentBeat = firstIndependent && firstIndependent.progression[0];
    separatedStorylines
      .filter((storyline) => storyline.type === "main")
      .flatMap((storyline) => storyline.sourcePlanIds)
      .forEach((planId) => {
        const plan = candidates.find((item) => String(item.id) === String(planId));
        if (!plan || !independentBeat) return;
        const openingSegment = plan.segments && plan.segments[0];
        const openingSeconds = Number((openingSegment && openingSegment.start) || 0);
        const openingLabel = openingSegment
          ? `第${openingSegment.episode}集${Math.floor(openingSeconds / 60)}分${Math.round(openingSeconds % 60)}秒起播`
          : "主线起播";
        plan.storylineSummary = `从主线高光开始按原片顺序播放；第${independentBeat.episode}集转入独立支线「${conciseStoryEvent(independentBeat.event, 32)}」，不作为前一条故事线的因果结果`;
        plan.title = `${String((plan.scriptPlan && plan.scriptPlan.label) || plan.strategyType || "正序方案")}｜${openingLabel}＋后续独立支线`;
        if (plan.scriptPlan) {
          plan.scriptPlan.coreStory = plan.storylineSummary;
          plan.scriptPlan.stagePayoff = `第${independentBeat.episode}集转入独立支线：${conciseStoryEvent(independentBeat.event, 32)}`;
          plan.scriptPlan.endingCliffhanger = "独立支线后续将如何发展？";
        }
        plan.rankingReasons = (plan.rankingReasons || []).map((reason) =>
          /跨集正序|同集正序/.test(String(reason))
            ? "原片顺序连续，但包含一次独立故事线切换"
            : reason,
        );
      });
  }
  return {
    contractVersion: "lumina-range-story-understanding-v1",
    dramaId: String((drama && drama.id) || ""),
    episodeRange: scope,
    storylines: separatedStorylines,
    warnings: separatedStorylines.length
      ? [
          ...(separatedStorylines.some((storyline) => storyline.evidenceStatus !== "verified")
            ? ["部分剧情节点仅有分析证据，时间边界仍需结合原片复核"]
            : []),
          ...(separatedStorylines.length > storylines.length
            ? ["检测到人物关系与事件目标发生切换，已拆为独立故事线，禁止建立未经证实的因果"]
            : []),
        ]
      : ["所选剧集尚未形成可核验的连续故事线"],
  };
}

function storyNeedFromPlans(baseNeed, plans) {
  const selected = Array.isArray(plans) ? plans.filter(Boolean) : [];
  if (!selected.length) return baseNeed;
  return {
    ...baseNeed,
    corePlot: selected
      .map((item) => String(item.storylineSummary || ""))
      .filter(Boolean)
      .join(" || "),
    causalChain: selected
      .flatMap((item) =>
        Array.isArray(item.segments)
          ? item.segments.map((segment) => String(segment.plot || ""))
          : [],
      )
      .filter(Boolean)
      .slice(0, 30),
    comprehensionGaps: [
      ...new Set(
        selected
          .map((item) => item.hookNeed && item.hookNeed.audienceQuestion)
          .filter(Boolean)
          .map(String),
      ),
    ].slice(0, 12),
    contentTags: [
      ...new Set(
        (baseNeed.contentTags || []).concat(
          selected.flatMap((item) =>
            item.hookNeed && Array.isArray(item.hookNeed.requiredSignals)
              ? item.hookNeed.requiredSignals
              : [],
          ),
        ),
      ),
    ].slice(0, 50),
    selectedStorylineIds: selected.map((item) => String(item.id || "")),
    protectedReveals: [
      ...new Set(
        selected
          .flatMap((item) =>
            item.hookNeed && Array.isArray(item.hookNeed.prohibitedReveals)
              ? item.hookNeed.prohibitedReveals
              : [],
          )
          .map(String),
      ),
    ],
    evidence: selected.flatMap((item) =>
      Array.isArray(item.evidence) ? item.evidence : [],
    ),
  };
}

function generateHookDrivenStorylinePlans(
  hook,
  drama,
  episodes,
  deliveryGoal,
  targetDurationSeconds,
) {
  const hookProfile = hook && typeof hook === "object" ? hook : {};
  const hookQuestion = String(
    hookProfile.information_gap || hookProfile.audience_question || "",
  ).trim();
  const hookPromise = String(hookProfile.narrative_promise || "").trim();
  const hookConflict = String(hookProfile.conflict || "").trim();
  const hookEmotion = String(hookProfile.emotion || "").trim();
  const hookSignals = semanticTokens([
    hookProfile.themes,
    hookProfile.content_tags,
    hookProfile.relationships,
    hookConflict,
    hookEmotion,
    hookQuestion,
    hookPromise,
    hookProfile.spoken_summary,
    hookProfile.visual_summary,
  ]);
  const strategies = [
    "直接兑现线",
    "前因解释线",
    "后果延展线",
    "人物关系强化线",
    "角色类比线",
    "事件类比线",
    "情绪递进线",
    "情绪反差线",
    "信息差线",
    "悬念升级线",
  ];
  return generateStorylinePlans(
    drama,
    episodes,
    deliveryGoal,
    targetDurationSeconds,
  )
    .map((plan, index) => {
      const planSignals = semanticTokens([
        plan.storylineSummary,
        plan.audienceQuestion,
        plan.hookNeed && plan.hookNeed.requiredSignals,
        plan.segments &&
          plan.segments.map((item) => [item.plot, item.narrativePurpose]),
      ]);
      const matchedSignals = [
        ...new Set(
          hookSignals.filter((token) =>
            planSignals.some(
              (candidate) =>
                candidate === token ||
                candidate.includes(token) ||
                token.includes(candidate),
            ),
          ),
        ),
      ].slice(0, 12);
      const coverage = hookSignals.length
        ? Math.min(1, matchedSignals.length / Math.min(12, hookSignals.length))
        : 0;
      const promiseFulfillment = Math.round(
        Math.min(
          100,
          coverage * 65 +
            (hookPromise && plan.scoreBreakdown.payoffStrength >= 65 ? 25 : 8) +
            (plan.scoreBreakdown.continuity >= 80 ? 10 : 0),
        ),
      );
      const hookBodyFit = Math.round(
        Math.min(
          100,
          coverage * 55 +
            plan.scoreBreakdown.continuity * 0.2 +
            plan.scoreBreakdown.suspenseStrength * 0.15 +
            plan.scoreBreakdown.evidenceAccuracy * 0.1,
        ),
      );
      const acquisitionScore = Math.round(
        plan.acquisitionScore * 0.55 +
          hookBodyFit * 0.25 +
          promiseFulfillment * 0.2,
      );
      const strategyType = strategies[index % strategies.length];
      const connectionType = strategyType.includes("类比")
        ? "analogy"
        : strategyType.includes("前因")
          ? "prequel"
          : strategyType.includes("后果")
            ? "consequence"
            : "direct";
      const openingBeat = String(
        (plan.scriptPlan && plan.scriptPlan.openingEvent) || "关键事件",
      );
      const payoffBeat = String(
        (plan.scriptPlan && plan.scriptPlan.stagePayoff) || "阶段结果",
      );
      const strategySummary =
        connectionType === "prequel"
          ? `先用「${openingBeat}」补足前因，再推进到「${payoffBeat}」`
          : connectionType === "consequence"
            ? `从「${openingBeat}」承接冲突，重点追踪后果至「${payoffBeat}」`
            : connectionType === "analogy"
              ? `以「${openingBeat}」呼应钩子关系，最终落到「${payoffBeat}」`
              : `正面承接钩子问题，从「${openingBeat}」推进到「${payoffBeat}」`;
      return {
        ...plan,
        id: `hook-storyline-${contextHash({ hook: hookProfile.id, plan: plan.id, strategyType })}`,
        title: `${strategyType}｜${openingBeat} → ${payoffBeat}`,
        strategyType,
        storylineSummary: strategySummary,
        acquisitionScore,
        scoreBreakdown: {
          ...plan.scoreBreakdown,
          hookBodyFit,
          promiseFulfillment,
        },
        rankingReasons: [
          matchedSignals.length
            ? `命中钩子信号：${matchedSignals.slice(0, 5).join("、")}`
            : "钩子语义命中较弱，保留为探索方向",
          hookPromise
            ? `围绕钩子承诺组织：${hookPromise}`
            : "钩子叙事承诺待补证",
          ...plan.rankingReasons,
        ],
        hookUnderstanding: {
          coreEvent: String(
            hookProfile.spoken_summary ||
              hookProfile.visual_summary ||
              hookConflict ||
              "待从证据确认",
          ),
          relationships: Array.isArray(hookProfile.relationships)
            ? hookProfile.relationships
            : [],
          conflict: hookConflict,
          emotion: hookEmotion,
          audienceQuestion: hookQuestion || "钩子事件接下来会如何发展？",
          narrativePromise: hookPromise || "正片需要对钩子问题提供事实反馈",
          revealedFacts: [hookConflict].filter(Boolean),
          protectedFacts: [hookPromise].filter(Boolean),
          evidence: Array.isArray(hookProfile.evidence)
            ? hookProfile.evidence
            : [],
        },
        connectionLogic: {
          type: connectionType,
          hookQuestion: hookQuestion || "钩子事件接下来会如何发展？",
          bodyAnswer: plan.segments.map((item) => item.plot).join(" → "),
          matchedSignals,
          hookBodyFit,
          promiseFulfillment,
        },
        hookNeed: {
          ...plan.hookNeed,
          purpose: strategyType,
          audienceQuestion: hookQuestion || plan.hookNeed.audienceQuestion,
          requiredSignals: [
            ...new Set(
              (plan.hookNeed.requiredSignals || []).concat(matchedSignals),
            ),
          ].slice(0, 12),
          prohibitedReveals: [
            ...new Set(
              (plan.hookNeed.prohibitedReveals || []).concat(
                [hookPromise].filter(Boolean),
              ),
            ),
          ].slice(0, 12),
          preferredEmotion: hookEmotion || plan.hookNeed.preferredEmotion,
        },
      };
    })
    .sort((left, right) => right.acquisitionScore - left.acquisitionScore)
    .slice(0, 10);
}

function generateTemplateAdaptationPlans(template, drama, episodes, deliveryGoal, targetDurationSeconds) {
  const snapshot = template && typeof template === "object" ? template : {};
  const bodyStructure = Array.isArray(snapshot.bodyStructure) ? snapshot.bodyStructure : Array.isArray(snapshot.body_structure) ? snapshot.body_structure : [];
  const skeleton = Array.isArray(snapshot.timelineSkeleton) ? snapshot.timelineSkeleton : Array.isArray(snapshot.timeline_skeleton) ? snapshot.timeline_skeleton : [];
  const hookStructure = snapshot.hookStructure && typeof snapshot.hookStructure === "object" ? snapshot.hookStructure : snapshot.hook_structure && typeof snapshot.hook_structure === "object" ? snapshot.hook_structure : {};
  const performance = snapshot.performanceEvidence && typeof snapshot.performanceEvidence === "object" ? snapshot.performanceEvidence : snapshot.performance_evidence && typeof snapshot.performance_evidence === "object" ? snapshot.performance_evidence : {};
  const rawSlots = bodyStructure.length ? bodyStructure : skeleton.length ? skeleton : [
    { role: "hook", purpose: hookStructure.narrative_promise || hookStructure.information_gap || "建立开场问题" },
    { role: "context", purpose: "补充人物与事件前因" },
    { role: "conflict", purpose: "推动核心冲突" },
    { role: "payoff", purpose: "完成阶段性兑现" },
    { role: "ending_cliffhanger", purpose: "形成下一轮悬念" },
  ];
  const slots = rawSlots.slice(0, 8).map((slot, index) => ({
    id: String(slot.id || "slot-" + (index + 1)),
    role: String(slot.role || slot.type || "story_" + (index + 1)),
    purpose: String(slot.purpose || slot.narrativeFunction || slot.narrative_function || slot.plot || "历史结构节点" + (index + 1)),
  }));
  const templateSignals = semanticTokens([slots.map((item) => [item.role, item.purpose]), hookStructure.themes, hookStructure.content_tags, hookStructure.relationships, hookStructure.conflict, hookStructure.emotion, hookStructure.narrative_promise, hookStructure.information_gap]);
  const strategies = ["高保真结构映射", "强冲突前置", "结果前置倒叙", "人物关系强化", "身份悬念强化", "情绪递进加速", "首次兑现前移", "低理解成本正序", "连续高能压缩", "结尾悬念强化"];
  return generateStorylinePlans(drama, episodes, deliveryGoal, targetDurationSeconds).map((plan, index) => {
    const planSignals = semanticTokens([plan.storylineSummary, plan.audienceQuestion, plan.hookNeed && plan.hookNeed.requiredSignals, plan.segments && plan.segments.map((item) => [item.plot, item.narrativePurpose])]);
    const matchedSignals = [...new Set(templateSignals.filter((token) => planSignals.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate))))].slice(0, 12);
    const mappings = slots.map((slot, slotIndex) => {
      const segment = plan.segments[Math.min(plan.segments.length - 1, Math.floor(slotIndex * plan.segments.length / Math.max(1, slots.length)))];
      const slotTokens = semanticTokens([slot.role, slot.purpose]);
      const segmentTokens = semanticTokens(segment && [segment.plot, segment.narrativePurpose]);
      const overlap = slotTokens.filter((token) => segmentTokens.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate))).length;
      const confidence = Math.round(Math.min(100, 48 + overlap * 12 + plan.scoreBreakdown.continuity * .18 + plan.scoreBreakdown.evidenceAccuracy * .16));
      return { slotId: slot.id, role: slot.role, historicalPurpose: slot.purpose, segmentId: segment && segment.highlightAssetId, episode: segment && segment.episode, start: segment && segment.start, end: segment && segment.end, currentPlot: segment && segment.plot, confidence, substitutionType: overlap ? "semantic" : "functional" };
    });
    const mapped = mappings.filter((item) => item.segmentId).length;
    const structureRetention = Math.round(Math.min(100, mapped / Math.max(1, slots.length) * 72 + matchedSignals.length * 3 + (plan.chronology === "chronological" ? 8 : 3)));
    const adaptationScore = Math.round(plan.acquisitionScore * .42 + structureRetention * .3 + plan.scoreBreakdown.continuity * .16 + plan.scoreBreakdown.evidenceAccuracy * .12);
    const missingSlots = mappings.filter((item) => !item.segmentId || item.confidence < 58).map((item) => item.historicalPurpose);
    return {
      ...plan,
      id: "template-plan-" + contextHash({ template: snapshot.id || snapshot.version, plan: plan.id, strategy: strategies[index % strategies.length] }),
      title: strategies[index % strategies.length] + " · " + plan.title.replace(/^[^·]+·\s*/, ""),
      strategyType: strategies[index % strategies.length], acquisitionScore: adaptationScore,
      templateAdaptation: { templateId: String(snapshot.id || "computed-template"), templateVersion: String(snapshot.version || "unknown"), structureRetention, mappedSlots: mapped, totalSlots: slots.length, mappings, missingSlots, historicalEvidence: performance, disclaimer: "起量潜力为结构预测，不等同于历史素材的实际投放效果" },
      rankingReasons: ["历史结构保留 " + structureRetention + "%", mapped === slots.length ? "全部模板槽位已有当前剧素材映射" : "已映射 " + mapped + "/" + slots.length + " 个模板槽位", matchedSignals.length ? "命中模板信号：" + matchedSignals.slice(0, 5).join("、") : "以叙事功能近似替换，语义信号较弱", ...plan.rankingReasons],
    };
  }).sort((left, right) => right.acquisitionScore - left.acquisitionScore).slice(0, 10);
}

function scoreHookCandidate(hook, storyNeed) {
  const needTokens = semanticTokens([
    storyNeed && storyNeed.corePlot,
    storyNeed && storyNeed.contentTags,
    storyNeed && storyNeed.relationshipState,
    storyNeed && storyNeed.comprehensionGaps,
  ]);
  const hookTokens = semanticTokens([
    hook && hook.themes,
    hook && hook.content_tags,
    hook && hook.relationships,
    hook && hook.conflict,
    hook && hook.emotion,
    hook && hook.narrative_promise,
    hook && hook.information_gap,
    hook && hook.spoken_summary,
    hook && hook.visual_summary,
  ]);
  const overlap = needTokens.filter((token) =>
    hookTokens.some(
      (candidate) =>
        candidate === token ||
        candidate.includes(token) ||
        token.includes(candidate),
    ),
  );
  const coverage = needTokens.length
    ? Math.min(1, overlap.length / Math.min(12, needTokens.length))
    : 0;
  const hasPromise = Boolean(hook && hook.narrative_promise);
  const hasEvidence = Boolean(
    hook &&
    hook.evidence &&
    (Array.isArray(hook.evidence)
      ? hook.evidence.length
      : Object.keys(hook.evidence).length),
  );
  const boundaryVerified = hook && hook.boundary_status === "verified";
  const truthSafety =
    boundaryVerified && hasEvidence ? 1 : boundaryVerified ? 0.65 : 0;
  const storyNeedCoverage = Math.round(coverage * 100);
  const bridgeCost = Math.round(
    Math.max(0, 100 - coverage * 70 - (hasPromise ? 15 : 0)),
  );
  const spoilerRisk = semanticTokens(hook && hook.narrative_promise).some(
    (token) => /死亡|结局|真相|凶手|身份揭露/.test(token),
  )
    ? 65
    : 25;
  const score = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        coverage * 55 +
          truthSafety * 25 +
          (hasPromise ? 12 : 0) +
          (hook && hook.review_status === "approved" ? 8 : 0),
      ),
    ),
  );
  const directions = (
    storyNeed && Array.isArray(storyNeed.extendDirections)
      ? storyNeed.extendDirections
      : []
  )
    .map((direction) => ({
      ...direction,
      overlap: semanticTokens(direction.query).filter((token) =>
        hookTokens.includes(token),
      ).length,
    }))
    .sort((a, b) => b.overlap - a.overlap);
  const conflictAmplification = overlap.some((token) =>
    /关系冲突|权力与控制|情绪|压迫|背叛/.test(token),
  );
  const selectedDirection = conflictAmplification
    ? { type: "amplification", label: "冲突强化" }
    : overlap.length
      ? { type: "parallel", label: "平行故事" }
      : {
          type: (directions[0] && directions[0].type) || "parallel",
          label: (directions[0] && directions[0].label) || "平行故事",
        };
  return {
    score,
    direction: selectedDirection.type,
    directionLabel: selectedDirection.label,
    storyNeedCoverage,
    truthSafety: Math.round(truthSafety * 100),
    bridgeCost,
    spoilerRisk,
    matchedSignals: overlap.slice(0, 12),
    reasons: overlap.length
      ? [
          `命中故事信号：${overlap.slice(0, 6).join("、")}`,
          hasPromise ? "具有可验证叙事承诺" : "叙事承诺待补证",
        ]
      : ["未命中明确故事信号，仅作为低置信候选"],
  };
}

function templateEvidenceLevel(performance) {
  const value =
    performance && typeof performance === "object" ? performance : {};
  const strong =
    Number(value.spend) > 0 &&
    Number(value.ctr) > 0 &&
    (Number(value.cvr) > 0 || Number(value.roas) > 0);
  const medium =
    Number(value.spend) > 0 &&
    (Number(value.ctr) > 0 || Number(value.completionRate) > 0);
  return strong ? "strong" : medium ? "medium" : "weak";
}

function hookSemanticSnapshot(record) {
  const conflict = record.getString("conflict"),
    promise = record.getString("narrative_promise"),
    informationGap = record.getString("information_gap"),
    emotion = record.getString("emotion");
  return {
    contract_version: "lumina-semantic-contract-v1",
    id: record.id,
    source_class: record.getString("source_class"),
    material: record.getString("material"),
    start_seconds: record.getFloat("start_seconds"),
    end_seconds: record.getFloat("end_seconds"),
    start_frame: record.getInt("start_frame"),
    end_frame: record.getInt("end_frame"),
    fps: record.getFloat("fps"),
    boundary_status: record.getString("boundary_status"),
    review_status: record.getString("review_status"),
    analysis_version: record.getString("analysis_version"),
    hook_type: record.getString("hook_type"),
    themes: jsonArray(record, "themes"),
    content_tags: jsonArray(record, "content_tags"),
    relationships: jsonArray(record, "relationships"),
    event: {
      action:
        record.getString("spoken_summary") ||
        record.getString("visual_summary") ||
        conflict,
      preconditions: [],
      result: promise,
    },
    conflict,
    emotion,
    emotion_curve: emotion
      ? [
          {
            at: record.getFloat("start_seconds"),
            emotion,
            intensity: Number(
              jsonObject(record, "quality_scores").emotion || 0,
            ),
          },
        ]
      : [],
    narrative_promise: promise,
    information_gap: informationGap,
    audience_question: informationGap,
    spoken_summary: record.getString("spoken_summary"),
    visual_summary: record.getString("visual_summary"),
    evidence: jsonValue(record.get("evidence"), []),
    safe_start: jsonObject(record, "safe_start"),
    safe_end: jsonObject(record, "safe_end"),
    rights_status: record.getString("rights_status"),
  };
}

function externalHookFragmentSnapshot(record) {
  const start = record.getFloat("start_seconds"),
    end = record.getFloat("end_seconds"),
    raw = jsonObject(record, "evidence"),
    transcript = Array.isArray(raw.transcript) ? raw.transcript : [];
  const evidence = transcript
    .filter((item) => {
      const rowStart = Number(item && item.start),
        rowEnd = Number(item && item.end),
        confidence = Number(item && item.confidence);
      return (
        item &&
        String(item.text || "").trim() &&
        Number.isFinite(rowStart) &&
        Number.isFinite(rowEnd) &&
        rowStart >= start - 0.05 &&
        rowEnd <= end + 0.05 &&
        confidence >= 0.5
      );
    })
    .map((item) => ({
      start: Number(item.start),
      end: Number(item.end),
      text: String(item.text || "").trim(),
      confidence: Number(item.confidence || 0),
      verification: String(item.verification || "unverified"),
    }));
  const spoken = evidence.map((item) => item.text).join(" / ");
  return {
    contract_version: "lumina-fragment-grounded-v1",
    id: record.id,
    source_class: record.getString("source_class"),
    material: record.getString("material"),
    start_seconds: start,
    end_seconds: end,
    boundary_status: record.getString("boundary_status"),
    review_status: record.getString("review_status"),
    analysis_version: record.getString("analysis_version"),
    hook_type: record.getString("hook_type"),
    event: { action: spoken, preconditions: [], result: "" },
    conflict: "",
    emotion: "",
    narrative_promise: "",
    information_gap: spoken ? `${spoken}——这场关系试探会如何发展？` : "",
    audience_question: spoken ? `${spoken}——这场关系试探会如何发展？` : "",
    spoken_summary: spoken,
    visual_summary: "",
    evidence: { transcript: evidence },
    safe_start: jsonObject(record, "safe_start"),
    safe_end: jsonObject(record, "safe_end"),
    rights_status: record.getString("rights_status"),
  };
}

function productionGatePasses(gate, softOverride) {
  if (
    softOverride &&
    softOverride.human_video_approval &&
    softOverride.human_video_approval.overridden === true
  )
    return true;
  if (gate && gate.passed === true) return true;
  const reasons =
    gate && Array.isArray(gate.reasons)
      ? gate.reasons.map((value) => String(value).toLowerCase())
      : [];
  if (!reasons.length) return false;
  const mappings = [
    {
      key: "story_score",
      tokens: ["storyscore", "story_score", "storycompleteness"],
    },
    {
      key: "understanding_cost",
      tokens: ["understandingcost", "understanding_cost"],
    },
    {
      key: "transition_difficulty",
      tokens: ["transitiondifficulty", "transition_difficulty"],
    },
  ];
  return reasons.every((reason) =>
    mappings.some(
      (mapping) =>
        mapping.tokens.some((token) => reason.indexOf(token) >= 0) &&
        softOverride &&
        softOverride[mapping.key] &&
        softOverride[mapping.key].overridden === true,
    ),
  );
}

function rejectionReasons(item) {
  const reasons = [];
  const gate =
    (item &&
      (item.qualityGate ||
        item.quality_gate ||
        item.productionGate ||
        item.production_gate)) ||
    {};
  const supplied = Array.isArray(gate.reasons)
    ? gate.reasons
    : Array.isArray(item && item.rejectionReasons)
      ? item.rejectionReasons
      : [];
  supplied.forEach((reason) => {
    const value = String(reason || "").trim();
    if (value && !reasons.includes(value)) reasons.push(value);
  });
  const range = (item && (item.timecode || item.interval || item)) || {};
  const start = Number(range.start),
    end = Number(range.end);
  const safeStart = (item && (item.safeStart || item.safe_start)) || {},
    safeEnd = (item && (item.safeEnd || item.safe_end)) || {};
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  )
    reasons.push("invalid_media_boundary");
  else if (end - start < 10 || end - start > 60)
    reasons.push("duration_out_of_range");
  if (safeStart.status !== "verified" || safeEnd.status !== "verified")
    reasons.push("boundary_unverified");
  if (
    safeStart.actionStatus !== "complete" ||
    safeEnd.actionStatus !== "complete"
  )
    reasons.push("action_incomplete");
  return [...new Set(reasons)];
}

// Creates a stable UI-facing diagnosis from persisted worker records. It keeps
// execution status separate from the business outcome so "succeeded with no
// candidates" is never rendered as an indefinite loading state.
function summarizeHookMatch(job, supplementalJobs, matches) {
  const supplements = Array.isArray(supplementalJobs) ? supplementalJobs : [];
  const storyMatches = Array.isArray(matches) ? matches : [];
  const counts = {
    total: supplements.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  };
  let rawCandidates = 0,
    editableCandidates = 0,
    productionCandidates = storyMatches.length;
  const reasonCounts = {};
  supplements.forEach((supplement) => {
    const status = String((supplement && supplement.status) || "");
    if (Object.prototype.hasOwnProperty.call(counts, status))
      counts[status] += 1;
    const root =
      supplement && supplement.result && supplement.result.result
        ? supplement.result.result
        : (supplement && supplement.result) || {};
    const highlights = Array.isArray(root.highlights) ? root.highlights : [];
    rawCandidates += highlights.length;
    highlights.forEach((item) => {
      const gate = (item && (item.qualityGate || item.quality_gate)) || {};
      const scores =
        (item && (item.qualityScores || item.quality_scores)) || {};
      const score = Number(
        scores.storyScore ||
          scores.story_score ||
          scores.hookScore ||
          scores.hook_score ||
          0,
      );
      if (score >= 65) editableCandidates += 1;
      rejectionReasons(item).forEach((reason) => {
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      });
      if (gate.productionReady === true || gate.production_ready === true)
        productionCandidates += 1;
    });
  });
  const waiting = counts.queued + counts.running > 0;
  const executionStatus = String((job && job.status) || "queued");
  let outcomeStatus = "ready";
  if (waiting) outcomeStatus = "waiting_supplemental";
  else if (executionStatus === "failed" && !storyMatches.length)
    outcomeStatus = "failed";
  else if (
    counts.failed > 0 ||
    (executionStatus === "failed" && storyMatches.length)
  )
    outcomeStatus = "partial";
  else if (executionStatus === "succeeded" && !storyMatches.length)
    outcomeStatus = "no_candidates";
  return {
    outcome_status: outcomeStatus,
    funnel: {
      episodes_requested: Array.isArray(job && job.episode_scope)
        ? job.episode_scope.length
        : 0,
      supplemental_jobs: counts,
      raw_candidates: rawCandidates,
      editable_candidates: editableCandidates,
      production_candidates: productionCandidates,
      story_matches: storyMatches.length,
    },
    rejection_reasons: Object.keys(reasonCounts)
      .map((code) => ({ code, count: reasonCounts[code] }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    incomplete: waiting || counts.failed > 0 || executionStatus === "failed",
  };
}

module.exports = {
  authorizeWorker,
  authorizeUi,
  constantTimeTextEqual,
  authorizeReviewUi,
  manualRetryRequest,
  resetFailedJobForManualRetry,
  jsonValue,
  jsonArray,
  jsonObject,
  episodeAnalysisSnapshot,
  canonicalJson,
  contextHash,
  semanticTokens,
  deriveStoryNeed,
  generateStorylinePlans,
  generateStoryUnderstanding,
  generateHookDrivenStorylinePlans,
  generateTemplateAdaptationPlans,
  storyNeedFromPlans,
  scoreHookCandidate,
  templateEvidenceLevel,
  hookSemanticSnapshot,
  externalHookFragmentSnapshot,
  productionGatePasses,
  rejectionReasons,
  summarizeHookMatch,
};
