"""Small, dependency-free confidence calibration and evaluation primitives.

The module deliberately keeps four signals separate: ``modelConfidence`` is a
model's probability, ``evidenceCoverage`` describes supporting evidence,
``boundaryReliability`` describes temporal boundary quality, and
``humanVerification`` records review state.  Only the first signal is fitted
by :class:`CalibrationProfile`.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping, Sequence

STORY_SCORE_WEIGHTS: dict[str, float] = {"promise": .30, "causal": .20, "conflict": .12, "relationship": .10, "informationGap": .10, "emotion": .08, "highlight": .05, "pacing": .05}
_STORY_SCORE_ALIASES = {
    "promise": ("promise", "promiseFulfillment", "narrativePromise"), "causal": ("causal", "causalCompleteness", "continuity"),
    "conflict": ("conflict", "conflictMatch"), "relationship": ("relationship", "relationshipMatch"),
    "informationGap": ("informationGap", "information_gap", "payoff"), "emotion": ("emotion", "emotionMatch"),
    "highlight": ("highlight", "highlightQuality"), "pacing": ("pacing", "pace"),
}


def _clip(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


@dataclass(frozen=True)
class CalibrationBin:
    lower: float
    upper: float
    probability: float
    count: int


@dataclass(frozen=True)
class ConfidenceSignals:
    """Typed payload used at boundaries; fields must not be conflated."""
    modelConfidence: float
    evidenceCoverage: float
    boundaryReliability: float
    humanVerification: str = "unverified"
    calibratedProbability: float | None = None

    def calibrated(self, profile: "CalibrationProfile") -> "ConfidenceSignals":
        return ConfidenceSignals(self.modelConfidence, self.evidenceCoverage,
                                 self.boundaryReliability, self.humanVerification,
                                 profile.calibrate(self.modelConfidence))


@dataclass
class CalibrationProfile:
    """Serializable equal-width reliability calibration profile."""

    bins: list[CalibrationBin]
    method: str = "reliability-binning"
    version: int = 1

    @classmethod
    def fit(cls, confidences: Iterable[float], outcomes: Iterable[int | bool], bins: int = 10) -> "CalibrationProfile":
        xs, ys = list(confidences), [int(bool(y)) for y in outcomes]
        if len(xs) != len(ys) or not xs:
            raise ValueError("confidences and outcomes must be non-empty and the same length")
        if bins < 1:
            raise ValueError("bins must be positive")
        buckets: list[list[int]] = [[] for _ in range(bins)]
        for x, y in zip(xs, ys):
            p = _clip(x)
            buckets[min(bins - 1, int(p * bins))].append(y)
        result = []
        for i, bucket in enumerate(buckets):
            # Empty bins interpolate to their midpoint, making profiles stable
            # and useful for samples outside the training distribution.
            result.append(CalibrationBin(i / bins, (i + 1) / bins,
                                         _clip(sum(bucket) / len(bucket)) if bucket else (i + .5) / bins,
                                         len(bucket)))
        return cls(result)

    def calibrate(self, confidence: float) -> float:
        p = _clip(confidence)
        for b in self.bins:
            if p < b.upper or b is self.bins[-1]:
                return _clip(b.probability)
        return p

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "method": self.method,
                "bins": [asdict(b) for b in self.bins]}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "CalibrationProfile":
        return cls([CalibrationBin(float(b["lower"]), float(b["upper"]),
                                   float(b["probability"]), int(b["count"]))
                    for b in data["bins"]], str(data.get("method", "reliability-binning")), int(data.get("version", 1)))

    def dumps(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True)

    @classmethod
    def loads(cls, value: str) -> "CalibrationProfile":
        return cls.from_dict(json.loads(value))


def _get(record: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in record:
            return record[name]
    return default


def deterministic_story_score(record: Mapping[str, Any]) -> dict[str, Any]:
    """Compute business suitability separately from model confidence."""
    source = _get(record, "dimensionScores", "dimension_scores", default={})
    source = source if isinstance(source, Mapping) else {}
    scores: dict[str, float] = {}
    for name, aliases in _STORY_SCORE_ALIASES.items():
        raw = _get(source, *aliases, default=_get(record, *aliases, default=0.0))
        try: scores[name] = max(0.0, min(100.0, float(raw or 0.0)))
        except (TypeError, ValueError): scores[name] = 0.0
    try: penalty = max(0.0, float(_get(record, "riskPenalty", "risk_penalty", default=0.0) or 0.0))
    except (TypeError, ValueError): penalty = 0.0
    risks = _get(record, "risks", default=[])
    if isinstance(risks, Sequence) and not isinstance(risks, (str, bytes)):
        for risk in risks:
            if isinstance(risk, Mapping):
                try: penalty += max(0.0, float(_get(risk, "penalty", "deduction", default=0.0) or 0.0))
                except (TypeError, ValueError): pass
    weighted = sum(scores[name] * weight for name, weight in STORY_SCORE_WEIGHTS.items())
    return {"score": round(max(0.0, min(100.0, weighted - penalty)), 2), "dimensionScores": scores, "riskPenalty": round(penalty, 2), "weights": {name: int(weight * 100) for name, weight in STORY_SCORE_WEIGHTS.items()}}


def evaluate(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Evaluate gold records.  Records may use camelCase or snake_case keys."""
    rows = list(records)
    tp = fp = fn = correct = 0
    binary = all(_get(r, "label", "goldLabel", "gold_label", "target") in (0, 1, True, False)
                 and _get(r, "prediction", "predictedLabel", "predicted_label") in (0, 1, True, False) for r in rows)
    boundary_errors: list[float] = []
    complete, contradiction = [], []
    for r in rows:
        pred = _get(r, "prediction", "predictedLabel", "predicted_label")
        gold = _get(r, "label", "goldLabel", "gold_label", "target")
        if pred == gold: correct += 1
        if binary:
            if bool(pred) and bool(gold): tp += 1
            elif bool(pred) and not bool(gold): fp += 1
            elif not bool(pred) and bool(gold): fn += 1
        elif pred == gold:
            tp += 1
        else:
            fp += 1; fn += 1
        pb = _get(r, "predictedBoundary", "predicted_boundary", "predictionBoundary")
        gb = _get(r, "goldBoundary", "gold_boundary", "boundary")
        if isinstance(pb, Sequence) and not isinstance(pb, (str, bytes)) and isinstance(gb, Sequence) and not isinstance(gb, (str, bytes)) and pb and gb:
            boundary_errors.append(sum(abs(float(a)-float(b)) for a, b in zip(pb, gb)) / min(len(pb), len(gb)))
        c = _get(r, "storyCompleteness", "story_completeness", default=None)
        if c is None:
            expected = _get(r, "expectedBeats", "expected_beats", default=[]); found = _get(r, "foundBeats", "found_beats", default=[])
            c = len(found) / len(expected) if expected else 1.0
        complete.append(_clip(c))
        contradiction.append(bool(_get(r, "contradiction", "hasContradiction", default=False)))
    n = len(rows)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"count": n, "precision": precision, "recall": recall, "f1": f1,
            "labelAgreement": correct / n if n else 0.0,
            "boundaryMAE": sum(boundary_errors) / len(boundary_errors) if boundary_errors else 0.0,
            "storyCompleteness": sum(complete) / len(complete) if complete else 0.0,
            "contradictionRate": sum(contradiction) / n if n else 0.0}


