import type { Draft, FactoryModeDefinition, QualityStatus } from "./types";

export const factoryModes: FactoryModeDefinition[] = [
  {
    id: "episode-splice",
    name: "正片剧集拼接",
    description: "连贯剧情与高光前置，保留因果和付费卡点",
    icon: "⌁",
    steps: ["选择正片", "拼接策略", "钩子候选", "生成时间线", "钩子质检", "保存草稿"],
  },
  {
    id: "episode-narration",
    name: "正片剧集解说",
    description: "解说句与原片镜头逐句对齐，控制信息密度",
    icon: "◉",
    steps: ["选择剧情", "解说策略", "设计钩子", "脚本工作台", "生成时间线", "钩子质检", "保存草稿"],
  },
  {
    id: "external-hook",
    name: "外搭钩子＋本剧正片",
    description: "匹配外搭钩子、自然过渡，并核验承诺兑现",
    icon: "↗",
    steps: ["选择正片", "钩子来源", "钩子推荐", "制作方式", "生成控制", "生成过渡", "时间线", "钩子质检", "保存草稿"],
  },
];

export const qualityOptions: QualityStatus[] = [
  "可以直接生成",
  "建议优化后生成",
  "停滑能力弱",
  "情绪强但信息不足",
  "信息清楚但缺少刺激",
  "音画不同步",
  "悬念锚定缺失",
  "过度剧透",
  "高点击低转化风险",
  "货不对板，禁止批量生成",
];

export const qualityMetrics = [
  ["停滑能力", 91],
  ["情绪强度", 88],
  ["感官刺激", 76],
  ["戏剧张力", 94],
  ["信息效率", 82],
  ["音画匹配", 86],
  ["悬念强度", 89],
] as const;

export const initialDrafts: Draft[] = [
  {
    id: "draft-splice-12",
    title: "身份揭露 · 高光前置 V12",
    mode: "episode-splice",
    drama: "Goodbye, My Billionaire Husband",
    hook: "董事会身份揭露",
    episodeRange: "EP 08–12",
    transition: "动作匹配",
    language: "英语",
    duration: "01:18",
    ratio: "9:16",
    qualityStatus: "可以直接生成",
    updatedAt: "12 分钟前",
    autoSaved: true,
    thumbnailTone: "rose",
    progress: 86,
  },
  {
    id: "draft-narration-08",
    title: "禁忌新娘 · 悬疑追问 V08",
    mode: "episode-narration",
    drama: "The Alpha's Forbidden Bride",
    hook: "为什么狼王没有处决她？",
    episodeRange: "EP 03–07",
    transition: "原声高潮",
    language: "德语",
    duration: "00:58",
    ratio: "9:16",
    qualityStatus: "建议优化后生成",
    updatedAt: "1 小时前",
    autoSaved: true,
    thumbnailTone: "violet",
    progress: 62,
  },
];
