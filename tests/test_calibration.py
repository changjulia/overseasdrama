import json
import unittest
from pathlib import Path
from processor.calibration import (CalibrationProfile, ConfidenceSignals,
    GateThresholds, build_calibration_payload, deterministic_story_score, evaluate, item_production_gate)

FIXTURE = Path(__file__).parent / "fixtures" / "calibration_gold.json"

class CalibrationTests(unittest.TestCase):
    def test_profile_is_reproducible_and_serializable(self):
        profile = CalibrationProfile.fit([.1, .2, .8, .9], [0, 0, 1, 1], bins=2)
        self.assertEqual(profile.calibrate(.15), 0.0)
        self.assertEqual(CalibrationProfile.loads(profile.dumps()).to_dict(), profile.to_dict())

    def test_payload_keeps_signals_distinct(self):
        profile = CalibrationProfile.fit([.9], [0])
        payload = build_calibration_payload(ConfidenceSignals(.9, .2, .8, "unverified"), profile)
        self.assertEqual(payload["modelConfidence"], .9)
        self.assertEqual(payload["evidenceCoverage"], .2)
        self.assertEqual(payload["calibratedProbability"], 0.0)

    def test_gold_metrics(self):
        metrics = evaluate(json.loads(FIXTURE.read_text(encoding="utf-8")))
        self.assertEqual((metrics["precision"], metrics["recall"], metrics["f1"]), (.5, .5, .5))
        self.assertEqual(metrics["labelAgreement"], .5)

    def test_item_gate_has_reasons_and_checks(self):
        gate = item_production_gate({"calibratedProbability": .9, "evidenceCoverage": .8,
            "boundaryReliability": .8, "storyCompleteness": 1, "contradictions": False,
            "humanVerification": "verified"}, GateThresholds(require_human_verification=True))
        self.assertTrue(gate["passed"])
        self.assertEqual(set(gate), {"passed", "reasons", "advisories", "checks", "requiredChecks", "thresholds"})
        failed = item_production_gate({"calibratedProbability": .1})
        self.assertFalse(failed["passed"])
        self.assertTrue(failed["reasons"])

    def test_story_completeness_can_be_creative_advisory(self):
        gate = item_production_gate({"calibratedProbability": .95, "evidenceCoverage": 1,
            "boundaryReliability": 1, "storyCompleteness": 0, "contradictions": False,
            "humanVerification": "verified"}, GateThresholds(require_human_verification=True,
            require_story_completeness=False))
        self.assertTrue(gate["passed"])
        self.assertFalse(gate["checks"]["storyCompleteness"])
        self.assertTrue(gate["advisories"])

    def test_story_business_score_is_deterministic_and_deducts_risks(self):
        result = deterministic_story_score({"dimensionScores": {"promise": 90, "causalCompleteness": 80,
            "conflict": 70, "relationship": 60, "informationGap": 50, "emotion": 40,
            "highlight": 30, "pacing": 20}, "riskPenalty": 2, "risks": [{"deduction": 3}]})
        self.assertEqual(result["score"], 63.1)
        self.assertEqual(result["riskPenalty"], 5)

    def test_business_gate_rejects_low_promise_and_story_score(self):
        gate = item_production_gate({"calibratedProbability": .95, "evidenceCoverage": 1,
            "boundaryReliability": 1, "storyCompleteness": 1, "contradictions": False,
            "humanVerification": "verified", "storyScore": 74.9, "promiseScore": 69.9},
            GateThresholds(require_human_verification=True))
        self.assertFalse(gate["passed"])
        self.assertFalse(gate["checks"]["storyScore"])
        self.assertFalse(gate["checks"]["promiseScore"])

if __name__ == "__main__":
    unittest.main()
