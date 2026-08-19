/** Shared, deliberately small vocabulary for labels exchanged by the stores. */
export const DIMENSIONS = ["genre", "theme", "role", "relation", "conflict", "emotion", "storyBeat", "scene", "audience", "acquisition"] as const;
export type OntologyDimension = typeof DIMENSIONS[number];
export type TagRelation = "exact" | "compatible" | "bridgeable" | "contradictory" | "unknown";
export type TagSetComparison = {
  relation: TagRelation;
  score: number;
  exact: Array<{ left: OntologyTag; right: OntologyTag }>;
  compatible: Array<{ left: OntologyTag; right: OntologyTag }>;
  bridgeable: Array<{ left: OntologyTag; right: OntologyTag }>;
  contradictory: Array<{ left: OntologyTag; right: OntologyTag }>;
  unknown: Array<{ left: OntologyTag; right: OntologyTag }>;
  hardConflicts: string[];
};
export type OntologyTag = {
  code: string; label: string; dimension: OntologyDimension; aliases: string[];
  parent?: string; related: string[]; contradicts: string[];
  original: string; evidence: string[]; confidence?: number;
};
type Definition = Omit<OntologyTag, "original" | "evidence" | "confidence" | "aliases"> & { aliases: string[] };

const definitions: Definition[] = [
  ["genre","都市",["都市剧","现代","urban","urban drama"]], ["genre","古装",["古装剧","历史剧","period","historical"]], ["genre","悬疑",["悬疑剧","推理","mystery","thriller"]], ["genre","甜宠",["甜宠剧","言情","romance","sweet romance"]], ["genre","豪门",["豪门剧","霸总","billionaire romance"]], ["genre","年代",["年代剧","年下","republican era"]], ["genre","仙侠",["仙侠剧","xianxia","fantasy"]], ["genre","现实",["现实题材","realistic"]],
  ["theme","复仇",["revenge"]], ["theme","重生",["重生逆袭","rebirth","second chance"]], ["theme","成长",["成长线","growth"]], ["theme","救赎",["redemption"]], ["theme","家族",["家族线","family","family saga"]], ["theme","女性独立",["女性成长","女强","female empowerment"]], ["theme","阶层逆袭",["逆袭","social mobility"]], ["theme","真相",["寻找真相","truth"]], ["theme","契约婚姻",["契约","contract marriage"]],
  ["role","主角",["主人公","男女主","protagonist","lead"]], ["role","男主",["male lead","hero"]], ["role","女主",["female lead","heroine"]], ["role","反派",["villain","antagonist"]], ["role","配角",["supporting character"]], ["role","受害者",["victim"]], ["role","权威者",["家长","boss","authority"]],
  ["relation","恋人",["情侣","lovers","romantic partners"]], ["relation","夫妻",["夫妻关系","spouses","married"]], ["relation","亲子",["父子","母子","parent-child"]], ["relation","敌对",["对手","敌人","rivals","enemies"]], ["relation","盟友",["同盟","allies"]], ["relation","上下级",["雇佣关系","上下属","subordinate"]], ["relation","师徒",["师生","师徒关系","mentor"]], ["relation","背叛",["betrayal"]],
  ["conflict","身份误会",["身份错认","identity misunderstanding","mistaken identity"]], ["conflict","复仇对抗",["revenge conflict"]], ["conflict","权力争夺",["权力斗争","power struggle"]], ["conflict","生存危机",["survival crisis"]], ["conflict","情感选择",["love choice","emotional dilemma"]], ["conflict","家族反目",["家庭矛盾","family feud"]], ["conflict","阶层压迫",["阶级冲突","class oppression"]], ["conflict","法律困境",["法律冲突","legal dilemma"]],
  ["emotion","愤怒",["anger","angry"]], ["emotion","悲伤",["sadness","sad"]], ["emotion","甜蜜",["甜","sweet"]], ["emotion","紧张",["tension","tense"]], ["emotion","爽感",["爽","catharsis","爽点"]], ["emotion","虐",["虐心","heartbreak"]], ["emotion","震惊",["惊讶","shock"]], ["emotion","期待",["anticipation"]], ["emotion","恐惧",["害怕","fear"]],
  ["storyBeat","开场钩子",["开场","opening hook","hook"]], ["storyBeat","反转",["twist","reversal"]], ["storyBeat","打脸",["爽点打脸","comeuppance"]], ["storyBeat","告白",["confession"]], ["storyBeat","揭密",["揭示秘密","revelation"]], ["storyBeat","危机",["危机升级","crisis"]], ["storyBeat","误会",["misunderstanding"]], ["storyBeat","团圆",["reunion"]], ["storyBeat","离别",["separation"]], ["storyBeat","复合",["reconciliation"]],
  ["scene","办公室",["office"]], ["scene","医院",["hospital"]], ["scene","家中",["家庭","home"]], ["scene","法庭",["courtroom","court"]], ["scene","校园",["school","campus"]], ["scene","宴会",["party","banquet"]], ["scene","警局",["派出所","police station"]], ["scene","街道",["street"]], ["scene","酒店",["hotel"]], ["scene","监狱",["prison"]],
  ["audience","女性向",["女频","female audience","women"]], ["audience","男性向",["男频","male audience","men"]], ["audience","年轻人群",["年轻用户","youth","young adults"]], ["audience","家庭人群",["家庭用户","family audience"]], ["audience","下沉人群",["下沉市场","mass market"]], ["audience","高消费人群",["高净值","premium audience"]],
  ["acquisition","信息差",["information gap"]], ["acquisition","情绪拉升",["情绪钩子","emotional lift"]], ["acquisition","强冲突",["冲突钩子","strong conflict"]], ["acquisition","悬念预告",["悬念","cliffhanger","suspense"]], ["acquisition","身份揭示",["身份钩子","identity reveal"]], ["acquisition","反差",["反差钩子","contrast"]], ["acquisition","爽点兑现",["爽感兑现","payoff"]], ["acquisition","虐点共情",["共情","empathy"]],
].map(([dimension, label, aliases]) => ({ code: `${dimension}.${String(label).replace(/[^\w\u4e00-\u9fff]+/g, "-")}`, label: String(label), dimension: dimension as OntologyDimension, aliases: [String(label), ...(aliases as string[])], related: [], contradicts: [] }));

