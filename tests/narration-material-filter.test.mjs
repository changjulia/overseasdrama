import test from "node:test";
import assert from "node:assert/strict";
import { fromRecord, materialTypeFilter, listInspirationMaterialsPage } from "../app/lib/inspiration-material-store.ts";
import { listSelectableExternalHooks, listSelectableExternalHooksByIds } from "../app/lib/hook-asset-store.ts";

test("confirmed narration remains filterable without full-video analysis", () => {
  const record = { id:"narration", collectionId:"materials", collectionName:"ad_materials", title:"用户已确认解说", type:"正片剧集解说", material_format:"正片剧集解说", analysis_status:"", opening_analysis:{scope:"opening_only",semanticStatus:"ready"} };
  const material = fromRecord(record);
  assert.equal(material.type,"正片剧集解说");
  assert.equal(material.analysisStatus,"idle");
  assert.match(material.analysis,/开头已核对.*整片未分析/);
});

test("story matcher fetches only the server-ranked hook IDs", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url), "http://localhost"));
    return Response.json({items:[],page:1,totalItems:0,totalPages:1});
  };
  try {
    await listSelectableExternalHooksByIds(["abcdefghijklmno", "1234567890abcde"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("perPage"), "50");
    assert.match(requests[0].searchParams.get("filter"), /abcdefghijklmno/);
    assert.match(requests[0].searchParams.get("filter"), /1234567890abcde/);
    assert.doesNotMatch(requests[0].searchParams.get("fields"), /(?:^|,)evidence(?:,|$)/);
  } finally { globalThis.fetch = original; }
});

test("factory hook picker pages compact records without raw transcript evidence", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url), "http://localhost"));
    return Response.json({items:[],page:1,totalItems:900,totalPages:2});
  };
  try {
    await listSelectableExternalHooks();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].searchParams.get("perPage"), "500");
    assert.equal(requests[1].searchParams.get("page"), "2");
    assert.doesNotMatch(requests[0].searchParams.get("fields"), /(?:^|,)evidence(?:,|$)/);
    assert.match(requests[0].searchParams.get("filter"), /narration_opening/);
  } finally { globalThis.fetch = original; }
});

test("type filtering is sent to the server before pagination", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url),"http://localhost"));
    return Response.json({items:[],page:1,totalItems:12,totalPages:1});
  };
  try {
    const page = await listInspirationMaterialsPage(1,24,undefined,"正片剧集解说");
    assert.equal(page.totalItems,12);
    assert.equal(requests[0].searchParams.get("filter"),materialTypeFilter("正片剧集解说"));
    assert.equal(requests[0].searchParams.get("perPage"),"24");
    assert.match(requests[0].searchParams.get("filter"),/analysis_status!="succeeded"/);
    assert.equal(materialTypeFilter("全部类型"),"");
    assert.equal(materialTypeFilter('" || id!="'),"");
  } finally { globalThis.fetch = original; }
});
