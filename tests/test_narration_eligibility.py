import unittest
from processor.pre_roll_eligibility import is_pre_roll_hook, narration_boundaries_verified
from processor.semantic_analysis import _external_hook_match_input
from processor.semantic_analysis import AnalysisFailed
from processor.factory_render import render_factory_project
from pathlib import Path


class NarrationEligibilityTests(unittest.TestCase):
    def test_source_and_usage_are_independent(self):
        self.assertTrue(is_pre_roll_hook({"source_class": "external_material"}))
        self.assertFalse(is_pre_roll_hook({"source_class": "narration_opening"}))
        self.assertTrue(is_pre_roll_hook({"source_class": "narration_opening", "usage_role": "pre_roll"}))
        self.assertFalse(is_pre_roll_hook({"source_class": "episode_highlight", "usage_role": "pre_roll"}))

    def test_partial_asr_cannot_verify_a_production_boundary(self):
        hook = {"source_class": "narration_opening", "boundary_status": "verified", "safe_start": {"status": "verified"}}
        self.assertFalse(narration_boundaries_verified(hook))
        hook["safe_end"] = {"status": "verified"}
        self.assertTrue(narration_boundaries_verified(hook))

    def test_cached_unscored_asr_is_preserved_without_fabricating_confidence(self):
        hook = {"source_class": "narration_opening", "usage_role": "pre_roll", "import_key": "narration:sample:v1", "start_seconds": 0, "end_seconds": 14,
                "analysis": {"schemaVersion": "narration-opening-v1", "identityConstraint": "第一人称不得换为其他人物"},
                "evidence": {"transcript": [{"start": 0, "end": 6, "text": "I was his wife."}, {"start": 7, "end": 10, "text": "uncertain", "confidence": .1}, {"start": 12, "end": 20, "text": "outside"}]}}
        result = _external_hook_match_input(hook)
        self.assertEqual(len(result["evidence"]["transcript"]), 1)
        self.assertIsNone(result["evidence"]["transcript"][0]["confidence"])
        self.assertEqual(result["evidence"]["transcript"][0]["verification"], "unverified")
        self.assertIn("第一人称", result["opening_identity_constraints"])
        hook["source_class"] = "external_material"
        self.assertFalse(_external_hook_match_input(hook)["evidence"])

    def test_old_matching_version_cannot_render_a_changed_narration_hook(self):
        hook = {"source_class": "narration_opening", "usage_role": "pre_roll", "analysis_version": "new", "boundary_status": "verified", "safe_start": {"status":"verified"}, "safe_end": {"status":"verified"}}
        with self.assertRaisesRegex(AnalysisFailed, "旧高光匹配"):
            render_factory_project({"project":{"mode":"external-hook"}, "hook":hook, "match":{"match_context":{"hookAnalysisVersion":"old"}}}, "http://localhost:8090", Path("unused"), Path("unused"))
