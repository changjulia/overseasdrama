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
    steps: ["生产目标", "正片承接段", "组合版本", "统一质检"],
  },
  {
    id: "episode-narration",
    name: "正片剧集解说",
    description: "解说句与原片镜头逐句对齐，控制信息密度",
    icon: "◉",
    steps: ["生产目标", "正片承接段", "解说策略", "组合版本", "统一质检"],
  },
  {
    id: "external-hook",
    name: "外搭钩子＋本剧正片",
    description: "匹配外搭钩子、自然过渡，并核验承诺兑现",
    icon: "↗",
    steps: ["生产目标", "正片承接段", "钩子匹配", "过渡生成", "组合版本", "统一质检"],
  },
];

export const factoryFlowSteps: FactoryFlowStep[] = [
  { id: "production-goal", order: 1, name: "生产目标", description: "确定平台、市场、目标与输出规格", state: "active" },
  { id: "episode-entry", order: 2, name: "正片承接段", description: "选择真实片源及可理解的正片接入点", state: "locked", prerequisite: "production-goal" },
  { id: "hook-match", order: 3, name: "钩子匹配", description: "从钩子库匹配或发起生成任务", state: "locked", prerequisite: "episode-entry" },
  { id: "transition", order: 4, name: "过渡生成", description: "连接钩子末段与正片开场", state: "locked", prerequisite: "hook-match" },
  { id: "combinations", order: 5, name: "组合版本", description: "组合已选资产并提交真实渲染", state: "locked", prerequisite: "transition" },
  { id: "quality-gate", order: 6, name: "统一质检", description: "检查钩子质量、连通性与承诺兑现", state: "locked", prerequisite: "combinations" },
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
  currentStep: "production-goal",
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
