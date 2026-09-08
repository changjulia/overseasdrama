type StoryBeat = { episode: number; plot?: string; beat?: string };

export function completeStoryEvent(value: string): string {
  const statements = value.split(/[；;。\n]+/).map(text => text.trim())
    .filter(text => text && !/…|\.{3}|尚待|完整承接/.test(text));
  const narrative = statements.filter(text =>
    !/^[“「"‘]|^(我|你|您|我们|你们|我的|你的)/.test(text) &&
    !/^[^：:]{1,16}[：:]/.test(text) &&
    !/^(画面|镜头|一位身穿|一名身穿)/.test(text));
  const action = /发现|宣布|拒绝|隐瞒|保护|警告|决定|反击|测试|追杀|求救|揭露|承认|寻找|命令|要求|质问|救|死|背叛/;
  return narrative.find(text => action.test(text)) || narrative[0] || "";
}

const titlePart = (value: string): string => String(value || "")
  .replace(/^[^｜|]{1,18}[｜|]\s*/, "")
  .replace(/\s*(?:→|->).*$/, "")
  .trim();

/** Title used while choosing a body-first storyline, before a hook is paired. */
export function bodyFirstStorylineTitle(plan: {
  title: string;
  strategyType: string;
}): string {
  return titlePart(plan.title) || "高光候选待补充";
}
