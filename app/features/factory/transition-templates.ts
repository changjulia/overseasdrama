import type { TransitionProductionObject } from "./types";

export type GapDiagnosis = TransitionProductionObject["gapDiagnosis"][number];
export type TransitionStyle = TransitionProductionObject["renderConfig"]["transitionStyle"];

export type TransitionTemplate = {
  id: string;
  name: string;
  description: string;
  gapTypes: GapDiagnosis[];
  style: TransitionStyle;
  durationSeconds: number;
  copyPlaceholder: string;
  evidenceRequired: boolean;
};

export type SubtitleTemplate = {
  id: string;
  name: string;
  description: string;
  assStyle: {
    fontFamily: string;
    fontSize: number;
    primaryColor: string;
    outlineColor: string;
    outlineWidth: number;
    shadowDepth: number;
    bold: boolean;
    alignment: "bottom-center" | "center" | "top-center";
    marginHorizontalPercent: number;
    marginVerticalPercent: number;
    maxLines: 2 | 3;
  };
};

export const TRANSITION_TEMPLATES: TransitionTemplate[] = [
  { id: "time-card", name: "时间卡＋黑场", description: "适合有明确年月、前后时间证据的跳时。", gapTypes: ["time"], style: "black", durationSeconds: 1.2, copyPlaceholder: "依据剧情证据填写，例如：十年后", evidenceRequired: true },
  { id: "parallel-fade", name: "并行事件淡入淡出", description: "连接不同空间的同期事件；同期关系必须有证据。", gapTypes: ["space", "time"], style: "fade", durationSeconds: 0.8, copyPlaceholder: "仅在证据支持时填写：与此同时", evidenceRequired: true },
  { id: "character-intro", name: "人物补充黑场", description: "人物身份缺失时留出可读信息卡，不自动编造身份。", gapTypes: ["character"], style: "black", durationSeconds: 1.4, copyPlaceholder: "依据人物关系证据填写必要身份", evidenceRequired: true },
  { id: "causal-bridge", name: "因果桥接淡入淡出", description: "为原因与结果之间的必要解释留出阅读时间。", gapTypes: ["causal"], style: "fade", durationSeconds: 1.0, copyPlaceholder: "依据剧情证据填写因果桥接词", evidenceRequired: true },
  { id: "emotion-breath", name: "情绪缓冲黑场", description: "强烈情绪切换前短暂停顿，不增加剧情事实。", gapTypes: ["emotion"], style: "black", durationSeconds: 0.6, copyPlaceholder: "可留空或填写有证据的极短情绪提示", evidenceRequired: false },
  { id: "flash-safe", name: "闪白避让", description: "高亮末帧可能闪白时使用压暗避让。", gapTypes: ["space", "emotion"], style: "flash_avoidance", durationSeconds: 0.35, copyPlaceholder: "通常不需要转场词", evidenceRequired: false },
  { id: "evidence-match-hard-cut", name: "证据支持的匹配硬切", description: "仅在出入镜头具有可验证的动作、构图或道具对应时使用。", gapTypes: ["space", "character", "emotion"], style: "match_cut", durationSeconds: 0, copyPlaceholder: "通常不需要转场词；必须补充镜头匹配证据", evidenceRequired: true },
  { id: "clean-hard-cut", name: "克制硬切", description: "连通性很高时直接进入正片，仍需人工确认。", gapTypes: ["time", "space", "character", "causal", "emotion"], style: "hard_cut", durationSeconds: 0, copyPlaceholder: "通常留空", evidenceRequired: false },
];

export const SUBTITLE_TEMPLATES: SubtitleTemplate[] = [
  { id: "short-white", name: "短剧白字描边", description: "高兼容默认样式，适合多数实拍画面。", assStyle: { fontFamily: "Noto Sans CJK SC", fontSize: 52, primaryColor: "#FFFFFF", outlineColor: "#111111", outlineWidth: 4, shadowDepth: 1, bold: true, alignment: "bottom-center", marginHorizontalPercent: 8, marginVerticalPercent: 12, maxLines: 2 } },
  { id: "high-contrast-yellow", name: "重点黄字", description: "用于停滑句和短重点，不建议整段滥用。", assStyle: { fontFamily: "Noto Sans CJK SC", fontSize: 56, primaryColor: "#FFE34D", outlineColor: "#111111", outlineWidth: 5, shadowDepth: 1, bold: true, alignment: "bottom-center", marginHorizontalPercent: 8, marginVerticalPercent: 13, maxLines: 2 } },
  { id: "dialogue-compact", name: "对白紧凑", description: "字号稍小，适合台词密度较高的连续解说。", assStyle: { fontFamily: "Noto Sans CJK SC", fontSize: 46, primaryColor: "#FFFFFF", outlineColor: "#151515", outlineWidth: 3, shadowDepth: 1, bold: false, alignment: "bottom-center", marginHorizontalPercent: 7, marginVerticalPercent: 11, maxLines: 2 } },
  { id: "cinematic-soft", name: "电影感柔白", description: "较轻描边与阴影，适合暗部稳定的画面。", assStyle: { fontFamily: "Source Han Serif SC", fontSize: 48, primaryColor: "#F7F2E8", outlineColor: "#1A1A1A", outlineWidth: 2, shadowDepth: 2, bold: false, alignment: "bottom-center", marginHorizontalPercent: 9, marginVerticalPercent: 12, maxLines: 2 } },
  { id: "center-hook", name: "居中停滑句", description: "只用于开头短句，避免遮挡人物面部。", assStyle: { fontFamily: "Noto Sans CJK SC", fontSize: 60, primaryColor: "#FFFFFF", outlineColor: "#101010", outlineWidth: 5, shadowDepth: 1, bold: true, alignment: "center", marginHorizontalPercent: 10, marginVerticalPercent: 18, maxLines: 2 } },
  { id: "top-safe", name: "顶部安全区", description: "底部有平台 UI 或画面文字时上移字幕。", assStyle: { fontFamily: "Noto Sans CJK SC", fontSize: 48, primaryColor: "#FFFFFF", outlineColor: "#111111", outlineWidth: 4, shadowDepth: 1, bold: true, alignment: "top-center", marginHorizontalPercent: 8, marginVerticalPercent: 14, maxLines: 2 } },
];

export function recommendedTransitionTemplates(gaps: GapDiagnosis[]): TransitionTemplate[] {
  if (!gaps.length) return TRANSITION_TEMPLATES;
  return TRANSITION_TEMPLATES.slice().sort((left, right) => {
    const leftScore = left.gapTypes.filter((gap) => gaps.includes(gap)).length;
    const rightScore = right.gapTypes.filter((gap) => gaps.includes(gap)).length;
    return rightScore - leftScore;
  });
}

// Phase 2 only: the same serializable template fields can feed a Remotion
// composition after product validation. MVP rendering remains in the existing
// FFmpeg/ASS-equivalent path and adds no Remotion runtime dependency.
