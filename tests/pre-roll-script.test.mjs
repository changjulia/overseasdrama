import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreRollContext, validatePreRollIdeas, validatePreRollScript, formatPreRollScript, buildPreRollPrompt } from '../app/lib/pre-roll-script.ts';
import { dialogueLanguageIssue, PRE_ROLL_LANGUAGES } from '../app/lib/pre-roll-language.ts';
import { generatePreRoll } from '../app/lib/pre-roll-generator.ts';

const context = { drama: '测试剧', plan: { id: 'plan1', title: '门外的证人', storylineSummary: '女主被误解，证人到场但尚未开口。', segments: [{ episode: 1, start: 10, end: 30, plot: '女主遭指责，门外响起脚步声。', highlightAssetId: 'highlight1' }], hookNeed: { prohibitedReveals: ['证人身份'] } }, duration: 15, language: '英语', ratio: '9:16', brief: '' };
const idea = { title: '门外是谁', direction: '悬念追问', opening: '手握门把', escalation: '指责声响起', cliffhanger: '脚步停住', bodyConnection: '接入正片门外脚步声', appeal: '观众想知道来人是谁', inventedDetails: ['门把手特写'], evidenceSegments: [0] };
Object.assign(idea, { turn: '挥来的手被另一人截住', firstThreeSeconds: [{ start: 0, end: 1, visual: '手掌挥向女主', sound: '衣袖破风' }, { start: 1, end: 2, visual: '女主抬手拦住', sound: '手臂碰撞闷响' }, { start: 2, end: 3, visual: '门被推开，两人转头', sound: '开门巨响' }] });
const ideas = { ideas: [idea, { ...idea, title: '质问', direction: '冲突直入' }, { ...idea, title: '沉默', direction: '情绪反差' }] };
const script = { style: '写实短剧', scene: '客厅，布局依参考图', mood: '压迫', characters: '人物外观依原片参考图', continuity: '人物站位保持一致', shots: [{ start: 0, end: 3, narrative: '近景固定，女主攥紧手指，门外脚步声骤停。' }, { start: 3, end: 10, narrative: '中景缓推，女主抬头说：「Who is there?」' }, { start: 10, end: 15, narrative: '镜头停在门边，女主转头，脚步声接入正片。' }], tags: { conflict: '误解', emotion: '压迫', framing: '近景、中景', camera: '固定、缓推', image: '客厅', action: '转头', voice: '英语对白、脚步声', sellingPoint: '悬念' }, handoff: '以脚步声接入第一段正片', referenceChecklist: ['女主与客厅参考图'] };

const fastScript = { ...script, shots: [
  { start: 0, end: 1, narrative: '特写，挥下的手被女主抓住，衣袖发出脆响。' },
  { start: 1, end: 2, narrative: '近景，女主推开手臂说：「Stop.」' },
  { start: 2, end: 3, narrative: '中景，门骤然推开，两人同时转头。' },
  ...[3,6,9,12].map(start => ({ start, end: start + 3, narrative: '近景，女主向门口迈一步，脚步声加快。' })),
] };

