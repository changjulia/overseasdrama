import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("app/features/library/DramaLibraryWorkspace.tsx", "utf8");
const styles = readFileSync("app/features/library/library.module.css", "utf8");

test("PocketBase failure keeps cached dramas visibly stale with explicit retry and sync evidence", () => {
  assert.match(source, /setSourceError\(error instanceof Error\?`实时剧库读取失败/);
  assert.match(source, /当前显示缓存快照，不是实时数据/);
  assert.match(source, /最后成功同步/);
  assert.match(source, /重试实时同步/);
  assert.match(source, /setSourceError\(""\);setLastSyncAt\(new Date\(\)\)/);
  assert.doesNotMatch(source, /catch\(\(\)=>setListState\(dramas\.length\?"ready":"error"\)\)/);
});

test("analysis retry rejection is captured in persistent UI instead of becoming unhandled", () => {
  const retry = source.slice(source.indexOf("const retryAnalysis=async"), source.indexOf("const previewAnalysis="));
  assert.match(retry, /try\{/);
  assert.match(retry, /catch\(error\)/);
  assert.match(retry, /setAnalysisActionError\(`解析重试失败/);
  assert.match(source, /analysisActionError&&<div className=\{styles\.actionError\} role="alert"/);
});

test("episode playback failure stays visible, identifies the asset, and offers a real retry", () => {
  assert.match(source, /setPlaybackError\(`第 \$\{playing\} 集无法播放/);
  assert.match(source, /资产标识：\{assetId\}/);
  assert.match(source, /const retryPlayback=\(\)=>\{setPlaybackError\(""\);setPlaybackAttempt\(value=>value\+1\)\}/);
  assert.match(source, /key=\{`\$\{active\.url\}-\$\{playbackAttempt\}`\}/);
  assert.match(source, />重试播放<\/button>/);
  assert.match(styles, /\.playbackError/);
});
