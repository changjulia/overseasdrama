export type WorkflowCoverage = {
  highlights?: { total?: number; current?: number };
  scripts?: { total?: number; nonEmpty?: number; current?: number };
  matches?: { current?: number };
  confirmed?: { current?: number };
  episodes?: { total?: number; current?: number; events?: number };
  candidateSemantics?: {
    total?: number;
    withTagRecall?: number;
    withEventMatch?: number;
    rulesOnly?: number;
  };
};

export type CoverageState = "ready" | "partial" | "blocked" | "unknown";

export type CoverageCard = {
  key:
    | "episodes"
    | "highlights"
    | "scripts"
    | "candidateTags"
    | "candidateEvents"
    | "matches"
    | "confirmed";
  label: string;
  value: string;
  detail: string;
  state: CoverageState;
};

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function fraction(current: unknown, total: unknown) {
  return count(current) && count(total) ? `${current}/${total}` : "正在核对";
}

function fractionState(current: unknown, total: unknown): CoverageState {
  if (!count(current) || !count(total)) return "unknown";
  if (current === 0) return "blocked";
  return current >= total ? "ready" : "partial";
}

export function summarizeWorkflowCoverage(coverage?: WorkflowCoverage) {
  const cards: CoverageCard[] = [
    { key: "episodes", label: "整集剧情分析", value: fraction(coverage?.episodes?.current, coverage?.episodes?.total), detail: count(coverage?.episodes?.events) ? `${coverage.episodes.events} 个有依据事件` : "事件数未提供", state: fractionState(coverage?.episodes?.current, coverage?.episodes?.total) },
    { key: "highlights", label: "高光当前有效语义", value: fraction(coverage?.highlights?.current, coverage?.highlights?.total), detail: "仅统计与当前来源指纹一致的结果", state: fractionState(coverage?.highlights?.current, coverage?.highlights?.total) },
    { key: "scripts", label: "素材脚本有效语义", value: fraction(coverage?.scripts?.current, coverage?.scripts?.nonEmpty), detail: count(coverage?.scripts?.total) ? `${coverage.scripts.total} 个素材中的非空场景` : "素材总数未提供", state: fractionState(coverage?.scripts?.current, coverage?.scripts?.nonEmpty) },
    { key: "candidateTags", label: "候选统一标签覆盖", value: fraction(coverage?.candidateSemantics?.withTagRecall, coverage?.candidateSemantics?.total), detail: count(coverage?.candidateSemantics?.total) && count(coverage?.candidateSemantics?.withTagRecall) ? `${coverage.candidateSemantics.total - coverage.candidateSemantics.withTagRecall} 个候选未生成或已失效，只能规则召回` : "尚未区分统一标签与规则召回", state: fractionState(coverage?.candidateSemantics?.withTagRecall, coverage?.candidateSemantics?.total) },
    { key: "candidateEvents", label: "候选事件匹配覆盖", value: fraction(coverage?.candidateSemantics?.withEventMatch, coverage?.candidateSemantics?.total), detail: count(coverage?.candidateSemantics?.total) && count(coverage?.candidateSemantics?.withEventMatch) ? `${coverage.candidateSemantics.total - coverage.candidateSemantics.withEventMatch} 个候选没有当前有效事件匹配` : "规则命中不计为事件匹配", state: fractionState(coverage?.candidateSemantics?.withEventMatch, coverage?.candidateSemantics?.total) },
    { key: "matches", label: "当前有效事件匹配", value: count(coverage?.matches?.current) ? String(coverage.matches.current) : "正在核对", detail: "包含候选、不适合与证据不足", state: !count(coverage?.matches?.current) ? "unknown" : coverage.matches.current > 0 ? "partial" : "blocked" },
    { key: "confirmed", label: "人工确认故事线输入", value: count(coverage?.confirmed?.current) ? String(coverage.confirmed.current) : "正在核对", detail: "完成双片拉片与全部审核门禁", state: !count(coverage?.confirmed?.current) ? "unknown" : coverage.confirmed.current > 0 ? "ready" : "blocked" },
  ];
  const tagCoverageKnown = count(coverage?.highlights?.current) && count(coverage?.scripts?.current);
  const tagEnabled = Boolean(tagCoverageKnown && coverage!.highlights!.current! > 0 && coverage!.scripts!.current! > 0);
  const eventCoverageKnown = count(coverage?.matches?.current);
  const eventEnabled = Boolean(eventCoverageKnown && coverage!.matches!.current! > 0);
  return {
    cards,
    tagEnabled,
    eventEnabled,
    tagReason: !tagCoverageKnown ? "先运行规则初筛以核对统一语义覆盖" : !tagEnabled ? "高光或素材脚本暂无当前有效语义" : fractionState(coverage?.highlights?.current, coverage?.highlights?.total) === "ready" && fractionState(coverage?.scripts?.current, coverage?.scripts?.nonEmpty) === "ready" ? "双方统一语义覆盖完整，可缩小候选范围" : "仅筛选已完成统一语义分析的部分数据",
    eventReason: !eventCoverageKnown ? "先运行规则初筛以核对事件匹配覆盖" : !eventEnabled ? "尚无当前有效事件匹配" : "仅查看已保存且仍与当前来源一致的事件匹配",
  };
}