test('reject missing highlight and invalid source ranges before requesting a model', () => {
  assert.equal(validatePreRollContext(context).duration, 15);
  assert.throws(() => validatePreRollContext({ ...context, plan: { ...context.plan, segments: [] } }));
  assert.throws(() => validatePreRollContext({ ...context, plan: { ...context.plan, segments: [{ ...context.plan.segments[0], end: 9 }] } }));
});
test('evidence indices cannot invent nonexistent footage', () => {
  assert.equal(validatePreRollIdeas(ideas, 1).length, 3);
  assert.throws(() => validatePreRollIdeas({ ideas: ideas.ideas.map(i => ({ ...i, evidenceSegments: [4] })) }, 1));
});
test('timestamps are continuous and must fill selected duration', () => {
  assert.deepEqual(validatePreRollScript(script, 15), script);
  for (const start of [2, 4]) assert.throws(() => validatePreRollScript({ ...script, shots: script.shots.map((s,i) => i === 1 ? { ...s, start } : s) }, 15));
  assert.throws(() => validatePreRollScript(script, 20));
  assert.throws(() => validatePreRollScript({ ...script, shots: [{ start: 0, end: 15, narrative: '镜头保持。' }] }, 15));
});
test('production narrative rejects field lists and wrong dialogue quotes', () => {
  for (const narrative of ['运镜：缓推；动作：转头', '女主说：“是谁？”', '女主说：「是谁？']) assert.throws(() => validatePreRollScript({ ...script, shots: script.shots.map((s,i) => i === 0 ? { ...s, narrative } : s) }, 15));
});
test('export follows scriptai order and per-shot export resets the timeline', () => {
  const full = formatPreRollScript(script, context);
  assert.ok(full.startsWith('【基本要求】'));
  assert.ok(full.indexOf('【分镜脚本】') < full.indexOf('【分镜标签】'));
  assert.match(full, /\[00:10-00:15\]/);
  const one = formatPreRollScript(script, context, 1);
  assert.match(one, /\[00:00-00:07\]/);
  assert.match(one, /人物一致性/);
  assert.doesNotMatch(one, /\[00:03/);
  assert.match(buildPreRollPrompt(context, idea), /证人身份/);
  assert.doesNotMatch(buildPreRollPrompt(context, idea), /候选机制：/);
  assert.match(buildPreRollPrompt(context, idea), /当前阶段是分镜化/);
});
test('invalid model output is retried and cannot become a successful script', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ choices: [{ message: { content: '{}' } }] }); };
  try {
    await assert.rejects(() => generatePreRoll(context, idea, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }), /暂未通过校验/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
test('valid model output requires a separate factual review before returning', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(++calls === 1 ? fastScript : { approved: true, issues: [] }) } }] });
  try { assert.deepEqual(await generatePreRoll(context, idea, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }), { script: fastScript, validation: { status: 'complete', repairs: 0, rejected: [], warnings: [] } }); }
  finally { globalThis.fetch = original; }
});
test('explicit contradictions with the body story are rejected even with valid formatting', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(++calls % 2 ? fastScript : { approved: false, issues: ['前贴把证人写死，但正片中该证人随即到场，人物状态矛盾'] }) } }] });
  try { await assert.rejects(() => generatePreRoll(context, idea, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }), /人物状态矛盾/); assert.equal(calls, 6); }
  finally { globalThis.fetch = original; }
});
test('English dialogue setting rejects Chinese dialogue', () => {
  assert.throws(() => validatePreRollScript({ ...script, shots: script.shots.map((s,i) => i === 0 ? { ...s, narrative: '近景下女主说：「你到底是谁？」' } : s) }, 15, '英语'), /对白语言不符/);
});
test('story candidates do not require per-second beats', () => {
  assert.doesNotThrow(() => validatePreRollIdeas({ ideas: ideas.ideas.map(i => ({ ...i, firstThreeSeconds: undefined, story: '女主挡住挥来的手，门突然被推开，两人回头。' })) }, 1));
  assert.deepEqual(validatePreRollScript(fastScript, 15, '英语', true), fastScript);
  assert.throws(() => validatePreRollScript(script, 15, '英语', true), /前三镜/);
  assert.throws(() => validatePreRollScript({ ...fastScript, shots: fastScript.shots.map((s,i) => i === 0 ? { ...s, narrative: '近景中她说：「You should never have come to this house tonight again.」' } : s) }, 15, '英语', true), /台词过长/);
});
test('one rejected idea does not discard other grounded candidates', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    const value = calls === 1 ? ideas : prompt.includes('你是独立剧情') ? (prompt.includes('"title":"门外是谁"') ? { approved: true, issues: [], warnings: ['开场可以更强'] } : { approved: false, issues: ['人物状态矛盾'] }) : ideas.ideas[1];
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  };
  try {
    const result = await generatePreRoll(context, undefined, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' });
    assert.deepEqual(result.ideas, [idea]);
    assert.equal(result.validation.status, 'partial');
    assert.equal(result.validation.rejected.length, 2);
    assert.ok(result.validation.warnings.includes('开场可以更强'));
  } finally { globalThis.fetch = original; }
});


