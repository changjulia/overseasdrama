import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, normalizeTags, relationOf, compareTagSets } from "../app/lib/ontology/normalization.ts";

test("normalizes Chinese and English aliases while retaining provenance", () => {
  const tag = normalizeTag({ label: "Revenge", evidence: ["asr-4"] }, "theme");
  assert.equal(tag.code, "theme.复仇");
  assert.equal(tag.label, "复仇");
  assert.equal(tag.original, "Revenge");
  assert.deepEqual(tag.evidence, ["asr-4"]);
});

test("supports all fixed ontology dimensions and legacy strings", () => {
  const tags = normalizeTags(["都市剧", "strong conflict"], "genre");
  assert.equal(tags[0].code, "genre.都市");
  // Unknown vocabulary remains lossless and does not break old payloads.
  assert.equal(tags[1].original, "strong conflict");
  assert.equal(tags[1].dimension, "acquisition");
});

test("relation API distinguishes known relations from unknown evidence", () => {
  assert.equal(relationOf("复仇", "revenge", "theme"), "exact");
  assert.equal(relationOf("复仇", "成长", "theme"), "compatible");
  assert.equal(relationOf("未收录甲", "未收录乙", "theme"), "unknown");
  assert.equal(relationOf("女性向", "男性向", "audience"), "contradictory");
});

test("compares sets with weighted score and hard conflicts", () => {
  const result = compareTagSets(["女性向", "年轻人群"], ["男性向", "年轻人群"], "audience");
  assert.equal(result.relation, "contradictory");
  assert.equal(result.hardConflicts.length, 1);
  assert.equal(result.exact.length, 1);
  assert.ok(result.score < 0.5);
});
