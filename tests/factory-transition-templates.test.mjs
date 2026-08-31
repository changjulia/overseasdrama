import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const templates = readFileSync("app/features/factory/transition-templates.ts", "utf8");
const editor = readFileSync("app/features/factory/components/ExternalHookAnalysis.tsx", "utf8");
const types = readFileSync("app/features/factory/types.ts", "utf8");

test("factory exposes eight evidence-aware transition templates spanning every gap diagnosis", () => {
  const ids = [...templates.matchAll(/\{ id: "([^"]+)", name:/g)].map((match) => match[1]);
  const transitionIds = ids.slice(0, 8);
  assert.equal(transitionIds.length, 8);
  for (const gap of ["time", "space", "character", "causal", "emotion"]) {
    assert.match(templates, new RegExp(`gapTypes: \\[[^\\]]*"${gap}"`));
  }
  assert.match(templates, /recommendedTransitionTemplates/);
  assert.match(editor, /orderedTransitionTemplates\.map/);
  assert.match(editor, /模板只设置制作参数，剧情事实仍需人工填写并提供证据/);
});

test("match_cut remains an internal enum while user-facing copy says evidence-supported hard cut", () => {
  assert.match(types, /"match_cut"/);
  assert.match(editor, /<option value="match_cut">证据支持的匹配硬切<\/option>/);
  assert.doesNotMatch(editor, />匹配剪辑</);
});

test("six ASS-equivalent subtitle templates carry safe-area and line-limit fields", () => {
  const subtitleBlock = templates.slice(templates.indexOf("SUBTITLE_TEMPLATES"));
  const subtitleIds = [...subtitleBlock.matchAll(/\{ id: "([^"]+)", name:/g)].map((match) => match[1]);
  assert.equal(subtitleIds.length, 6);
  for (const field of ["fontFamily", "fontSize", "primaryColor", "outlineColor", "outlineWidth", "shadowDepth", "alignment", "marginHorizontalPercent", "marginVerticalPercent", "maxLines"]) {
    assert.match(subtitleBlock, new RegExp(field));
    assert.match(types, new RegExp(field));
  }
  assert.match(editor, /ASS 等价字幕模板/);
  assert.match(templates, /Phase 2 only:[\s\S]*Remotion[\s\S]*adds no Remotion runtime dependency/);
});
