import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { buildOpening, selectPilot } from "../scripts/import-narration-openings.mjs";
import { isPreRollSource } from "../app/lib/pre-roll-eligibility.ts";
import { isSelectableExternalHook } from "../app/lib/hook-asset-store.ts";

const sandbox = { module: { exports: {} }, Math, JSON, String, Number, Array, Object, Set, Error };
vm.runInNewContext(fs.readFileSync(new URL("../pb_hooks/narration_intake_helpers.js", import.meta.url), "utf8"), sandbox);
const helpers = sandbox.module.exports;
const decision = { key: "sample", group: "g", type: "角色内心独白", reason: "开头旁白", verified: "ASR＋抽帧" };
const cached = { title: "Example", url: "https://example.com/ad.mp4", duration: 90, segments: [{ start: 0, end: 6, text: "I discovered his secret." }, { start: 7, end: 14, text: "He never knew." }] };

test("only opted-in narration may enter the existing external-hook pipeline", () => {
  const server = { module: { exports: {} }, $os: { getenv: () => "" } };
  vm.runInNewContext(fs.readFileSync(new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url), "utf8"), server);
  for (const [source, usage, allowed] of [["external_material", "", true], ["narration_opening", "", false], ["narration_opening", "pre_roll", true], ["episode_highlight", "pre_roll", false]]) {
    assert.equal(isPreRollSource(source, usage), allowed);
    assert.equal(server.module.exports.isPreRollHook({ getString: (key) => key === "source_class" ? source : usage }), allowed);
    assert.equal(isSelectableExternalHook({ sourceClass: source, usageRole: usage, boundaryStatus: "unverified", reviewStatus: "needs_review" }), allowed);
  }
  assert.equal(isSelectableExternalHook({ sourceClass: "narration_opening", usageRole: "pre_roll", reviewStatus: "rejected" }), false);
});

test("server retains imported transcript as unscored evidence, not an empty hook", () => {
  const server = { module: { exports: {} }, $os: { getenv: () => "" } };
  vm.runInNewContext(fs.readFileSync(new URL("../pb_hooks/hook_factory_helpers.js", import.meta.url), "utf8"), server);
  const data = { source_class: "narration_opening", usage_role: "pre_roll", import_key: "narration:sample:v1", start_seconds: 0, end_seconds: 14,
    analysis: { schemaVersion: "narration-opening-v1" }, evidence: { transcript: [{start:0,end:6,text:"实际转写"}] } };
  const snapshot = server.module.exports.externalHookFragmentSnapshot({ id:"h", get: (k)=>data[k], getString:(k)=>String(data[k]||""), getFloat:(k)=>Number(data[k]||0) });
  assert.equal(snapshot.evidence.transcript.length,1);
  assert.equal(snapshot.evidence.transcript[0].confidence,null);
  assert.equal(snapshot.evidence.transcript[0].verification,"unverified");
});

test("cached opening preserves timecodes, not a fabricated full-video analysis", () => {
  const row = buildOpening(decision, cached, "frames-v1");
  const validated = helpers.validate(row);
  assert.equal(validated.end, 14);
  assert.equal(row.transcript.length, 2);
  assert.equal(row.analysisStatus, undefined);
  assert.notEqual(row.cacheKey, buildOpening(decision, cached, "frames-v2").cacheKey);
  assert.equal(row.cacheKey, buildOpening(decision, cached, "frames-v1").cacheKey);
  assert.throws(() => helpers.validate({ ...row, transcript: [{ start: 0, end: 30, text: "outside coverage" }] }));
  assert.throws(() => buildOpening({ ...decision, key: "../escape" }, cached));
});

test("pilot balances all four opening styles without duplicate assets", () => {
  const rows = ["第三人称", "角色自述", "内心独白", "系统播报"].flatMap((category) => Array.from({ length: 5 }, (_, i) => ({ category, key: category+i })));
  const selected = selectPilot(rows, 12);
  assert.equal(new Set(selected.map((row) => row.key)).size, 12);
  for (const category of new Set(rows.map((row) => row.category))) assert.equal(selected.filter((row) => row.category === category).length, 3);
});

