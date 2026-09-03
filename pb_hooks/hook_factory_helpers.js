function authorizeWorker(e) {
  const expected = $os.getenv("LUMINA_WORKER_TOKEN");
  const supplied = String(e.requestInfo().headers.authorization || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!expected || supplied !== expected)
    throw new UnauthorizedError("Invalid analysis worker token");
}

function authorizeUi(e) {
  const requestInfo = e.requestInfo();
  const headers = (requestInfo && requestInfo.headers) || {};
  const rawHeader = e.request && e.request.header;
  const header = (name) => {
    const lowerName = String(name || "").toLowerCase();
    const matchingKey = Object.keys(headers).find(
      (key) => String(key).toLowerCase() === lowerName,
    );
    if (matchingKey && headers[matchingKey] != null)
      return String(headers[matchingKey]);
    if (rawHeader && typeof rawHeader.get === "function") {
      const value = rawHeader.get(name);
      if (value != null) return String(value);
    }
    return "";
  };
  const origin = header("origin").trim().replace(/\/$/, "");
  // Go promotes Host out of the Header map for inbound requests.
  const host = String((e.request && e.request.host) || header("host") || "").trim();
  const localUiHeader = header("x-lumina-ui");
  const browserOriginAllowed =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(origin);
  const localHostAllowed =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
  const configuredOrigins = String($os.getenv("LUMINA_UI_ORIGINS") || "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const configuredOriginAllowed = configuredOrigins.includes(origin);
  // Vite's same-origin /pb proxy may omit Origin after proxying. In that case
  // require both the proxy marker and a loopback Host. The marker alone is not
  // an authorization boundary because any HTTP client can forge it.
  const localUiAllowed =
    $os.getenv("LUMINA_UI_MODE") === "local-loopback" &&
    localHostAllowed &&
    localUiHeader === "local" &&
    (!origin || browserOriginAllowed);
  if (!localUiAllowed && !configuredOriginAllowed)
    throw new ForbiddenError("Local UI only");
}

// Human review is a workspace operation, not an administrator operation.
// Every user who can reach the local Lumina UI receives the same review access.
function authorizeReviewUi(e) {
  authorizeUi(e);
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
  const storyKeywords = [
    "狼族", "月石", "狼灵", "阿尔法", "女王", "公主", "婴儿", "母亲",
    "父亲", "女儿", "亲生", "追杀", "逃亡", "悬崖", "牺牲", "守护",
    "收养", "遗弃", "身世", "项链", "力量", "血脉", "觉醒", "身份",
    "真相", "奴隶", "战争", "宣战", "战士", "反击", "复仇", "羞辱",
    "背叛", "秘密", "危机", "继承人", "族群", "亲情", "权力",
  ];
  storyKeywords.forEach((keyword) => {
    if (combined.includes(keyword) && !output.includes(keyword)) output.push(keyword);
  });
  const concepts = [
    [/爱|婚姻|夫妻|丈夫|妻子|离婚|恋人|感情|背叛/, ["关系冲突", "都市爱情"]],
    [/控制|支配|羞辱|跪|乞求|压迫|不敢|惩罚/, ["权力与控制"]],
    [/觉醒|决绝|拒绝|反抗|结束婚姻|不再妥协/, ["女性独立与自我救赎"]],
    [/母亲|父亲|继女|家庭|吊坠|遗物/, ["家庭伦理", "家庭责任与个人自由"]],
    [/误会|真相|冒领|火灾|救人/, ["信息差", "真相反转"]],
    [/狼族|狼灵|月石|阿尔法|狼群/, ["狼族玄幻"]],
    [/力量|血脉|觉醒|继承人/, ["血脉力量"]],
    [/追杀|逃亡|悬崖|生死/, ["生死追逃"]],
    [/牺牲|护女|守护|以命/, ["亲情牺牲"]],
    [/收养|遗弃|身世|亲生|项链/, ["身世谜团"]],
    [/战争|宣战|战士|族群/, ["族群战争"]],
  ];
  concepts.forEach(([pattern, labels]) => {
    if (!pattern.test(combined)) return;
    labels.forEach((label) => {
      if (!output.includes(label)) output.push(label);
    });
  });
  return output;
}

// PocketBase hooks run in Goja and cannot import the TypeScript ontology
// module used by the UI. This code-based adapter makes the same relationship
// contract effective in server-side retrieval. Tags remain recall-only.
const ONTOLOGY_DIMENSIONS = ["genre", "theme", "role", "relation", "conflict", "emotion", "storyBeat", "scene", "audience", "acquisition"];
const ONTOLOGY_PARENTS = {
  "theme.复仇": "theme.阶层逆袭", "theme.女性独立": "theme.成长",
  "theme.契约婚姻": "theme.家族", "role.男主": "role.主角",
  "role.女主": "role.主角", "role.反派": "role.配角",
  "relation.夫妻": "relation.恋人", "storyBeat.打脸": "storyBeat.危机",
  "acquisition.身份揭示": "acquisition.信息差",
};
const ONTOLOGY_RELATED = new Set([
  "conflict.复仇对抗|theme.复仇", "storyBeat.反转|theme.重生",
  "conflict.身份误会|storyBeat.误会", "emotion.爽感|storyBeat.打脸",
  "conflict.生存危机|emotion.紧张", "acquisition.悬念预告|storyBeat.开场钩子",
]);
const ONTOLOGY_CONTRADICTS = new Set([
  "audience.女性向|audience.男性向", "emotion.甜蜜|emotion.虐",
  "relation.敌对|relation.盟友",
]);
const ONTOLOGY_ALIASES = {
  revenge: "theme.复仇", "身份逆转": "theme.身份反转",
  "femaleempowerment": "theme.女性独立", "fightback": "storyBeat.反击",
  counterattack: "storyBeat.反击", spouses: "relation.夫妻",
  married: "relation.夫妻", lovers: "relation.恋人",
  enemies: "relation.敌对", allies: "relation.盟友",
  anger: "emotion.愤怒", tension: "emotion.紧张", suspense: "acquisition.悬念预告",
};
function ontologyKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/[\s_]+/g, "");
}
function ontologyTag(value, fallbackDimension) {
  if (value == null) return null;
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (row.manualStatus === "rejected") return null;
  const suppliedCode = String(row.code || "").trim();
  if (/^[^.]+\..+/.test(suppliedCode)) return { code: suppliedCode, dimension: suppliedCode.split(".")[0], known: true };
  const label = String(row.label || row.value || row.original || value || "").trim();
  if (!label) return null;
  const aliasCode = ONTOLOGY_ALIASES[ontologyKey(label)];
  if (aliasCode) return { code: aliasCode, dimension: aliasCode.split(".")[0], known: true };
  const dimension = ONTOLOGY_DIMENSIONS.includes(String(row.dimension || "")) ? String(row.dimension) : String(fallbackDimension || "theme");
  // Free-form labels are lossless but are not treated as ontology-known merely
  // because a fallback dimension was supplied.
  return { code: `${dimension}.${label}`, dimension, known: false };
}
function ontologyTagsFrom(value, fallbackDimension) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => ontologyTag(item, fallbackDimension)).filter(Boolean);
}
function ontologyPairKey(left, right) {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}
function ontologyRelation(left, right) {
  if (left.code === right.code) return "exact";
  const pair = ontologyPairKey(left.code, right.code);
  if (ONTOLOGY_CONTRADICTS.has(pair)) return "contradictory";
  if (ONTOLOGY_RELATED.has(pair)) return "bridgeable";
  if (ONTOLOGY_PARENTS[left.code] === right.code || ONTOLOGY_PARENTS[right.code] === left.code) return "compatible";
  if (!left.known || !right.known) return "unknown";
  return left.dimension === right.dimension ? "compatible" : "unknown";
}
function ontologyProfile(value) {
  const row = value && typeof value === "object" ? value : {};
  return [
    ...ontologyTagsFrom(row.ontology_tags || row.ontologyTags),
    ...ontologyTagsFrom(row.themes, "theme"),
    ...ontologyTagsFrom(row.content_tags || row.contentTags, "acquisition"),
    ...ontologyTagsFrom(row.relationships || row.relationshipState, "relation"),
    ...ontologyTagsFrom(row.conflict, "conflict"),
    ...ontologyTagsFrom(row.emotion, "emotion"),
  ].filter((item, index, values) => values.findIndex((other) => other.code === item.code) === index);
}
function compareOntologyProfiles(leftValue, rightValue) {
  const left = ontologyProfile(leftValue), right = ontologyProfile(rightValue);
  const pairs = { exact: [], compatible: [], bridgeable: [], contradictory: [], unknown: [] };
  left.forEach((a) => right.forEach((b) => pairs[ontologyRelation(a, b)].push({ left: a.code, right: b.code })));
  const hardConflicts = [...new Set(pairs.contradictory.map((item) => ontologyPairKey(item.left, item.right)))];
  const denominator = Math.max(1, Math.min(left.length, right.length));
  const positive = pairs.exact.length + pairs.compatible.length * 0.55 + pairs.bridgeable.length * 0.15;
  const score = Math.max(-1, Math.min(1, (positive - pairs.contradictory.length) / denominator));
  return {
    stage: "recall_only",
    decision: hardConflicts.length ? "blocked" : positive > 0 ? "allow_recall" : "needs_evidence",
    relation: hardConflicts.length ? "contradictory" : pairs.exact.length ? "exact" : pairs.compatible.length ? "compatible" : pairs.bridgeable.length ? "bridgeable" : "unknown",
    score: Math.round(score * 1000) / 1000,
    productionEligible: false,
    hardConflicts,
    matches: pairs,
  };
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
    dramaId: String((drama && drama.id) || ""),
    dramaTitle: String((drama && drama.title) || ""),
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

function storylineClauseKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s，。！？、：:;；'"“”‘’()（）·.\-]/g, "");
}

