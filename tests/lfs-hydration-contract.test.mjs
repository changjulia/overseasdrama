import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = join(process.cwd(), "scripts/hydrate-git-lfs-file.sh");

function command(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function fixture({ remote = "https://example.test/repository.git", body = "restored-lfs-object\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lfs-hydration-"));
  assert.equal(command("git", ["init", "-q", root]).status, 0);
  assert.equal(command("git", ["-C", root, "remote", "add", "origin", remote]).status, 0);
  const payload = Buffer.from(body);
  const oid = createHash("sha256").update(payload).digest("hex");
  const pointer = join(root, "tracked.bin");
  writeFileSync(pointer, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`);
  assert.equal(command("git", ["-C", root, "add", "tracked.bin"]).status, 0);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fakeCurl = join(bin, "curl");
  writeFileSync(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -d|-H|-X) shift 2 ;;
    --fail|--silent|--show-error|--location) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == */info/lfs/objects/batch ]]; then
  printf '{"objects":[{"actions":{"download":{"href":"https://objects.example.test/object","header":{"Authorization":"Bearer test"}}}}]}' > "$output"
elif [[ "$url" == "https://objects.example.test/object" ]]; then
  printf '%s' '${body.replaceAll("'", "'\\''")}' > "$output"
else
  exit 22
fi
`);
  chmodSync(fakeCurl, 0o755);
  return { root, pointer, payload, oid, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

test("hydrates and verifies a repository LFS pointer into an explicit new target", () => {
  const value = fixture();
  const output = join(value.root, "restored", "tracked.bin");
  const result = command("bash", [script, value.pointer, output], { env: value.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output), value.payload);
  assert.match(result.stdout, /hydrated and verified/);
});

test("refuses to overwrite an existing target", () => {
  const value = fixture();
  const output = join(value.root, "existing.bin");
  writeFileSync(output, "keep-me");
  const result = command("bash", [script, value.pointer, output], { env: value.env });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(output, "utf8"), "keep-me");
  assert.match(result.stderr, /Refusing to overwrite/);
});

test("rejects malformed pointers and non-HTTPS origins", () => {
  const malformed = fixture();
  writeFileSync(malformed.pointer, "version https://git-lfs.github.com/spec/v1\noid sha256:nope\nsize 4\n");
  let result = command("bash", [script, malformed.pointer, join(malformed.root, "out")], { env: malformed.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pointer is invalid/);

  const insecure = fixture({ remote: "git@github.com:owner/repo.git" });
  result = command("bash", [script, insecure.pointer, join(insecure.root, "out")], { env: insecure.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an HTTPS origin/);
});

test("does not publish a download whose hash or size differs from the pointer", () => {
  const value = fixture();
  writeFileSync(value.pointer, `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize ${value.payload.length}\n`);
  const output = join(value.root, "out.bin");
  const result = command("bash", [script, value.pointer, output], { env: value.env });
  assert.equal(result.status, 1);
  assert.equal(existsSync(output), false);
  assert.match(result.stderr, /integrity validation/);
});
