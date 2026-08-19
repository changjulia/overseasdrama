import unittest

from processor.semantic_analysis import _normalize_material_format


class MaterialReconciliationTests(unittest.TestCase):
    def test_verified_same_drama_removes_contradictory_source_uncertainty(self):
        creative = {
            "bodyFormat": {"value": "正片主导", "confidence": 0.96, "verification": "verified", "evidence": []},
            "hookSourceStatus": {"value": "已确认同剧", "confidence": 0.98, "verification": "verified", "evidence": []},
        }
        review = {
            "status": "needs_review",
            "reviewRequired": True,
            "reasons": [
                "无法确认是否存在外部钩子或剪辑来源差异，需进一步核实。",
                "部分语音识别置信度较低，需要人工复核。",
            ],
        }

        normalized_creative, normalized_review = _normalize_material_format(creative, review)

        self.assertEqual(normalized_creative["format"]["value"], "正片剧集拼接")
        self.assertEqual(normalized_review["reasons"], ["部分语音识别置信度较低，需要人工复核。"])
        self.assertTrue(normalized_review["reviewRequired"])

    def test_unconfirmed_source_keeps_uncertainty_reason(self):
        creative = {
            "bodyFormat": {"value": "正片主导", "confidence": 0.8, "verification": "verified", "evidence": []},
            "hookSourceStatus": {"value": "来源未知", "confidence": 0.5, "verification": "unverified", "evidence": []},
        }
        reason = "无法确认是否存在外部钩子或剪辑来源差异，需进一步核实。"

        _, normalized_review = _normalize_material_format(creative, {"status": "needs_review", "reasons": [reason]})

        self.assertIn(reason, normalized_review["reasons"])

    def test_verified_same_drama_removes_cannot_exclude_external_wording(self):
        creative = {
            "bodyFormat": {"value": "正片主导", "confidence": 0.96, "verification": "verified", "evidence": []},
            "hookSourceStatus": {"value": "已确认同剧", "confidence": 0.98, "verification": "verified", "evidence": []},
        }
        conflict = "尽管视觉/音频证据完整，但因无原始剧集信息，无法完全排除外搭可能性，需结合更多源数据确认。"

        _, normalized_review = _normalize_material_format(
            creative,
            {"status": "needs_review", "reviewRequired": True, "reasons": [conflict, "术语需要补充背景说明。"]},
        )

        self.assertEqual(normalized_review["reasons"], ["术语需要补充背景说明。"])

    def test_normalizes_machine_values_using_verified_labels(self):
        creative = {
            "bodyFormat": {
                "value": "drama_driven",
                "label": "正片主导",
                "code": "正片主导",
                "confidence": 0.99,
                "verification": "verified",
                "evidence": [],
            },
            "hookSourceStatus": {
                "value": "same_drama",
                "label": "已确认同剧",
                "code": "已确认同剧",
                "confidence": 0.98,
                "verification": "verified",
                "evidence": [],
            },
        }

        normalized_creative, _ = _normalize_material_format(creative, {"status": "ready", "reasons": []})

        self.assertEqual(normalized_creative["format"]["code"], "EPISODE_SPLICE")
        self.assertEqual(normalized_creative["format"]["value"], "正片剧集拼接")


if __name__ == "__main__":
    unittest.main()
