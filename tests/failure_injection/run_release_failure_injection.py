"""Run the release failure-injection suite and persist auditable evidence."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "release-evidence" / "2026-08-30" / "failure-injection"
COMMAND = [sys.executable, "-m", "unittest", "-v", "tests.failure_injection.test_release_failure_injection"]


def main() -> int:
    environment = {**os.environ, "PYTHONWARNINGS": "ignore::ResourceWarning"}
    result = subprocess.run(COMMAND, cwd=ROOT, capture_output=True, text=True, env=environment)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    combined = (result.stdout + result.stderr).strip()
    cases = []
    pending = None
    for line in combined.splitlines():
        if line.startswith("test_") and " ... " in line:
            pending, inline_status = line.split(" ... ", 1)
            if inline_status in {"ok", "FAIL", "ERROR"} or inline_status.startswith("skipped"):
                cases.append({"name": pending, "status": inline_status})
                pending = None
        elif pending and (line in {"ok", "FAIL", "ERROR"} or line.startswith("skipped")):
            cases.append({"name": pending, "status": line})
            pending = None
    payload = {
        "schemaVersion": "lumina-release-failure-injection-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "command": COMMAND,
        "offline": True,
        "productionMutation": False,
        "exitCode": result.returncode,
        "passed": result.returncode == 0 and bool(cases),
        "cases": cases,
        "rawOutput": combined,
    }
    (EVIDENCE / "result.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rows = "\n".join(f"| `{case['name']}` | {case['status']} |" for case in cases)
    markdown = f"""# 失败注入验收证据\n\n- 生成时间（UTC）：`{payload['generatedAt']}`\n- 离线执行：是\n- 生产变更：无\n- 结论：**{'通过' if payload['passed'] else '失败'}**\n\n| 场景 | 结果 |\n|---|---|\n{rows}\n\n## 覆盖范围\n\n源文件 404、坏媒体、无音轨、QC 时长漂移与编码不符、worker transient/permanent 重试分类，以及 QC 失败时临时文件不发布。\n\n## 原始输出\n\n```text\n{combined}\n```\n"""
    (EVIDENCE / "README.md").write_text(markdown, encoding="utf-8")
    print(markdown)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
