import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = "scripts/start-analysis-worker.sh";
const supervisor = "scripts/start-analysis-workers.sh";

test("macOS/Linux worker launchers have valid bash syntax", () => {
  execFileSync("bash", ["-n", worker]);
  execFileSync("bash", ["-n", supervisor]);
});

test("worker launcher validates queue before reading credentials", () => {
  assert.throws(
    () => execFileSync("bash", [worker, "--queue", "invalid"], { encoding: "utf8", stdio: "pipe" }),
    (error) => error.status === 2 && error.stderr.includes("Invalid queue"),
  );
});

test("worker launcher never sources dotenv and pins project media binaries", () => {
  const script = readFileSync(worker, "utf8");
  assert.doesNotMatch(script, /(?:^|\n)\s*(?:source|\.)\s+["']?\$?ENV_FILE/m);
  assert.match(script, /node_modules\/ffmpeg-static\/ffmpeg/);
  assert.match(script, /node_modules\/@ffprobe-installer/);
  assert.match(script, /-perm -u\+x/, "worker must accept a project FFprobe executable by its owner");
  assert.doesNotMatch(script, /-perm -111/, "worker must not require group/world execute bits");
  assert.match(script, /\.runtime\/analysis-venv\/bin\/python/, "worker must reuse the compatible project analysis environment selected by preflight");
  assert.match(script, /differs from \.analysis-worker-token/);
});

test("supervisor supports selectable queues, restart, and signal cleanup", () => {
  const script = readFileSync(supervisor, "utf8");
  assert.match(script, /--worker/);
  assert.match(script, /restarting in/);
  assert.match(script, /trap cleanup EXIT INT TERM/);
  assert.match(script, /kill "\$pid"/);
});

test("PocketBase shell launcher enforces the shared token file", () => {
  const script = readFileSync("scripts/start-pocketbase.sh", "utf8");
  assert.match(script, /\.analysis-worker-token/);
  assert.match(script, /secrets\.token_hex\(32\)/);
  assert.match(script, /umask 077/);
  assert.match(script, /chmod 600/);
  assert.match(script, /refusing to start PocketBase/);
});
