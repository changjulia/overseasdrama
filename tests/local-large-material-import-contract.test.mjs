import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("local large material import is loopback-only, root-confined and hash-bound", async () => {
  const [hook, helper, worker] = await Promise.all([
    read("pb_hooks/local_ui_gateway.pb.js"),
    read("pb_hooks/local_ui_gateway_helpers.js"),
    read("processor/job_worker.py"),
  ]);
  assert.match(hook, /\/api\/lumina\/local-ui\/import-material-file/);
  assert.match(hook, /LUMINA_UI_MODE/);
  assert.match(helper, /LUMINA_LOCAL_MEDIA_IMPORT_ROOT/);
  assert.match(helper, /Local media path is outside the configured import root/);
  assert.match(helper, /\^\[a-f0-9\]\{64\}\$/);
  assert.match(helper, /\$filesystem\.fileFromPath\(sourcePath\)/);
  assert.match(worker, /expected_content_hash != actual_content_hash/);
  assert.match(worker, /content hash does not match the recorded intake identity/);
});
