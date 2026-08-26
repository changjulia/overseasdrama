from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from processor.semantic_analysis import _apply_material_opening_analysis, _augment_story_from_event_ledger, _enrich_material_hooks, _ensure_material_story_landmarks, _material_story_quality_issues, _material_story_consistency_issues, _normalize_material_format


def read_json(path: Path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload.get("data", payload)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Reconcile a stored material opening analysis with verified local boundaries.")
    parser.add_argument("material_id")
    parser.add_argument("cache_dir", type=Path, nargs="?")
    parser.add_argument("--base-url", default="http://127.0.0.1:8090")
    args = parser.parse_args()

    with urllib.request.urlopen(f"{args.base_url}/api/collections/ad_materials/records/{args.material_id}") as response:
        material = json.loads(response.read())
    result = material.get("analysis_result")
    if isinstance(result, str):
        result = json.loads(result)
    if not isinstance(result, dict):
        raise RuntimeError("material has no structured analysis_result")

    duration = float(result.get("durationSeconds") or material.get("duration") or 0)
    evidence = result.get("evidence") if isinstance(result.get("evidence"), dict) else {}
    shots = evidence.get("shots") if isinstance(evidence.get("shots"), list) else []
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    opening = creative.get("openingAnalysis") if isinstance(creative.get("openingAnalysis"), dict) else {}
    result = _apply_material_opening_analysis(result, opening, duration)
    result = _augment_story_from_event_ledger(result, {}, duration)
    semantic_segments = result.get("semanticSegments") if isinstance(result.get("semanticSegments"), list) else []
    observations = [item.get("result", {}) for item in semantic_segments if isinstance(item, dict)]
    result = _ensure_material_story_landmarks(result, observations, duration, shots)
    creative, review = _normalize_material_format(result.get("creative", {}), result.get("review", {}))
    transcript = evidence.get("transcript") if isinstance(evidence.get("transcript"), list) else []
    if args.cache_dir:
        transcript = read_json(args.cache_dir / "asr.json")
        scan = read_json(args.cache_dir / "scan-v2.json")
        shots = scan.get("shots", [])
    creative = _enrich_material_hooks(creative, transcript, shots, duration)
    remaining_issues = _material_story_quality_issues(result, duration) + _material_story_consistency_issues(result, duration, json.dumps(observations, ensure_ascii=False))
    review_reasons = [str(item) for item in review.get("reasons", []) if str(item)] if isinstance(review.get("reasons"), list) else []
    obsolete = ("云端全片汇总截断", "页面剧情阶段必须", "剧情概括", "人物归一", "人物关系不足", "具体剧情证据不足", "证据包含操作提示")
    review["reasons"] = list(dict.fromkeys([*[item for item in review_reasons if not any(marker in item for marker in obsolete)], *remaining_issues]))
    review["reviewRequired"] = bool(review["reasons"])
    review["status"] = "needs_review" if review["reviewRequired"] else "ready"
    result["creative"], result["review"] = creative, review
    semantic = dict(result.get("semantic") or {})
    semantic["content"] = result.get("content", {})
    semantic["creative"], semantic["review"] = creative, result.get("review", review)
    result["semantic"] = semantic
    hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
    first_hook = hooks[0] if hooks and isinstance(hooks[0], dict) else {}
    print(json.dumps({
        "duration": duration,
        "format": (creative.get("format") or {}).get("value"),
        "source": (creative.get("hookSourceStatus") or {}).get("value"),
        "assembly": (creative.get("hookAssemblyType") or {}).get("value"),
        "hookRange": [first_hook.get("start"), first_hook.get("end")],
    }, ensure_ascii=False))

    body = json.dumps({"analysis_result": result}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{args.base_url}/api/lumina/material-analysis/materials/{args.material_id}/reproject",
        data=body,
        headers={"content-type": "application/json", "origin": "http://127.0.0.1:3000"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        print(response.read().decode("utf-8"))


if __name__ == "__main__":
    main()
