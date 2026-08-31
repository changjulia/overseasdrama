import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = path.resolve("scripts/setup-analysis-env.sh");

const fakePython = (version = "3.12.8") => {
  const dir = mkdtempSync(path.join(tmpdir(), "analysis-python-"));
  const executable = path.join(dir, "python");
  writeFileSync(executable, `#!/usr/bin/env bash\ncase "$*" in\n  *sys.version_info*) [[ "${version}" == 3.12.* ]] && exit 0 || exit 1 ;;\n  *platform.python_version*) printf '%s\\n' '${executable} (Python ${version}, test)' ;;\nesac\n`);
  chmodSync(executable, 0o755);
  return executable;
};

test("dry-run selects a compatible Python without creating or installing", () => {
  const python = fakePython();
  const venv = path.join(tmpdir(), `analysis-venv-${process.pid}-missing`);
  const result = spawnSync("bash", [script, "--dry-run", "--python", python], {
    encoding: "utf8",
    env: { ...process.env, LUMINA_ANALYSIS_VENV: venv },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY-RUN:.*-m venv/);
  assert.match(result.stdout, /requirements-analysis\.txt/);
  assert.doesNotMatch(result.stdout + result.stderr, /Collecting|Downloading/);
});

test("incompatible Python fails with an actionable version boundary", () => {
  const python = fakePython("3.14.0");
  const result = spawnSync("bash", [script, "--check", "--python", python], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python 3\.9–3\.12/);
  assert.match(result.stderr, /3\.13\/3\.14/);
});

test("check mode does not silently install a missing environment", () => {
  const python = fakePython();
  const venv = path.join(tmpdir(), `analysis-venv-${process.pid}-absent`);
  const result = spawnSync("bash", [script, "--check", "--python", python], {
    encoding: "utf8",
    env: { ...process.env, LUMINA_ANALYSIS_VENV: venv },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /尚未创建/);
  assert.match(result.stderr, /--install/);
});

test("check mode reuses an existing compatible project venv without requiring a global Python", () => {
  const venv = mkdtempSync(path.join(tmpdir(), "analysis-existing-venv-"));
  mkdirSync(path.join(venv, "bin"));
  const executable = path.join(venv, "bin", "python");
  writeFileSync(executable, `#!/usr/bin/env bash\ncase "$*" in\n  *sys.version_info*) exit 0 ;;\n  *platform.python_version*) printf '%s\\n' '${executable} (Python 3.12.8, test)' ;;\n  *faster_whisper*) exit 0 ;;\nesac\n`);
  chmodSync(executable, 0o755);
  const result = spawnSync("bash", [script, "--check"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin", LUMINA_ANALYSIS_VENV: venv, LUMINA_ANALYSIS_PYTHON: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /分析依赖可导入/);
  assert.match(result.stdout, new RegExp(executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("unknown options fail fast", () => {
  const result = spawnSync("bash", [script, "--surprise"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知参数/);
});
