import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDimension, normalizeTag, normalizeTags, rankOntologyTags, relationOf, compareTagSets, evaluateTagRecall } from "../app/lib/ontology/normalization.ts";

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

test("maps legacy page dimensions to the shared cross-page vocabulary", () => {
  assert.equal(normalizeDimension("character"), "role");
  assert.equal(normalizeDimension("relationships"), "relation");
  assert.equal(normalizeDimension("plot"), "storyBeat");
  assert.equal(normalizeDimension("adUse"), "acquisition");
  assert.equal(normalizeDimension("买量用途"), "acquisition");
});

test("normalizes expanded drama vocabulary without losing aliases", () => {
  assert.equal(normalizeTag("身份逆转", "theme").code, "theme.身份反转");
  assert.equal(normalizeTag("fight back", "storyBeat").code, "storyBeat.反击");
});

test("selects at most two evidence-backed primary tags and respects manual locks", () => {
  const ranked=rankOntologyTags([
    {...normalizeTag("复仇","theme",{confidence:.9,evidence:["e1","e2"]}),episodes:[1,2,3]},
    {...normalizeTag("成长","theme",{confidence:.8,evidence:["e1"]}),episodes:[1,2]},
    {...normalizeTag("救赎","theme",{confidence:.2}),episodes:[]},
    {...normalizeTag("亲情","theme",{confidence:.1}),episodes:[],locked:true,manualStatus:"confirmed"},
  ],10);
  assert.equal(ranked.find(tag=>tag.label==="亲情").prominence,"primary");
  assert.ok(ranked.filter(tag=>tag.prominence==="primary").length<=2);
  assert.equal(ranked.find(tag=>tag.label==="救赎").prominence,"secondary");
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

test("recall gate blocks contradictions and leaves unknown pending evidence", () => {
  const blocked = evaluateTagRecall(["女性向"], ["男性向"], "audience");
  assert.equal(blocked.decision, "blocked");
  assert.equal(blocked.productionEligible, false);
  assert.ok(blocked.hardConflicts.length > 0);

  const pending = evaluateTagRecall(["未收录甲"], ["未收录乙"], "theme");
  assert.equal(pending.decision, "needs_evidence");
  assert.equal(pending.productionEligible, false);

  const recalled = evaluateTagRecall(["复仇"], ["revenge"], "theme");
  assert.equal(recalled.decision, "allow_recall");
  assert.equal(recalled.productionEligible, false);
});
