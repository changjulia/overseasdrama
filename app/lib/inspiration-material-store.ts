"use client";

import { normalizeTag, type OntologyDimension } from "./ontology/normalization";

export type InspirationMaterialType =
  "未确定" | "正片剧集拼接" | "正片剧集解说" | "外搭钩子＋本剧正片";
export type InspirationAnalysisStatus =
  "queued" | "running" | "succeeded" | "failed" | "idle";

export type MaterialEvidence = {
  id?: string;
  kind: "asr" | "ocr" | "frame" | "shot" | "audio" | string;
  start: number;
  end: number;
  text?: string;
  translation?: string;
  observation?: string;
  supports?: string;
  sourceText?: string;
  evidenceClass?: "narrative" | "auxiliary" | "technical";
  confidence: number;
  verification?: "verified" | "needs_review" | "rejected" | string;
};

export type MaterialTag = {
  code: string;
  label: string;
  confidence: number;
  evidence?: string[];
  evidenceSources?: string[];
  verification?: "verified" | "needs_review" | "rejected" | string;
};

export type MaterialSegment = {
  code: string;
  label: string;
  start: number;
  end: number;
  description?: string;
  confidence?: number;
  evidence?: string[];
};

export type MaterialObservation = {
  factId: string;
  start: number;
  end: number;
  actorObserved: string;
  actionObserved: string;
  objectOrTargetObserved?: string;
  resultObserved?: string;
  verification?: string;
};
export type MaterialInference = MaterialTag & {
  statement: string;
  inferenceType?: string;
  basedOnFactIds: string[];
};

export type MaterialAnalysisV2 = {
  schemaVersion: "material-v2" | string;
  evidence: MaterialEvidence[];
  content: {
    summary?: string;
    completeness?: string;
    observations: MaterialObservation[];
    inferences: MaterialInference[];
    genres: MaterialTag[];
    themes: MaterialTag[];
    characters: MaterialTag[];
    relations: MaterialTag[];
    emotions: MaterialTag[];
    conflicts: MaterialTag[];
    storyBeats: MaterialTag[];
    scenes: MaterialTag[];
    storyboardUnits: MaterialSegment[];
  };
  creative: {
    materialType?: MaterialTag;
    tLevel?: MaterialTag;
    bodyFormat?: MaterialTag;
    hookSourceStatus?: MaterialTag;
    hookAssemblyType?: MaterialTag;
    narrationCoverage?: number;
    hook?: {
      start?: number;
      end?: number;
      hookType?: string;
      source?: string;
      plotSummary?: string;
      spokenSummary?: string;
      visualSummary?: string;
      narrativePromise?: string;
      informationGap?: string;
      mechanisms: MaterialTag[];
      sensoryChannels: MaterialTag[];
      emotionCurve?: { start?: string; peak?: string; endSuspense?: string };
      informationStructure?: {
        audienceKnows?: string;
        characterKnows?: string;
        unrevealed?: string;
      };
      exitState?: {
        lastLine?: string;
        lastAction?: string;
        facing?: string;
        shotScale?: string;
        audioClosure?: string;
      };
      intensity?: {
        conflict?: number;
        informationDensity?: number;
        comprehensionBarrier?: number;
        first3sStimulus?: number;
      };
    };
    timeline: MaterialSegment[];
    packaging: MaterialTag[];
    transitions: MaterialTag[];
  };
  value: {
    scores: Array<{
      code: string;
      label: string;
      score: number;
      reason?: string;
      evidence?: string[];
    }>;
    inspirations: string[];
    avoid: string[];
    suitableGenres: string[];
    suitableAudiences: string[];
  };
  review: {
    status?: string;
    reviewRequired?: boolean;
    items: Array<{
      id: string;
      field: string;
      label: string;
      reason?: string;
      proposedValue?: string;
      confidence?: number;
    }>;
    note?: string;
  };
  sourceAttribution?: unknown;
};

export type InspirationMaterial = {
  id: string;
  title: string;
  type: InspirationMaterialType;
  source: "外部" | "内部";
  platform: string;
  market: string;
  language: string;
  theme: string;
  emotion: string;
  hookType: string;
  hookDuration: number;
  transition: string;
  episode: string;
  exposure: number;
  days: number;
  captured: string;
  prototype: string;
  reuse: number;
  confidence: number;
  review: string;
  analysis: string;
  analysisStatus?: InspirationAnalysisStatus;
  analysisProgress?: number;
  analysisStage?: string;
  analysisError?: string;
  analysisResult?: unknown;
  analysisV2?: MaterialAnalysisV2;
  color: "rose" | "blue" | "cyan" | "amber";
  sensory: string;
  relation: string;
  highlight: string;
  hookRelation: string;
  avLead: string;
  ageDays: number;
  highPerformanceRatio: number;
  media?: {
    name: string;
    type: string;
    size: number;
    duration: number;
    url?: string;
  };
  coverUrl?: string;
  createdAt?: string;
  contentHash?: string;
  sourceUrl?: string;
  rightsStatus?: string;
  formScriptScenes?: Array<{
    sceneNumber: string;
    script: string;
    frameUrl?: string;
    reportedDuration?: string;
  }>;
};

type PBRecord = Record<string, unknown> & {
  id: string;
  collectionId: string;
  collectionName: string;
  created?: string;
};

const configuredUrl =
  typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_POCKETBASE_URL
    : undefined;
const PB_URL = (
  configuredUrl ||
  (typeof window !== "undefined" ? "/pb" : "http://127.0.0.1:8090")
).replace(/\/$/, "");

