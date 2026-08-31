import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const run = (args, env = {}) => spawnSync("bash", ["scripts/runtime-check.sh", ...args], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, ...env },
});

test("render profile checks only the render worker dependency boundary", () => {
  const result = run(["--profile", "render"], {
    LUMINA_WORKER_TOKEN: "runtime-check-contract-placeholder",
    DASHSCOPE_API_KEY: "",
    LUMINA_SEMANTIC_API_KEY: "",
    OPENAI_API_KEY: "",
    LUMINA_ANALYSIS_ENV_FILE: "/definitely/missing/lumina-analysis-env",
  });
  const output = result.stdout + result.stderr;

  assert.equal(result.status, 0, output);
  assert.match(output, /profile：render/);
  assert.match(output, /Pillow 可导入/);
  assert.match(output, /项目固定版本/);
  assert.doesNotMatch(output, /缺少 DASHSCOPE_API_KEY|faster-whisper|paddleocr|jsonschema/);
  assert.doesNotMatch(output, /curl:/);
});

test("analysis profile retains semantic and ASR/OCR gates", () => {
  const result = run(["--profile", "analysis"], {
    LUMINA_WORKER_TOKEN: "runtime-check-contract-placeholder",
    DASHSCOPE_API_KEY: "",
    LUMINA_SEMANTIC_API_KEY: "",
    OPENAI_API_KEY: "",
    LUMINA_ANALYSIS_ENV_FILE: "/definitely/missing/lumina-analysis-env",
  });
  const output = result.stdout + result.stderr;

  assert.match(output, /profile：analysis/);
  assert.match(output, /缺少 DASHSCOPE_API_KEY/);
  assert.match(output, /faster-whisper/);
  assert.match(output, /paddleocr/);
  assert.match(output, /jsonschema/);
});

test("analysis profile validates the configured worker Python instead of the shell Python by accident", () => {
  const result = run(["--profile", "analysis"], {
    LUMINA_WORKER_TOKEN: "runtime-check-contract-placeholder",
    LUMINA_PYTHON_EXE: "/definitely/missing/lumina-python",
  });
  const output = result.stdout + result.stderr;
  assert.match(output, /分析 Python 不可用：\/definitely\/missing\/lumina-python/);
});

test("full local profile resolves the same safe media defaults as the PocketBase launcher", () => {
  const result = run(["--profile", "full"], {
    LUMINA_WORKER_TOKEN: "runtime-check-contract-placeholder",
    LUMINA_FFPROBE_PATH: "",
    LUMINA_SHA256_PATH: "",
    LUMINA_POCKETBASE_WORKER_BASE_URL: "",
  });
  const output = result.stdout + result.stderr;
  assert.match(output, /旁白上传 ffprobe 可用/);
  assert.match(output, /旁白上传 SHA-256 工具可用/);
  assert.match(output, /旁白媒体 worker 同源地址可用：http:\/\/127\.0\.0\.1:8090/);
  assert.doesNotMatch(output, /缺少可执行的 LUMINA_FFPROBE_PATH|缺少可执行的 LUMINA_SHA256_PATH|LUMINA_POCKETBASE_WORKER_BASE_URL 必须/);
});

test("invalid profile fails fast", () => {
  const result = run(["--profile", "unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /无效 profile/);
});

test("hosted gateway preflight requires server-only credentials and disables loopback trust", () => {
  const result = run(["--help"]);
  const script = result.stdout;
  assert.match(script, /LUMINA_HOSTED_GATEWAY_CHECK/);

  const checked = run(["--profile", "full"], {
    LUMINA_HOSTED_GATEWAY_CHECK: "1",
    POCKETBASE_URL: "http://127.0.0.1:8090",
    LUMINA_UI_GATEWAY_TOKEN: "",
    LUMINA_POCKETBASE_SUPERUSER_IDENTITY: "",
    LUMINA_POCKETBASE_SUPERUSER_PASSWORD: "",
    LUMINA_UI_MODE: "local-loopback",
  });
  const output = checked.stdout + checked.stderr;
  assert.match(output, /缺少 LUMINA_UI_GATEWAY_TOKEN/);
  assert.match(output, /缺少 LUMINA_POCKETBASE_SUPERUSER_IDENTITY/);
  assert.match(output, /托管环境不得启用 LUMINA_UI_MODE=local-loopback/);
});