test("reimport is idempotent and preserves later human review and semantic data", () => {
  const records = [], jobs = [];
  class Record {
    constructor(collection) { this.collection = collection; this.id = "id" + records.length; this.values = {}; }
    set(key, value) { this.values[key] = value; }
    get(key) { return this.values[key]; }
    getString(key) { return String(this.values[key] || ""); }
  }
  sandbox.Record = Record;
  const app = {
    findCollectionByNameOrId: (name) => name,
    findFirstRecordByFilter(collection, _filter, args) {
      const record = records.find((r) => r.collection === collection && (args.key ? r.getString("import_key") === args.key : r.getString("source_url") === args.url));
      if (!record) throw new Error("missing"); return record;
    },
    save(record) { if (!records.includes(record)) records.push(record); if (record.getString("analysis_status") === "queued") jobs.push(record); },
  };
  const row = buildOpening(decision, cached);
  const first = helpers.importOpening(app, row);
  const hook = records.find((r) => r.collection === "hook_assets");
  const material = records.find((r) => r.collection === "ad_materials");
  assert.equal(material.getString("type"), "正片剧集解说");
  material.set("type", "未确定");
  material.set("material_format", "未确定");
  hook.set("review_status", "approved"); hook.set("narrative_promise", "reviewed promise");
  material.set("opening_analysis", [...Buffer.from(JSON.stringify(material.get("opening_analysis")), "utf8")]);
  const second = helpers.importOpening(app, row);
  assert.equal(first.hookId, second.hookId);
  assert.equal(records.length, 2);
  assert.equal(jobs.length, 0);
  assert.equal(material.getString("type"), "正片剧集解说");
  assert.equal(material.getString("material_format"), "正片剧集解说");
  assert.equal(material.getString("analysis_status"), "");
  assert.equal(material.get("analysis_result"), undefined);
  assert.equal(JSON.parse(Buffer.from(material.get("opening_analysis")).toString("utf8")).scope, "opening_only");
  assert.equal(hook.getString("review_status"), "approved");
  assert.equal(hook.getString("narrative_promise"), "reviewed promise");
  assert.throws(() => helpers.importOpening(app, { ...row, cacheKey: "a".repeat(64) }), /revision/);
});

test("full-material analysis cannot reuse or overwrite the imported hook at the same interval", () => {
  for (const review of ["needs_review", "approved"]) {
    class Record {
      constructor() { this.id = "new-full-analysis"; this.values = {}; }
      set(k,v) { this.values[k] = v; }
      getString(k) { return String(this.values[k] || ""); }
      getFloat(k) { return Number(this.values[k] || 0); }
    }
    const imported = new Record(); imported.id = "imported";
    Object.assign(imported.values, { import_key: "narration:m:v1", source_class: "narration_opening", start_seconds: 0, end_seconds: 14, review_status: review, narrative_promise: "原轻分析或人工确认", analysis_version: "original-version" });
    const before = JSON.stringify(imported.values), saved = [], deleted = [];
    const context = { module: { exports: {} }, Record };
    vm.runInNewContext(fs.readFileSync(new URL("../pb_hooks/material_analysis_helpers.js", import.meta.url), "utf8"), context);
    const app = { findCollectionByNameOrId: () => "hook_assets", findRecordsByFilter: () => [imported], save: (r) => saved.push(r), delete: (r) => deleted.push(r) };
    const material = { id: "m", getString: () => "素材" };
    context.module.exports.syncMaterialHookAssets(app, material, { durationSeconds: 90, creative: { hooks: [{ start:0,end:14,narrativePromise:"整片新结论" }] } }, {format:"正片剧集解说",schemaVersion:"material-v2"});
    assert.equal(JSON.stringify(imported.values), before);
    assert.equal(deleted.length,0);
    assert.equal(saved.length,1);
    assert.notEqual(saved[0].id,imported.id);
  }
});