const byCode = new Map(definitions.map((d) => [d.code, d]));
// Explicit oppositions are kept in the ontology rather than inferred from labels.
const oppositionPairs: Array<[string, string]> = [["audience.女性向", "audience.男性向"], ["emotion.甜蜜", "emotion.虐"], ["relation.盟友", "relation.敌对"]];
for (const [left, right] of oppositionPairs) {
  byCode.get(left)?.contradicts.push(right);
  byCode.get(right)?.contradicts.push(left);
}
const hierarchy: Array<[string, string]> = [["theme.复仇", "theme.阶层逆袭"], ["theme.女性独立", "theme.成长"], ["theme.契约婚姻", "theme.家族"], ["role.男主", "role.主角"], ["role.女主", "role.主角"], ["role.反派", "role.配角"], ["relation.夫妻", "relation.恋人"], ["storyBeat.打脸", "storyBeat.危机"], ["acquisition.身份揭示", "acquisition.信息差"]];
for (const [child, parent] of hierarchy) byCode.get(child)!.parent = parent;
const relatedPairs: Array<[string, string]> = [["theme.复仇", "conflict.复仇对抗"], ["theme.重生", "storyBeat.反转"], ["conflict.身份误会", "storyBeat.误会"], ["emotion.爽感", "storyBeat.打脸"], ["emotion.紧张", "conflict.生存危机"], ["acquisition.悬念预告", "storyBeat.开场钩子"]];
for (const [left, right] of relatedPairs) { byCode.get(left)!.related.push(right); byCode.get(right)!.related.push(left); }
const key = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s_]+/g, "");
const byAlias = new Map(definitions.flatMap((d) => d.aliases.map((alias) => [`${d.dimension}:${key(alias)}`, d] as const)));
const anyAlias = new Map(definitions.flatMap((d) => d.aliases.map((alias) => [key(alias), d] as const)));
const slug = (value: string) => key(value).replace(/[^\w\u4e00-\u9fff-]+/g, "-").slice(0, 64) || "unknown";
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function normalizeTag(input: unknown, dimension: OntologyDimension = "theme", options: { evidence?: string[]; confidence?: number } = {}): OntologyTag {
  const rawObject = obj(input); const original = typeof input === "string" ? input : String(rawObject.label ?? rawObject.name ?? rawObject.code ?? "未命名标签");
  const candidate = byCode.get(String(rawObject.code ?? "")) ?? byAlias.get(`${dimension}:${key(original)}`) ?? anyAlias.get(key(original));
  const definition = candidate ?? { code: `${dimension}.${slug(original)}`, label: original.trim() || "未命名标签", dimension, aliases: [original], related: [], contradicts: [] };
  const evidence = Array.from(new Set([...(options.evidence ?? []), ...(Array.isArray(rawObject.evidence) ? rawObject.evidence.filter((v): v is string => typeof v === "string") : [])]));
  return { code: definition.code, label: definition.label, dimension: definition.dimension, aliases: definition.aliases, parent: definition.parent, related: definition.related, contradicts: definition.contradicts, original, evidence, confidence: typeof options.confidence === "number" ? options.confidence : typeof rawObject.confidence === "number" ? rawObject.confidence : undefined };
}

