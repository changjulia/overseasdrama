import test from "node:test";
import assert from "node:assert/strict";
import { summarizeWorkflowCoverage } from "../app/features/factory/script-hook-coverage.ts";

test("coverage names rule-only degradation separately from tag and event matches", () => {
  const summary = summarizeWorkflowCoverage({
    highlights: { total: 2, current: 2 },
    scripts: { total: 10, nonEmpty: 10, current: 8 },
    matches: { current: 3 },
    confirmed: { current: 0 },
    candidateSemantics: {
      total: 10,
      withTagRecall: 6,
      withEventMatch: 3,
      rulesOnly: 4,
    },
  });
  const tags = summary.cards.find((card) => card.key === "candidateTags");
  const events = summary.cards.find((card) => card.key === "candidateEvents");
  assert.equal(tags?.value, "6/10");
  assert.match(tags?.detail ?? "", /4 个候选.*规则召回/);
  assert.equal(events?.value, "3/10");
  assert.match(events?.detail ?? "", /7 个候选没有当前有效事件匹配/);
});

test("missing candidate semantic coverage stays unknown instead of implying success", () => {
  const summary = summarizeWorkflowCoverage({ matches: { current: 0 } });
  for (const key of ["candidateTags", "candidateEvents"]) {
    const card = summary.cards.find((item) => item.key === key);
    assert.equal(card?.state, "unknown");
    assert.equal(card?.value, "正在核对");
  }
  assert.equal(summary.eventEnabled, false);
});