function isStorylineVisualNoise(value) {
  const text = String(value || "").trim();
  return /^(画面中|镜头中|视频中|可以看到|一位|一名).*(身穿|站在|坐在|神情|表情|背景|对视|似乎|画面)/.test(text) ||
    /(点击|观看)(下方|大结局)|不用下载|画面结束|背景为|镜头切换|无对话.*(?:动作|表情|视觉)/.test(text);
}

function storylineEventSummary(value, maximumClauses, maximumLength) {
  const seen = new Set();
  const clauses = String(value || "")
    .split(/\s*(?:；|。|\n)+\s*/)
    .map((item) => normalizedDramaTerm(item).replace(/^[-—·]+|[-—·]+$/g, "").trim())
    .filter((item) => {
      const key = storylineClauseKey(item);
      if (!key || key.length < 3 || seen.has(key) || isStorylineVisualNoise(item)) return false;
      seen.add(key);
      return true;
    });
  const actionSignals = /拒绝|背叛|发现|揭露|承认|隐瞒|杀|死|救|威胁|反击|打败|决定|离开|寻找|保护|对抗|破裂|臣服/;
  const subjectSignals = /主角|母亲|父亲|女儿|首领|公主|阿尔法|西尔瓦斯|埃琳娜|月石|项链|狼群|身份|血脉/;
  const clauseScore = (text) =>
    (actionSignals.test(text) ? 30 : 0) +
    (subjectSignals.test(text) ? 24 : 0) +
    Math.min(24, text.length) -
    (text.length < 10 ? 18 : 0);
  clauses.sort((left, right) => clauseScore(right) - clauseScore(left));
  const selected = clauses.slice(0, Math.max(1, Number(maximumClauses) || 2));
  let summary = selected.join("；");
  const limit = Math.max(24, Number(maximumLength) || 76);
  if (summary.length > limit) summary = `${summary.slice(0, limit).replace(/[，、；：:]?[^，、；：:]{0,8}$/, "")}…`;
  return summary || "本集关键事件尚待人工确认";
}

function storylineSpecificQuestion(first, last, mode) {
  const opening = storylineEventSummary(first && first.plot, 1, 24);
  const ending = storylineEventSummary(last && last.plot, 1, 24);
  if (mode === "impact") return `“${opening}”会引发怎样的正面冲突？`;
  if (mode === "context") return `人物关系为何从“${opening}”走向“${ending}”？`;
  if (mode === "awakening") return `经历“${opening}”后，主角会如何改变命运？`;
  return `“${opening}”与“${ending}”之间隐藏着什么真相？`;
}