export function normalizeTags(input: unknown, dimension: OntologyDimension, options?: { evidence?: string[] }): OntologyTag[] {
  return (Array.isArray(input) ? input : input == null ? [] : [input]).map((item) => normalizeTag(item, dimension, options));
}

export function relationOf(left: unknown, right: unknown, dimension: OntologyDimension = "theme"): TagRelation {
  const a = normalizeTag(left, dimension), b = normalizeTag(right, dimension);
  if (a.code === b.code) return "exact";
  if (a.contradicts.includes(b.code) || b.contradicts.includes(a.code)) return "contradictory";
  if (a.related.includes(b.code) || b.related.includes(a.code)) return "bridgeable";
  if (a.parent === b.code || b.parent === a.code) return "compatible";
  // An unregistered label has no verified semantic relationship. Treating it
  // as bridgeable made missing evidence look like a weak positive match.
  if (!byCode.has(a.code) || !byCode.has(b.code)) return "unknown";
  return a.dimension === b.dimension ? "compatible" : "bridgeable";
}

export const tagRelation = relationOf;
export function compareTagSets(left: unknown[], right: unknown[], dimension: OntologyDimension = "theme"): TagSetComparison {
  const a = normalizeTags(left, dimension), b = normalizeTags(right, dimension);
  const buckets: Record<TagRelation, TagSetComparison["exact"]> = { exact: [], compatible: [], bridgeable: [], contradictory: [], unknown: [] };
  for (const leftTag of a) for (const rightTag of b) { const relation = relationOf(leftTag, rightTag, dimension); buckets[relation].push({ left: leftTag, right: rightTag }); }
  const hardConflicts = Array.from(new Set(buckets.contradictory.map(({ left: l, right: r }) => `${l.code}:${r.code}`)));
  const score = Math.max(-1, Math.min(1, (buckets.exact.length * 1 + buckets.compatible.length * 0.55 + buckets.bridgeable.length * 0.15 - buckets.contradictory.length) / Math.max(1, a.length * b.length)));
  const relation: TagRelation = hardConflicts.length ? "contradictory" : buckets.exact.length ? "exact" : buckets.compatible.length ? "compatible" : buckets.bridgeable.length ? "bridgeable" : "unknown";
  return { relation, score, ...buckets, hardConflicts };
}
export function normalizeAnalysisPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = { ...(value as Record<string, unknown>) };
  const content = obj(root.content);
  const fields: Array<[string, OntologyDimension]> = [["genres","genre"],["themes","theme"],["characters","role"],["relations","relation"],["relationships","relation"],["emotions","emotion"],["conflicts","conflict"],["storyBeats","storyBeat"],["scenes","scene"]];
  if (Object.keys(content).length) root.content = { ...content, ...Object.fromEntries(fields.filter(([f]) => f in content).map(([f,d]) => [f, normalizeTags(content[f], d as OntologyDimension)])) };
  return root;
}
