import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const store = await readFile(new URL("../app/lib/pocketbase-drama-store.ts", import.meta.url), "utf8");
const consoleUi = await readFile(new URL("../app/features/operations/ExternalDataConsole.tsx", import.meta.url), "utf8");

test("signed playback health uses one-byte Range GET and never HEAD", () => {
  assert.match(store, /headers:\{Range:"bytes=0-0"\}/);
  assert.match(store, /healthResponse\.status!==206/);
  assert.match(store, /contentType!=="video\/mp4"/);
  assert.doesNotMatch(store, /method:\s*["']HEAD["']/);
});

test("playback UI can import exactly the first ten episodes for acceptance", () => {
  assert.match(store, /episodeLimit\?: number/);
  assert.match(store, /selectedEpisodes\.length!==input\.episodeLimit/);
  assert.match(store, /selectedEpisodes=orderedEpisodes\.slice/);
  assert.match(store, /用户授权内部验收前10集（非生产）/);
  assert.match(store, /验收导入要求从第 1 集开始连续/);
  assert.match(consoleUi, /前10集验收入库/);
  assert.match(consoleUi, /acceptance_scope:"first_10"/);
});
