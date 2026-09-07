import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreRollPrompt } from '../app/lib/pre-roll-script.ts';
import { generatePreRoll } from '../app/lib/pre-roll-generator.ts';
import { PRE_ROLL_PREQUEL_POLICY } from '../app/lib/pre-roll-prequel-policy.ts';

test('generation and review both receive the same permission to invent compatible preceding events', async () => {
  const context = { drama: '测试剧', plan: { id: 'p1', title: '门外的证人', storylineSummary: '女主被指责，证人即将出现。', segments: [{ episode: 1, start: 10, end: 30, plot: '门外传来脚步声。', highlightAssetId: 'h1' }] }, duration: 15, language: '英语', ratio: '9:16', brief: '' };
  const idea = { title: '门口阻拦', direction: '危险救援', opening: '有人将证人拦在门口', escalation: '证人听见里面的指责', cliffhanger: '证人冲破阻拦走向门口', bodyConnection: '脚步声接入正片', appeal: '观众等着看证人能否替女主澄清', inventedDetails: ['证人在走廊遇到阻拦是原创前因'], evidenceSegments: [0] };
  const candidates = [idea, { ...idea, title: '误会加深', direction: '欺压反杀' }, { ...idea, title: '意外保护', direction: '关系悬念' }];
  const prompts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    prompts.push(JSON.parse(init.body).messages.at(-1).content);
    return Response.json({ choices: [{ message: { content: JSON.stringify(prompts.length === 1 ? { ideas: candidates } : { approved: true, issues: [] }) } }] });
  };
  try {
    const result = await generatePreRoll(context, undefined, { endpoint: 'https://example.test/chat/completions', key: 'test', model: 'test' });
    assert.deepEqual(result.ideas[0].inventedDetails, idea.inventedDetails);
    assert.equal(prompts.length, 4);
    for (const prompt of prompts) {
      assert.ok(prompt.includes(PRE_ROLL_PREQUEL_POLICY));
      assert.doesNotMatch(prompt, /新增关键因果事实仍须拒绝|优先把输入中已经发生的冲突/);
    }
    const scriptPrompt = buildPreRollPrompt(context, idea);
    assert.ok(scriptPrompt.includes(PRE_ROLL_PREQUEL_POLICY));
    assert.match(scriptPrompt, /允许补写必要的前置行动/);
    assert.doesNotMatch(scriptPrompt, /候选机制：|不得增加所选候选和正片中都不存在的事件/);
  } finally { globalThis.fetch = original; }
});
