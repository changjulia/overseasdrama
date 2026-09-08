import test from "node:test";
import assert from "node:assert/strict";
import { externalMaterialPoster, isExternalMaterialMedia } from "../app/lib/material-poster.ts";
import { fromRecord } from "../app/lib/inspiration-material-store.ts";

test("link imports receive a small video snapshot and uploaded covers keep priority", () => {
  for (const host of ["overseas-material.dataeye.com", "zqingalioss.wozhangwan.com"]) {
    const source = `https://${host}/folder/video.mp4`;
    const record = {id:"123456789012345",collectionId:"pbc_lumadmat001",collectionName:"ad_materials",source_url:source};
    const poster = new URL(fromRecord(record).coverUrl);
    assert.equal(poster.hostname,host);
    assert.equal(poster.searchParams.get("x-oss-process"),"video/snapshot,t_1000,f_jpg,w_480,m_fast");
    assert.match(fromRecord({...record,cover:"uploaded.jpg"}).coverUrl,/\/uploaded\.jpg$/);
    assert.equal(fromRecord(record).media.url,source);
    assert.equal(isExternalMaterialMedia(source), true);
  }
});

test("unknown providers and signed URLs are never rewritten", () => {
  for (const source of ["", "not a URL", "https://example.com/movie.mp4", "https://overseas-material.dataeye.com.evil.test/a.mp4", "http://overseas-material.dataeye.com/a.mp4", "https://overseas-material.dataeye.com/a.mp4?Signature=abc", "https://user:pass@overseas-material.dataeye.com/a.mp4"])
    assert.equal(externalMaterialPoster(source),undefined);
  for (const source of ["", "not a URL", "https://example.com/movie.mp4", "https://overseas-material.dataeye.com.evil.test/a.mp4", "http://overseas-material.dataeye.com/a.mp4", "https://user:pass@overseas-material.dataeye.com/a.mp4"])
    assert.equal(isExternalMaterialMedia(source), false);
});