async function pbFetch(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${PB_URL}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error(
      `无法连接 PocketBase（${PB_URL}），请先启动本项目的 PocketBase 服务`,
    );
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
      data?: Record<string, { message?: string }>;
    } | null;
    const fieldMessage =
      payload?.data &&
      Object.values(payload.data)
        .map((value) => value?.message)
        .find(Boolean);
    throw new Error(
      fieldMessage ||
        payload?.message ||
        `PocketBase 请求失败（HTTP ${response.status}）`,
    );
  }
  return response;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function first(
  result: Record<string, unknown>,
  names: string[],
  fallback: unknown = "",
) {
  for (const name of names) {
    if (
      result[name] !== undefined &&
      result[name] !== null &&
      result[name] !== ""
    )
      return result[name];
  }
  return fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
const languageNames: Record<string, string> = {
  zh: "中文",
  en: "英语",
  ja: "日语",
  jp: "日语",
  ko: "韩语",
  es: "西班牙语",
  pt: "葡萄牙语",
  fr: "法语",
  de: "德语",
  it: "意大利语",
  ru: "俄语",
  ar: "阿拉伯语",
  hi: "印地语",
  tr: "土耳其语",
  vi: "越南语",
  th: "泰语",
  id: "印度尼西亚语",
};
function normalizedLanguage(value: unknown) {
  const raw = text(value).trim(),
    code = raw.toLowerCase().split(/[-_]/)[0];
  return languageNames[code] || raw;
}
function detectEvidenceLanguage(value: unknown) {
  const root = object(value),
    evidence = object(root.evidence),
    sample = list(evidence.transcript)
      .concat(list(evidence.ocr))
      .map((item) => text(object(item).text))
      .join(" ");
  if (/[\u3040-\u30ff]/u.test(sample)) return "日语";
  if (/[\uac00-\ud7af]/u.test(sample)) return "韩语";
  if (/[\u0400-\u04ff]/u.test(sample)) return "俄语";
  if (/[\u0600-\u06ff]/u.test(sample)) return "阿拉伯语";
  if (/[\u0e00-\u0e7f]/u.test(sample)) return "泰语";
  if (/[\u4e00-\u9fff]/u.test(sample)) return "中文";
  return "";
}
function tags(
  value: unknown,
  dimension: OntologyDimension = "theme",
): MaterialTag[] {
  return list(value).map((raw, index) => {
    if (typeof raw === "string")
      return { code: `TAG_${index + 1}`, label: raw, confidence: Number.NaN };
    const item = object(raw);
    const relationLabel =
      text(item.from) && text(item.to)
        ? `${text(item.from)} · ${text(item.type, "关系")} · ${text(item.to)}`
        : "";
    const legacy = text(
      item.label,
      text(item.name, relationLabel || text(item.type, "未命名标签")),
    );
    const canonical = normalizeTag({ ...item, label: legacy }, dimension);
    const rawEvidence = list(item.evidence);
    return {
      code: byLegacyCode(item.code, canonical.code, index),
      label: canonical.label,
      confidence:
        item.confidence === undefined || item.confidence === null
          ? Number.NaN
          : number(item.confidence),
      evidence: rawEvidence
        .map((value) =>
          typeof value === "string"
            ? value
            : text(object(value).sourceText, text(object(value).text)),
        )
        .filter(Boolean),
      evidenceSources: rawEvidence
        .map((value) => text(object(value).source))
        .filter(Boolean),
      verification: text(item.verification) || undefined,
    };
  });
}

const technicalThemePattern =
  /(?:语音|ASR|OCR|字幕|识别|置信度|混合语言|多语言内容|疑似(?:产品|专有|人物)名称|技术|画质|音质|分辨率|语种|翻译质量)/i;
const genericStoryBeatPattern =
  /^(?:第[一二三四五六七八九十\d]+段语义单元|语义段落(?::.*)?|主体叙事段落|叙事主体段落|核心叙事段落(?::.*)?|核心剧情(?:推进)?段|核心剧情段落(?::.*)?|重复引入段|心理对话段|经济情境段|互动收尾段|角色互动|对话驱动|(?:开场|再)?钩子|正片主体|主体段落|中期冲突|高潮(?:段落|与行动号召)?|悬念点|行动号召)$/u;
const narrativeFormThemePattern =
  /^(?:对话驱动|角色互动|任务管理|信息交换|剧情推进|叙事不完整)$/u;
const genericContentLabels: Partial<Record<OntologyDimension, Set<string>>> = {
  genre: new Set(["剧情", "故事", "短剧", "影视", "视频"]),
  theme: new Set(["剧情", "故事", "主题", "情节", "剧情主题"]),
  role: new Set(["主角", "主人公", "人物", "角色", "主要人物", "核心人物"]),
  relation: new Set(["关系", "人物关系", "角色关系"]),
  conflict: new Set(["冲突", "矛盾", "戏剧冲突"]),
  emotion: new Set(["情绪", "情感", "人物情绪"]),
  storyBeat: new Set(["剧情", "情节", "剧情节点", "情节点"]),
  scene: new Set(["场景", "地点", "环境"]),
};

function contentTags(
  value: unknown,
  dimension: OntologyDimension,
): MaterialTag[] {
  const seen = new Set<string>();
  return tags(value, dimension)
    .filter((tag) => {
      const label = tag.label.trim();
      if (!label || seen.has(label)) return false;
      if (genericContentLabels[dimension]?.has(label)) return false;
      if (
        dimension === "theme" &&
        (technicalThemePattern.test(label) ||
          narrativeFormThemePattern.test(label))
      )
        return false;
      if (dimension === "storyBeat" && genericStoryBeatPattern.test(label))
        return false;
      seen.add(label);
      return true;
    })
    .map((tag) => {
      if (tag.verification !== "verified") return tag;
      const sources = new Set(
        (tag.evidenceSources ?? []).map((value) => value.toLowerCase()),
      );
      const hasTextEvidence = [
        "transcript",
        "asr",
        "ocr",
        "subtitle",
        "manual_review",
      ].some((source) => sources.has(source));
      const privilegedIdentity =
        /(?:queen|princess|emperor|king|prince|duke|doctor|ceo|billionaire|女王|公主|皇帝|国王|王子|公爵|医生|总裁|亿万富翁)/i.test(
          tag.label,
        );
      const insufficient =
        !tag.evidence?.length ||
        (dimension === "role" && privilegedIdentity && !hasTextEvidence) ||
        (dimension === "relation" && !hasTextEvidence);
      return insufficient ? { ...tag, verification: "needs_review" } : tag;
    });
}

function byLegacyCode(raw: unknown, canonical: string, index: number) {
  const legacy = text(raw);
  return legacy && /^TAG_|^[A-Z0-9_-]+$/.test(legacy)
    ? legacy
    : canonical || `TAG_${index + 1}`;
}

const evidenceGroupForStore = (kind: string) =>
  /ocr|subtitle/i.test(kind)
    ? "ocr"
    : /asr|transcript/i.test(kind)
      ? "asr"
      : "other";

function parseV2(value: unknown): MaterialAnalysisV2 | undefined {
  const root = object(value);
  const candidate =
    text(root.schemaVersion) === "material-v2" ? root : object(root.materialV2);
  if (text(candidate.schemaVersion) !== "material-v2") return undefined;
  const semantic = object(candidate.semantic),
    semanticContent = object(semantic.content),
    semanticCreative = object(semantic.creative);
  // The root fields are the finalized, normalized projection. Nested
  // semantic data is retained for provenance, but may be an earlier draft
  // after a reproject/repair and must never overwrite the final result.
  const content = { ...semanticContent, ...object(candidate.content) },
    creative = { ...semanticCreative, ...object(candidate.creative) };
  const evidenceGroup = object(candidate.evidence);
  const translatedEvidence: Array<{
    source: string;
    start: number;
    end: number;
    text: string;
  }> = [];
  const claimEvidence: Array<{ raw: unknown; kind: string; supports: string }> =
    [];
  const collectTranslations = (value: unknown, insideRawEvidence = false) => {
    if (Array.isArray(value)) {
      for (const item of value) collectTranslations(item, insideRawEvidence);
      return;
    }
    const item = object(value);
    if (!Object.keys(item).length) return;
    const source = text(item.source),
      timecode = object(item.timecode),
      translated = text(item.translation, text(item.text));
    if (
      !insideRawEvidence &&
      source &&
      translated &&
      /[\u4e00-\u9fff]/u.test(translated) &&
      (item.timecode || item.start !== undefined)
    )
      translatedEvidence.push({
        source: evidenceGroupForStore(source),
        start: number(item.start, number(timecode.start)),
        end: number(
          item.end,
          number(timecode.end, number(item.start, number(timecode.start))),
        ),
        text: translated,
      });
    for (const [key, child] of Object.entries(item))
      collectTranslations(
        child,
        insideRawEvidence || (key === "evidence" && item === candidate),
      );
  };
  collectTranslations(candidate);
  const collectClaimEvidence = (value: unknown, parentClaim = "") => {
    if (Array.isArray(value)) {
      for (const item of value) collectClaimEvidence(item, parentClaim);
      return;
    }
    const item = object(value);
    if (!Object.keys(item).length) return;
    const ownClaim = text(
      item.label,
      text(item.value, text(item.description, parentClaim)),
    );
    if (Array.isArray(item.evidence))
      for (const raw of item.evidence) {
        const evidence = object(raw),
          source = text(evidence.source);
        if (source && (evidence.timecode || evidence.start !== undefined))
          claimEvidence.push({
            raw,
            kind: source,
            supports: ownClaim || parentClaim,
          });
      }
    for (const [key, child] of Object.entries(item))
      if (key !== "evidence" && key !== "sourceText")
        collectClaimEvidence(child, ownClaim || parentClaim);
  };
  collectClaimEvidence(content, "剧情理解");
  collectClaimEvidence(creative, "创意结构");
  collectClaimEvidence(object(candidate.value), "投放价值");
  const translationByTime = new Map<string, string>();
  for (const item of translatedEvidence)
    translationByTime.set(
      `${item.source}|${Math.round(item.start * 4)}|${Math.round(item.end * 2)}`,
      item.text,
    );
  const groupedEvidence = [
    ["transcript", "asr"],
    ["asr", "asr"],
    ["ocr", "ocr"],
    ["keyframes", "frame"],
    ["shots", "shot"],
    ["audioEvents", "audio"],
  ] as const;
  const semanticEvidence = list(content.segments).flatMap((segment) => {
    const item = object(segment);
    return list(item.evidence).map((raw) => {
      const evidence = object(raw);
      return {
        raw: {
          ...evidence,
          kind: text(evidence.source, "segment"),
          translation: text(evidence.text),
          text: text(evidence.sourceText),
        },
        kind: text(evidence.source, "segment"),
      };
    });
  });
  const rawEvidence = claimEvidence.length
    ? claimEvidence
    : semanticEvidence.length
      ? semanticEvidence.map((item) => ({ ...item, supports: "剧情阶段" }))
      : Array.isArray(candidate.evidence)
        ? list(candidate.evidence).map((raw) => ({
            raw,
            kind: "frame",
            supports: "",
          }))
        : groupedEvidence.flatMap(([field, kind]) =>
            list(evidenceGroup[field]).map((raw) => ({
              raw,
              kind,
              supports: "",
            })),
          );
  const allEvidence = rawEvidence
    .map(({ raw, kind, supports }, index) => {
      const item = object(raw),
        timecode = object(item.timecode),
        shot = number(item.shot, -1),
        evidenceText = text(
          item.text,
          shot >= 0 ? `镜头 ${shot}` : text(item.type),
        ),
        start = number(item.start, number(timecode.start)),
        end = number(item.end, number(timecode.end, start)),
        matched = translationByTime.get(
          `${evidenceGroupForStore(kind)}|${Math.round(start * 4)}|${Math.round(end * 2)}`,
        ),
        observation = text(item.translation, text(item.text, matched)),
        sourceText = text(item.sourceText);
      return {
        id: text(item.id, `evidence-${kind}-${index + 1}`),
        kind: text(item.kind, text(item.source, kind)),
        start,
        end,
        text: evidenceText || undefined,
        translation: text(item.translation, matched) || undefined,
        observation: observation || undefined,
        supports: supports ? supports.slice(0, 96) : undefined,
        sourceText: sourceText || undefined,
        evidenceClass:
          observation && supports
            ? ("narrative" as const)
            : observation
              ? ("auxiliary" as const)
              : ("technical" as const),
        confidence: number(item.confidence),
        verification:
          kind === "ocr" ? "observed" : text(item.verification) || undefined,
      };
    })
    .filter((item) => {
      if (evidenceGroupForStore(item.kind) !== "ocr") return true;
      const value = (item.translation || item.text || "")
          .replace(/\s+/g, " ")
          .trim(),
        compact = value.replace(/[^\p{L}\p{N}]/gu, "");
      return (
        compact.length >= 2 &&
        !/(?:,|;|:|\b(?:and|or|but|with|to|of|a|an|the))$/i.test(value)
      );
    });
  const evidenceKeys = new Set<string>();
  const uniqueEvidence = allEvidence
    .filter((item) => {
      const key = `${item.kind}|${Math.round(item.start * 20)}|${item.translation || item.text || ""}`;
      if (evidenceKeys.has(key)) return false;
      evidenceKeys.add(key);
      return true;
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const evidenceLimit = 48;
  const evidence =
    uniqueEvidence.length <= evidenceLimit
      ? uniqueEvidence
      : Array.from(
          { length: evidenceLimit },
          (_, index) =>
            uniqueEvidence[
              Math.round(
                (index * (uniqueEvidence.length - 1)) / (evidenceLimit - 1),
              )
            ],
        );
  const hook = object(creative.hook),
    completeHook = object(list(creative.hooks)[0]),
    entryPoint = object(list(creative.entryPoints)[0]),
    hookSource = Object.keys(hook).length
      ? hook
      : Object.keys(completeHook).length
        ? completeHook
        : entryPoint,
    valuePart = object(candidate.value),
    review = object(candidate.review);
  const displayPhases = list(creative.displayPhases),
    creativeTimeline = list(creative.timeline),
    storyBeats = list(content.storyBeats),
    storyTimeline = list(content.segments);
  const genericStoryLabel =
    /^(?:(?:开场|再)?钩子|正片主体|主体段落|中期冲突|高潮(?:段落|与行动号召)?|悬念点|行动号召|CTA|剧情推进|未命名段落)$/i;
  const concreteStoryItems = (items: unknown[]) =>
    items.filter((raw) => {
      const item = object(raw),
        label = text(item.label, text(item.value));
      return Boolean(label) && !genericStoryLabel.test(label);
    });
  const splitNarrativeClauses = (value: string) => {
    const clauses: string[] = [],
      opening = new Set(["“", "‘", '"']),
      closing = new Set(["”", "’", '"']);
    let buffer = "",
      quote = "";
    for (const char of value) {
      if (opening.has(char)) {
        if (char === '"' && quote === '"') quote = "";
        else if (!quote) quote = char;
        buffer += char;
        continue;
      }
      if (closing.has(char) && quote && char !== quote) {
        quote = "";
        buffer += char;
        continue;
      }
      if (!quote && /[，；。]/u.test(char)) {
        if (buffer.trim()) clauses.push(buffer.trim());
        buffer = "";
        continue;
      }
      buffer += char;
    }
    if (buffer.trim()) clauses.push(buffer.trim());
    return clauses;
  };
  const completeSegmentTitle = (raw: unknown, index: number) => {
    const item = object(raw),
      description = text(item.description)
        .replace(/随后[，、：:]?\s*/gu, "")
        .trim(),
      clauses = splitNarrativeClauses(description),
      first =
        clauses.find((value) => !/^为.+(?:而|以|，)?$/u.test(value)) ||
        clauses[0],
      outcome =
        [...clauses]
          .reverse()
          .find((value) =>
            /(?:结果|关系|引发|导致|转向|升级|确认|认可|紧张|缓和|决裂|悬念|危机)/u.test(
              value,
            ),
          ) || clauses.at(-1),
      derived = [first, outcome && outcome !== first ? outcome : ""]
        .filter(Boolean)
        .join("，")
        .replace(/，(?:结果|关系变化为)/u, "，"),
      stored = text(item.label, text(item.value));
    return derived || stored || `剧情节点${index + 1}`;
  };
  const withCompleteTitles = (items: unknown[]) =>
    items.map((raw, index) => {
      const item = object(raw),
        label = completeSegmentTitle(item, index);
      return { ...item, label, value: label };
    });
  const storyboardRaw = withCompleteTitles(list(content.storyboardUnits)),
    completeStoryboardBeats = concreteStoryItems(storyboardRaw),
    concreteBeats = completeStoryboardBeats.length
      ? completeStoryboardBeats
      : [
          ...concreteStoryItems(storyBeats),
          ...concreteStoryItems(storyTimeline),
        ];
  const observationBeats = list(content.observations)
    .map((raw, index) => {
      const item = object(raw),
        actor = text(item.actorObserved, "当事人"),
        action = text(item.actionObserved),
        result = text(item.resultObserved);
      return {
        code: text(item.factId, `OBSERVED_BEAT_${index + 1}`),
        label: `${actor}${action}`.trim(),
        value: `${actor}${action}`.trim(),
        description: [action, result && `结果：${result}`]
          .filter(Boolean)
          .join("；"),
        confidence: number(item.confidence, 1),
        evidence: list(item.evidence),
        verification: text(item.verification, "unverified"),
      };
    })
    .filter((item) => item.label && item.label !== "当事人");
  const storyBeatSource = concreteBeats.length
    ? concreteBeats
    : observationBeats;
  const rawScenes = concreteStoryItems(list(content.scenes));
  const inferredSceneLabels = rawScenes.length
    ? []
    : [
        ...new Set(
          list(content.observations).flatMap((raw) =>
            list(object(raw).evidence)
              .map((evidence) => text(object(evidence).text))
              .flatMap(
                (value) =>
                  value.match(
                    /宫殿|宴会厅|卧室|医院|诊室|办公室|会议室|街头|餐厅|酒吧|舞蹈室|排练室|竞技场|森林|雪地|废墟|悬崖|庭院|广告界面/g,
                  ) ?? [],
              ),
          ),
        ),
      ];
  const sceneSource = rawScenes.length
    ? rawScenes
    : inferredSceneLabels.map((label, index) => ({
        code: `INFERRED_SCENE_${index + 1}`,
        label,
        value: label,
        confidence: 0.7,
        verification: "observed",
      }));
  const hasConcreteDescription = (items: unknown[]) =>
    items.some(
      (raw) => text(object(raw).description).replace(/\s+/g, "").length >= 8,
    );
  // The causal-story ledger needs concrete events. Generic creative edit labels
  // must not hide richer story segments merely because their array exists.
  const timelineSource = hasConcreteDescription(displayPhases)
    ? displayPhases
    : hasConcreteDescription(storyTimeline)
      ? storyTimeline
      : hasConcreteDescription(creativeTimeline)
        ? creativeTimeline
        : hasConcreteDescription(storyBeats)
          ? storyBeats
          : displayPhases.length
            ? displayPhases
            : storyTimeline.length
              ? storyTimeline
              : creativeTimeline.length
                ? creativeTimeline
                : storyBeats;
  const parseSegments = (source: unknown[], prefix: string) =>
    source.map((raw, index) => {
      const item = object(raw);
      return {
        code: text(item.code, `${prefix}_${index + 1}`),
        label: completeSegmentTitle(item, index),
        start: number(item.start),
        end: number(item.end),
        description: text(item.description) || undefined,
        confidence: number(item.confidence),
        evidence: list(item.evidence)
          .map((value) => text(object(value).text, text(value)))
          .filter(Boolean),
      };
    });
  const timeline = parseSegments(timelineSource, "SEGMENT");
  const storyboardUnits = parseSegments(storyboardRaw, "STORYBOARD");
  const packagingObject = object(creative.packaging),
    packagingValues = [
      ...list(packagingObject.visual),
      ...list(packagingObject.subtitle),
      ...list(packagingObject.audio),
      ...list(packagingObject.rhythm),
    ];
  const tag = (raw: unknown): MaterialTag | undefined =>
    tags(raw ? [raw] : [])[0];
  const reviewReasonItem = (reason: string, index: number) => {
    const sourceIssue = /外搭|外部钩子|来源差异|剪辑来源/.test(reason),
      speechIssue = /语音|听写|ASR|转录/.test(reason),
      contextIssue = /上下文|叙事链|完整叙事|背景/.test(reason);
    return {
      id: `review-reason-${index + 1}`,
      field: sourceIssue
        ? "creative.hookSourceStatus"
        : speechIssue
          ? "evidence.asr"
          : contextIssue
            ? "content.completeness"
            : "analysis",
      label: sourceIssue
        ? "素材来源待复核"
        : speechIssue
          ? "语音证据待复核"
          : contextIssue
            ? "叙事上下文待复核"
            : "分析结论待复核",
      reason,
    };
  };
  const claimTextValue = (value: unknown) => {
    const item = object(value);
    return text(item.value, text(item.label, text(item.code, text(value))));
  };
  return {
    schemaVersion: "material-v2",
    evidence,
    content: {
      summary: claimTextValue(content.summary) || undefined,
      completeness: claimTextValue(content.completeness) || undefined,
      observations: list(content.observations).map((raw, index) => {
        const item = object(raw);
        return {
          factId: text(item.factId, `F${index + 1}`),
          start: number(item.start, number(object(item.timecode).start)),
          end: number(item.end, number(object(item.timecode).end)),
          actorObserved: text(item.actorObserved, "未知主体"),
          actionObserved: text(item.actionObserved, "缺少可观察动作"),
          objectOrTargetObserved:
            text(item.objectOrTargetObserved) || undefined,
          resultObserved: text(item.resultObserved) || undefined,
          verification: text(item.verification) || undefined,
        };
      }),
      inferences: tags(content.inferences).map((tag, index) => {
        const item = object(list(content.inferences)[index]);
        return {
          ...tag,
          statement: text(item.statement, tag.label),
          inferenceType: text(item.inferenceType) || undefined,
          basedOnFactIds: list(item.basedOnFactIds).filter(
            (value): value is string => typeof value === "string",
          ),
        };
      }),
      genres: contentTags(content.genres, "genre"),
      themes: contentTags(content.themes ?? content.tags, "theme"),
      characters: contentTags(content.characters, "role"),
      relations: contentTags(
        content.relations ?? content.relationships,
        "relation",
      ),
      emotions: contentTags(content.emotions, "emotion"),
      conflicts: contentTags(content.conflicts, "conflict"),
      storyBeats: contentTags(storyBeatSource, "storyBeat"),
      scenes: contentTags(sceneSource, "scene"),
      storyboardUnits,
    },
    creative: {
      materialType: tag(creative.materialType ?? creative.format),
      tLevel: tag(creative.tLevel ?? creative.tier),
      bodyFormat: tag(creative.bodyFormat),
      hookSourceStatus: tag(creative.hookSourceStatus),
      hookAssemblyType: tag(creative.hookAssemblyType),
      narrationCoverage: number(
        object(creative.narrationCoverage).value,
        number(creative.narrationCoverage),
      ),
      hook: Object.keys(hookSource).length
        ? (() => {
            const emotionCurve = object(hookSource.emotionCurve),
              informationStructure = object(hookSource.informationStructure),
              exitState = object(hookSource.exitState),
              intensity = object(
                hookSource.intensity ??
                  hookSource.intensityScores ??
                  hookSource.qualityScores,
              );
            return {
              start: number(hookSource.start),
              end: number(hookSource.end),
              hookType:
                text(
                  hookSource.hookType,
                  text(hookSource.type, text(hookSource.label)),
                ) || undefined,
              source:
                text(
                  hookSource.plotSummary,
                  text(hookSource.spokenSummary, text(hookSource.label)),
                ) || undefined,
              plotSummary: text(hookSource.plotSummary) || undefined,
              spokenSummary: text(hookSource.spokenSummary) || undefined,
              visualSummary: text(hookSource.visualSummary) || undefined,
              narrativePromise: text(hookSource.narrativePromise) || undefined,
              informationGap: text(hookSource.informationGap) || undefined,
              mechanisms: tags(hookSource.mechanisms ?? hookSource.contentTags),
              sensoryChannels: tags(hookSource.sensoryChannels),
              emotionCurve: {
                start: text(emotionCurve.start) || undefined,
                peak: text(emotionCurve.peak) || undefined,
                endSuspense: text(emotionCurve.endSuspense) || undefined,
              },
              informationStructure: {
                audienceKnows:
                  text(informationStructure.audienceKnows) || undefined,
                characterKnows:
                  text(informationStructure.characterKnows) || undefined,
                unrevealed: text(informationStructure.unrevealed) || undefined,
              },
              exitState: {
                lastLine: text(exitState.lastLine) || undefined,
                lastAction: text(exitState.lastAction) || undefined,
                facing: text(exitState.facing) || undefined,
                shotScale: text(exitState.shotScale) || undefined,
                audioClosure: text(exitState.audioClosure) || undefined,
              },
              intensity: {
                conflict: number(intensity.conflict),
                informationDensity: number(intensity.informationDensity),
                comprehensionBarrier: number(intensity.comprehensionBarrier),
                first3sStimulus: number(
                  intensity.first3sStimulus,
                  number(intensity.stopPower),
                ),
              },
            };
          })()
        : undefined,
      timeline,
      packaging: tags(packagingValues),
      transitions: tags(creative.transitions),
    },
    value: {
      scores: list(valuePart.scores).map((raw) => {
        const item = object(raw);
        return {
          code: text(item.code),
          label: text(item.label),
          score: number(item.score),
          reason: text(item.reason) || undefined,
          evidence: list(item.evidence).filter(
            (v): v is string => typeof v === "string",
          ),
        };
      }),
      inspirations: list(valuePart.inspirations).filter(
        (v): v is string => typeof v === "string",
      ),
      avoid: list(valuePart.avoid).filter(
        (v): v is string => typeof v === "string",
      ),
      suitableGenres: list(valuePart.suitableGenres).filter(
        (v): v is string => typeof v === "string",
      ),
      suitableAudiences: list(valuePart.suitableAudiences).filter(
        (v): v is string => typeof v === "string",
      ),
    },
    review: {
      status: text(review.status) || undefined,
      reviewRequired: Boolean(review.reviewRequired),
      items: [
        ...list(review.items).map((raw, index) => {
          const item = object(raw);
          return {
            id: text(item.id, `review-${index + 1}`),
            field: text(item.field),
            label: text(item.label, "待复核项"),
            reason: text(item.reason) || undefined,
            proposedValue: text(item.proposedValue) || undefined,
            confidence:
              item.confidence === undefined || item.confidence === null
                ? undefined
                : number(item.confidence),
          };
        }),
        ...list(review.reasons)
          .filter((v): v is string => typeof v === "string")
          .map(reviewReasonItem),
      ],
      note: text(review.note) || undefined,
    },
    sourceAttribution: candidate.sourceAttribution,
  };
}

function analysisLabel(status: InspirationAnalysisStatus, progress: number) {
  if (status === "succeeded") return "真实分析完成";
  if (status === "failed") return "分析失败";
  if (status === "running") return `真实分析中 ${Math.round(progress)}%`;
  if (status === "queued") return "等待真实分析";
  return "尚未分析";
}

function fileUrl(record: PBRecord, filename: unknown) {
  if (typeof filename !== "string" || !filename) return undefined;
  return `${PB_URL}/api/files/${record.collectionId}/${record.id}/${encodeURIComponent(filename)}`;
}

export function fromRecord(
  record: PBRecord,
  job?: PBRecord,
): InspirationMaterial {
  const envelope = object(record.analysis_result);
  const result = {
    ...envelope,
    ...object(envelope.materialFields),
    ...object(envelope.result),
  };
  const structure = object(
    first(result, ["structure", "creativeStructure"], {}),
  );
  const hook = object(first(result, ["hook", "hookAnalysis"], {}));
  const rawStatus = text(record.analysis_status, "idle");
  const status = (
    rawStatus === "completed" ? "succeeded" : rawStatus
  ) as InspirationAnalysisStatus;
  const progress = Math.max(0, Math.min(100, number(record.analysis_progress)));
  const createdAt = text(record.created);
  const video = text(record.video);
  const cover = text(record.cover);
  const duration = number(record.duration_seconds);
  const analysisV2 = parseV2(record.analysis_result);
  const sourceAttribution = object(record.source_attribution);
  const formScriptScenes = list(sourceAttribution.scenes)
    .map((raw) => {
      const scene = object(raw);
      return {
        sceneNumber: text(scene.sceneNumber),
        script: text(scene.script),
        frameUrl: text(scene.frameUrl) || undefined,
        reportedDuration: text(scene.reportedDuration) || undefined,
      };
    })
    .filter((scene) => scene.script);
  const analyzedType = text(
    record.material_format,
    analysisV2?.creative.materialType?.label || "",
  );
  const effectiveType = (
    ["正片剧集拼接", "正片剧集解说", "外搭钩子＋本剧正片"].includes(
      analyzedType,
    )
      ? analyzedType
      : "未确定"
  ) as InspirationMaterialType;
  return {
    id: record.id,
    title: text(record.title, text(record.original_name, "未命名素材")),
    type:
      status === "succeeded"
        ? effectiveType
        : ((text(record.type) === "待AI识别"
            ? "未确定"
            : text(record.type, "未确定")) as InspirationMaterialType),
    source: text(record.source, "外部") === "内部" ? "内部" : "外部",
    platform: text(record.platform, "手动上传"),
    market: text(record.market, "未知市场"),
    language:
      normalizedLanguage(
        first(
          result,
          ["detectedLanguage", "language"],
          detectEvidenceLanguage(record.analysis_result),
        ),
      ) ||
      normalizedLanguage(record.language) ||
      "未知语种",
    theme: text(
      record.theme,
      text(first(result, ["theme", "genre"]), "待分析"),
    ),
    emotion: text(first(result, ["emotion", "dominantEmotion"]), "待分析"),
    hookType: text(
      first(
        hook,
        ["type", "hookType"],
        first(result, ["hookType", "hook_type"], "待分析"),
      ),
    ),
    hookDuration: number(
      first(
        hook,
        ["duration", "durationSeconds"],
        first(result, ["hookDuration", "hook_duration"], 0),
      ),
    ),
    transition: text(
      first(
        structure,
        ["transition", "transitionType"],
        first(result, ["transition", "transitionType"], "待分析"),
      ),
    ),
    episode: text(first(result, ["episode", "sourceEpisode"]), "上传素材"),
    exposure: number(record.exposure),
    days: number(record.days),
    captured: createdAt ? new Date(createdAt).toLocaleString("zh-CN") : "",
    prototype: text(
      record.prototype,
      text(first(result, ["prototype", "hookPrototype"]), "待分析"),
    ),
    reuse: number(first(result, ["reuse", "reuseCount"])),
    confidence: Math.round(
      number(first(result, ["confidence", "overallConfidence"])) *
        (number(first(result, ["confidence", "overallConfidence"])) <= 1
          ? 100
          : 1),
    ),
    review: text(record.review_status, "待复核"),
    analysis: analysisLabel(status, progress),
    analysisStatus: status,
    analysisProgress: progress,
    analysisStage: text(
      object(job?.logs).stage,
      status === "queued"
        ? "等待素材 Worker"
        : status === "succeeded"
          ? "分析完成"
          : "",
    ),
    analysisError: text(record.analysis_error) || undefined,
    // Keep the normalized material-v2 view in React state. Retaining the full raw
    // analysis envelope (hundreds of KB per card) makes browser inspection and
    // reconciliation needlessly expensive and can freeze the page.
    analysisResult: undefined,
    analysisV2,
    color: "blue",
    sensory: text(first(result, ["sensory", "sensoryHook"]), "待分析"),
    relation: text(first(result, ["relation", "characterRelation"]), "待分析"),
    highlight: text(first(result, ["highlight", "highlightSummary"]), "待分析"),
    hookRelation: text(
      first(result, ["hookRelation", "hook_relation"]),
      "待分析",
    ),
    avLead: text(first(result, ["avLead", "audioVisualLead"]), "待分析"),
    ageDays: number(first(result, ["ageDays", "age_days"])),
    highPerformanceRatio: number(
      first(result, ["highPerformanceRatio", "high_performance_ratio"]),
    ),
    media:
      video || text(record.source_url)
        ? {
            name: text(record.original_name, video || "远程 ADX 素材"),
            type: text(record.mime_type, "video/mp4"),
            size: number(record.byte_size),
            duration,
            url: video ? fileUrl(record, video) : text(record.source_url),
          }
        : undefined,
    // Only advertise a cover when PocketBase actually stores one. CSV/link
    // imports commonly have no cover file; inventing a static path here makes
    // every card render a broken <img> instead of the intentional fallback.
    coverUrl: fileUrl(record, cover),
    createdAt,
    contentHash: text(record.content_hash) || undefined,
    sourceUrl: text(record.source_url) || undefined,
    rightsStatus: text(record.rights_status, "仅限内部分析"),
    formScriptScenes,
  };
}

export async function submitInspirationReview(
  id: string,
  status: "已通过" | "已修改" | "退回重分析",
  note: string,
): Promise<void> {
  const response = await pbFetch(
    `/api/collections/ad_materials/records/${encodeURIComponent(id)}`,
  );
  const record = (await response.json()) as PBRecord;
  const current = object(record.analysis_result);
  const v2 = parseV2(current);
  const nextResult = v2
    ? {
        ...current,
        review: {
          ...v2.review,
          status,
          note,
          reviewedAt: new Date().toISOString(),
        },
      }
    : current;
  await pbFetch(
    `/api/collections/ad_materials/records/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        review_status: status,
        analysis_result: nextResult,
      }),
    },
  );
  if (status === "退回重分析") await retryInspirationMaterialAnalysis(id);
}

export async function listInspirationMaterials(
  signal?: AbortSignal,
): Promise<InspirationMaterial[]> {
  const materialFields = [
    "id",
    "collectionId",
    "collectionName",
    "title",
    "original_name",
    "type",
    "source",
    "platform",
    "market",
    "language",
    "theme",
    "exposure",
    "days",
    "created",
    "review_status",
    "analysis_status",
    "analysis_progress",
    "analysis_stage",
    "analysis_error",
    "material_format",
    "prototype",
    "video",
    "cover",
    "mime_type",
    "byte_size",
    "duration_seconds",
    "content_hash",
    "source_url",
    "rights_status",
    "analysis_result",
    "source_attribution",
  ].join(",");
  try {
    const [materialResponse, jobResponse] = await Promise.all([
      pbFetch(
        `/api/collections/ad_materials/records?perPage=500&sort=-id&fields=${materialFields}`,
        { signal },
      ),
      pbFetch(
        "/api/collections/material_analysis_jobs/records?perPage=500&sort=-id&fields=id,material,status,progress,logs",
        { signal },
      ),
    ]);
    const payload = (await materialResponse.json()) as { items?: PBRecord[] };
    const jobPayload = (await jobResponse.json()) as { items?: PBRecord[] };
    const jobByMaterial = new Map(
      (jobPayload.items ?? []).map((job) => [text(job.material), job]),
    );
    return (payload.items ?? []).map((record) =>
      fromRecord(record, jobByMaterial.get(record.id)),
    );
  } catch (reason) {
    if (signal?.aborted) throw reason;
    if (typeof window === "undefined") throw reason;
    const cached = await fetch("/material-analysis/index.json", {
      signal,
      cache: "no-store",
    });
    if (!cached.ok) throw reason;
    return (await cached.json()) as InspirationMaterial[];
  }
}

export type InspirationMaterialPage = {
  items: InspirationMaterial[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
};

export type InspirationMaterialStats = {
  total: number;
  completed: number;
  longRunning: number;
  pendingReview: number;
};

/**
 * Return collection-wide counters for the inspiration dashboard.
 *
 * The material grid is intentionally paginated, so deriving these values from
 * the currently loaded cards makes every counter change as the user scrolls.
 * PocketBase still calculates totalItems for a one-row query, which keeps the
 * dashboard accurate without downloading the full material collection.
 */
export async function getInspirationMaterialStats(
  signal?: AbortSignal,
): Promise<InspirationMaterialStats> {
  const count = async (filter?: string) => {
    const query = filter ? `&filter=${encodeURIComponent(filter)}` : "";
    const response = await pbFetch(
      `/api/collections/ad_materials/records?perPage=1&fields=id${query}`,
      { signal },
    );
    const payload = (await response.json()) as {
      items?: PBRecord[];
      totalItems?: number;
    };
    return payload.totalItems ?? payload.items?.length ?? 0;
  };
  const [total, completed, longRunning, pendingReview] = await Promise.all([
    count(),
    count('analysis_status="succeeded"'),
    count("days>=30"),
    count(
      'analysis_status="succeeded" && (review_status="needs_review" || review_status="待复核" || review_status="退回重分析")',
    ),
  ]);
  return { total, completed, longRunning, pendingReview };
}

export async function listInspirationMaterialsPage(
  page = 1,
  perPage = 24,
  signal?: AbortSignal,
): Promise<InspirationMaterialPage> {
  const materialFields = [
    "id",
    "collectionId",
    "collectionName",
    "title",
    "original_name",
    "type",
    "source",
    "platform",
    "market",
    "language",
    "theme",
    "exposure",
    "days",
    "created",
    "review_status",
    "analysis_status",
    "analysis_progress",
    "analysis_stage",
    "analysis_error",
    "material_format",
    "prototype",
    "video",
    "cover",
    "mime_type",
    "byte_size",
    "duration_seconds",
    "content_hash",
    "source_url",
    "rights_status",
    "analysis_result",
    "source_attribution",
  ].join(",");
  const boundedPage = Math.max(1, Math.floor(page)),
    boundedPerPage = Math.max(1, Math.min(60, Math.floor(perPage)));
  const response = await pbFetch(
    `/api/collections/ad_materials/records?page=${boundedPage}&perPage=${boundedPerPage}&sort=-id&fields=${materialFields}`,
    { signal },
  );
  const payload = (await response.json()) as {
    items?: PBRecord[];
    page?: number;
    perPage?: number;
    totalItems?: number;
    totalPages?: number;
  };
  const records = payload.items ?? [];
  const ids = records.map((item) => item.id).filter(Boolean);
  let jobs: PBRecord[] = [];
  if (ids.length) {
    const filter = encodeURIComponent(
      ids.map((id) => `material="${id}"`).join(" || "),
    );
    const jobResponse = await pbFetch(
      `/api/collections/material_analysis_jobs/records?perPage=${Math.min(200, ids.length * 3)}&sort=-id&filter=${filter}&fields=id,material,status,progress,logs,error,error_kind`,
      { signal },
    );
    jobs = ((await jobResponse.json()) as { items?: PBRecord[] }).items ?? [];
  }
  const jobByMaterial = new Map<string, PBRecord>();
  for (const job of jobs)
    if (!jobByMaterial.has(text(job.material)))
      jobByMaterial.set(text(job.material), job);
  return {
    items: records.map((record) =>
      fromRecord(record, jobByMaterial.get(record.id)),
    ),
    page: payload.page ?? boundedPage,
    perPage: payload.perPage ?? boundedPerPage,
    totalItems: payload.totalItems ?? records.length,
    totalPages: payload.totalPages ?? 1,
  };
}

export async function getInspirationMaterial(
  id: string,
  signal?: AbortSignal,
): Promise<InspirationMaterial> {
  try {
    const filter = encodeURIComponent(`material="${id.replace(/"/g, '\\"')}"`);
    const [materialResponse, jobResponse] = await Promise.all([
      pbFetch(
        `/api/collections/ad_materials/records/${encodeURIComponent(id)}`,
        { signal },
      ),
      pbFetch(
        `/api/collections/material_analysis_jobs/records?perPage=1&sort=-id&filter=${filter}&fields=id,material,status,progress,logs`,
        { signal },
      ),
    ]);
    const record = (await materialResponse.json()) as PBRecord;
    const jobs = (await jobResponse.json()) as { items?: PBRecord[] };
    return fromRecord(record, jobs.items?.[0]);
  } catch (reason) {
    if (signal?.aborted || typeof window === "undefined") throw reason;
    const cached = await fetch(
      `/material-analysis/${encodeURIComponent(id)}.json`,
      { signal, cache: "no-store" },
    );
    if (!cached.ok) throw reason;
    return (await cached.json()) as InspirationMaterial;
  }
}

export type InspirationMaterialInput = {
  title: string;
  type: InspirationMaterialType;
  source: "外部" | "内部";
  platform: string;
  market: string;
  language: string;
  theme: string;
  exposure: number;
  days: number;
  duration: number;
  contentHash: string;
  sourceUrl?: string;
  rightsStatus: string;
};

export async function saveInspirationMaterial(
  input: InspirationMaterialInput | InspirationMaterial,
  video: File,
  onProgress?: (percent: number) => void,
  queueAnalysis = true,
): Promise<InspirationMaterial> {
  const form = new FormData();
  form.set("title", input.title);
  form.set("type", input.type);
  form.set("source", input.source);
  form.set("platform", input.platform);
  form.set("market", input.market);
  form.set("language", input.language);
  form.set("theme", input.theme);
  form.set("exposure", String(input.exposure));
  form.set("days", String(input.days));
  form.set("original_name", video.name);
  form.set("mime_type", video.type || "application/octet-stream");
  form.set("byte_size", String(video.size));
  form.set(
    "duration_seconds",
    String("duration" in input ? input.duration : (input.media?.duration ?? 0)),
  );
  form.set("content_hash", input.contentHash ?? "");
  form.set("source_url", input.sourceUrl ?? "");
  form.set("rights_status", input.rightsStatus ?? "仅限内部分析");
  // analysis_status is an optional select whose valid values do not include
  // "idle". Leaving it empty stores a reference without triggering the
  // PocketBase analysis hook; queued uploads continue to create a job.
  if (queueAnalysis) form.set("analysis_status", "queued");
  form.set("analysis_progress", "0");
  form.set("review_status", "待复核");
  form.set("video", video, video.name);
  const savedRecord = await new Promise<PBRecord>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${PB_URL}/api/collections/ad_materials/records`);
    request.timeout = 120_000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress?.(
          Math.max(
            1,
            Math.min(99, Math.round((event.loaded / event.total) * 100)),
          ),
        );
    };
    request.onerror = () => reject(new Error(`上传连接中断（${PB_URL}）`));
    request.ontimeout = () =>
      reject(new Error("上传 PocketBase 超时（120 秒）"));
    request.onabort = () =>
      reject(new DOMException("上传已取消", "AbortError"));
    request.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        payload = null;
      }
      if (request.status < 200 || request.status >= 300) {
        const body = object(payload);
        const data = object(body.data);
        const fieldMessage = Object.values(data)
          .map((value) => text(object(value).message))
          .find(Boolean);
        reject(
          new Error(
            fieldMessage ||
              text(
                body.message,
                `PocketBase 上传失败（HTTP ${request.status}）`,
              ),
          ),
        );
        return;
      }
      onProgress?.(100);
      resolve(payload as PBRecord);
    };
    request.send(form);
  });
  const saved = fromRecord(savedRecord);
  // The upload modal keeps the submitted object until this promise resolves.
  // Synchronise that reference so its immediate optimistic row uses the PB id/file URL.
  if ("id" in input) Object.assign(input, saved);
  return saved;
}

export type ExternalInspirationReferenceInput = {
  externalId?: string;
  title: string;
  sourceUrl: string;
  market: string;
  exposure: number;
  days: number;
  durationSeconds: number;
};

/** Save a remote ADX video, optionally queueing it for analysis. */
export async function saveExternalInspirationReference(
  input: ExternalInspirationReferenceInput,
  autoAnalyze = false,
): Promise<{
  material: InspirationMaterial;
  created: boolean;
  analysisQueued: boolean;
}> {
  const canonicalSource = (() => {
    try {
      const url = new URL(input.sourceUrl);
      return `${url.origin}${url.pathname}`;
    } catch {
      return input.sourceUrl;
    }
  })();
  const dedupeSeed = `adx:${input.externalId || canonicalSource}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(dedupeSeed),
  );
  const sourceIdentityHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // content_hash is included for records created before source_identity_hash
  // was introduced, when it still stored the ADX identity hash.
  const existingFilter = encodeURIComponent(
    `source_identity_hash="${sourceIdentityHash}" || content_hash="${sourceIdentityHash}" || source_url="${input.sourceUrl.replace(/"/g, '\\"')}"`,
  );
  const existingResponse = await pbFetch(
    `/api/collections/ad_materials/records?perPage=1&filter=${existingFilter}`,
  );
  const existing = (await existingResponse.json()) as { items?: PBRecord[] };
  if (existing.items?.[0]) {
    const material = fromRecord(existing.items[0]);
    if (
      autoAnalyze &&
      !["queued", "running", "succeeded"].includes(
        material.analysisStatus ?? "idle",
      )
    ) {
      await retryInspirationMaterialAnalysis(material.id);
      return {
        material: {
          ...material,
          analysisStatus: "queued",
          analysisProgress: 0,
          analysisStage: "等待素材 Worker",
          analysisError: undefined,
        },
        created: false,
        analysisQueued: true,
      };
    }
    return { material, created: false, analysisQueued: false };
  }
  const response = await fetch("/api/material-intake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, sourceIdentityHash, autoAnalyze }),
  });
  const payload = (await response.json()) as {
    record?: PBRecord;
    created?: boolean;
    analysisQueued?: boolean;
    message?: string;
  };
  if (!response.ok || !payload.record)
    throw new Error(
      payload.message || `服务端入库失败（HTTP ${response.status}）`,
    );
  return {
    material: fromRecord(payload.record),
    created: payload.created === true,
    analysisQueued: payload.analysisQueued === true,
  };
}