test('language checks are field scoped, multilingual and tolerate short or named utterances', () => {
  const structured = { ...script, shots: script.shots.map(s => ({ ...s, narrative: '她转身看向门口。', dialogue: [{ speaker: 'Stella', text: 'Stop right there.', subtitle: 'Detente ahí.' }] })) };
  assert.doesNotThrow(() => validatePreRollScript(structured, 15, 'en-US', false, { subtitleLocale: 'es-ES' }));
  assert.match(formatPreRollScript(structured, { ...context, subtitleLocale: 'es-ES' }), /Detente ahí/);
  assert.equal(dialogueLanguageIssue('OK', 'ja-JP'), undefined);
  assert.equal(dialogueLanguageIssue('こんにちは', 'ja-JP'), undefined);
  assert.equal(dialogueLanguageIssue('안녕하세요', 'ko-KR'), undefined);
  assert.equal(dialogueLanguageIssue('Stella, stop!', 'en-US'), undefined);
  assert.ok(dialogueLanguageIssue('你到底是谁', 'es-ES'));
  assert.ok(dialogueLanguageIssue('你到底是谁', 'ko-KR'));
  for (const [locale] of PRE_ROLL_LANGUAGES) assert.doesNotThrow(() => validatePreRollContext({ ...context, language: locale, descriptionLocale: locale, subtitleLocale: locale }));
  assert.throws(() => validatePreRollContext({ ...context, subtitleLocale: 'made-up' }));
  const mixed = { ...structured, shots: structured.shots.map(s => ({ ...s, dialogue: [{ speaker: 'Stella', text: '你到底是谁' }] })) };
  assert.doesNotThrow(() => validatePreRollScript(mixed, 15, 'en-US', false, { allowMixedDialogue: true }));
  assert.throws(() => validatePreRollScript(mixed, 15, 'en-US', false, { allowMixedDialogue: true, subtitleLocale: 'es-ES' }), /字幕/);
});

test('dialogue repair preserves every action and timestamp and reviews repaired content', async () => {
  const original = globalThis.fetch;
  const broken = { ...fastScript, shots: fastScript.shots.map((s,i) => ({ ...s, narrative: '女主推开手臂，转身看向门口。', dialogue: i === 1 ? [{ speaker: 'Stella', text: '你不要过来' }] : [] })) };
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages.at(-1).content;
    calls++;
    const value = calls === 1 ? broken : calls === 2 ? { groups: broken.shots.map(s => s.dialogue.map(d => ({ ...d, text: 'Stay back.' }))) } : { approved: true, issues: [], warnings: [] };
    if (calls === 3) { assert.match(prompt, /Stay back/); assert.doesNotMatch(prompt, /你不要过来/); }
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  };
  try {
    const result = await generatePreRoll(context, idea, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' });
    assert.deepEqual(result.script.shots.map(({ dialogue, ...shot }) => shot), broken.shots.map(({ dialogue, ...shot }) => shot));
    assert.equal(result.script.shots[1].dialogue[0].text, 'Stay back.');
    assert.equal(result.validation.repairs, 1);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});

test('supplement requests generate only the missing count and keep existing ideas out of repairs', async () => {
  const original = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages.at(-1).content);
    return Response.json({ choices: [{ message: { content: JSON.stringify(prompts.length === 1 ? { ideas: [ideas.ideas[2]] } : { approved: true, issues: [] }) } }] });
  };
  try {
    const result = await generatePreRoll(context, undefined, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }, undefined, { count: 1, existingIdeas: ideas.ideas.slice(0,2) });
    assert.equal(result.ideas.length, 1);
    assert.match(prompts[0], /本次恰好生成 1 个方向/);
    assert.equal(result.validation.status, 'complete');
    assert.equal(prompts.length, 2);
  } finally { globalThis.fetch = original; }
});

test('an aborted request never enters repair or sends another model call', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; controller.abort(); throw new DOMException('Aborted', 'AbortError'); };
  try {
    await assert.rejects(() => generatePreRoll(context, idea, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});


test('new language contract repairs omitted dialogue arrays instead of silently approving them', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const multilingual = { ...context, descriptionLocale: 'zh-CN', subtitleLocale: 'es-ES' };
  const repaired = { ...idea, dialogue: [{ speaker: 'Stella', text: 'Stay back.', subtitle: 'Aléjate.' }] };
  globalThis.fetch = async () => {
    const value = ++calls === 1 ? { ideas: [idea] } : calls === 2 ? repaired : { approved: true, issues: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  };
  try {
    const result = await generatePreRoll(multilingual, undefined, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' }, undefined, { count: 1 });
    assert.deepEqual(result.ideas[0].dialogue, repaired.dialogue);
    assert.equal(result.validation.repairs, 1);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