@dataclass(frozen=True)
class GateThresholds:
    min_f1: float = .80
    min_label_agreement: float = .90
    max_boundary_mae: float = 1.0
    min_story_completeness: float = .90
    max_contradiction_rate: float = .05
    min_calibrated_probability: float = .80
    min_evidence_coverage: float = .70
    min_boundary_reliability: float = .70
    require_human_verification: bool = False
    require_story_completeness: bool = True


def production_gate(metrics: Mapping[str, float], thresholds: GateThresholds | None = None) -> dict[str, Any]:
    t = thresholds or GateThresholds()
    checks = {"f1": (metrics.get("f1", 0) >= t.min_f1, f"f1 {metrics.get('f1', 0):.3f} < {t.min_f1:.3f}"),
              "labelAgreement": (metrics.get("labelAgreement", 0) >= t.min_label_agreement, f"labelAgreement {metrics.get('labelAgreement', 0):.3f} < {t.min_label_agreement:.3f}"),
              "boundaryMAE": (metrics.get("boundaryMAE", float("inf")) <= t.max_boundary_mae, f"boundaryMAE {metrics.get('boundaryMAE', float('inf')):.3f} > {t.max_boundary_mae:.3f}"),
              "storyCompleteness": (metrics.get("storyCompleteness", 0) >= t.min_story_completeness, f"storyCompleteness {metrics.get('storyCompleteness', 0):.3f} < {t.min_story_completeness:.3f}"),
              "contradictionRate": (metrics.get("contradictionRate", 1) <= t.max_contradiction_rate, f"contradictionRate {metrics.get('contradictionRate', 1):.3f} > {t.max_contradiction_rate:.3f}")}
    return {"passed": all(ok for ok, _ in checks.values()), "reasons": [reason for ok, reason in checks.values() if not ok], "checks": {k: ok for k, (ok, _) in checks.items()}, "thresholds": asdict(t)}


