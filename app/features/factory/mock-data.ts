import type {
  Draft,
  FactoryFlowStep,
  FactoryModeDefinition,
  FactoryWorkflow,
  ProductionGoal,
  QualityStatus,
} from "./types";

export const factoryModes: FactoryModeDefinition[] = [
  {
    id: "episode-splice",
    name: "正片剧集拼接",
    description: "连贯剧情与高光前置，保留因果和付费卡点",
    icon: "⇄",
    steps: ["钩子匹配", "过渡生成", "组合版本", "统一质检"],
  },
  {
    id: "episode-narration",
    name: "正片剧集解说",
    description: "解说句与原片镜头逐句对齐，控制信息密度",
    icon: "◉",
    steps: ["钩子匹配", "过渡生成", "组合版本", "统一质检"],
  },
  {
    id: "external-hook",
    name: "外搭钩子＋本剧正片",
    description: "匹配外搭钩子、自然过渡，并核验承诺兑现",
    icon: "↗",
    steps: ["选择剧集", "按主题 / 内容标签筛选外搭钩子", "匹配完整故事线与投放区间", "设计过渡", "成片时间线", "质检", "预览和审核", "保存和导出"],
  },
];

export const factoryFlowSteps: FactoryFlowStep[] = [
  { id: "episode-source", order: 1, name: "选择剧集", description: "选择真实片源与免费剧集范围", state: "active" },
  { id: "hook-source", order: 2, name: "按主题 / 内容标签筛选外搭钩子", description: "根据剧目主题和内容标签筛选可追溯钩子", state: "locked", prerequisite: "episode-source" },
  { id: "hook-match", order: 3, name: "匹配完整故事线与投放区间", description: "按不同主题和钩子的故事脉络，匹配对应剧集、完整投放区间和精确承接帧", state: "locked", prerequisite: "hook-source" },
  { id: "transition", order: 4, name: "设计过渡", description: "连接钩子末帧与正片首个可理解事件", state: "locked", prerequisite: "hook-match" },
  { id: "timeline", order: 5, name: "成片时间线", description: "调整结构、入出点与片段时长", state: "locked", prerequisite: "transition" },
  { id: "quality-gate", order: 6, name: "质检", description: "检查停滑力、承诺兑现、故事线连续性与合规", state: "locked", prerequisite: "timeline" },
  { id: "preview-review", order: 7, name: "预览和审核", description: "生成 9:16 预览并提交人工审核", state: "locked", prerequisite: "quality-gate" },
  { id: "save-export", order: 8, name: "保存和导出", description: "保存版本并按审核结果导出", state: "locked", prerequisite: "preview-review" },
];

export const defaultProductionGoal: ProductionGoal = {
  objective: null,
  market: "",
  language: "英语",
  platform: null,
  ratio: "9:16",
  aiGenerationAllowed: false,
  intensity: "balanced",
};

/** Empty by design: downstream assets appear only after a source/API returns real results. */
export const createInitialFactoryWorkflow = (): FactoryWorkflow => ({
  currentStep: "episode-source",
  steps: factoryFlowSteps.map((step) => ({ ...step })),
  goal: { ...defaultProductionGoal },
  entryPoints: [],
  hooks: [],
  transitions: [],
  combinations: [],
  qualityReport: { status: "not-connected", findings: [] },
});

export const qualityOptions: QualityStatus[] = [
  "可以直接生成",
  "建议优化后生成",
  "停滑能力弱",
  "情绪强但信息不足",
  "信息清晰但缺少刺激",
  "音画不同步",
  "悬念锚定缺失",
  "过度剧透",
  "高点击低转化风险",
  "货不对板，禁止批量生成",
];

/** Metric labels only; scores must come from a completed quality service response. */
export const qualityMetrics = [
  "停滑能力",
  "情绪强度",
  "感官刺激",
  "戏剧张力",
  "信息效率",
  "音画匹配",
  "悬念强度",
] as const;

// New workspaces start empty. Drafts shown in the UI must come from user actions.
export const initialDrafts: Draft[] = [];
