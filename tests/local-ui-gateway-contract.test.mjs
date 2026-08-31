import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("pb_hooks/local_ui_gateway.pb.js", "utf8");
const helper = readFileSync("pb_hooks/local_ui_gateway_helpers.js", "utf8");
const vite = readFileSync("vite.config.ts", "utf8");
const url = readFileSync("app/lib/pocketbase-url.ts", "utf8");
const analysisHelper = readFileSync("pb_hooks/analysis_helpers.js", "utf8");

test("local UI adapter is explicitly loopback-only and header-gated", () => {
  assert.match(route, /LUMINA_UI_MODE/);
  assert.match(route, /local-loopback/);
  assert.match(route, /x-lumina-ui/);
  assert.match(route, /localhost\|127/);
  assert.doesNotMatch(route, /LUMINA_POCKETBASE_SUPERUSER_PASSWORD/);
});

test("local UI adapter exposes only exact collection and file allowlists", () => {
  assert.match(helper, /LOCAL_COLLECTIONS/);
  assert.match(helper, /LOCAL_WRITABLE/);
  assert.match(helper, /LOCAL_FILE_COLLECTIONS/);
  assert.match(helper, /throw new ForbiddenError/);
  assert.doesNotMatch(helper, /_superusers/);
  assert.doesNotMatch(helper, /maintenance/);
});

test("development uses local adapter while hosted browser keeps authenticated gateway", () => {
  assert.match(url, /"\/pb-local"/);
  assert.match(url, /"\/api\/pocketbase"/);
  assert.match(vite, /\/api\/lumina\/local-ui\/collections/);
  assert.match(vite, /searchParams\.delete\("fields"\)/);
  assert.match(vite, /proxyRequest\.setHeader\("x-lumina-ui", "local"\)/);
});

test("drama analysis local authorization reads Go-promoted host and raw headers", () => {
  assert.match(analysisHelper, /e\.request && e\.request\.host/);
  assert.match(analysisHelper, /rawHeader\.get\(name\)/);
  assert.match(analysisHelper, /LUMINA_UI_MODE/);
  assert.match(analysisHelper, /local-loopback/);
  assert.match(analysisHelper, /localHostAllowed/);
});
