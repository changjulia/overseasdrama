import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/preprod-readiness-check.sh", import.meta.url));
const script = readFileSync(scriptPath, "utf8");

test("preprod checker is read-only and never prints secret values", () => {
  assert.match(script, /Read-only pre-production gate/);
  assert.doesNotMatch(script, /\b(?:source|eval)\s+.*env/);
  assert.doesNotMatch(script, /(?:print|echo|printf)[^\n]*(?:API_KEY|PASSWORD|WORKER_TOKEN).*\$\{/);
  assert.doesNotMatch(script, /^\s*(?:wrangler\s+deploy|git\s+push|.*\bmigrate\s+(?:up|down)\b|sqlite3\s+[^\n]*\b(?:UPDATE|DELETE|INSERT)\b)/im);
});

test("preprod checker fails closed without attestations and does not echo injected secrets", () => {
  const sentinel = "MUST_NOT_APPEAR_IN_OUTPUT";
  const result = spawnSync("bash", [scriptPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: {
      ...process.env,
      EXTERNAL_OPEN_API_KEY: sentinel,
      LUMINA_WORKER_TOKEN: sentinel,
      LUMINA_UI_GATEWAY_TOKEN: sentinel,
      LUMINA_POCKETBASE_SUPERUSER_IDENTITY: sentinel,
      LUMINA_POCKETBASE_SUPERUSER_PASSWORD: sentinel,
      DASHSCOPE_API_KEY: sentinel,
      LUMINA_PREPROD_EVIDENCE_DIR: "/path/that/does/not/exist",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(output, new RegExp(sentinel));
  assert.match(output, /证据缺失/);
  assert.match(output, /预生产必须显式配置绝对路径 LUMINA_FACTORY_RENDER_DIR/);
});

test("preprod checker syntax is valid", () => {
  const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
