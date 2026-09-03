// Text-only, evidence-preserving first-pass retrieval. Never a semantic quality verdict.
const VERSION = "script-candidate-v2";
const CONCEPTS = [
  ["身份与阶级", /身份|公主|王子|女王|奴隶|贵族|血统|princess|queen|prince|slave|royal|identity/ig],
  ["权力与强迫", /压迫|逼迫|强迫|挑选|挑妻|奴隶|命令|霸凌|惩罚|slave|command|bully|punish|force/ig],
  ["亲属关系", /母亲|父亲|女儿|儿子|姐姐|妹妹|兄弟|mother|father|daughter|sister|brother|son\b/ig],
  ["伴侣关系", /妻子|丈夫|离婚|未婚|婚姻|嫁|结婚|wife|husband|marriage|married|divorce|mate\b/ig],
  ["背叛与欺骗", /背叛|欺骗|出轨|谎言|betray|cheat|lie\b|deceiv/ig],
  ["危险与救援", /救命|救援|拯救|危险|死亡|杀死|袭击|逃跑|逃离|rescue|save|kill|death|attack|escape/ig],
  ["冲突与反抗", /冲突|反抗|争吵|殴打|打斗|争执|战斗|fight|battle|defy|confront/ig],
  ["财富与交易", /租金|合同|金钱|百万|富豪|贫穷|交易|money|rich|poor|contract|million/ig],
  ["觉醒与能力", /觉醒|狼灵|变身|异能|魔法|狼人|狼族|awaken|power|magic|wolf|lycan/ig],
  ["惊讶", /惊讶|震惊|吃惊|惊呆|surpris|shock/ig],
  ["恐惧", /慌张|害怕|恐惧|惊恐|fear|afraid|terrifi/ig],
  ["愤怒", /愤怒|生气|愤恨|怒吼|angry|anger|furious/ig],
];
function concepts(text) {
  return CONCEPTS.flatMap(([label, pattern]) => {
    const hits = [...new Set(String(text || "").match(pattern) || [])];
    return hits.length ? [{ label, status: "inferred", evidence: hits.slice(0, 6), note: "词汇归类推断，不证明剧情关系成立" }] : [];
  });
}
function extractScene(scene) {
  const script = String(scene.script || "");
  const lines = script.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const select = pattern => lines.filter(line => pattern.test(line));
  const field = (quotes, missing) => {
    const claims=quotes.map(quote=>({quote,status:/似乎|可能|疑似|推测|也许|仿佛|seems?\b|perhaps\b|might\b|apparently\b/i.test(quote)?"inferred":"script_explicit",source:"csv_script",verification:"unverified"}));
    return {status:claims.length?(claims.some(c=>c.status==="inferred")?"inferred":"script_explicit"):"missing",quotes,claims,note:quotes.length?"仅代表表单原文，未核验原片；不确定措辞单独标为推断":missing};
  };
  const ranges = [...script.matchAll(/\[(\d{2}):(\d{2})\s*--\s*(\d{2}):(\d{2})\]/g)].map(m => ({start:Number(m[1])*60+Number(m[2]),end:Number(m[3])*60+Number(m[4]),status:"unverified_relative"}));
  const invalidRange = ranges.some(r => r.end <= r.start) || [...script.matchAll(/\[(\d{2}):(\d{2})\s*--\s*(\d{2}):(\d{2})\]/g)].some(m=>Number(m[2])>=60||Number(m[4])>=60);
  return {version:VERSION, sceneNumber:scene.sceneNumber, script,
    fields: {
      events:field(select(/^(镜头描述|画面描述|剧情|事件)[：:]/),"缺少明确事件描述"),
      dialogue:field(select(/^(台词或旁白|台词|旁白)[：:]/),"缺少对白或旁白"),
      relationships:field(select(/^(人物关系|关系)[：:]/),"人物关系尚未明确，不能由共同角色词断定"),
      conflict:field(select(/^(核心矛盾|冲突)[：:]/),"冲突需结合事件复核"),
      emotion:field(select(/^(情绪|情绪曲线)[：:]/),"情绪走向未明确"),
      promise:field(select(/^(悬念|叙事承诺|悬念承诺)[：:]/),"钩子承诺及正片兑现条件未明确"),
    }, concepts:concepts(script), reportedDuration:Number(scene.reportedDuration)||null, relativeRanges:ranges,
    warnings:["脚本与原片内容待核验","原片起止时间和脚本时间偏移待校准",...(invalidRange?["脚本存在无效或零时长区间"]:[]),...(!script.trim()?["脚本缺失，不能参与文本召回"]:[])],
  };
}
function rankCandidate(extracted, highlightText) {
  const target = concepts(highlightText);
  const overlap = extracted.concepts.filter(c => target.some(t => t.label === c.label));
  const evidence = overlap.map(c => ({dimension:c.label, hookQuotes:c.evidence, highlightQuotes:target.find(t=>t.label===c.label).evidence,status:"inferred"}));
  const missing = Object.entries(extracted.fields).filter(([,v])=>v.status==="missing").map(([key,v])=>({field:key,reason:v.note}));
  return {method:VERSION, signalCount:overlap.length, state:overlap.length?"candidate_recommendation":"no_clear_signal", evidence, missing,
    connection:overlap.length?`可能存在「${overlap.map(c=>c.label).join("、")}」的平行或强化关系；前因后果承接尚未确认。`:"没有明确共同剧情信号，不推荐直接拼接。",
    risks:["共同词义不代表同一人物、世界观或因果关系","悬念能否由该正片兑现尚未核实","跨语种对应是词表推断，需内容复核"],
    promiseVerdict:"unknown", conflictVerdict:"unknown", productionEligible:false};
}
function validateDecision(body, highlight, extracted) {
  if (!["shortlist","reject","confirm"].includes(body.action)) throw new Error("请选择入围、排除或核验确认");
  if(body.action!=="reject"&&!extracted.script.trim())throw new Error("脚本缺失，不能入围或确认；可排除并补齐来源资料");
  if (body.action !== "confirm") return {state:body.action,storylineReady:false};
  if (![body.start,body.end,body.mediaDuration].every(v=>typeof v==="number"&&Number.isFinite(v)) || body.start<0 || body.end<=body.start || body.end>body.mediaDuration)
    throw new Error("请填写与原视频对应的有效起止秒数");
  if (body.end-body.start<5 || body.end-body.start>60) throw new Error("当前可用钩子区间仍要求5–60秒；表单场景不等于完整钩子");
  if (!extracted.script.trim()) throw new Error("缺少脚本，请先补齐内容依据");
  if (body.contentVerified!==true || body.boundaryVerified!==true || body.connectionVerified!==true || body.promiseVerified!==true || body.noSevereConflict!==true)
    throw new Error("请逐项完成人工内容、边界、承接、兑现与严重冲突核验");
  if (typeof body.note!=="string" || body.note.trim().length<10) throw new Error("请填写至少10字的内容及承接核验依据");
  if (highlight.boundaryStatus!=="verified" || highlight.reviewStatus!=="approved") throw new Error("正片高光尚未通过现有边界与人工审核，暂不可确认故事线输入");
  return {state:"confirmed",storylineReady:true};
}
// Decode structured fields at the API boundary, never stringify JSON as prose.
// Only explicit text properties are accepted; confidence/status are not content.
function evidenceText(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (/^[\[{"]/.test(text)) {
      try { return evidenceText(JSON.parse(text), depth + 1); } catch (_) { /* Preserve ordinary prose verbatim. */ }
    }
    return [text];
  }
  if (Array.isArray(value)) return value.reduce((all, item) => all.concat(evidenceText(item, depth + 1)), []);
  if (typeof value === "object") {
    for (const key of ["text", "value", "label", "description", "summary"]) {
      const result = evidenceText(value[key], depth + 1);
      if (result.length) return result;
    }
  }
  return [];
}
function highlightContent(record) {
  const fields = {};
  for (const [key, stored] of [["spokenSummary","spoken_summary"],["visualSummary","visual_summary"],["conflict","conflict"],["emotion","emotion"],["narrativePromise","narrative_promise"],["relationships","relationships"]]) {
    fields[key] = evidenceText(record.getString(stored));
  }
  return fields;
}
module.exports={VERSION,concepts,extractScene,rankCandidate,validateDecision,evidenceText,highlightContent};
