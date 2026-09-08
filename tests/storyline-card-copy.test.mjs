import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyFirstStorylineTitle } from '../app/lib/storyline-card-copy.ts';

test('body-first cards use only the concise highlight event as the heading', () => {
  assert.equal(
    bodyFirstStorylineTitle({ strategyType: '悬念卡点方案', title: '母亲发现女儿隐藏血脉' }),
    '母亲发现女儿隐藏血脉',
  );
  assert.equal(
    bodyFirstStorylineTitle({ strategyType: '悬念卡点方案', title: '悬念卡点方案｜母亲发现女儿隐藏血脉 → 身份揭晓' }),
    '母亲发现女儿隐藏血脉',
  );
});
