"""Read-only MVP for validating one material-v2 analysis against its evidence contract."""

from __future__ import annotations

import argparse
import copy
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from processor.semantic_analysis import _apply_material_evidence_gate

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load(args: argparse.Namespace) -> dict[str, Any]:
    if args.material_id:
        material_id = urllib.parse.quote(args.material_id, safe="")
        url = f"{args.base_url.rstrip('/')}/api/collections/ad_materials/records/{material_id}"
        with urllib.request.urlopen(url, timeout=15) as response:
            record = json.load(response)
        payload = record.get("analysis_result")
        if not isinstance(payload, dict):
            raise ValueError("素材没有 analysis_result")
        return payload
    with Path(args.file).open("r", encoding="utf-8") as stream:
        payload = json.load(stream)
    if not isinstance(payload, dict):
        raise ValueError("输入必须是 JSON 对象")
    return payload


def _analysis(payload: dict[str, Any]) -> dict[str, Any]:
    value = payload.get("result") if isinstance(payload.get("result"), dict) else payload
    if isinstance(value.get("materialV2"), dict):
        value = value["materialV2"]
    if not isinstance(value, dict):
        raise ValueError("找不到 material-v2 分析对象")
    return copy.deepcopy(value)


def _flagged(result: dict[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    def visit(value: Any, path: str) -> None:
        if isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f"{path}[{index}]")
            return
        if not isinstance(value, dict):
            return
        if value.get("verification") == "unverified" or value.get("reviewRequired") is True:
            label = value.get("statement") or value.get("label") or value.get("value") or value.get("factId") or "未命名结论"
            rows.append({"path": path, "label": str(label)[:120], "verification": str(value.get("verification") or "needs_review")})
        for key, child in value.items():
            if key not in {"evidence", "timecode"}:
                visit(child, f"{path}.{key}" if path else key)

    visit(result, "")
    return rows


def validate(payload: dict[str, Any]) -> dict[str, Any]:
    result = _apply_material_evidence_gate(_analysis(payload))
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    gate = result.get("qualityGate") if isinstance(result.get("qualityGate"), dict) else {}
    observations = content.get("observations") if isinstance(content.get("observations"), list) else []
    inferences = content.get("inferences") if isinstance(content.get("inferences"), list) else []
    return {
        "contractVersion": "material-evidence-v1",
        "passed": gate.get("passed") is True,
        "status": gate.get("status", "review_required"),
        "layers": {
            "observations": len(observations),
            "verifiedObservations": sum(item.get("verification") == "verified" for item in observations if isinstance(item, dict)),
            "inferences": len(inferences),
            "verifiedInferences": sum(item.get("verification") == "verified" for item in inferences if isinstance(item, dict)),
        },
        "reasons": gate.get("reasons", []),
        "flaggedClaims": _flagged(result),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="只读校验一条素材分析是否满足证据契约")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--material-id")
    source.add_argument("--file")
    parser.add_argument("--base-url", default="http://127.0.0.1:8090")
    args = parser.parse_args()
    try:
        report = validate(_load(args))
    except Exception as exc:
        print(json.dumps({"passed": False, "status": "validator_error", "error": str(exc)}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