def build_calibration_payload(signals: ConfidenceSignals | Mapping[str, Any], profile: CalibrationProfile) -> dict[str, Any]:
    """Build the stable payload consumed by downstream semantic producers."""
    if isinstance(signals, ConfidenceSignals):
        s = signals.calibrated(profile)
        return asdict(s)
    model = float(_get(signals, "modelConfidence", "model_confidence", default=0.0))
    return {"modelConfidence": model,
            "evidenceCoverage": float(_get(signals, "evidenceCoverage", "evidence_coverage", default=0.0)),
            "boundaryReliability": float(_get(signals, "boundaryReliability", "boundary_reliability", default=0.0)),
            "humanVerification": _get(signals, "humanVerification", "human_verification", default="unverified"),
            "calibratedProbability": profile.calibrate(model)}


def item_production_gate(item: Mapping[str, Any], thresholds: GateThresholds | None = None) -> dict[str, Any]:
    """Apply conservative production checks to one calibrated item."""
    t = thresholds or GateThresholds()
    probability = float(_get(item, "calibratedProbability", "calibrated_probability", default=0.0))
    evidence = float(_get(item, "evidenceCoverage", "evidence_coverage", default=0.0))
    boundary = float(_get(item, "boundaryReliability", "boundary_reliability", default=0.0))
    completeness = float(_get(item, "storyCompleteness", "story_completeness", default=0.0))
    story_score = float(_get(item, "storyScore", "story_score", default=100.0))
    promise_score = float(_get(item, "promiseScore", "promise_score", default=100.0))
    contradictions = _get(item, "contradictions", "contradiction", "hasContradiction", default=False)
    contradiction_ok = not bool(contradictions) if not isinstance(contradictions, (int, float)) else float(contradictions) <= t.max_contradiction_rate
    review = str(_get(item, "humanVerification", "human_verification", "review", default="unverified")).lower()
    review_ok = not t.require_human_verification or review in {"verified", "approved", "human_verified"}
    checks = {"calibratedProbability": probability >= t.min_calibrated_probability,
              "evidenceCoverage": evidence >= t.min_evidence_coverage,
              "boundaryReliability": boundary >= t.min_boundary_reliability,
              "storyCompleteness": completeness >= t.min_story_completeness,
              "storyScore": story_score >= 75.0, "promiseScore": promise_score >= 70.0,
              "contradictions": contradiction_ok, "review": review_ok}
    required = {**checks, "storyCompleteness": checks["storyCompleteness"] or not t.require_story_completeness}
    reasons = [f"{name} below threshold" if name not in ("contradictions", "review") else f"{name} failed" for name, ok in required.items() if not ok]
    advisories = ["storyCompleteness below threshold; creative truncation is allowed"] if not checks["storyCompleteness"] and not t.require_story_completeness else []
    return {"passed": all(required.values()), "reasons": reasons, "advisories": advisories, "checks": checks, "requiredChecks": required, "thresholds": asdict(t)}


# Descriptive aliases keep callers independent of the implementation name.
evaluate_gold = evaluate
check_production_gate = production_gate

def calibrate_probability(profile: CalibrationProfile, model_confidence: float) -> float:
    return profile.calibrate(model_confidence)


__all__ = ["CalibrationBin", "CalibrationProfile", "ConfidenceSignals", "GateThresholds", "STORY_SCORE_WEIGHTS", "deterministic_story_score", "evaluate", "evaluate_gold", "production_gate", "check_production_gate", "calibrate_probability", "build_calibration_payload", "item_production_gate"]
