import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcquisitionHookGuidance } from '../app/lib/pre-roll-hook-patterns.ts';
import { buildPreRollPrompt, validatePreRollContext, validatePreRollIdea } from '../app/lib/pre-roll-script.ts';

test('selecting a mechanism carries it into generation without forcing three different mechanisms', () => {
  const guidance = buildAcquisitionHookGuidance(['danger-rescue']);
  assert.match(guidance, /危险救援/);
  assert.doesNotMatch(guidance, /身份反差/);
  assert.match(guidance, /只选择一种时/);
  const prompt = buildPreRollPrompt({ duration: 15, hookPatterns: ['danger-rescue'] });
  assert.match(prompt, /danger-rescue（危险救援）/);
  assert.match(prompt, /viewerExpectation/);
  assert.match(prompt, /局势转折/);
});

test('viewer expectation and turn survive validation for candidate cards', () => {
  const idea = { title: '门外救援', direction: '被阻拦的救援者', opening: '医生被拦在门外', escalation: '里面传来呼救', cliffhanger: '门突然打开', bodyConnection: '正片继续救援', appeal: '观众急着看能否救下', inventedDetails: [], evidenceSegments: [0], patternId: 'danger-rescue', viewerExpectation: '他能否及时救下她？', turn: '拦路者听出里面的声音' };
  assert.deepEqual(validatePreRollIdea(idea, 1), idea);
});

test('request context accepts selected directions and rejects unknown control values', () => {
  const context = { drama: '测试', plan: { id: 'p1', title: '救援', storylineSummary: '门外的医生要救人。', segments: [{ episode: 1, start: 1, end: 20, plot: '门外的医生被拦住。', highlightAssetId: 'h1' }] }, duration: 15, language: '英语', ratio: '9:16', brief: '', hookPatterns: ['danger-rescue'] };
  assert.deepEqual(validatePreRollContext(context).hookPatterns, ['danger-rescue']);
  assert.throws(() => validatePreRollContext({ ...context, hookPatterns: ['unknown'] }), /走向/);
});
