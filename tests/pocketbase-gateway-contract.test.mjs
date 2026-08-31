import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("app/api/pocketbase/[...path]/route.ts", "utf8");
const helper = readFileSync("app/lib/pocketbase-url.ts", "utf8");
const hook = readFileSync("pb_hooks/hook_factory_helpers.js", "utf8");
const analysisHook = readFileSync("pb_hooks/analysis_helpers.js", "utf8");
const materialHook = readFileSync("pb_hooks/material_analysis_helpers.js", "utf8");
const stores = [
  "pocketbase-drama-store.ts", "pocketbase-analysis-store.ts", "hook-match-store.ts",
  "hook-asset-store.ts", "factory-production-store.ts", "inspiration-material-store.ts",
].map((name) => readFileSync(`app/lib/${name}`, "utf8"));

test("hosted gateway requires ChatGPT identity and a server-only credential", () => {
  assert.match(route, /await getChatGPTUser\(\)/);
  assert.match(route, /if \(!user\).*status: 401/);
  assert.match(route, /process\.env\.LUMINA_UI_GATEWAY_TOKEN/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_POCKETBASE_URL/);
  assert.match(route, /status: 503/);
});

test("locked collection routes use short-lived server-side PocketBase authentication", () => {
  assert.match(route, /LUMINA_POCKETBASE_SUPERUSER_IDENTITY/);
  assert.match(route, /LUMINA_POCKETBASE_SUPERUSER_PASSWORD/);
  assert.match(route, /auth-with-password/);
  assert.match(route, /needsPocketBaseAdmin \? await getPocketBaseAdminToken\(\) : token/);
  assert.match(route, /needsPocketBaseAdmin = isCollectionRequest \|\|/);
  assert.match(route, /FILE_COLLECTIONS\.has\(fileMatch\[1\]\)/);
  assert.match(route, /upstream\.status === 401/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_LUMINA_POCKETBASE_SUPERUSER/);
});

test("a forged local UI header cannot authenticate the hosted gateway", async () => {
  const workerUrl = new URL(`../dist/server/index.js?gateway-test=${process.pid}-${Date.now()}`, import.meta.url);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("https://lumina.example/api/pocketbase/api/collections/dramas/records", {
    headers: { "x-lumina-ui": "local", origin: "https://lumina.example", "sec-fetch-site": "same-origin" },
  }));
  assert.equal(response.status, 401);
});

test("gateway strips browser credentials and local trust headers", () => {
  for (const name of ["authorization", "cookie", "x-lumina-ui", "x-lumina-user-id", "oai-authenticated-", "x-forwarded-"]) {
    assert.match(route, new RegExp(name));
  }
  assert.match(route, /headers\.set\("authorization", `Bearer \$\{needsPocketBaseAdmin \? await getPocketBaseAdminToken\(\) : token\}`\)/);
  assert.doesNotMatch(route, /headers\.set\("x-lumina-ui"/);
  assert.match(route, /key\.toLowerCase\(\) !== "set-cookie"/);
});

test("gateway defaults closed for routes, worker APIs, methods, and cross-site writes", () => {
  assert.match(route, /READABLE_COLLECTIONS/);
  assert.match(route, /WRITABLE_COLLECTIONS/);
  assert.doesNotMatch(route, /\/api\\\/\(collections\|files\|health\)/);
  assert.doesNotMatch(route, /\/api\/admins/);
  assert.doesNotMatch(route, /maintenance/);
  assert.doesNotMatch(route, /factory-render/);
  assert.doesNotMatch(route, /\/claim/);
  assert.match(route, /part === "\.\."/);
  assert.match(route, /part\.includes\("\\\\"\)/);
  assert.match(route, /origin === request\.nextUrl\.origin/);
  assert.match(route, /site === "same-origin"/);
});

test("gateway explicitly allows authenticated transition preview and review routes", () => {
  assert.match(route, /transition-preview\|transition-review/);
  assert.match(route, /factory\\\/projects\\\/\[\^\/\]\+\\\/transition-preview/);
});

test("browser stores share the authenticated gateway and never add the local marker", () => {
  assert.match(helper, /typeof window !== "undefined"[\s\S]*NODE_ENV === "development"[\s\S]*"\/pb-local"[\s\S]*"\/api\/pocketbase"/);
  for (const source of stores) {
    assert.match(source, /pocketbase-url/);
    assert.doesNotMatch(source, /NEXT_PUBLIC_POCKETBASE_URL/);
    assert.doesNotMatch(source, /"x-lumina-ui": "local"/);
  }
});

test("PocketBase UI authorization separates gateway bearer from explicit loopback mode", () => {
  for (const source of [hook, analysisHook, materialHook]) {
    assert.match(source, /LUMINA_UI_GATEWAY_TOKEN/);
    assert.match(source, /authorization/);
    assert.match(source, /constantTimeTextEqual/);
    assert.match(source, /LUMINA_UI_MODE/);
    assert.match(source, /local-loopback/);
    assert.match(source, /localHostAllowed/);
    assert.match(source, /localUiHeader !== "local"/);
  }
});
