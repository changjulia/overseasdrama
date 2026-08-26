from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def text_value(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("value") or value.get("label") or value.get("description") or "")
    return str(value or "")


def labels(values: Any) -> list[str]:
    if isinstance(values, dict):
        values = [values]
    return [text_value(item) for item in values or [] if text_value(item)]


def score_analysis(actual: dict[str, Any], gold: dict[str, Any]) -> dict[str, Any]:
    content = actual.get("content") if isinstance(actual.get("content"), dict) else {}
    creative = actual.get("creative") if isinstance(actual.get("creative"), dict) else {}
    summary = text_value(content.get("summary"))
    summary_hits = [any(word in summary for word in group) for group in gold["summaryConcepts"]]
    forbidden = [pattern for pattern in gold["forbiddenSummaryPatterns"] if pattern in summary]
    phases = creative.get("displayPhases") or creative.get("timeline") or content.get("storyBeats") or content.get("segments") or []
    phases = [item for item in phases if isinstance(item, dict)]
    phase_text = " ".join(text_value(item) + " " + str(item.get("description") or "") for item in phases)
    phase_hits = [any(word in phase_text for word in phase["concepts"]) for phase in gold["phases"]]
    relation_text = " ".join(labels(content.get("relationships") or content.get("relations")))
    character_text = " ".join(labels(content.get("characters")))
    relation_hits = [all(any(name in relation_text for name in (character if isinstance(character, list) else [character])) for character in item["characters"]) and any(word in relation_text for word in item["concepts"]) for item in gold["relationships"]]
    summary_causal = len(re.findall(r"随后|继而|因此|迫使|直到|最终|结尾|却|但", summary)) >= 3
    phase_count_ok = 4 <= len(phases) <= 7
    phase_order_ok = all(float(item.get("end", 0) or 0) > float(item.get("start", 0) or 0) for item in phases) and all(abs(float(phases[index].get("end", 0) or 0) - float(phases[index + 1].get("start", 0) or 0)) <= 1 for index in range(len(phases) - 1))
    ending_phase_ok = bool(phases) and float(phases[-1].get("start", 0) or 0) >= 1200 and float(phases[-1].get("end", 0) or 0) >= 0.9 * 1453.456
    timeline_coverage = False
    if phases:
        starts = [float(item.get("start", 0) or 0) for item in phases]
        ends = [float(item.get("end", 0) or 0) for item in phases]
        timeline_coverage = min(starts) <= 1 and max(ends) >= 0.9 * 1453.456
    fixed_minutes = sum(1 for item in phases if abs(float(item.get("end", 0) or 0) - float(item.get("start", 0) or 0) - 60) < 0.2)
    not_raw_chunks = fixed_minutes <= 1
    format_ok = text_value(creative.get("format") or creative.get("materialType")) == gold["format"]
    expected_hook_status = gold["hookSourceStatus"] if isinstance(gold["hookSourceStatus"], list) else [gold["hookSourceStatus"]]
    hook_status_ok = text_value(creative.get("hookSourceStatus")) in expected_hook_status
    assembly_ok = text_value(creative.get("hookAssemblyType")) == gold["hookAssemblyType"]
    hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
    hook = hooks[0] if hooks and isinstance(hooks[0], dict) else creative.get("hook") if isinstance(creative.get("hook"), dict) else {}
    hook_range = gold["hookRange"]
    hook_boundary_ok = (
        isinstance(hook.get("start"), (int, float))
        and isinstance(hook.get("end"), (int, float))
        and abs(float(hook["start"]) - float(hook_range["start"])) <= float(hook_range["tolerance"])
        and abs(float(hook["end"]) - float(hook_range["end"])) <= float(hook_range["tolerance"])
    )
    hook_summary = str(hook.get("plotSummary") or hook.get("source") or hook.get("spokenSummary") or "")
    hook_type = text_value(hook.get("hookType") or hook.get("hook_type") or hook)
    hook_summary_hits = [any(word in hook_summary for word in group) for group in gold["hookSummaryConcepts"]]
    hook_summary_ok = sum(hook_summary_hits) >= 5
    checks = {
        "summary_length": 180 <= len(summary) <= 600,
        "summary_concepts": sum(summary_hits) >= 7,
        "summary_causal": summary_causal,
        "summary_not_generic": not forbidden,
        "story_phase_count": phase_count_ok,
        "story_phase_concepts": sum(phase_hits) >= 4,
        "story_timeline_coverage": timeline_coverage,
        "story_not_raw_minute_chunks": not_raw_chunks,
        "story_phase_order": phase_order_ok,
        "ending_phase_boundary": ending_phase_ok,
        "characters_normalized": not any(name in character_text for name in gold.get("forbiddenCharacters", [])),
        "relationships": all(relation_hits),
        "format": format_ok,
        "hook_source": hook_status_ok,
        "hook_assembly": assembly_ok,
        "hook_complete_boundary": hook_boundary_ok,
        "hook_complete_summary": hook_summary_ok,
        "hook_type": hook_type in gold.get("hookTypes", []),
    }
    return {
        "passed": all(checks.values()),
        "score": round(100 * sum(checks.values()) / len(checks), 1),
        "checks": checks,
        "diagnostics": {
            "summaryCharacters": len(summary),
            "summaryConceptHits": summary_hits,
            "forbiddenPatterns": forbidden,
            "phaseCount": len(phases),
            "phaseConceptHits": phase_hits,
            "fixedMinutePhases": fixed_minutes,
            "relationshipText": relation_text,
            "characterText": character_text,
            "format": text_value(creative.get("format") or creative.get("materialType")),
            "hookSourceStatus": text_value(creative.get("hookSourceStatus")),
            "hookAssemblyType": text_value(creative.get("hookAssemblyType")),
            "hookRange": {"start": hook.get("start"), "end": hook.get("end")},
            "hookSummary": hook_summary,
            "hookType": hook_type,
            "hookSummaryConceptHits": hook_summary_hits,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    parser.add_argument("--gold", type=Path, default=Path("analysis_artifacts/lyeacmt405cpccn/ideal-analysis.json"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    actual = json.loads(args.analysis.read_text(encoding="utf-8"))
    if isinstance(actual.get("analysisV2"), dict):
        actual = actual["analysisV2"]
    elif isinstance(actual.get("analysis"), dict):
        actual = actual["analysis"]
    gold = json.loads(args.gold.read_text(encoding="utf-8"))["gold"]
    report = score_analysis(actual, gold)
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