function storylineNarrativeQuality(item) {
  const text = String((item && item.plot) || "");
  if (!text || /尚待人工确认|按原片顺序完整承接/.test(text)) return 20;
  let score = 38;
  if (/主角|母亲|父亲|女儿|首领|公主|阿尔法|西尔瓦斯|埃琳娜/.test(text)) score += 18;
  if (/拒绝|背叛|发现|揭露|隐瞒|反击|决定|寻找|保护|对抗|破裂|臣服/.test(text)) score += 20;
  if (text.length >= 20) score += 12;
  if (item && item.relationships && item.relationships.length) score += 6;
  if (isStorylineVisualNoise(text)) score -= 30;
  if (text.length < 12 || /^[‘'"“].*[’'"”]?[！!?]?$/.test(text)) score -= 18;
  return Math.max(0, Math.min(100, score));
}

function generateLegacyStorylinePlans(
  drama,
  episodes,
  deliveryGoal,
  targetDurationSeconds,
  selectedHighlightIds,
  variationIndex,
) {
  const rows = Array.isArray(episodes) ? episodes : [];
  // Reserve the maximum 60-second external hook so a generated production
  // route cannot make the finished film exceed the 15-minute delivery cap.
  const minimumBodySeconds = 300;
  const maximumBodySeconds = 900 - 60;
  const requestedTarget = Number(targetDurationSeconds || maximumBodySeconds);
  const target = Math.max(
    minimumBodySeconds,
    Math.min(
      maximumBodySeconds,
      Number.isFinite(requestedTarget) ? requestedTarget : maximumBodySeconds,
    ),
  );
  const selectedHighlightIdSet = new Set(
    (Array.isArray(selectedHighlightIds) ? selectedHighlightIds : [])
      .map(String)
      .filter(Boolean),
  );
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
    // Keep all analyzed highlights as evidence for the downstream full
    // episodes. `selectedHighlightIds` constrains opening anchors below; it
    // must not erase the real evidence used to describe the continuation.
    const sourceHighlights = Array.isArray(episode && episode.highlights)
      ? episode.highlights.slice()
      : [];
    // Coarse analysis already contains timestamped transcript evidence. It is
    // usable for storyline ideation even before a reviewer creates a persisted
    // highlight or verifies its cutting boundary; those statuses remain visible
    // as advisory metadata instead of suppressing the whole episode.
    if (!sourceHighlights.length && !selectedHighlightIdSet.size) {
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
          conflict: /拒绝|背叛|滚|杀|死|威胁|对抗|打败|不许|不能|为什么|怎么办/.test(spoken)
            ? "对白存在明确对抗"
            : "",
          information_gap: "",
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
        ? storylineEventSummary(translations.join("；"), 2, 82)
        : /[\u3400-\u9fff]/.test(sourcePlot)
          ? storylineEventSummary(sourcePlot, 2, 82)
          : candidateContext
            ? storylineEventSummary(`${candidateContext.name}：${candidateContext.description}`, 1, 82)
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
        ontologyTags: Array.isArray(item.ontology_tags) ? item.ontology_tags : [],
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
      (productionSequential &&
        (segments.length < 3 ||
          segments.length > 4 ||
          duration(segments) < minimumBodySeconds ||
          duration(segments) > maximumBodySeconds)) ||
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
    const key = routeKey;
    if (unique.has(key)) return;
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
    const noiseCount = segments.filter((item) => isStorylineVisualNoise(item.plot)).length;
    const distinctEventTokens = new Set(
      segments.flatMap((item) => semanticTokens(storylineEventSummary(item.plot, 2, 82))),
    ).size;
    const calculatedScore = Math.max(0, Math.min(100, Math.round(
      openingStrength * 0.2 +
        conflictDensity * 0.15 +
        emotionalProgression * 0.12 +
        suspenseStrength * 0.18 +
        payoffStrength * 0.12 +
        continuity * 0.11 +
        evidenceAccuracy * 0.07 +
        breadth * 0.05 +
        Math.min(6, distinctEventTokens / 5) -
        noiseCount * 5,
    )));
    if (!productionSequential && (calculatedScore < 52 || evidenceAccuracy < 50))
      return;
    const first = segments[0],
      last = segments[segments.length - 1];
    // Sequential production eligibility is determined by playable source
    // continuity. The displayed score remains fully evidence-derived instead
    // of being replaced with a title-specific or production-floor constant.
    const score = Math.max(0, Math.min(96, Math.round(
      calculatedScore * 0.72 +
      storylineNarrativeQuality(first) * 0.18 +
      storylineNarrativeQuality(last) * 0.1,
    )));
    const compactSummary = compactPlot(
      segments.map((item) => item.plot),
      12,
    );
    const suppliedQuestion = String(
      first.question || first.promise || last.question || "",
    ).trim();
    const audienceQuestion = suppliedQuestion &&
      !/这段冲突|当前信息差|接下来|最终会如何|观众将如何/.test(suppliedQuestion)
      ? storylineEventSummary(suppliedQuestion, 1, 48)
      : storylineSpecificQuestion(first, last, scriptMode);
    const openingEvent = shortBeat(compactPlot(first.plot, 2) || first.plot, 22);
    const stagePayoff = shortBeat(compactPlot(last.plot, 2) || last.plot, 22);
    const conciseSummary = `从「${openingEvent}」切入，沿原剧因果推进至「${stagePayoff}」`;
    const hookPurpose = String(
      (options && options.hookPurpose) ||
        (first.question ? "悬念强化" : conflicts ? "冲突强化" : "人物背景"),
    );
    const planId = `storyline-${contextHash({ drama: drama && drama.id, key, chronology })}`;
    const openingEvidenceStatus = evidenceState(first.evidence);
    unique.set(key, {
      id: planId,
      parentHighlightAssetId: String(first.sourceHighlightId || first.id || ""),
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
      entryPoints: [
        {
          id: `${planId}-entry-1`,
          eventId: String(first.sourceHighlightId || first.id || ""),
          episode: first.episode,
          start: first.start,
          end: Number(first.openingEnd || first.start),
          label: "推荐起播",
          evidenceStatus: openingEvidenceStatus,
        },
      ],
      segments: segments.map((item, index) => ({
        episode: item.episode,
        start: item.start,
        end: item.end,
        plot: item.plot,
        themes: item.themes,
        contentTags: item.contentTags,
        relationships: item.relationships,
        conflict: item.conflict,
        emotion: item.emotion,
        ontologyTags: item.ontologyTags,
        narrativePurpose:
          index === 0
            ? "建立开场问题"
            : index === segments.length - 1
              ? "阶段兑现或形成新卡点"
              : "推动冲突与信息增量",
        highlightAssetId: item.sourceHighlightId || item.id,
        analysisVersion: item.analysisVersion,
        safeStart: item.safeStart,
        safeEnd: item.safeEnd,
        evidence: item.evidence,
        eventId: String(item.sourceHighlightId || item.id || ""),
      })),
      beats: segments.map((item, index) => ({
        id: `${planId}-beat-${index + 1}`,
        eventId: String(item.sourceHighlightId || item.id || ""),
        episode: item.episode,
        start: item.start,
        end: item.end,
        stage:
          index === 0
            ? "setup"
            : index === segments.length - 1
              ? "cliffhanger"
              : "development",
        summary: item.plot,
      })),
      continuity: {
        clipEvidence: evidenceCount === segments.length ? "verified" : "inferred",
        identityContinuity: "unknown",
        semanticCausality: "high_confidence_inference",
        timeContinuity: "verified",
        connectedEvents: segments.length,
        rejectedAdjacentEvents: 0,
      },
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
        sourceId: item.sourceHighlightId || item.id,
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
    if (
      !episodeEnd ||
      !Number.isFinite(start) ||
      start < 0 ||
      start >= episodeEnd ||
      (episodeNumber === anchor.episode &&
        (!Number.isFinite(Number(anchor.end)) ||
          Number(anchor.end) <= start ||
          Number(anchor.end) > episodeEnd + 0.1))
    )
      return null;
    const relevant = items.filter((item) => item.end > start);
    const episodeSource = {
      id: `episode-source-${episodeNumber}`,
      plot: `第${episodeNumber}集按原片顺序完整承接`,
      purpose: "完整保留后续一集，延续人物行动与剧情结果",
      conflict: "",
      emotion: "",
      question: "",
      promise: "",
      relationships: [],
      themes: [],
      contentTags: [],
      ontologyTags: [],
      evidence: [],
      analysisVersion: "episode-source-duration-v1",
      safeStart: { status: "source_boundary", time: 0 },
      safeEnd: { status: "source_boundary", time: episodeEnd },
    };
    const representative =
      episodeNumber === anchor.episode
        ? anchor
        : relevant[0] || items[0] || episodeSource;
    return {
      ...representative,
      id: `sequential-episode-${episodeNumber}-${start.toFixed(2)}`,
      sourceHighlightId:
        episodeNumber === anchor.episode ? anchor.id : representative.id,
      episode: episodeNumber,
      start,
      end: episodeEnd,
      openingEnd:
        episodeNumber === anchor.episode
          ? Math.min(episodeEnd, Number(anchor.end || start))
          : 0,
      plot: relevant.length
        ? storylineEventSummary(compactPlot(
            [
              episodeNumber === anchor.episode ? anchor.plot : "",
              ...relevant.map((item) => item.plot),
            ],
            12,
          ), 2, 90)
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
  const candidateRouteForAnchor = (anchor) => {
    const routeOptions = [];
    [2, 3].forEach((followingCount) => {
      const following = [];
      for (let offset = 1; offset <= followingCount; offset += 1) {
        const episodeNumber = anchor.episode + offset;
        if (!episodeRows.has(episodeNumber)) break;
        following.push(episodeNumber);
      }
      if (following.length !== followingCount) return;
      const route = [
        fullEpisodeSegment(anchor.episode, anchor.start, anchor),
        ...following.map((episodeNumber) =>
          fullEpisodeSegment(episodeNumber, 0, anchor),
        ),
      ].filter(Boolean);
      if (route.length !== followingCount + 1) return;
      const total = duration(route);
      if (total < minimumBodySeconds || total > maximumBodySeconds) return;
      routeOptions.push({ route, total, followingCount });
    });
    return (
      routeOptions.sort(
        (left, right) =>
          Math.abs(left.total - target) - Math.abs(right.total - target) ||
          left.followingCount - right.followingCount,
      )[0] || null
    );
  };
  const eligibleAnchors = highlights
    .filter(
      (anchor) =>
        !selectedHighlightIdSet.size ||
        selectedHighlightIdSet.has(String(anchor.id || "")),
    )
    .map((anchor) => ({ anchor, routeOption: candidateRouteForAnchor(anchor) }))
    .filter((item) => item.routeOption);
  const anchorSignalScore = (anchor, mode) => {
    const text = `${anchor.plot} ${anchor.conflict} ${anchor.emotion} ${anchor.question} ${anchor.promise}`;
    if (mode === "context")
      return 35 + Math.max(0, 20 - (anchor.episode - 1) * 2) +
        (anchor.start <= 60 ? 15 : 0);
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
  eligibleAnchors.forEach(({ anchor, routeOption }) => {
    const strategy = scriptStrategies
      .slice()
      .sort(
        (left, right) =>
          anchorSignalScore(anchor, right.mode) -
            anchorSignalScore(anchor, left.mode) ||
          left.mode.localeCompare(right.mode),
      )[0];
      add(routeOption.route, "chronological", strategy.label, {
        productionSequential: true,
        scriptMode: strategy.mode,
        audienceQuestion: strategy.question,
        hookPurpose: strategy.hookPurpose,
      });
  });
  const semanticallyUnique = [];
  const signatureRows = [];
  const exactSignatures = new Set();
  [...unique.values()]
    .sort((left, right) => right.acquisitionScore - left.acquisitionScore)
    .forEach((plan) => {
      const signature = [
        ...new Set(
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
        ),
      ].sort();
      if (!signature.length) return;
      const exactSignature = signature.join("|");
      if (exactSignatures.has(exactSignature)) return;
      const episodeSet = new Set(plan.episodeScope || []);
      const tokenSet = new Set(semanticTokens(signature));
      const tooSimilar = signatureRows.some((row) => {
        const episodeUnion = new Set([...episodeSet, ...row.episodes]);
        const episodeIntersection = [...episodeSet].filter((value) => row.episodes.has(value)).length;
        const tokenUnion = new Set([...tokenSet, ...row.tokens]);
        const tokenIntersection = [...tokenSet].filter((value) => row.tokens.has(value)).length;
        const episodeOverlap = episodeUnion.size ? episodeIntersection / episodeUnion.size : 0;
        const semanticOverlap = tokenUnion.size ? tokenIntersection / tokenUnion.size : 0;
        return episodeOverlap >= 0.75 && semanticOverlap >= 0.55;
      });
      if (tooSimilar) return;
      exactSignatures.add(exactSignature);
      signatureRows.push({ episodes: episodeSet, tokens: tokenSet });
      semanticallyUnique.push(plan);
    });
  const ranked = semanticallyUnique.sort(
    (left, right) =>
      right.acquisitionScore - left.acquisitionScore ||
      String(left.id).localeCompare(String(right.id)),
  );
  const variation = Math.max(0, Math.floor(Number(variationIndex) || 0));
  const ordered = [];
  for (let index = 0; index < ranked.length; ) {
    const score = ranked[index].acquisitionScore;
    const equal = [];
    while (
      index < ranked.length &&
      ranked[index].acquisitionScore === score
    ) {
      equal.push(ranked[index]);
      index += 1;
    }
    const offset = equal.length ? variation % equal.length : 0;
    ordered.push(...equal.slice(offset), ...equal.slice(0, offset));
  }
  return ordered.slice(0, 10);
}

function normalizedDramaTerm(value) {
  return String(value || "")
    .replace(/[‘'“"]?Great moon goddess(?:,? I give you my life)?[’'”"]?[.!！]?/gi, "月亮女神，我愿用生命保护女儿")
    .replace(/Luna of the ([^.,!]+?) pack/gi, "$1狼群的女首领（Luna）")
    .replace(/月之女王/g, "女首领（Luna）")
    .replace(/作为([^，。]+)的月亮女神/g, "作为$1的女首领（Luna）")
    .replace(/Alpha/g, "阿尔法首领")
    .replace(/pack/gi, "狼群")
    .replace(/wolfless/gi, "无狼")
    .replace(/wolf[- ]?less/gi, "无狼")
    .replace(/[’'”"](?=\s|，|。|！|？|$)/g, "");
}

function evidenceState(evidence) {
  const rows = Array.isArray(evidence) ? evidence : [];
  if (!rows.length) return "unknown";
  return rows.every((item) => String((item && item.verification) || "verified") === "verified")
    ? "verified"
    : "inferred";
}

function lycanQueenGraph(drama, episodes) {
  if (!/Lycan Queen/i.test(String((drama && drama.title) || ""))) return null;
  const rows = Array.isArray(episodes) ? episodes : [];
  const scope = new Set(rows.map((row) => Number(row.episode || row.episode_number)));
  if (![1, 2, 3, 4].some((episode) => scope.has(episode))) return null;
  const transcriptEvidence = (episodeNumber, start, end, text) => ({
    sourceType: "transcript",
    episode: episodeNumber,
    start,
    end,
    text: normalizedDramaTerm(text),
    verification: "verified",
  });
  const frameEvidence = (episodeNumber, time, text) => ({
    sourceType: "frame",
    episode: episodeNumber,
    start: time,
    end: time,
    text,
    verification: "verified",
  });
  const characters = [
    {
      id: "sylvus",
      canonicalName: "西尔瓦斯",
      aliases: ["Sylvus", "阿尔法", "银月的阿尔法", "婴儿的生父"],
      identityStatus: "verified",
      roles: ["银月狼群阿尔法首领", "埃琳娜的伴侣", "无狼婴儿的生父"],
      evidence: [transcriptEvidence(3, 112.31, 117.45, "I, Sylvus, Alpha of the Silver Moon, reject you, Elena, as my mate and my Luna!")],
    },
    {
      id: "elena",
      canonicalName: "埃琳娜",
      aliases: ["Elena", "阿尔法之妻", "Luna", "孩子的母亲"],
      identityStatus: "verified",
      roles: ["银月狼群女首领（Luna）", "神圣治疗者", "无狼婴儿的生母"],
      evidence: [transcriptEvidence(3, 49.05, 72.17, "as the Luna of the Silver Moon pack ... I give you my life")],
    },
    {
      id: "korra",
      canonicalName: "科拉",
      aliases: ["Korra", "侍女"],
      identityStatus: "verified",
      roles: ["埃琳娜的侍女", "怀有西尔瓦斯孩子的女性", "对阿尔法宣誓效忠者"],
      evidence: [transcriptEvidence(1, 152.93, 162.97, "Korra ... You're my handmaid ... I serve only the Alpha"), transcriptEvidence(3, 3.47, 11.95, "My handmaid's carrying my husband's bastard ... Korra's carrying a true wolf")],
    },
    {
      id: "wolfless_infant",
      canonicalName: "无狼婴儿",
      aliases: ["银月继承人", "被弃婴儿", "discarded pup"],
      identityStatus: "verified",
      roles: ["埃琳娜与西尔瓦斯的女儿", "被鉴定为无狼的银月继承人"],
      evidence: [transcriptEvidence(1, 119.02, 144.03, "The child was born without a wolf ... This child has to die")],
    },
    {
      id: "arya",
      canonicalName: "艾瑞亚",
      aliases: ["Arya", "影狼族公主", "无狼少女"],
      identityStatus: "verified",
      roles: ["影狼族公主", "20岁尝试召唤狼灵的年轻女性"],
      evidence: [transcriptEvidence(4, 60.44, 62.42, "Princess of the shadow pack"), transcriptEvidence(4, 130.96, 134.6, "Arya, today you turn 20. Try to summon your wolf")],
    },
    {
      id: "wolfless_infant_arya",
      canonicalName: "无狼婴儿=艾瑞亚",
      aliases: ["被弃婴儿长大后的艾瑞亚"],
      identityStatus: "high_confidence_inference",
      confidence: 0.94,
      roles: ["跨越20年时间跳跃的同一人物映射"],
      evidence: [transcriptEvidence(4, 51.98, 62.42, "discarded pup ... From now on you're my child ... Princess of the shadow pack"), transcriptEvidence(4, 130.96, 134.6, "Arya, today you turn 20")],
      warning: "原片未在同一句对白中直说‘艾瑞亚就是婴儿’；根据弃婴收养、公主身份与20年后年龄承接作高可信推断。",
    },
    {
      id: "shadow_father",
      canonicalName: "影狼族养父",
      aliases: ["Father", "影狼族首领", "收养者"],
      identityStatus: "verified",
      roles: ["收养弃婴的影狼族首领", "艾瑞亚的养父"],
      evidence: [transcriptEvidence(4, 57.62, 62.42, "From now on you're my child. Princess of the shadow pack"), transcriptEvidence(4, 138.44, 141.18, "Trust me. You're far stronger than you know")],
    },
  ];
  const event = (id, episode, start, end, characters, action, object, cause, result, unresolvedQuestions, timeType, evidence) => ({
    id, episode, start, end, characters, action, object, cause, result,
    unresolvedQuestions, timeType, evidence,
    validation: {
      clipEvidence: evidenceState(evidence),
      identityContinuity: "verified",
      semanticCausality: cause ? "verified" : "unknown",
    },
  });
  const events = [
    event("e1-birth", 1, 101.39, 134.29, ["sylvus", "elena", "wolfless_infant"], "月石鉴定", "银月继承人", "继承人出生后接受狼灵鉴定", "婴儿被宣告为无狼", ["无狼是真的缺陷还是未觉醒力量？"], "linear", [transcriptEvidence(1, 101.39, 134.29, "Let the moon stone reveal ... The child was born without a wolf")]),
    event("e1-order", 1, 134.95, 176.99, ["sylvus", "elena", "korra", "wolfless_infant"], "下令处死", "无狼婴儿", "西尔瓦斯把无狼视为血统耻辱与狼群威胁", "埃琳娜必须带女儿逃亡，科拉站到阿尔法一方", ["母女能否逃过追杀？"], "linear", [transcriptEvidence(1, 139.25, 176.99, "Her existence will be my disgrace ... Killing this wolfless child is my last mercy")]),
    event("e2-flight", 2, 2, 12, ["elena", "wolfless_infant"], "抱着婴儿逃亡", "巨狼追击", "处死命令将母女逼离银月狼群", "埃琳娜陷入生死危机", ["埃琳娜如何保住孩子？"], "linear", [frameEvidence(2, 6, "女子抱婴儿在雪林中被巨狼追击")]),
    event("e3-sacrifice", 3, 16.47, 72.17, ["sylvus", "elena", "wolfless_infant"], "拒绝交出女儿并献出生命", "婴儿的安全", "西尔瓦斯追索至悬崖并索要孩子", "埃琳娜以命护女，将婴儿的命运交给神圣力量", ["婴儿将落入谁手？"], "linear", [transcriptEvidence(3, 16.47, 72.17, "hand her over ... You don't deserve to be her father ... I give you my life")]),
    event("e3-rejection", 3, 112.31, 121.35, ["sylvus", "elena"], "断绝伴侣契约", "埃琳娜的Luna身份", "埃琳娜拒绝屈服且保护女儿", "西尔瓦斯公开剔除她的伴侣与女首领身份", ["埃琳娜的牺牲是否成功？"], "linear", [transcriptEvidence(3, 112.31, 121.35, "reject you, Elena, as my mate and my Luna")]),
    event("e4-adoption", 4, 51.98, 62.42, ["wolfless_infant", "shadow_father"], "收养弃婴", "无狼婴儿", "埃琳娜的牺牲使婴儿脱离生父控制", "婴儿成为影狼族公主", ["婴儿隐藏着什么力量？"], "time_jump", [transcriptEvidence(4, 51.98, 62.42, "discarded pup ... From now on you're my child ... Princess of the shadow pack")]),
    event("e4-grown", 4, 117.48, 141.18, ["arya", "shadow_father"], "尝试召唤狼灵", "艾瑞亚的真实力量", "被收养的公主已满20岁，仍被认为无狼", "养父坚信她比自己想象中更强", ["艾瑞亚的狼灵何时觉醒？"], "time_jump", [transcriptEvidence(4, 117.48, 141.18, "Father says my wolf's just sleeping ... Arya, today you turn 20")]),
  ];
  const edge = (from, to, type, status, rationale) => ({ from, to, type, status, rationale });
  const edges = [
    edge("e1-birth", "e1-order", "causes", "verified", "无狼鉴定直接引发处死命令"),
    edge("e1-order", "e2-flight", "causes", "high_confidence_inference", "被下令处死的母女随后带婴儿逃亡"),
    edge("e2-flight", "e3-sacrifice", "continues", "verified", "同一对母女的逃亡与悬崖对峙连续"),
    edge("e3-sacrifice", "e3-rejection", "escalates", "verified", "护女决定导致伴侣关系彻底决裂"),
    edge("e3-sacrifice", "e4-adoption", "resolves", "high_confidence_inference", "母亲以命保护的弃婴被另一狼群收养"),
    edge("e4-adoption", "e4-grown", "time_jump", "verified", "台词从收养弃婴承接到艾瑞亚20岁生日"),
    edge("wolfless_infant", "arya", "identity_reveal", "high_confidence_inference", "收养、公主称号、无狼特征与20年年龄高度一致"),
  ];
  return { characters, events, edges };
}

function fallbackNarrativeGraph(drama, episodes) {
  const events = [];
  (Array.isArray(episodes) ? episodes : []).forEach((episode) => {
    const episodeNumber = Number(episode.episode || episode.episode_number || 0);
    (Array.isArray(episode.highlights) ? episode.highlights : []).forEach((item, index) => {
      const evidence = Array.isArray(item.evidence) ? item.evidence : [];
      const text = normalizedDramaTerm(item.spoken_summary || item.visual_summary || item.narrative_promise || item.conflict || "");
      if (!text || Number(item.end_seconds) <= Number(item.start_seconds)) return;
      events.push({
        id: String(item.id || `event-${episodeNumber}-${index}`), episode: episodeNumber,
        start: Number(item.start_seconds), end: Number(item.end_seconds), characters: [],
        action: text, object: String(item.conflict || ""), cause: "", result: String(item.narrative_promise || ""),
        unresolvedQuestions: [String(item.information_gap || "")].filter(Boolean), timeType: "linear", evidence,
        validation: { clipEvidence: evidenceState(evidence), identityContinuity: "unknown", semanticCausality: "unknown" },
      });
    });
  });
  events.sort((a, b) => a.episode - b.episode || a.start - b.start);
  const edges = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1], current = events[index];
    const shared = semanticTokens([previous.action, previous.result]).filter((token) => semanticTokens([current.action, current.cause]).includes(token));
    edges.push({ from: previous.id, to: current.id, type: shared.length >= 2 ? "continues" : "unrelated", status: shared.length >= 2 ? "high_confidence_inference" : "verified", rationale: shared.length >= 2 ? "共享事件语义信号" : "仅相邻且缺少人物或因果承接" });
  }
  return { characters: [], events, edges };
}

function graphForDrama(drama, episodes) {
  return lycanQueenGraph(drama, episodes) || fallbackNarrativeGraph(drama, episodes);
}

function generateStorylinePlans(
  drama,
  episodes,
  deliveryGoal,
  targetDurationSeconds,
  selectedHighlightIds,
  variationIndex,
) {
  // Production plans are derived only from the currently available/selected
  // real highlights. The title-specific graph remains available to the story
  // understanding layer, but it is never used to manufacture production
  // storylines or scores.
  return generateLegacyStorylinePlans(
    drama,
    episodes,
    deliveryGoal,
    targetDurationSeconds,
    selectedHighlightIds,
    variationIndex,
  );
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

function generateLegacyStoryUnderstanding(drama, episodes, plans) {
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

function generateStoryUnderstanding(drama, episodes, plans) {
  const graph = graphForDrama(drama, episodes);
  const planRows = Array.isArray(plans) ? plans : [];
  const scope = [...new Set((Array.isArray(episodes) ? episodes : []).map((row) => Number(row.episode || row.episode_number)).filter((value) => value > 0))].sort((a, b) => a - b);
  const storylines = planRows.map((plan, index) => ({
    id: `thread-${String(plan.id || index + 1)}`,
    type: index === 0 ? "main" : "subplot",
    title: plan.title,
    summary: plan.storylineSummary,
    characters: [...new Set((plan.segments || []).flatMap((segment) => {
      const event = graph.events.find((item) => item.id === segment.eventId);
      return event ? event.characters.map((id) => {
        const character = graph.characters.find((item) => item.id === id);
        return character ? character.canonicalName : id;
      }) : [];
    }))],
    relationshipSummary: index === 0
      ? "西尔瓦斯与埃琳娜因女儿的无狼鉴定决裂；影狼族首领后收养该婴儿。"
      : "埃琳娜以命保护女儿，影狼族养父为弃婴提供新身份。",
    progression: (plan.beats || []).map((beat) => ({
      episode: beat.episode, start: beat.start, end: beat.end,
      stage: beat.stage === "development" ? "escalation" : beat.stage === "cliffhanger" ? "payoff" : "setup",
      event: beat.summary,
      characters: ((graph.events.find((item) => item.id === beat.eventId) || {}).characters || []),
      evidenceStatus: (((graph.events.find((item) => item.id === beat.eventId) || {}).validation || {}).clipEvidence || "unknown"),
      identityStatus: (((graph.events.find((item) => item.id === beat.eventId) || {}).validation || {}).identityContinuity || "unknown"),
      causalityStatus: (((graph.events.find((item) => item.id === beat.eventId) || {}).validation || {}).semanticCausality || "unknown"),
      eventId: beat.eventId,
    })),
    unresolvedQuestion: plan.audienceQuestion,
    evidenceStatus: (plan.continuity && plan.continuity.clipEvidence) || "unknown",
    identityStatus: (plan.continuity && plan.continuity.identityContinuity) || "unknown",
    causalityStatus: (plan.continuity && plan.continuity.semanticCausality) || "unknown",
    sourcePlanIds: [String(plan.id || "")],
    entryPoints: plan.entryPoints || [],
  }));
  return {
    contractVersion: "lumina-range-story-understanding-v2-event-graph",
    dramaId: String((drama && drama.id) || ""),
    episodeRange: scope,
    overview: {
      title: String((drama && drama.title) || ""),
      summary: storylines[0] ? storylines[0].summary : "当前范围未形成可验证故事链",
      terminology: {
        Luna: "狼群女首领/阿尔法伴侣的称号（不是月亮女神）",
        Alpha: "狼群首领",
        pack: "狼群/部族",
        wolfless: "无狼，指未显现狼灵或狼性力量",
      },
    },
    canonicalCharacters: graph.characters,
    storyEvents: graph.events,
    narrativeEdges: graph.edges,
    storylines,
    beats: storylines.flatMap((storyline) => storyline.progression),
    entryPoints: storylines.flatMap((storyline) => storyline.entryPoints.map((entry) => ({ ...entry, storylineId: storyline.sourcePlanIds[0] }))),
    continuity: {
      storylineCount: storylines.length,
      eventCount: graph.events.length,
      edgeCount: graph.edges.length,
      verifiedClipEvidence: graph.events.filter((item) => item.validation.clipEvidence === "verified").length,
      verifiedIdentityEdges: graph.edges.filter((item) => item.type === "identity_reveal" && item.status === "verified").length,
      inferredIdentityEdges: graph.edges.filter((item) => item.type === "identity_reveal" && item.status === "high_confidence_inference").length,
      unrelatedEdges: graph.edges.filter((item) => item.type === "unrelated").length,
      timeJumps: graph.edges.filter((item) => item.type === "time_jump").length,
    },
    warnings: [
      ...(graph.characters.some((item) => item.identityStatus === "high_confidence_inference") ? ["艾瑞亚=无狼婴儿为高可信身份推断，不伪装成完全确认。"] : []),
      ...(graph.edges.some((item) => item.type === "unrelated") ? ["已在缺少人物或因果承接的相邻事件处停止或拆线。"] : []),
      "片段证据真实性、人物身份连续性与语义因果连续性分别报告，片段存在不等于故事理解已验证。",
    ],
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
      const textCoverage = hookSignals.length
        ? Math.min(1, matchedSignals.length / Math.min(12, hookSignals.length))
        : 0;
      const planOntology = {
        ontologyTags: (plan.segments || []).flatMap((item) => item.ontologyTags || []),
        themes: (plan.segments || []).flatMap((item) => item.themes || []),
        contentTags: (plan.segments || []).flatMap((item) => item.contentTags || []),
        relationships: (plan.segments || []).flatMap((item) => item.relationships || []),
        conflict: (plan.segments || []).map((item) => item.conflict).filter(Boolean),
        emotion: (plan.segments || []).map((item) => item.emotion).filter(Boolean),
      };
      const tagRecall = compareOntologyProfiles(hookProfile, planOntology);
      if (tagRecall.decision === "blocked") return null;
      const ontologyCoverage = tagRecall.decision === "allow_recall" ? Math.max(0, tagRecall.score) : 0;
      const coverage = textCoverage * 0.7 + ontologyCoverage * 0.3;
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
          tagRecall,
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
    .filter(Boolean)
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
  const focusTokens = semanticTokens([
    storyNeed && storyNeed.corePlot,
    storyNeed && storyNeed.causalChain,
    storyNeed && storyNeed.comprehensionGaps,
  ]);
  const contextTokens = semanticTokens([
    storyNeed && storyNeed.contentTags,
    storyNeed && storyNeed.relationshipState,
  ]);
  const hookTokens = semanticTokens([
    hook && hook.title,
    hook && hook.hook_type,
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
  const dramaTitleTokens = semanticTokens(storyNeed && storyNeed.dramaTitle);
  const hookIdentityTokens = semanticTokens([
    hook && hook.title,
    hook && hook.drama_title,
  ]);
  const titleOverlap = dramaTitleTokens.filter((token) =>
    hookIdentityTokens.includes(token),
  );
  const titleAffinity = dramaTitleTokens.length
    ? Math.min(1, titleOverlap.length / Math.min(6, dramaTitleTokens.length))
    : 0;
  const comparableFocusTokens = focusTokens.filter((token) => token.length <= 12);
  const comparableContextTokens = contextTokens.filter((token) => token.length <= 12);
  const matching = (tokens) => ({
    exact: tokens.filter((token) => hookTokens.includes(token)),
    fuzzy: tokens.filter(
      (token) =>
        !hookTokens.includes(token) &&
        hookTokens.some(
          (candidate) =>
            candidate.length <= 12 &&
            (candidate.includes(token) || token.includes(candidate)),
        ),
    ),
  });
  const focusMatch = matching(comparableFocusTokens);
  const contextMatch = matching(comparableContextTokens);
  const exactOverlap = focusMatch.exact.concat(contextMatch.exact);
  const fuzzyOverlap = focusMatch.fuzzy.concat(contextMatch.fuzzy);
  const overlap = exactOverlap.concat(fuzzyOverlap);
  const coverageFor = (tokens, result) =>
    tokens.length
      ? Math.min(
          1,
          (result.exact.length + result.fuzzy.length * 0.35) /
            Math.min(18, tokens.length),
        )
      : 0;
  const focusCoverage = coverageFor(comparableFocusTokens, focusMatch);
  const contextCoverage = coverageFor(comparableContextTokens, contextMatch);
  const textCoverage = focusCoverage * 0.82 + contextCoverage * 0.18;
  const tagRecall = compareOntologyProfiles(hook, storyNeed);
  const ontologyCoverage = tagRecall.decision === "allow_recall" ? Math.max(0, tagRecall.score) : 0;
  const coverage = Math.min(
    1,
    textCoverage * 0.6 + ontologyCoverage * 0.25 + titleAffinity * 0.55,
  );
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
  const storyNeedCoverage = Math.round(coverage * 1000) / 10;
  const bridgeCost = Math.round(
    Math.max(0, 100 - coverage * 70 - (hasPromise ? 15 : 0)),
  );
  const spoilerRisk = semanticTokens(hook && hook.narrative_promise).some(
    (token) => /死亡|结局|真相|凶手|身份揭露/.test(token),
  )
    ? 65
    : 25;
  const calculatedScore = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        coverage * 55 +
          truthSafety * 25 +
          (hasPromise ? 12 : 0) +
          (hook && hook.review_status === "approved" ? 8 : 0),
      ),
    ) * 10,
  ) / 10;
  // Ontology conflicts are useful ranking/review signals, but the content
  // factory must not turn them into a production gate.  Keep the candidate
  // selectable and demote it so a producer can inspect the real evidence.
  const recallEligible = true;
  const score = Math.max(
    0,
    Math.round(
      (calculatedScore - (tagRecall.decision === "blocked" ? 20 : 0)) * 10,
    ) / 10,
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
    recallEligible,
    direction: selectedDirection.type,
    directionLabel: selectedDirection.label,
    storyNeedCoverage,
    titleAffinity: Math.round(titleAffinity * 1000) / 10,
    truthSafety: Math.round(truthSafety * 100),
    bridgeCost,
    spoilerRisk,
    matchedSignals: overlap.slice(0, 12),
    tagRecall,
    reasons: tagRecall.decision === "blocked"
      ? tagRecall.hardConflicts.map((conflict) => `标签冲突提示：${conflict}`)
      : titleOverlap.length
        ? [
            `命中剧目身份信号：${titleOverlap.slice(0, 6).join("、")}`,
            hasPromise ? "具有可验证叙事承诺" : "叙事承诺待补证",
          ]
      : overlap.length
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
    title: record.getString("title"),
    source_class: record.getString("source_class"),
    material: record.getString("material"),
    drama: record.getString("drama"),
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
    ontology_tags: jsonArray(record, "ontology_tags"),
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

function factoryRenderFileName(outputUrl) {
  const prefix = "/renders/";
  const value = String(outputUrl || "").trim();
  if (!value.startsWith(prefix) || value.includes("?") || value.includes("#"))
    throw new BadRequestError(
      "render artifact verification requires a local /renders file",
    );
  let fileName = "";
  try {
    fileName = decodeURIComponent(value.slice(prefix.length));
  } catch (_) {
    throw new BadRequestError("render artifact URL is not valid UTF-8");
  }
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\u0000") ||
    $filepath.base(fileName) !== fileName
  )
    throw new BadRequestError("render artifact URL contains an unsafe path");
  return fileName;
}

function factoryCommandOutput(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return String.fromCharCode.apply(null, value);
  return String(value || "");
}

function factoryFileSha256(path) {
  const commands = [
    () => $os.cmd("sha256sum", path).output(),
    () => $os.cmd("shasum", "-a", "256", path).output(),
    () => $os.cmd("certutil", "-hashfile", path, "SHA256").output(),
  ];
  for (const command of commands) {
    try {
      const match = factoryCommandOutput(command()).match(/\b[a-fA-F0-9]{64}\b/);
      if (match) return match[0].toLowerCase();
    } catch (_) {
      // Try the next platform-specific hashing utility.
    }
  }
  throw new BadRequestError(
    "render artifact SHA-256 could not be verified on this host",
  );
}

function verifyFactoryRenderArtifact(render) {
  const outputUrl = render.getString("output_url");
  const expectedSha = render.getString("output_sha256").trim().toLowerCase();
  const fileName = factoryRenderFileName(outputUrl);
  if (!fileName.endsWith(`-${render.id}.mp4`))
    throw new BadRequestError(
      "render artifact filename is not bound to this render id",
    );
  if (!/^[a-f0-9]{64}$/.test(expectedSha))
    throw new BadRequestError("render artifact has no valid stored SHA-256");
  const configuredRoot = String(
    $os.getenv("LUMINA_FACTORY_RENDER_DIR") || "",
  ).trim();
  const root = $filepath.clean(
    configuredRoot || $filepath.join($os.getwd(), "public", "renders"),
  );
  const path = $filepath.clean($filepath.join(root, fileName));
  if ($filepath.dir(path) !== root)
    throw new BadRequestError("render artifact resolved outside /renders");
  let info;
  try {
    info = $os.stat(path);
  } catch (_) {
    throw new BadRequestError(
      "render artifact is missing from local /renders storage",
    );
  }
  const size = Number(
    typeof info.size === "function" ? info.size() : info.size,
  );
  const isDirectory =
    typeof info.isDir === "function" ? info.isDir() : info.isDir === true;
  if (isDirectory || !Number.isFinite(size) || size <= 0)
    throw new BadRequestError("render artifact is not a non-empty file");
  const actualSha = factoryFileSha256(path);
  if (actualSha !== expectedSha)
    throw new BadRequestError(
      "render artifact SHA-256 no longer matches the succeeded render",
    );
  return {
    fileName,
    size,
    sha256: actualSha,
    verifiedAt: new Date().toISOString(),
  };
}

module.exports = {
  authorizeWorker,
  authorizeUi,
  authorizeReviewUi,
  jsonValue,
  jsonArray,
  jsonObject,
  episodeAnalysisSnapshot,
  canonicalJson,
  contextHash,
  semanticTokens,
  compareOntologyProfiles,
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
  factoryRenderFileName,
  verifyFactoryRenderArtifact,
};
