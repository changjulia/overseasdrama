import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("app/api/pocketbase/[...path]/route.ts", "utf8");
const localHook = readFileSync("pb_hooks/local_ui_gateway.pb.js", "utf8");
const localHelper = readFileSync("pb_hooks/local_ui_gateway_helpers.js", "utf8");

test("hosted gateway never buffers hundreds of MiB in application memory", () => {
  assert.doesNotMatch(route, /MAX_MATERIAL_UPLOAD_REQUEST_BYTES/);
  assert.doesNotMatch(route, /bufferedBody = await request\.arrayBuffer\(\)/);
  assert.match(route, /body: request\.method === "GET" \|\| request\.method === "HEAD" \? undefined : request\.body/);
});

test("large workstation intake uses the root-confined local file importer", () => {
  assert.match(localHook, /\/api\/lumina\/local-ui\/import-material-file/);
  assert.match(localHelper, /LUMINA_LOCAL_MEDIA_IMPORT_ROOT/);
  assert.match(localHelper, /\$filesystem\.fileFromPath\(sourcePath\)/);
  assert.match(localHelper, /\^\[a-f0-9\]\{64\}\$/);
});
