import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync("pb_hooks/hook_factory.pb.js", "utf8");
const helper = readFileSync("pb_hooks/narration_audio_helpers.js", "utf8");
const migration = readFileSync("pb_migrations/1787570900_create_narration_audio_assets.js", "utf8");
const gateway = readFileSync("app/api/pocketbase/[...path]/route.ts", "utf8");

test("narration audio upload is project-bound, authenticated, and lineage checked", () => {
  assert.match(hook, /projects\/\{id\}\/narration-audio/);
  assert.match(hook, /helpers\.authorizeUi\(e\)/);
  assert.match(hook, /record\.set\("project", project\.id\)/);
  assert.match(hook, /declaredSha256 !== metadata\.sha256/);
  assert.match(hook, /audioAsset\.getString\("project"\) !== narrationProject\.id/);
  assert.match(hook, /narration audio lineage metadata does not match/);
});

test("server enforces bounded audio formats and computes SHA-256 from bytes", () => {
  assert.match(migration, /maxSize: 104857600/);
  for (const mime of ["audio/mpeg", "audio/mp4", "audio/wav", "audio/aac", "audio/ogg", "audio/webm", "audio/flac"]) {
    assert.match(migration, new RegExp(mime.replace("/", "\\/")));
  }
  assert.match(helper, /function commandSha256File/);
  assert.match(helper, /LUMINA_SHA256_PATH/);
  assert.match(helper, /ffprobe container signature does not match/);
  assert.match(helper, /command\.stdin = reader/);
  assert.match(hook, /duration < 60 \|\| duration > 100/);
});

test("media URL is signed, same-origin, and the hosted write is CSRF-gated", () => {
  assert.match(helper, /\$security\.hs256/);
  assert.match(helper, /LUMINA_WORKER_TOKEN/);
  assert.match(helper, /LUMINA_POCKETBASE_WORKER_BASE_URL/);
  assert.match(hook, /narration-audio\/\{id\}\/media/);
  assert.match(hook, /constantTimeTextEqual\(supplied, expected\)/);
  assert.match(gateway, /transition-review\|narration-audio/);
  assert.match(gateway, /origin === request\.nextUrl\.origin/);
});

test("draft skeleton is allowed but preview refuses missing uploaded narration", () => {
  assert.match(hook, /\["draft", "pending"\]\.includes/);
  assert.match(hook, /continuous narration preview requires uploaded manual audio/);
  assert.match(hook, /continuous narration preview requires matching project audio lineage/);
});