export async function findInspirationMaterialByHash(
  hash: string,
): Promise<InspirationMaterial | undefined> {
  if (!hash) return undefined;
  const filter = encodeURIComponent(
    `content_hash="${hash.replace(/"/g, '\\"')}"`,
  );
  const response = await pbFetch(
    `/api/collections/ad_materials/records?perPage=1&filter=${filter}`,
  );
  const payload = (await response.json()) as { items?: PBRecord[] };
  return payload.items?.[0] ? fromRecord(payload.items[0]) : undefined;
}

export async function hashInspirationVideo(file: File): Promise<string> {
  if (typeof Worker !== "undefined")
    return await new Promise<string>((resolve, reject) => {
      const worker = new Worker("/material-hash-worker.js");
      worker.onmessage = (event) => {
        worker.terminate();
        event.data?.hash
          ? resolve(event.data.hash)
          : reject(new Error(event.data?.error || "视频哈希失败"));
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || "视频哈希 Worker 失败"));
      };
      worker.postMessage(file);
    });
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createInspirationMaterialVideoUrl(
  material: InspirationMaterial,
): string | null {
  return material.media?.url ?? null;
}

export async function removeInspirationMaterial(id: string): Promise<void> {
  await pbFetch(
    `/api/collections/ad_materials/records/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function retryInspirationMaterialAnalysis(
  id: string,
  force = false,
): Promise<void> {
  await pbFetch(
    `/api/lumina/material-analysis/materials/${encodeURIComponent(id)}/retry`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force, force_semantic_refresh: force }),
    },
  );
}

export function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取视频，请确认文件格式有效"));
    };
    video.src = url;
  });
}
