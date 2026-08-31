import copy
import base64
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from pathlib import Path

from PIL import Image

from processor.pack import group_phrases, pack_transcripts
from processor.scribe import is_cache_valid, source_fingerprint
from processor.batch_transcribe import select_free_episodes
from processor.job_worker import ApiRequestError, _detail_motion_recall_intervals, _select_detail_evidence_frames, classify_failure, envelope_from_dict, execute_entry_precision_job, execute_semantic_job, process_available, process_one_endpoint
from processor.factory_render import _validated_splice_boundaries, build_render_quality_report
from processor.semantic_analysis import AnalysisFailed, AnalysisEnvelope, Evidence, Timecode, _aggregate_material_classification, _apply_material_evidence_gate, _bounded_detail_frames, _bounded_precision_frames, _complete_sentence_limit, _detail_recall_probes, _downgrade_unsupported_external_hook, _drama_claim_safety_issue, _enrich_material_dialogue_entities, _enrich_material_hooks, _ensure_material_output_contract, _episode_owned_core_facts, _external_hook_fragment_evidence, _external_hook_match_input, _extract_chat_stream, _extract_provider_result, _material_evidence_timestamps, _material_output_contract_missing_paths, _material_output_contract_valid, _material_publish_confidence, _material_semantic_analysis, _material_story_consistency_issues, _material_story_quality_issues, _material_visual_event_verification, _normalize_material_format, _normalize_precision_hooks, _openai_request_body, _opening_preface_boundary, _precision_candidates, _rebuild_material_summary_from_verified_observations, _reconstruct_storyline, _reconstruct_highlights, _relink_material_ocr_evidence, _run_detail_checkpoint, _sanitize_drama_detail_semantics, _sanitize_material_provider_input, _sanitize_material_story_candidates, _select_precision_evidence_frames, _semantic_frame_base64, _semantic_model_for_task, _semantic_request, _story_duration_validation, _storyboard_quality_issues, _storyboard_units_from_event_ledger, _strict_safety_provider_input, _target_duration_spec, _validate_material_visual_events, _validate_semantic_claims, analyze_coarse, analyze_detail, analyze_detail_reconcile, analyze_hook_entry_points, analyze_hook_story_match, analyze_material, failed_envelope, transcribe

MATERIAL_CONTRACT = {
    "content": {"summary": {"value": "摘要", "confidence": 0.9, "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 1}, "confidence": 0.9, "text": "开场对白"}], "basedOnFactIds": ["F1"], "verification": "verified"}, "observations": [{"factId": "F1", "actorObserved": "说话者", "actionObserved": "说出开场对白", "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 1}, "confidence": 0.9, "text": "开场对白"}], "verification": "verified"}], "inferences": [], "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {"value": "完整", "confidence": 0.9, "evidence": []}},
    "creative": {"format": {"value": "正片剧集拼接", "confidence": 0.9, "evidence": []}, "tier": {"value": "T1", "confidence": 0.9, "evidence": []}, "hooks": [], "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
    "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
    "review": {"status": "needs_review", "reasons": []},
}


class ProcessorTests(unittest.TestCase):
    def test_material_content_hash_mismatch_is_permanent_media_failure(self):
        self.assertEqual(classify_failure(RuntimeError("material content hash does not match the recorded intake identity")), ("media", False, 0))

    def test_two_level_model_routing_keeps_final_judgment_on_max(self):
        with patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "qwen-vl-max", "LUMINA_SEMANTIC_RECALL_MODEL": "qwen3-vl-flash"}):
            self.assertEqual(_semantic_model_for_task("detail-recall-probe"), "qwen3-vl-flash")
            for task in ("detail-drama-analysis", "repair-detail-output-contract"):
                self.assertEqual(_semantic_model_for_task(task), "qwen3-vl-flash")
            for task in ("reconcile-drama-storyline", "ground-drama-episode", "synthesize-drama-overview", "precision-highlight-analysis"):
                self.assertEqual(_semantic_model_for_task(task), "qwen-vl-max")

    def test_checkpoint_uses_actual_flash_model_and_does_not_persist_request_media(self):
        secret_media = "signed-url-and-original-media-must-not-be-persisted"
        payload = {"sourceUrl": f"https://media.invalid/video.mp4?signature={secret_media}", "frames": [{"base64": secret_media}]}
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "qwen-vl-max", "LUMINA_SEMANTIC_RECALL_MODEL": "qwen3-vl-flash"}):
            result, diagnostics = _run_detail_checkpoint(
                "detail-recall-probe",
                payload,
                Path(directory),
                "probe-001",
                lambda request_diagnostics: {"probe": "safe structured output"},
            )
            checkpoint_files = list(Path(directory).glob("drama-detail/by-content-hash/*/qwen3-vl-flash/drama-detail-checkpoint-v1-20260831/*.json"))
            self.assertEqual(result, {"probe": "safe structured output"})
            self.assertEqual(diagnostics["model"], "qwen3-vl-flash")
            self.assertEqual(len(checkpoint_files), 1)
            self.assertNotIn(secret_media, checkpoint_files[0].read_text(encoding="utf-8"))
    def test_visual_event_validator_rejects_single_frame_action_and_weak_speaker_link(self):
        frames = [{"timecode": {"start": value, "end": value}} for value in (1.0, 1.4)]
        result = _validate_material_visual_events({
            "events": [{"id": "kneel", "start": 1, "end": 1.4, "actorCandidate": "man A", "actionObserved": "男子跪下", "evidenceFrames": [{"timecode": {"start": 1, "end": 1}}], "confidence": .9, "verification": "verified"}],
            "speakerLinks": [{"speakerCandidate": "man A", "evidenceModalities": ["adjacency_only"], "confidence": .9, "verification": "verified"}],
        }, frames, {"start": 1, "end": 1.4})
        self.assertEqual(result["events"], [])
        self.assertEqual(len(result["rejectedEvents"]), 1)
        self.assertEqual(result["rejectedEvents"][0]["verification"], "unverified")
        self.assertTrue(result["rejectedEvents"][0]["reviewRequired"])
        self.assertEqual(result["speakerLinks"][0]["verification"], "unverified")
        self.assertEqual(result["boundaryAssessment"]["actionStatus"], "unverified")
        self.assertEqual(result["boundaryAssessment"]["semanticStatus"], "unverified")

    def test_visual_event_validator_accepts_real_multiframe_state_change(self):
        frames = [{"timecode": {"start": value, "end": value}} for value in (1.0, 1.4)]
        result = _validate_material_visual_events({"events": [{
            "id": "posture", "start": 1, "end": 1.4, "actorCandidate": "man A", "actionObserved": "男子从站立降低到单膝着地",
            "evidenceFrames": [{"timecode": {"start": 1, "end": 1}}, {"timecode": {"start": 1.4, "end": 1.4}}], "confidence": .8, "verification": "verified",
        }]}, frames, {"start": 1, "end": 1.4})
        self.assertEqual(result["events"][0]["validatedFrameTimes"], [1.0, 1.4])
        self.assertEqual(result["events"][0]["actorCandidate"], "可见角色（身份待核）")

    def test_visual_event_validator_rejects_emotion_and_speaking_inference(self):
        frames = [{"timecode": {"start": value, "end": value}} for value in (1.0, 1.4)]
        result = _validate_material_visual_events({"events": [{
            "id": "reaction", "start": 1, "end": 1.4, "actorCandidate": "Killian", "actionObserved": "似乎正在说话",
            "reactionObserved": "因前一个镜头而震惊", "evidenceFrames": [{"timecode": {"start": 1, "end": 1}}, {"timecode": {"start": 1.4, "end": 1.4}}],
            "confidence": .9, "verification": "verified",
        }]}, frames, {"start": 1, "end": 1.4})
        self.assertEqual(result["events"], [])
        self.assertEqual(len(result["rejectedEvents"]), 1)

    def test_visual_event_verification_uses_separate_cache(self):
        provider_result = {"events": [], "speakerLinks": [], "boundaryAssessment": {}, "openQuestions": []}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image_path = root / "frame.jpg"
            Image.new("RGB", (32, 32), "red").save(image_path)
            frames = [{"path": str(image_path), "timecode": {"start": 1.0, "end": 1.0}}]
            payload = {"transcript": [], "ocr": [], "shots": []}
            with patch("processor.semantic_analysis._semantic_request", return_value=provider_result) as request:
                _material_visual_event_verification(payload, frames, {"start": .5, "end": 1.5}, root, lambda *_: None)
                _material_visual_event_verification(payload, frames, {"start": .5, "end": 1.5}, root, lambda *_: None)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(len(list(root.glob("visual-events-v1-*.json"))), 1)

    def test_visual_event_request_contract_forbids_single_frame_motion(self):
        body = _openai_request_body("openai-chat-completions", "test-model", "paid-ad-material-visual-event-verification", {"frames": []})
        prompt = json.loads(body["messages"][1]["content"][0]["text"])
        self.assertIn("events", prompt["requiredOutputContract"])
        self.assertTrue(any("at least two distinct" in rule for rule in prompt["outputRules"]))
        self.assertEqual(body["max_tokens"], 4000)

    def test_dialogue_entity_enrichment_uses_asr_and_point_ocr_without_visual_invention(self):
        transcript = [
            {"start": 0, "end": 2.8, "text": "Juggernaut, end this brat!", "confidence": .8},
            {"start": 16.8, "end": 20.04, "text": "Killian the Juggernaut, champion warrior.", "confidence": .88},
            {"start": 20.9, "end": 21.86, "text": "At your command.", "confidence": .98},
        ]
        ocr = [{"text": "Killian the Juggernaut", "timecode": {"start": 17.5, "end": 17.5}, "framePath": "/tmp/frame.jpg", "confidence": .99}]
        enriched = _enrich_material_dialogue_entities({"observations": [{"factId": "fact-002", "actionObserved": "发出命令", "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 2.8}, "confidence": .8}], "verification": "verified"}]}, transcript, ocr)
        self.assertEqual({item["factId"] for item in enriched["observations"]}, {"fact-002", "local-dialogue-title", "local-dialogue-response"})
        self.assertEqual(len(enriched["characters"]), 2)
        self.assertEqual(enriched["relationships"][0]["type"], "mention_response")
        self.assertEqual(enriched["relationships"][0]["subject"], "character-title-speaker")
        self.assertTrue(all(item["verification"] == "unverified" for item in enriched["characters"]))
        self.assertEqual(enriched["relationships"][0]["verification"], "unverified")
        self.assertIn("ocr_frame", {item["source"] for item in enriched["characters"][1]["evidence"]})
        self.assertNotIn("跪", json.dumps(enriched, ensure_ascii=False))

    def test_material_cta_is_not_a_story_cliffhanger_and_reveal_is_recovered(self):
        creative = {"timeline": [{"code": "cliffhanger", "label": "悬念", "start": 24.48, "end": 26.56, "evidence": [{"sourceText": "Click the link below to watch the full series."}]}], "hooks": []}
        transcript = [
            {"start": 16.8, "end": 20.04, "text": "Killian the Juggernaut, champion warrior of the Shadow Pack.", "confidence": .88},
            {"start": 20.9, "end": 21.86, "text": "At your command.", "confidence": .98},
            {"start": 24.48, "end": 26.56, "text": "Click the link below to watch the full series.", "confidence": .99},
        ]
        result = _sanitize_material_story_candidates(creative, transcript, [], 34.504)
        self.assertEqual(result["timeline"], [])
        self.assertEqual(result["cta"][0]["code"], "cta")
        self.assertEqual(result["hooks"][0]["code"], "identity_reveal_response")
        self.assertAlmostEqual(result["hooks"][0]["start"], 15.1)
        self.assertAlmostEqual(result["hooks"][0]["end"], 23.46)

    def test_complete_material_is_downgraded_when_cta_replaces_story_resolution(self):
        result = copy.deepcopy(MATERIAL_CONTRACT)
        result["durationSeconds"] = 34.5
        result["content"]["characters"] = []
        result["content"]["relationships"] = []
        result["content"]["completeness"] = {"code": "complete", "value": "完整", "confidence": .95, "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 34.5}, "confidence": .9, "sourceText": "Click the link below to watch the full series."}], "verification": "verified"}
        gated = _apply_material_evidence_gate(result)
        self.assertEqual(gated["content"]["completeness"]["value"], "不完整")
        self.assertFalse(gated["qualityGate"]["passed"])
        self.assertTrue(any("CTA" in reason for reason in gated["qualityGate"]["reasons"]))

    def test_unverified_material_facts_are_quarantined_from_consumable_layers(self):
        result = copy.deepcopy(MATERIAL_CONTRACT)
        result["durationSeconds"] = 10
        result["content"]["observations"].append({"factId": "F-DANGLING", "actionObserved": "零时长字幕推断", "confidence": .9, "evidence": [{"source": "ocr", "timecode": {"start": 5, "end": 5}, "confidence": .9}], "verification": "verified"})
        result["content"]["inferences"] = [{"statement": "悬空身份", "basedOnFactIds": ["F-DANGLING"], "confidence": .9, "evidence": [{"source": "ocr", "timecode": {"start": 5, "end": 5}, "confidence": .9}], "verification": "verified"}]
        gated = _apply_material_evidence_gate(result)
        self.assertEqual([item["factId"] for item in gated["content"]["observations"]], ["F1"])
        self.assertEqual(gated["content"]["inferences"], [])
        rejected = gated["review"]["rejectedClaims"]
        self.assertTrue({"observation", "inference"}.issubset({item["layer"] for item in rejected}))

    def test_material_evidence_graph_has_no_dangling_consumable_edges(self):
        result = copy.deepcopy(MATERIAL_CONTRACT)
        result["durationSeconds"] = 10
        result["content"]["segments"] = [{"code": "body", "basedOnFactIds": ["MISSING"], "verification": "unverified"}]
        result["creative"]["transitions"] = [{"code": "fade", "basedOnFactIds": ["MISSING"], "verification": "verified"}]
        result["creative"]["timeline"] = [{"code": "peak", "basedOnFactIds": ["F1"], "verification": "verified"}]
        result["creative"]["cta"] = [{"code": "cta", "basedOnFactIds": ["MISSING"], "verification": "verified", "evidence": [{"source": "transcript", "timecode": {"start": 8, "end": 9}, "confidence": .9}]}]
        result["creative"]["bodyFormat"] = {"value": "正片主导", "basedOnFactIds": ["MISSING"], "verification": "verified"}
        result["value"]["risks"] = [{"label": "风险", "basedOnFactIds": ["MISSING"], "verification": "verified"}]
        gated = _apply_material_evidence_gate(result)
        self.assertEqual(gated["content"]["segments"], [])
        self.assertEqual(gated["creative"]["transitions"], [])
        self.assertEqual(gated["creative"]["timeline"][0]["basedOnFactIds"], ["F1"])
        self.assertEqual(gated["creative"]["cta"][0]["basedOnFactIds"], [])
        self.assertEqual(gated["creative"]["bodyFormat"]["basedOnFactIds"], [])
        self.assertEqual(gated["creative"]["bodyFormat"]["verification"], "unverified")
        self.assertEqual(gated["value"]["risks"], [])
        rejected_layers = {item["layer"] for item in gated["review"]["rejectedClaims"]}
        self.assertTrue({"content.segments", "creative.transitions", "creative.bodyFormat", "value.risks"}.issubset(rejected_layers))

    def test_material_publish_confidence_is_capped_when_quality_gate_fails(self):
        result = copy.deepcopy(MATERIAL_CONTRACT)
        result["qualityGate"] = {"passed": False}
        result["content"]["characters"] = []
        result["content"]["relationships"] = []
        result["creative"]["hooks"] = []
        result["value"]["scores"] = {}
        self.assertLessEqual(_material_publish_confidence(result), 49)

    def test_material_contract_diagnostic_lists_nested_missing_paths(self):
        invalid = {"content": {"summary": {"value": "摘要"}}, "creative": {}, "value": {}, "review": {}}
        missing = _material_output_contract_missing_paths(invalid)
        self.assertIn("content.summary.evidence[]", missing)
        self.assertIn("content.summary.basedOnFactIds[]", missing)
        self.assertIn("content.summary.verification=verified", missing)
        self.assertIn("content.observations[]", missing)
        self.assertFalse(_material_output_contract_valid(invalid))
        self.assertEqual(_material_output_contract_missing_paths(MATERIAL_CONTRACT), [])

    def test_material_aggregate_preserves_verified_segment_observations(self):
        first = copy.deepcopy(MATERIAL_CONTRACT)
        second = copy.deepcopy(MATERIAL_CONTRACT)
        second["content"]["observations"][0]["actionObserved"] = "打开房门"
        merged = _aggregate_material_classification([first, second], 20)
        repaired = _rebuild_material_summary_from_verified_observations(merged)
        fact_ids = [item["factId"] for item in repaired["content"]["observations"]]
        self.assertEqual(fact_ids, ["segment-1:F1", "segment-2:F1"])
        self.assertEqual(repaired["content"]["summary"]["basedOnFactIds"], fact_ids)

    def test_material_ocr_point_relinks_only_to_matching_measured_frame(self):
        claim = {"confidence": .9, "evidence": [{"source": "ocr", "timecode": {"start": 0, "end": 0}, "confidence": .9, "text": "救命"}]}
        source = [{"timecode": {"start": 0, "end": 0}, "text": "救命", "framePath": "/local/frame-000.jpg"}]
        linked = _validate_semantic_claims(_relink_material_ocr_evidence(claim, source), 5)
        self.assertEqual(linked["verification"], "verified")
        self.assertEqual(linked["evidence"][0]["framePath"], "/local/frame-000.jpg")
        unmatched = _validate_semantic_claims(_relink_material_ocr_evidence(claim, [{**source[0], "text": "别走"}]), 5)
        self.assertEqual(unmatched["verification"], "unverified")

    def test_material_source_claim_requires_lineage_not_dialogue(self):
        dialogue = [{"source": "transcript", "text": "You are from the same pack", "timecode": {"start": 1, "end": 2}, "confidence": .9}]
        result = _apply_material_evidence_gate({
            "content": {"observations": [{"factId": "F1", "actionObserved": "角色提到同一族群", "evidence": dialogue, "verification": "verified"}], "inferences": [], "characters": [], "relationships": []},
            "creative": {
                "hookSourceStatus": {"value": "已确认同剧", "confidence": .9, "evidence": dialogue, "verification": "verified"},
                "hookAssemblyType": {"value": "同剧外搭", "confidence": .9, "evidence": dialogue, "verification": "verified"},
                "tier": {"value": "T1", "confidence": .9, "evidence": dialogue, "verification": "verified"},
                "packaging": {"audio": []},
            },
            "sourceAttribution": {"status": "not_required", "matches": []},
            "review": {"status": "ready", "reviewRequired": False, "reasons": []},
        })
        self.assertEqual(result["creative"]["hookSourceStatus"]["value"], "来源未知")
        self.assertEqual(result["creative"]["hookAssemblyType"]["value"], "外搭来源待确认")
        self.assertEqual(result["creative"]["tier"]["verification"], "unverified")
        self.assertTrue(result["review"]["reviewRequired"])
        self.assertFalse(result["qualityGate"]["passed"])

    def test_material_summary_repair_uses_only_verified_observations(self):
        evidence = [{"source": "transcript", "timecode": {"start": 1, "end": 2}, "confidence": .9, "text": "Stop"}]
        invalid = copy.deepcopy(MATERIAL_CONTRACT)
        invalid["content"]["summary"] = {"value": "unsupported provider summary"}
        invalid["content"]["observations"] = [
            {"factId": "F1", "actorObserved": "发令者", "actionObserved": "命令众人停下", "confidence": .9, "evidence": evidence, "verification": "verified"},
            {"factId": "F2", "actorObserved": "旁观者", "actionObserved": "可能感到害怕", "confidence": .8, "evidence": evidence, "verification": "unverified"},
        ]
        repaired = _rebuild_material_summary_from_verified_observations(invalid)
        summary = repaired["content"]["summary"]
        self.assertEqual(summary["basedOnFactIds"], ["F1"])
        self.assertEqual(summary["evidence"], evidence)
        self.assertNotIn("害怕", summary["value"])
        self.assertEqual(summary["repair"], "rebuilt_from_verified_observations")
        self.assertTrue(_material_output_contract_valid(repaired))
        self.assertEqual(repaired["review"]["status"], "needs_review")

    def test_material_summary_repair_refuses_unverified_facts(self):
        invalid = copy.deepcopy(MATERIAL_CONTRACT)
        invalid["content"]["summary"] = {}
        invalid["content"]["observations"] = [{"factId": "F1", "actionObserved": "猜测身份", "evidence": [], "verification": "unverified"}]
        repaired = _rebuild_material_summary_from_verified_observations(invalid)
        self.assertFalse(_material_output_contract_valid(repaired))

    def test_material_contract_repairs_summary_locally_before_paid_retry(self):
        invalid = copy.deepcopy(MATERIAL_CONTRACT)
        invalid["content"]["summary"] = {"value": "provider summary without fact lineage"}
        with patch("processor.semantic_analysis._semantic_request", side_effect=AssertionError("provider repair must not run")):
            repaired = _ensure_material_output_contract(invalid, {}, 34.5, lambda *_: None)
        self.assertTrue(_material_output_contract_valid(repaired))
        self.assertEqual(repaired["content"]["summary"]["repair"], "rebuilt_from_verified_observations")

    def test_material_primary_hook_prefers_complete_opening_over_later_climax(self):
        claim = {"confidence": .9, "evidence": [], "verification": "unverified"}
        creative = {
            "format": {**claim, "value": "正片剧集拼接"},
            "timeline": [{**claim, "code": "STORY_PHASE_1", "label": "身份争议", "start": 0, "end": 60, "description": "开场建立身份冲突"}],
            "hooks": [{**claim, "label": "后段揭露高光", "hookType": "揭露", "start": 180, "end": 210}],
        }
        enriched = _enrich_material_hooks(creative, [], [], 291)
        self.assertEqual(enriched["hooks"][0]["start"], 0)
        self.assertEqual(enriched["hooks"][0]["end"], 60)
        self.assertTrue(any(item["start"] == 180 for item in enriched["hooks"][1:]))

    def test_summary_limit_never_persists_a_broken_sentence(self):
        value = ("第一阶段完成。" * 90) + "结尾行动仍在继续并形成最终结果。"
        limited = _complete_sentence_limit(value, 500)
        self.assertLessEqual(len(limited), 500)
        self.assertTrue(limited.endswith("。"))

    def test_event_ledger_builds_continuous_concrete_storyboard(self):
        ledger = {"events": [
            {"start": 12, "end": 35, "actor": "安努杰", "goal": "救活病人", "action": "坚持实施高风险治疗", "obstacle": "帕万公开质疑", "result": "病人存活", "relationshipChange": "旁观医生开始认可他", "confidence": .92},
            {"start": 65, "end": 105, "actor": "帕万", "goal": "维护自己的名望", "action": "公开抢夺治疗功劳", "obstacle": "安努杰当场反驳", "result": "双方彻底决裂", "relationshipChange": "职业竞争公开化", "confidence": .88},
            {"start": 125, "end": 175, "actor": "苏夫里", "goal": "阻止冲突升级", "action": "试图劝开争执双方", "obstacle": "双方拒绝退让", "result": "公开对峙继续", "relationshipChange": "调解失败", "confidence": .86},
            {"start": 190, "end": 230, "actor": "家族长辈", "goal": "查明礼物来源", "action": "要求鉴定古董真伪", "obstacle": "送礼者试图掩饰", "result": "赝品被识破", "relationshipChange": "家族信任动摇", "confidence": .9},
            {"start": 245, "end": 270, "actor": "安努杰", "goal": "揭露欺骗", "action": "展示伪造证据", "obstacle": "涉事者继续否认", "result": "阴谋被公开", "relationshipChange": "家族信任破裂", "confidence": .9},
            {"start": 275, "end": 289, "actor": "家族长辈", "goal": "惩罚欺骗者", "action": "宣布驱逐涉事成员", "obstacle": "众人求情", "result": "冲突以决裂收尾", "relationshipChange": "亲属关系断裂", "confidence": .86},
        ]}
        units = _storyboard_units_from_event_ledger(ledger, 291)
        self.assertEqual(len(units), 6)
        self.assertEqual(units[0]["start"], 0)
        self.assertEqual(units[-1]["end"], 291)
        self.assertEqual([item["end"] for item in units[:-1]], [item["start"] for item in units[1:]])
        self.assertFalse(_storyboard_quality_issues(units, 291))
        self.assertTrue(all(item["label"] not in {"剧情理解", "部分完整", "不完整"} for item in units))
        self.assertIn("旁观医生开始认可他", units[0]["label"])

    def test_storyboard_title_keeps_complete_long_action_and_outcome(self):
        ledger = {"events": [{"start": 0, "end": 30, "actor": "Mr. Pavan", "goal": "确认治疗方案", "action": "质问Anuj如何治疗其孙子", "obstacle": "双方发生激烈争执", "result": "Anuj的治疗效果得到部分认可", "relationshipChange": "两人关系暂时缓和", "confidence": .9}]}
        title = _storyboard_units_from_event_ledger(ledger, 30)[0]["label"]
        self.assertEqual(title, "Mr. Pavan质问Anuj如何治疗其孙子，两人关系暂时缓和")
        self.assertNotRegex(title, r"(?:如|与|向|把|将)$")

    def test_material_evidence_gate_rejects_self_proving_visual_inference(self):
        frame = lambda text: [{"source": "frame", "text": text, "timecode": {"start": 2, "end": 2}, "confidence": 1}]
        result = _apply_material_evidence_gate({
            "content": {
                "characters": [{"label": "女王", "verification": "verified", "evidence": frame("佩戴王冠")}],
                "relationships": [{"label": "情侣关系", "verification": "verified", "evidence": frame("两人对视")}],
            },
            "creative": {
                "tier": {"label": "T1", "verification": "verified", "evidence": frame("服饰和灯光精致")},
                "packaging": {"audio": [{"label": "戏剧性配乐", "verification": "verified", "evidence": frame("音频事件缺失，但根据画面推断")}]},
            },
            "review": {"status": "ready", "reviewRequired": False, "reasons": []},
        })
        self.assertEqual(result["content"]["characters"][0]["verification"], "unverified")
        self.assertEqual(result["content"]["relationships"][0]["verification"], "unverified")
        self.assertEqual(result["creative"]["tier"]["verification"], "unverified")
        self.assertEqual(result["creative"]["packaging"]["audio"][0]["verification"], "unverified")
        self.assertTrue(result["review"]["reviewRequired"])
        self.assertFalse(result["qualityGate"]["passed"])

    def test_material_evidence_gate_accepts_supported_identity_and_metrics_tier(self):
        result = _apply_material_evidence_gate({
            "content": {
                "observations": [{"factId": "F1", "actorObserved": "画外说话者", "actionObserved": "称呼画中女性为女王", "evidence": [{"source": "transcript", "sourceText": "Your Majesty, my queen", "timecode": {"start": 1, "end": 2}, "confidence": .9}], "verification": "verified"}],
                "inferences": [{"label": "该女性身份为女王", "statement": "该女性身份为女王", "basedOnFactIds": ["F1"], "verification": "verified", "evidence": [{"source": "transcript", "sourceText": "Your Majesty, my queen", "timecode": {"start": 1, "end": 2}, "confidence": .9}]}],
                "characters": [{"label": "女王", "verification": "verified", "evidence": [{"source": "transcript", "sourceText": "Your Majesty, my queen", "timecode": {"start": 1, "end": 2}, "confidence": .9}]}], "relationships": []},
            "creative": {"tier": {"label": "T1", "verification": "verified", "evidence": [{"source": "adx", "text": "verified spend tier", "timecode": {"start": 0, "end": 1}, "confidence": 1}]}, "packaging": {"audio": []}},
            "review": {"status": "ready", "reviewRequired": False, "reasons": []},
        })
        self.assertEqual(result["content"]["characters"][0]["verification"], "verified")
        self.assertEqual(result["creative"]["tier"]["verification"], "verified")
        self.assertTrue(result["qualityGate"]["passed"])

    def test_material_evidence_gate_requires_fact_before_inference(self):
        result = _apply_material_evidence_gate({
            "content": {
                "summary": {"value": "两人因背叛争执", "verification": "verified", "evidence": [{"source": "frame", "text": "两人站立", "timecode": {"start": 1, "end": 1}, "confidence": .9}]},
                "characters": [], "relationships": [],
                "inferences": [{"label": "情侣背叛", "verification": "verified", "basedOnFactIds": ["F404"], "evidence": [{"source": "frame", "text": "两人站立", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
            },
            "creative": {}, "review": {},
        })
        self.assertFalse(result["qualityGate"]["passed"])
        self.assertEqual(result["content"]["summary"]["verification"], "unverified")
        self.assertEqual(result["content"]["inferences"], [])
        self.assertTrue(any(item["layer"] == "inference" for item in result["review"]["rejectedClaims"]))

    def test_material_evidence_gate_rejects_visual_motive_inference(self):
        result = _apply_material_evidence_gate({
            "content": {
                "observations": [{"factId": "F1", "actionObserved": "女人拿起信封", "verification": "verified", "evidence": [{"source": "frame", "text": "女人拿起信封", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
                "inferences": [{"label": "她为了钱背叛朋友", "statement": "她为了钱背叛朋友", "inferenceType": "motive", "basedOnFactIds": ["F1"], "verification": "verified", "evidence": [{"source": "frame", "text": "女人拿起信封", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
                "characters": [], "relationships": [],
            }, "creative": {}, "review": {"status": "ready", "reviewRequired": False},
        })
        self.assertFalse(result["qualityGate"]["passed"])
        self.assertEqual(result["content"]["inferences"], [])
        self.assertTrue(any(item["layer"] == "inference" for item in result["review"]["rejectedClaims"]))

    def test_material_evidence_gate_respects_existing_review_required(self):
        result = _apply_material_evidence_gate({
            "content": {"observations": [{"factId": "F1", "actionObserved": "男人关门", "verification": "verified", "evidence": [{"source": "frame", "text": "男人关门", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}], "inferences": [], "characters": [], "relationships": []},
            "creative": {}, "review": {"status": "needs_review", "reviewRequired": True, "reasons": ["对白缺失"]},
        })
        self.assertFalse(result["qualityGate"]["passed"])
        self.assertIn("对白缺失", result["qualityGate"]["reasons"])

    def test_material_evidence_gate_rejects_fake_verified_fact_timecode(self):
        result = _apply_material_evidence_gate({
            "durationSeconds": 10,
            "content": {"observations": [{"factId": "F1", "actionObserved": "男人关门", "verification": "verified", "evidence": [{"source": "transcript", "text": "男人关门", "timecode": {"start": 12, "end": 12}, "confidence": 2}]}], "inferences": [], "characters": [], "relationships": []},
            "creative": {}, "review": {"status": "ready", "reviewRequired": False},
        })
        self.assertFalse(result["qualityGate"]["passed"])
        self.assertEqual(result["content"]["observations"], [])
        self.assertTrue(any(item["layer"] == "observation" for item in result["review"]["rejectedClaims"]))

    def test_coarse_request_requires_episode_summary_contract(self):
        body = _openai_request_body("openai-chat-completions", "test-model", "coarse-episode-analysis", {"episode": 1})
        prompt = json.loads(body["messages"][1]["content"][0]["text"])
        self.assertIn("episodeSummary", prompt["requiredOutputContract"])
        self.assertIn("castCandidates", prompt["requiredOutputContract"])

    def test_repair_coarse_request_uses_same_summary_contract(self):
        body = _openai_request_body("openai-chat-completions", "test-model", "repair-coarse-episode-output-contract", {"episode": 1})
        prompt = json.loads(body["messages"][1]["content"][0]["text"])
        self.assertIn("episodeSummary", prompt["requiredOutputContract"])

    def test_semantic_frame_payload_is_resized(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "large.jpg"
            Image.new("RGB", (1920, 1080), "red").save(source, quality=95)
            encoded = _semantic_frame_base64(source)
            with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
                self.assertLessEqual(max(image.size), 640)

    @patch("processor.semantic_analysis._semantic_request", return_value={"summary": {}})
    @patch("processor.semantic_analysis.read_ocr", return_value=([], {"status": "ok"}))
    @patch("processor.semantic_analysis.transcribe", return_value=([], {"status": "no_audio"}))
    @patch("processor.semantic_analysis.extract_frames", return_value=[])
    @patch("processor.semantic_analysis._duration", return_value=10.0)
    def test_coarse_rejects_empty_success(self, _duration_mock, _frames_mock, _transcribe_mock, _ocr_mock, _semantic_mock):
        with self.assertRaisesRegex(AnalysisFailed, "episodeSummary"):
            analyze_coarse(Path("episode.mp4"), 1, Path("workspace"))

    @patch("processor.semantic_analysis._semantic_request")
    @patch("processor.semantic_analysis.read_ocr", return_value=([], {"status": "ok"}))
    @patch("processor.semantic_analysis.transcribe", return_value=([{"start": 1, "end": 2, "text": "line"}], {"status": "ok"}))
    @patch("processor.semantic_analysis.extract_frames", side_effect=AnalysisFailed("Output file does not contain any stream"))
    @patch("processor.semantic_analysis._duration", return_value=10.0)
    def test_coarse_audio_only_episode_uses_transcript(self, _duration_mock, _frames_mock, _transcribe_mock, _ocr_mock, semantic_mock):
        semantic_mock.return_value = {"episodeSummary": {"value": "仅音轨剧情摘要", "confidence": .9, "evidence": [
            {"source": "transcript", "timecode": {"start": 1, "end": 2}, "confidence": .9},
            {"source": "transcript", "timecode": {"start": 9, "end": 12}, "confidence": .9},
        ]}, "castCandidates": []}
        result = analyze_coarse(Path("audio-only.mp4"), 1, Path("workspace"))
        self.assertEqual(result.engine["frames"]["status"], "no_video")
        self.assertEqual(result.result["episodeSummary"]["verification"], "verified")
        self.assertEqual(len(result.result["episodeSummary"]["evidence"]), 1)

    @patch("processor.whisper_runtime.create_whisper_model")
    def test_transcribe_treats_missing_audio_stream_as_visual_only(self, create_model):
        def missing_audio():
            raise IndexError("tuple index out of range")
            yield None
        model = MagicMock()
        model.transcribe.return_value = (missing_audio(), SimpleNamespace(language=""))
        runtime = SimpleNamespace(device="cpu", compute_type="int8", fallback_reason="")
        create_model.return_value = (model, runtime)
        fake_whisper = SimpleNamespace(WhisperModel=MagicMock())
        with patch.dict(sys.modules, {"faster_whisper": fake_whisper}), patch.dict("os.environ", {"LUMINA_WHISPER_MODEL": "tiny", "LUMINA_WHISPER_DEVICE": "cpu", "LUMINA_WHISPER_COMPUTE_TYPE": "int8"}, clear=False):
            transcript, engine = transcribe(Path("silent.mp4"))
        self.assertEqual(transcript, [])
        self.assertEqual(engine["status"], "no_audio")

    def test_failure_classifier_does_not_retry_deterministic_ffmpeg_error(self):
        kind, retryable, delay = classify_failure(RuntimeError("ffmpeg failed: Non full-range YUV is non-standard; Invalid argument"))
        self.assertEqual(kind, "media")
        self.assertFalse(retryable)
        self.assertEqual(delay, 0)

    def test_failure_classifier_retries_network_timeout(self):
        kind, retryable, delay = classify_failure(TimeoutError("provider read timed out"))
        self.assertEqual(kind, "transient")
        self.assertTrue(retryable)
        self.assertEqual(delay, 30)

    def test_failure_classifier_retries_ssl_eof(self):
        kind, retryable, delay = classify_failure(RuntimeError("SSL: UNEXPECTED_EOF_WHILE_READING"))
        self.assertEqual(kind, "transient")
        self.assertTrue(retryable)
        self.assertEqual(delay, 30)

    def test_failure_classifier_retries_mkl_memory_pressure(self):
        kind, retryable, delay = classify_failure(RuntimeError("mkl_malloc: failed to allocate memory"))
        self.assertEqual(kind, "transient")
        self.assertTrue(retryable)
        self.assertEqual(delay, 30)

    @patch("processor.job_worker._entry_frame_quality", return_value={"passed": True})
    @patch("processor.job_worker.extract_frames", return_value=[{"path": "frame.jpg", "timecode": {"start": 5, "end": 5}}])
    @patch("processor.job_worker.download")
    def test_entry_precision_worker_maps_persisted_snake_case_match(self, _download, _frames, _quality):
        evidence = {"transcript": [{"timecode": {"start": 5, "end": 6}}], "actions": [{"timecode": {"start": 5, "end": 5.5}}], "shots": [{"timecode": {"start": 5, "end": 7}}], "audioEvents": [{"timecode": {"start": 5, "end": 6}}]}
        result = execute_entry_precision_job({"job": {"stage": "entry_precision"}, "match": {"story_score": 70, "production_gate": {"passed": False}, "dimension_scores": {"emotion": 80, "promise": 80}, "segments": [{"episode": 1, "entryEvidence": evidence}]}, "episodes": [{"id": "ep1", "collectionId": "episodes", "episode_number": 1, "video": "ep1.mp4"}]}, "http://pb", Path("tmp"))
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["start"], 5)

    @patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"})
    @patch("processor.semantic_analysis._semantic_request")
    def test_hook_story_match_rejects_out_of_scope_and_marks_unsafe(self, semantic_mock):
        semantic_mock.return_value = {"matches": [{"title": "完整脉络", "matchScore": 88, "segments": [
            {"episode": 1, "start": 3, "end": 9, "safeStart": {"status": "verified"}, "safeEnd": {"status": "unverified"}},
            {"episode": 9, "start": 1, "end": 4, "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}},
        ]}]}
        payload = {"hook": {"id": "h1", "source_class": "external_material", "boundary_status": "verified"}, "drama": {"id": "d1"}, "episodes": [{"episode_number": 1, "analysis_result": {}, "highlights": [{"id": "eh1", "start_seconds": 2, "end_seconds": 10, "boundary_status": "verified", "review_status": "approved", "safe_start": {"status": "verified"}, "safe_end": {"status": "unverified"}}]}], "episode_scope": [1]}
        result = analyze_hook_story_match(payload).result
        self.assertEqual([segment["episode"] for segment in result["matches"][0]["segments"]], [1])
        self.assertEqual(result["matches"][0]["segments"][0]["highlightAssetId"], "eh1")
        self.assertTrue(result["matches"][0]["reviewRequired"])
        self.assertIn("storyGraph", result["matches"][0])
        self.assertIn("entryPoints", result["matches"][0])
        self.assertIn("calibration", result["matches"][0])
        self.assertFalse(result["matches"][0]["productionGate"]["passed"])

    @patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"})
    @patch("processor.semantic_analysis._semantic_request")
    def test_story_to_hook_limits_body_segments_to_selected_storyline_evidence(self, semantic_mock):
        semantic_mock.return_value = {"matches": [{"title": "候选", "matchScore": 80, "segments": [
            {"episode": 1, "start": 0, "end": 10, "highlightAssetId": "selected"},
            {"episode": 1, "start": 20, "end": 30, "highlightAssetId": "not-selected"},
        ]}]}
        highlight = lambda asset_id, start: {"id": asset_id, "start_seconds": start, "end_seconds": start + 10, "boundary_status": "verified", "review_status": "approved", "safe_start": {"status": "verified"}, "safe_end": {"status": "verified"}, "evidence": [{"text": asset_id}]}
        payload = {
            "hook": {"id": "h1", "source_class": "external_material", "boundary_status": "verified"}, "drama": {"id": "d1"},
            "episodes": [{"episode_number": 1, "analysis_result": {}, "highlights": [highlight("selected", 0), highlight("not-selected", 20)]}], "episode_scope": [1],
            "match_context": {"matchStrategy": "story_to_hook", "storyNeed": {"corePlot": "选中路线", "selectedStorylineIds": ["p1"], "evidence": [{"sourceType": "episode_highlight", "sourceId": "selected", "episode": 1, "start": 0, "end": 10}]}}
        }
        result = analyze_hook_story_match(payload).result
        self.assertTrue(result["matches"])
        for match in result["matches"]:
            self.assertEqual({segment["highlightAssetId"] for segment in match["segments"]}, {"selected"})

    @patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"})
    def test_hook_story_match_requests_supplemental_analysis_without_approved_highlights(self):
        payload = {"hook": {"id": "h1", "source_class": "external_material", "boundary_status": "verified"}, "drama": {"id": "d1"}, "episodes": [{"episode_number": 1, "highlights": []}], "episode_scope": [1]}
        result = analyze_hook_story_match(payload).result
        self.assertEqual(result["matches"], [])
        self.assertEqual(result["supplementalAnalysisRequests"][0]["requestedAnalysis"], "highlight_precision")

    @patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"})
    def test_hook_story_match_accepts_verified_non_external_source_class(self):
        payload = {"hook": {"id": "h1", "source_class": "episode_highlight", "boundary_status": "verified"}, "drama": {"id": "d1"}, "episodes": [{"episode_number": 1, "highlights": []}], "episode_scope": [1]}
        result = analyze_hook_story_match(payload).result
        self.assertEqual(result["matches"], [])

    def test_story_duration_tiers_allow_only_explained_shortfall(self):
        spec = _target_duration_spec({"targetDurationTier": "5-15m"})
        segments = [{"start": 0, "end": 240}]
        self.assertFalse(_story_duration_validation(segments, spec)["passed"])
        self.assertEqual(_story_duration_validation(segments, spec, "free scope has no more approved highlights")["status"], "explained_shortfall")

    def test_entry_points_require_real_dialogue_action_and_shot_evidence(self):
        match = {"id": "m1", "storyScore": 80, "productionGate": {"passed": True}, "businessScore": {"dimensionScores": {"emotion": 90, "promise": 90}}, "segments": [{"episode": 1, "entryEvidence": {"transcript": [{"start": 1, "end": 2}], "actions": [{"start": 2, "end": 3}], "shots": [{"start": 2, "end": 4}], "audioEvents": [{"start": 2, "end": 3}]}}]}
        result = analyze_hook_entry_points({"matches": [match]})
        self.assertEqual(len(result["matches"][0]["candidates"]), 1)
        self.assertEqual(result["matches"][0]["candidates"][0]["start"], 2)
        match["segments"][0]["entryEvidence"].pop("actions")
        self.assertEqual(analyze_hook_entry_points({"matches": [match]})["matches"][0]["candidates"], [])

    def test_material_hooks_keep_multiple_assets_and_boundary_evidence(self):
        creative = {"hooks": [
            {"label": "身份揭露", "start": 0.0, "end": 8.0},
            {"label": "危险逼近", "start": 12.0, "end": 20.0},
        ]}
        transcript = [{"text": "complete line", "start": 0.0, "end": 3.0}]
        shots = [{"timecode": {"start": 0.0, "end": 8.0}}, {"timecode": {"start": 12.0, "end": 20.0}}]
        result = _enrich_material_hooks(creative, transcript, shots, 30.0)
        self.assertEqual(len(result["hooks"]), 2)
        self.assertEqual(result["hooks"][0]["boundaryStatus"], "unverified")
        self.assertEqual(result["hooks"][0]["safeEnd"]["actionStatus"], "shot_boundary_only")
        self.assertEqual(result["hooks"][1]["safeStart"]["dialogueStatus"], "complete")

    def test_material_hook_boundary_rejects_mid_dialogue_cut(self):
        creative = {"hooks": [{"label": "截断台词", "start": 1.0, "end": 6.0}]}
        transcript = [{"text": "one complete sentence", "start": 0.0, "end": 2.0}]
        shots = [{"timecode": {"start": 1.0, "end": 6.0}}]
        result = _enrich_material_hooks(creative, transcript, shots, 10.0)
        self.assertEqual(result["hooks"][0]["boundaryStatus"], "unverified")
        self.assertTrue(result["hooks"][0]["reviewRequired"])

    def test_boundary_exposes_all_production_states_and_time_evidence(self):
        creative = {"hooks": [{"label": "安全点", "start": 0.0, "end": 8.0}]}
        transcript = [{"text": "line", "start": 0.0, "end": 2.0, "confidence": .9}]
        shots = [{"timecode": {"start": 0.0, "end": 8.0}, "confidence": 1}]
        result = _enrich_material_hooks(creative, transcript, shots, 12.0)["hooks"][0]
        self.assertEqual(set(("dialogue", "action", "shot", "semantic")), set(result["safeStart"]) & {"dialogue", "action", "shot", "semantic"})
        self.assertEqual(result["safeStart"]["timecode"], {"start": 0.0, "end": 0.0})
        self.assertIn("productionGate", result)

    def test_storyline_contains_required_event_fields_and_completeness(self):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .9, "timecode": {"start": 1, "end": 2}}]
        semantic = {"events": [
            {"episode": 1, "start": 1, "end": 2, "phase": phase, "evidence": evidence, "action": phase, "result": phase, "preconditions": ["前序"] if index else []}
            for index, phase in enumerate(("setup", "escalation", "payoff", "ending"))
        ]}
        graph = _reconstruct_storyline(semantic, [{"episode": 1, "durationSeconds": 10}])
        self.assertEqual(graph["completeness"]["status"], "complete")
        self.assertFalse(graph["reviewRequired"])
        self.assertTrue(all(set(("actors", "preconditions", "action", "result", "relationshipBefore", "relationshipAfter", "emotionBefore", "emotionAfter", "reveals", "unresolvedQuestions", "timeEvidence")) <= set(event) for event in graph["events"]))

    def test_highlight_rejects_zero_and_truncated_candidates_and_keeps_intervals(self):
        evidence = [{"source": "transcript", "confidence": .8, "timecode": {"start": 2, "end": 3}}]
        candidates = _reconstruct_highlights([
            {"start": 3, "end": 3, "evidence": evidence},
            {"start": 2, "end": 4, "evidence": evidence, "safeStart": {"dialogue": {"status": "truncated"}}},
            {"start": 2, "end": 8, "evidence": evidence},
        ], 10)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["narrativeInterval"]["start"], 2)
        self.assertEqual(candidates[0]["productionInterval"]["end"], 8)
        self.assertEqual(candidates[0]["trigger"]["timecode"], {"start": 2, "end": 3})

    def test_short_external_opening_is_rejected_instead_of_expanding_to_body(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "短钩子", "start": 0, "end": 1.4}, {"label": "正片内再钩子", "start": 80, "end": 90}]}
        shots = [{"timecode": {"start": 0, "end": 8}}, {"timecode": {"start": 8, "end": 23.36}}, {"timecode": {"start": 23.36, "end": 38.48}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(result["hooks"], [])
        self.assertEqual(result["hookLocalization"]["status"], "needs_review")
        self.assertFalse(result["hookLocalization"]["wholeVideoFallbackAllowed"])

    def test_whole_material_is_never_accepted_as_hook(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "整片", "start": 0, "end": 120}]}
        shots = [{"timecode": {"start": 0, "end": 20}}, {"timecode": {"start": 20, "end": 120}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(result["hooks"], [])

    def test_external_hook_conclusion_covers_complete_external_fragment(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "完整外搭开场", "start": 0, "end": 23.36, "plotSummary": "完整概括外搭片段"}], "entryPoints": [{"label": "强句入口", "start": 4, "end": 10}]}
        shots = [{"timecode": {"start": 0, "end": 8}}, {"timecode": {"start": 8, "end": 23.36}}, {"timecode": {"start": 23.36, "end": 120}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(len(result["hooks"]), 1)
        self.assertEqual(result["hooks"][0]["end"], 23.36)
        self.assertEqual(result["hooks"][0]["scope"], "complete_external_fragment")
        self.assertEqual(result["hooks"][0]["plotSummary"], "完整概括外搭片段")
        self.assertEqual(result["entryPoints"][0]["end"], 10)

    def test_strong_line_is_extended_to_complete_preface_boundary(self):
        hooks = [{"start": 0, "end": 12}]
        shots = [
            {"timecode": {"start": 0, "end": 1.28}},
            {"timecode": {"start": 1.28, "end": 3.52}},
            {"timecode": {"start": 3.52, "end": 6.48}},
            {"timecode": {"start": 6.48, "end": 11.32}},
            {"timecode": {"start": 11.32, "end": 15.52}},
            {"timecode": {"start": 15.52, "end": 17.24}},
            {"timecode": {"start": 17.24, "end": 19.92}},
            {"timecode": {"start": 19.92, "end": 21.08}},
            {"timecode": {"start": 21.08, "end": 23.36}},
            {"timecode": {"start": 23.36, "end": 38.48}},
        ]
        self.assertEqual(_opening_preface_boundary(hooks, shots, 120), 23.36)

    def test_complete_external_opening_is_the_hook_conclusion(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "完整外搭片段", "start": 0, "end": 23.36}]}
        shots = [{"timecode": {"start": 0, "end": 8}}, {"timecode": {"start": 8, "end": 23.36}}, {"timecode": {"start": 23.36, "end": 120}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(len(result["hooks"]), 1)
        self.assertEqual(result["hooks"][0]["start"], 0)
        self.assertEqual(result["hooks"][0]["end"], 23.36)
        self.assertEqual(result["hooks"][0]["verification"], "needs_review")

    def test_suspected_external_without_complete_boundary_is_downgraded(self):
        result = _downgrade_unsupported_external_hook({"creative": {"hookSourceStatus": {"value": "疑似外搭"}, "hooks": [{"start": 0, "end": 8}]}, "review": {"status": "ready", "reasons": []}})
        self.assertEqual(result["creative"]["hookSourceStatus"]["value"], "来源未知")
        self.assertTrue(result["review"]["reviewRequired"])

    def test_story_quality_gate_is_generic_and_requires_causal_understanding(self):
        phases = [{"start": index * 120, "end": (index + 1) * 120, "label": f"阶段{index}", "description": "事件发生并改变局势"} for index in range(5)]
        result = {"content": {"summary": {"value": "甲和乙围绕爱情、家庭与事业展开一系列故事。"}, "characters": [{"name": "甲"}, {"name": "乙"}], "relationships": [{"subject": "甲", "object": "乙"}, {"subject": "甲", "object": "丙"}], "segments": phases}, "creative": {"timeline": []}}
        issues = _material_story_quality_issues(result, 600) + _material_story_consistency_issues(result, 600, "")
        self.assertTrue(any("概括" in issue for issue in issues))
        self.assertTrue(any("动机" in issue for issue in issues))
        self.assertTrue(any("因果" in issue for issue in issues))
        self.assertFalse(any("林绵" in issue or "秦总" in issue for issue in issues))

    def test_story_quality_gate_rejects_technical_themes_and_placeholder_phases(self):
        result = {"content": {
            "summary": {"value": "为了改变贫困生活，女主试图隐藏语言能力，却因公司加薪机会不得不作出选择，因此身份开始暴露。随后同事产生怀疑，关系逐渐紧张，直到片尾仍停在是否公开真实能力的悬念上。"},
            "genres": [{"label": "职场逆袭"}],
            "themes": [{"label": "语音识别置信度低"}, {"label": "对话驱动"}],
            "characters": [{"name": "女主"}, {"name": "上司"}],
            "relationships": [{"subject": "女主", "object": "上司"}, {"subject": "女主", "object": "同事"}],
            "conflicts": [{"label": "隐藏身份与改变命运"}],
            "segments": [{"start": index * 120, "end": (index + 1) * 120, "label": "核心叙事段落" if index == 2 else f"阶段{index}", "description": "人物为目标行动，遭遇阻碍并改变关系"} for index in range(5)],
        }, "creative": {"timeline": []}}
        issues = _material_story_quality_issues(result, 600)
        self.assertTrue(any("技术元数据" in issue for issue in issues))
        self.assertTrue(any("技术占位名称" in issue for issue in issues))

    @patch.dict("os.environ", {"LUMINA_MATERIAL_MAX_EVIDENCE_FRAMES": "24"})
    def test_material_frames_reserve_coverage_for_the_middle(self):
        shots = [{"timecode": {"start": value, "end": value + 1}} for value in range(0, 1500, 2)]
        timestamps = _material_evidence_timestamps(1500, shots, [])
        self.assertLessEqual(len(timestamps), 24)
        self.assertTrue(any(300 < value < 1200 for value in timestamps))
        self.assertTrue(any(value <= 60 for value in timestamps))
        self.assertTrue(any(value >= 1470 for value in timestamps))

    def test_material_format_v1_keeps_same_drama_hook_as_episode_splice(self):
        verified = lambda label: {"label": label, "confidence": .9, "evidence": [], "verification": "verified"}
        creative, review = _normalize_material_format({"bodyFormat": verified("正片主导"), "hookSourceStatus": verified("已确认同剧")}, {"status": "ready", "reasons": []})
        self.assertEqual(creative["format"]["label"], "正片剧集拼接")
        self.assertFalse(review["reviewRequired"])

    def test_same_drama_preface_is_external_assembly_not_plain_episode_splice(self):
        verified = lambda label: {"label": label, "confidence": .9, "evidence": [], "verification": "verified"}
        creative, _review = _normalize_material_format({"bodyFormat": verified("正片主导"), "hookSourceStatus": verified("已确认同剧"), "hookAssemblyType": verified("同剧外搭")}, {"status": "ready", "reasons": []})
        self.assertEqual(creative["format"]["label"], "外搭钩子＋本剧正片")

    def test_material_format_v1_flags_suspected_external_for_review(self):
        verified = lambda label: {"label": label, "confidence": .8, "evidence": [], "verification": "verified"}
        creative, review = _normalize_material_format({"bodyFormat": verified("解说主导"), "hookSourceStatus": verified("疑似外搭")}, {"status": "ready", "reasons": []})
        self.assertEqual(creative["format"]["label"], "外搭钩子＋本剧正片")
        self.assertTrue(review["reviewRequired"])
        self.assertEqual(review["status"], "needs_review")

    def test_material_format_v1_merges_confirmed_external_formats(self):
        verified = lambda label: {"label": label, "confidence": .95, "evidence": [], "verification": "verified"}
        creative, _review = _normalize_material_format({"bodyFormat": verified("解说主导"), "hookSourceStatus": verified("已确认外搭")}, {"status": "ready"})
        self.assertEqual(creative["format"]["label"], "外搭钩子＋本剧正片")

    def test_external_hook_can_reuse_original_cast_in_newly_produced_shots(self):
        verified = lambda label: {"label": label, "confidence": .95, "evidence": [], "verification": "verified"}
        creative, _review = _normalize_material_format({
            "bodyFormat": verified("正片主导"),
            "hookSourceStatus": verified("已确认外搭"),
            "externalHookSubtype": verified("复用原剧人物资产但镜头为新生成/新制作"),
        }, {"status": "ready"})
        self.assertEqual(creative["format"]["label"], "外搭钩子＋本剧正片")
        self.assertEqual(creative["externalHookSubtype"]["code"], "REUSED_CAST_NEW_PRODUCTION")

    def test_external_hook_subtype_defaults_to_review_when_lineage_is_missing(self):
        verified = lambda label: {"label": label, "confidence": .8, "evidence": [], "verification": "verified"}
        creative, _review = _normalize_material_format({
            "bodyFormat": verified("正片主导"),
            "hookSourceStatus": verified("疑似外搭"),
        }, {"status": "ready", "reasons": []})
        self.assertEqual(creative["externalHookSubtype"]["code"], "UNKNOWN_REVIEW")

    def test_phrase_breaks_on_speaker_and_silence(self):
        words = [
            {"text": "Hello", "start": 0.0, "end": 0.4, "type": "word", "speaker_id": "speaker_0"},
            {"text": "world", "start": 0.45, "end": 0.8, "type": "word", "speaker_id": "speaker_0"},
            {"text": "Wait", "start": 0.85, "end": 1.1, "type": "word", "speaker_id": "speaker_1"},
            {"text": "What", "start": 2.0, "end": 2.2, "type": "word", "speaker_id": "speaker_1"},
        ]
        phrases = group_phrases(words)
        self.assertEqual([p["text"] for p in phrases], ["Hello world", "Wait", "What"])

    def test_cache_uses_source_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "episode.mp4"
            source.write_bytes(b"video-v1")
            output = root / "episode.json"
            output.write_text(json.dumps({"_lumina": {"source_fingerprint": source_fingerprint(source)}}))
            self.assertTrue(is_cache_valid(source, output))
            source.write_bytes(b"video-v2")
            self.assertFalse(is_cache_valid(source, output))

    def test_packed_output_keeps_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            edit = Path(tmp)
            (edit / "transcripts").mkdir()
            payload = {"words": [{"text": "Stop", "start": 1.25, "end": 1.7, "type": "word", "speaker_id": "speaker_2"}], "_lumina": {"source": "/drama/e01.mp4"}}
            (edit / "transcripts" / "e01.json").write_text(json.dumps(payload))
            packed = pack_transcripts(edit)
            text = packed.read_text(encoding="utf-8")
            self.assertIn("[00001.25-00001.70] S2 Stop", text)

    def test_only_free_episodes_are_selected_per_drama(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for drama in ["Drama A", "Drama B"]:
                folder = root / drama
                folder.mkdir()
                for episode in [1, 2, 10, 3]:
                    (folder / f"EP{episode}.mp4").write_bytes(b"x")
            selected, excluded, manifest = select_free_episodes(list(root.rglob("*.mp4")), root, 2)
            self.assertEqual(len(selected), 4)
            self.assertEqual(len(excluded), 4)
            self.assertEqual([Path(p).name for p in manifest["Drama A"]], ["EP1.mp4", "EP2.mp4"])

    def test_evidence_rejects_invalid_confidence_and_timecode(self):
        with self.assertRaises(ValueError):
            Evidence("transcript", Timecode(0, 1), 1.2, "episode.mp4")
        with self.assertRaises(ValueError):
            Timecode(4, 2)

    def test_semantic_claim_without_evidence_is_unverified(self):
        result = _validate_semantic_claims({"summary": {"value": "A claim", "confidence": 0.9, "evidence": []}}, 10)
        self.assertEqual(result["summary"]["verification"], "unverified")

    def test_semantic_claim_with_in_range_evidence_is_verified(self):
        claim = {"value": "Observed line", "confidence": 0.8, "evidence": [{"timecode": {"start": 1.0, "end": 2.0}, "source": "transcript", "confidence": 0.9}]}
        result = _validate_semantic_claims(claim, 10)
        self.assertEqual(result["verification"], "verified")

    def test_out_of_range_evidence_is_unverified(self):
        claim = {"value": "Impossible", "confidence": 0.7, "evidence": [{"timecode": {"start": 9.0, "end": 12.0}, "source": "frame", "confidence": 0.8}]}
        result = _validate_semantic_claims(claim, 10)
        self.assertEqual(result["verification"], "unverified")

    def test_failure_envelope_contains_no_result(self):
        envelope = failed_envelope("coarse", {"episode": 1}, AnalysisFailed("model missing"))
        self.assertEqual(envelope.status, "failed")
        self.assertIsNone(envelope.result)
        self.assertEqual(envelope.error["message"], "model missing")

    def test_semantic_provider_never_falls_back_to_fake_data(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(AnalysisFailed, "LUMINA_SEMANTIC_ENDPOINT"):
                _semantic_request("detail-drama-analysis", {})

    def test_openai_responses_adapter_keeps_multimodal_timecode(self):
        body = _openai_request_body("openai-responses", "model", "precision-highlight-analysis", {"frames": [{"episode": 2, "timecode": {"start": 1, "end": 1}, "mimeType": "image/jpeg", "base64": "YWJj"}]})
        content = body["input"][0]["content"]
        self.assertEqual(content[-1]["type"], "input_image")
        self.assertIn('"episode": 2', content[-2]["text"])

    def test_openai_chat_completions_adapter_and_result(self):
        body = _openai_request_body("openai-chat-completions", "model", "detail-drama-analysis", {})
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertTrue(body["stream"])
        self.assertEqual(body["stream_options"], {"include_usage": True})
        result = _extract_provider_result("openai-chat-completions", {"choices": [{"message": {"content": '{"precisionCandidates": []}'}}]})
        self.assertEqual(result, {"precisionCandidates": []})

    def test_detail_prompt_requires_highlight_candidates_even_when_empty(self):
        body = _openai_request_body("openai-chat-completions", "model", "detail-drama-analysis", {"episodes": []})
        prompt = body["messages"][1]["content"][0]["text"]
        self.assertIn("highlightCandidates must be []", prompt)
        self.assertIn("requiredOutputContract", prompt)

    def test_openai_chat_stream_merges_sse_json_fragments(self):
        stream = [
            b'data: {"choices":[{"delta":{"content":"{\\"summary\\":"}}]}\n',
            b'data: {"choices":[{"delta":{"content":"{}}"}}]}\n',
            b'data: {"choices":[],"usage":{"total_tokens":12}}\n',
            b'data: [DONE]\n',
        ]
        self.assertEqual(_extract_chat_stream(stream), {"summary": {}})

    def test_openai_chat_stream_accepts_fenced_json(self):
        stream = [
            b'data: {"choices":[{"delta":{"content":"```json\\n{\\"summary\\":{}}\\n```"},"finish_reason":"stop"}]}\n',
            b'data: [DONE]\n',
        ]
        self.assertEqual(_extract_chat_stream(stream), {"summary": {}})

    def test_material_prompt_requires_field_level_output_contract(self):
        body = _openai_request_body("openai-chat-completions", "qwen-vl-max", "paid-ad-material-analysis-merge", {"segmentAnalyses": []})
        prompt = body["messages"][1]["content"][0]["text"]
        contract = json.loads(prompt)["requiredOutputContract"]
        self.assertIn("content", contract)
        self.assertIn("creative", contract)
        self.assertIn("value", contract)
        self.assertIn("review", contract)
        rules = " ".join(json.loads(prompt)["outputRules"])
        self.assertIn("concrete observable fact", rules)
        self.assertIn("technical metadata, not semantic evidence", rules)
        self.assertIn("four strictly separated layers", rules)
        self.assertIn("observations", contract["content"])
        self.assertIn("inferences", contract["content"])

    def test_short_material_prompt_is_compact_and_output_bounded(self):
        body = _openai_request_body("openai-chat-completions", "qwen-vl-max", "paid-ad-material-analysis", {"durationSeconds": 34.5, "transcript": [], "ocr": []})
        prompt = json.loads(body["messages"][1]["content"][0]["text"])
        rules = " ".join(prompt["outputRules"])
        self.assertIn("below 8000 Chinese characters", rules)
        self.assertIn("at most 8 observations", rules)
        self.assertIn("at most 1 strongest evidence item per claim", rules)
        self.assertEqual(body["max_tokens"], 12000)

    @patch("processor.semantic_analysis._semantic_request", return_value=copy.deepcopy(MATERIAL_CONTRACT))
    def test_short_material_uses_compact_segment_contract(self, semantic_mock):
        result = _material_semantic_analysis({"frames": [], "transcript": [], "ocr": [], "requirements": []}, 34.5, lambda *_: None)
        self.assertTrue(_material_output_contract_valid(result))
        self.assertEqual(semantic_mock.call_count, 1)
        self.assertEqual(semantic_mock.call_args.args[0], "paid-ad-material-segment-analysis")
        self.assertEqual(semantic_mock.call_args.args[1]["segment"], {"start": 0.0, "end": 34.5})

    @patch("processor.semantic_analysis._semantic_request", return_value=copy.deepcopy(MATERIAL_CONTRACT))
    def test_short_material_reuses_provider_result_cache(self, semantic_mock):
        payload = {"frames": [], "transcript": [], "ocr": [], "requirements": []}
        with tempfile.TemporaryDirectory() as temporary:
            cache_dir = Path(temporary)
            first = _material_semantic_analysis(payload, 34.5, lambda *_: None, cache_dir)
            second = _material_semantic_analysis(payload, 34.5, lambda *_: None, cache_dir)
            self.assertTrue((cache_dir / "semantic-short-v1.json").exists())
        self.assertTrue(_material_output_contract_valid(first))
        self.assertEqual(first, second)
        self.assertEqual(semantic_mock.call_count, 1)

    def test_material_contract_rejects_single_summary_claim(self):
        self.assertFalse(_material_output_contract_valid({"value": "summary", "confidence": 0.9, "evidence": []}))
        empty_summary = copy.deepcopy(MATERIAL_CONTRACT)
        empty_summary["content"]["summary"] = {"value": "", "confidence": 0.9, "evidence": []}
        self.assertFalse(_material_output_contract_valid(empty_summary))
        self.assertTrue(_material_output_contract_valid(MATERIAL_CONTRACT))

    def test_material_story_gate_rejects_hollow_evidence_copy(self):
        result = {
            "content": {"summary": {"value": "由于主角急需钱，她选择冒险，随后遭到控制，因此开始反抗，但关系继续恶化，直到最终在结尾面对新的生命威胁。" * 3}, "characters": [{}, {}], "relationships": [{}, {}], "segments": [], "tags": [{"evidence": [{"text": "检测到关键画面，回看片段确认剧情"}]}]},
            "creative": {"timeline": [{"start": 0, "end": 20}, {"start": 20, "end": 50}, {"start": 50, "end": 80}, {"start": 80, "end": 100}]},
            "value": {},
        }
        issues = _material_story_quality_issues(result, 100)
        self.assertTrue(any("操作提示" in issue for issue in issues))

    def test_material_merge_redacts_explicit_text_but_keeps_timecode(self):
        source = {"value": "explicit sexual scene", "sourceText": "verbatim", "evidence": [{"timecode": {"start": 1, "end": 2}}]}
        cleaned = _sanitize_material_provider_input(source)
        self.assertNotIn("sourceText", cleaned)
        self.assertNotIn("sexual", cleaned["value"])
        self.assertEqual(cleaned["evidence"][0]["timecode"], {"start": 1, "end": 2})

    def test_strict_safety_redaction_keeps_geometry_and_removes_free_prose(self):
        cleaned = _strict_safety_provider_input({"summary": "arbitrary unsafe narrative", "source": "transcript", "timecode": {"start": 1, "end": 2}})
        self.assertEqual(cleaned["summary"], "内容已严格脱敏，需人工复核")
        self.assertEqual(cleaned["source"], "transcript")
        self.assertEqual(cleaned["timecode"], {"start": 1, "end": 2})

    @patch("processor.semantic_analysis.urllib.request.urlopen")
    def test_dashscope_api_key_is_accepted_for_qwen(self, urlopen_mock):
        response = urlopen_mock.return_value.__enter__.return_value
        response.__iter__.return_value = iter([
            b'data: {"choices":[{"delta":{"content":"{\\"summary\\":{}}"}}]}\n',
            b'data: [DONE]\n',
        ])
        with patch.dict("os.environ", {
            "DASHSCOPE_API_KEY": "local-test-key",
            "LUMINA_SEMANTIC_ENDPOINT": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "LUMINA_SEMANTIC_MODEL": "qwen3-vl-plus",
            "LUMINA_SEMANTIC_PROVIDER": "openai-chat-completions",
        }, clear=True):
            self.assertEqual(_semantic_request("coarse-episode-analysis", {}), {"summary": {}})
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(request.headers["Authorization"], "Bearer local-test-key")
        request_body = json.loads(request.data)
        self.assertTrue(request_body["stream"])
        self.assertFalse(request_body["enable_thinking"])

    @patch("processor.semantic_analysis.time.sleep", return_value=None)
    @patch("processor.semantic_analysis.urllib.request.urlopen")
    def test_stream_truncation_retries_only_current_request_and_counts_attempts(self, urlopen_mock, _sleep_mock):
        partial_context = MagicMock()
        partial_context.__enter__.return_value.__iter__.return_value = iter([
            b'data: {"choices":[{"delta":{"content":"{\\"summary\\":"},"finish_reason":"length"}]}\n',
            b'data: [DONE]\n',
        ])
        complete_context = MagicMock()
        complete_context.__enter__.return_value.__iter__.return_value = iter([
            b'data: {"choices":[{"delta":{"content":"{\\"summary\\":{}}"},"finish_reason":"stop"}]}\n',
            b'data: [DONE]\n',
        ])
        urlopen_mock.side_effect = [partial_context, complete_context]
        diagnostics = {}
        with patch.dict("os.environ", {
            "DASHSCOPE_API_KEY": "local-test-key",
            "LUMINA_SEMANTIC_ENDPOINT": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "LUMINA_SEMANTIC_MODEL": "qwen-vl-max",
            "LUMINA_SEMANTIC_PROVIDER": "openai-chat-completions",
            "LUMINA_SEMANTIC_REQUEST_ATTEMPTS": "2",
        }, clear=True):
            result = _semantic_request("detail-drama-analysis", {"episodes": []}, diagnostics=diagnostics)
        self.assertEqual(result, {"summary": {}})
        self.assertEqual(urlopen_mock.call_count, 2)
        self.assertEqual(diagnostics["requestCount"], 2)
        self.assertEqual(diagnostics["model"], "qwen-vl-max")
        self.assertGreaterEqual(diagnostics["wallClockSeconds"], 0)

    @patch("processor.semantic_analysis.urllib.request.urlopen")
    def test_dashscope_content_inspection_retries_with_sanitized_evidence(self, urlopen_mock):
        blocked = urllib.error.HTTPError("https://dashscope", 400, "bad request", {}, io.BytesIO(b'{"error":{"code":"data_inspection_failed"}}'))
        retry_context = MagicMock()
        retry_response = retry_context.__enter__.return_value
        retry_response.__iter__.return_value = iter([
            b'data: {"choices":[{"delta":{"content":"{\\"content\\":{},\\"review\\":{}}"}}]}\n',
            b'data: [DONE]\n',
        ])
        urlopen_mock.side_effect = [blocked, retry_context]
        with patch.dict("os.environ", {
            "DASHSCOPE_API_KEY": "local-test-key",
            "LUMINA_SEMANTIC_ENDPOINT": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "LUMINA_SEMANTIC_MODEL": "qwen3-vl-plus",
            "LUMINA_SEMANTIC_PROVIDER": "openai-chat-completions",
        }, clear=True):
            result = _semantic_request("paid-ad-material-analysis", {"transcript": [{"text": "explicit sexual scene", "start": 1, "end": 2}], "frames": [{"base64": "secret-image"}]})
        self.assertTrue(result["_providerSafetySanitized"])
        self.assertTrue(result["review"]["reviewRequired"])
        retry_body = urlopen_mock.call_args_list[1].args[0].data.decode("utf-8")
        self.assertNotIn("explicit sexual scene", retry_body)
        self.assertNotIn("secret-image", retry_body)

    def test_detail_evidence_requires_episode_and_uses_its_duration(self):
        durations = {1: 5.0, 2: 20.0}
        missing_episode = {"value": "claim", "confidence": .8, "evidence": [{"source": "transcript", "confidence": .9, "timecode": {"start": 1, "end": 2}}]}
        self.assertEqual(_validate_semantic_claims(missing_episode, durations)["verification"], "unverified")
        episode_two = {"value": "claim", "confidence": .8, "evidence": [{"episode": 2, "source": "transcript", "confidence": .9, "timecode": {"start": 10, "end": 12}}]}
        self.assertEqual(_validate_semantic_claims(episode_two, durations)["verification"], "verified")

    def test_detail_precision_candidates_exclude_invalid_or_unverified_ranges(self):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .9, "timecode": {"start": 1, "end": 2}}]
        candidates = _precision_candidates([
            {"episode": 1, "start": 1, "end": 3, "confidence": .8, "evidence": evidence},
            {"episode": 1, "start": 8, "end": 12, "confidence": .9, "evidence": evidence},
            {"episode": 2, "start": 1, "end": 2, "confidence": .9, "evidence": evidence},
        ], {1: 10})
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["episode"], 1)

    def test_detail_frames_are_evenly_bounded_by_count_and_encoded_size(self):
        frames = [{"episode": 1, "timecode": index, "base64": "x" * 10_000} for index in range(12)]
        bounded = _bounded_detail_frames(frames, 8, 35_000)
        self.assertLessEqual(len(bounded), 8)
        self.assertLessEqual(sum(len(item["base64"]) for item in bounded), 35_000)
        self.assertEqual(bounded[0]["timecode"], 0)
        self.assertEqual(bounded[-1]["timecode"], 11)

    def test_detail_motion_selector_preserves_endpoints_and_motion_burst(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(27):
                shade = 240 if index == 14 else 10
                path = Path(directory) / f"{index}.jpg"
                Image.new("RGB", (64, 64), (shade, shade, shade)).save(path)
                frames.append({"path": str(path), "timecode": index * 3})
            selected = _select_detail_evidence_frames(frames, 8)
        times = [item["timecode"] for item in selected]
        self.assertEqual(times[0], 0)
        self.assertEqual(times[-1], 78)
        self.assertTrue({39, 42, 45}.issubset(set(times)))

    def test_drama_claim_safety_rejects_negation_reversal_and_weak_kinship(self):
        negated = {"description": "Alpha怀疑Tiffany", "evidence": [{"sourceText": "No. Not Tiffany."}]}
        self.assertIn("否定极性", _drama_claim_safety_issue(negated))
        kinship = {"description": "Arya是Killen的母亲", "evidence": [{"sourceText": "She's his mother. Killen hadn't..."}]}
        self.assertIn("血缘", _drama_claim_safety_issue(kinship))

    def test_no_audio_relationships_and_frame_only_characters_are_not_published(self):
        semantic = {
            "characters": [{"name": "守护者", "episodes": [2], "verification": "verified", "evidence": [{"episode": 2, "source": "frame", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
            "relationships": [{"character1": "Amelia", "character2": "婴儿", "type": "母子", "episodes": [2], "verification": "verified", "evidence": [{"episode": 2, "source": "frame", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
        }
        result = _sanitize_drama_detail_semantics(semantic, [{"episode": 2, "transcript": []}])
        self.assertEqual(result["characters"], [])
        self.assertEqual(result["relationships"], [])
        self.assertEqual(len(result["characterCandidates"]), 1)
        self.assertEqual(len(result["relationshipCandidates"]), 1)
        self.assertTrue(result["reviewRequired"])

    def test_episode_plot_rejects_cross_episode_evidence(self):
        local = {"description": "local", "evidence": [{"episode": 9, "source": "transcript"}]}
        foreign = {"description": "foreign", "evidence": [{"episode": 10, "source": "transcript"}]}
        mixed = {"description": "mixed", "evidence": [{"episode": 9}, {"episode": 10}]}
        self.assertEqual(_episode_owned_core_facts([local, foreign, mixed], 9), [local])

    def test_detail_precision_candidates_deduplicate_overlap_without_confidence_ranking(self):
        def candidate(episode, confidence):
            start = confidence * 5
            evidence = [{"episode": episode, "source": "transcript", "confidence": .9, "timecode": {"start": start, "end": start + 1}}]
            return {"episode": episode, "start": start, "end": start + 2, "confidence": confidence, "evidence": evidence}

        candidates = _precision_candidates(
            [candidate(1, confidence) for confidence in (.4, .9, .6, .8, .5, .7)] + [candidate(2, .75)],
            {1: 10, 2: 10},
        )
        self.assertEqual([item["episode"] for item in candidates], [1, 2])
        self.assertEqual([item["confidence"] for item in candidates], [.4, .75])
        self.assertFalse(candidates[0]["precisionEligible"])

    def test_detail_candidate_enters_precision_before_dense_quality_scoring(self):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .95, "timecode": {"start": 10, "end": 12}}]
        candidate = {"episode": 1, "start": 8, "end": 25, "confidence": .9, "audienceQuestion": "她为何隐瞒身份？", "narrativePromise": "后续将揭示真实身份。", "evidence": evidence}
        result = _precision_candidates([candidate], {1: 40})
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["precisionEligible"])
        self.assertTrue(result[0]["precisionDiscoveryGate"]["passed"])
        self.assertFalse(result[0]["scoreContractComplete"])
        self.assertTrue(result[0]["reviewRequired"])

    def test_detail_precision_candidates_expand_fragments_to_twelve_seconds(self):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .9, "timecode": {"start": 21, "end": 23}}]
        candidates = _precision_candidates([{"episode": 1, "start": 21, "end": 23, "confidence": .9, "evidence": evidence}], {1: 100})
        self.assertEqual(candidates[0]["end"] - candidates[0]["start"], 12)
        self.assertEqual(candidates[0]["eventInterval"], {"start": 21.0, "end": 23.0})
        self.assertEqual(candidates[0]["precisionInterval"], {"start": 16.0, "end": 28.0})

    def test_precision_frames_obey_count_size_and_endpoint_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(121):
                path = Path(directory) / f"{index}.jpg"
                Image.new("RGB", (640, 360), (index % 255, (index * 3) % 255, (index * 7) % 255)).save(path)
                frames.append({"path": str(path), "timecode": index / 2, "episode": 1})
            selected = _select_precision_evidence_frames(frames, 16)
            with patch.dict("os.environ", {"LUMINA_PRECISION_MAX_FRAMES": "16", "LUMINA_PRECISION_MAX_BASE64_CHARS": "240000"}):
                bounded = _bounded_precision_frames(frames)
        self.assertLessEqual(len(selected), 16)
        self.assertEqual((selected[0]["timecode"], selected[-1]["timecode"]), (0, 60))
        self.assertLessEqual(len(bounded), 16)
        self.assertLessEqual(sum(len(item["base64"]) for item in bounded), 240000)
        self.assertEqual((bounded[0]["timecode"], bounded[-1]["timecode"]), (0, 60))

    def test_detail_recall_probes_enqueue_motion_and_uncovered_ending_without_claiming_highlight(self):
        frames = [
            {"episode": 8, "timecode": 42, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
            {"episode": 8, "timecode": 45, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
            {"episode": 8, "timecode": 48, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
            {"episode": 8, "timecode": 72, "selectionReason": "endpoint_context"},
            {"episode": 8, "timecode": 75, "selectionReason": "endpoint_context"},
            {"episode": 8, "timecode": 78, "selectionReason": "endpoint"},
        ]
        probes = _detail_recall_probes(frames, {8: 80}, [])
        self.assertEqual({item["candidateKind"] for item in probes}, {"motion_recall_probe", "ending_recall_probe"})
        self.assertTrue(all(item["precisionEligible"] and item["reviewRequired"] for item in probes))
        self.assertTrue(all(not item["qualityGate"]["passed"] for item in probes))
        self.assertGreaterEqual(probes[1]["eventInterval"]["end"], 79)

    def test_detail_recall_probes_accept_worker_timecode_objects(self):
        frames = [
            {"episode": 4, "timecode": {"start": 27, "end": 27}, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
            {"episode": 4, "timecode": {"start": 30, "end": 30}, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
            {"episode": 4, "timecode": {"start": 33, "end": 33}, "selectionReason": "motion_burst", "sequenceId": "motion-1"},
        ]
        probes = _detail_recall_probes(frames, {4: 100}, [])
        self.assertEqual(len(probes), 1)
        self.assertEqual(probes[0]["eventInterval"], {"start": 25.5, "end": 34.5})

    def test_detail_motion_recall_intervals_cover_each_timeline_quartile(self):
        with tempfile.TemporaryDirectory() as directory:
            frames = []
            for index in range(40):
                shade = (index * 29) % 255
                path = Path(directory) / f"{index}.jpg"
                Image.new("RGB", (64, 64), (shade, shade, shade)).save(path)
                frames.append({"path": str(path), "timecode": {"start": index * 3, "end": index * 3}})
            intervals = _detail_motion_recall_intervals(frames, 4)
        self.assertEqual([item["quartile"] for item in intervals], [1, 2, 3, 4])
        self.assertTrue(all(item["episode"] == 4 for item in intervals))
        centers = [(item["eventInterval"]["start"] + item["eventInterval"]["end"]) / 2 for item in intervals]
        self.assertTrue(all(index * 30 - 15 <= center <= (index + 1) * 30 + 15 for index, center in enumerate(centers)))

    def test_precision_hooks_expand_and_require_boundary_review(self):
        hooks = _normalize_precision_hooks([{"start": 21, "end": 23, "evidence": [{"source": "transcript"}]}], 18, 30)
        self.assertEqual((hooks[0]["start"], hooks[0]["end"]), (18, 28))
        self.assertEqual(hooks[0]["safeEnd"]["status"], "unverified")

    @patch("processor.semantic_analysis._semantic_request")
    def test_detail_result_matches_pocketbase_precision_contract(self, semantic_request):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .9, "timecode": {"start": 1, "end": 2}}]
        semantic_request.return_value = {"highlightCandidates": [{"episode": 1, "start": 1, "end": 3, "confidence": .8, "evidence": evidence}]}
        coarse = AnalysisEnvelope("1.0.0", "coarse-1", "coarse", "succeeded", {"episode": 1, "durationSeconds": 10}, {}, {"episode": 1, "durationSeconds": 10, "transcript": [], "ocr": []})
        with patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"}):
            detail = analyze_detail([coarse])
        self.assertEqual(detail.result["highlightCandidates"], detail.result["precisionCandidates"])
        self.assertEqual(detail.result["highlightCandidates"][0]["verification"], "verified")

    @patch("processor.semantic_analysis._semantic_request")
    def test_detail_repairs_missing_candidates_to_explicit_empty_array(self, semantic_request):
        semantic_request.side_effect = [
            {"characters": [], "relationships": [], "episodePlots": [], "emotionCurve": []},
            {"highlightCandidates": []},
            {"highlightCandidates": []},
        ]
        coarse = AnalysisEnvelope("1.0.0", "coarse-1", "coarse", "succeeded", {"episode": 1, "durationSeconds": 10}, {}, {"episode": 1, "durationSeconds": 10, "transcript": [], "ocr": []})
        with patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model"}):
            detail = analyze_detail([coarse])
        self.assertEqual(detail.result["highlightCandidates"], [])
        self.assertEqual(detail.result["precisionCandidates"], [])
        self.assertEqual(semantic_request.call_count, 2)

    def test_detail_episode_checkpoint_reuses_success_and_records_diagnostics(self):
        provider_result = {
            "characters": [], "relationships": [], "episodePlots": [{"episode": 1, "summary": "", "coreEvents": [], "relationshipChanges": [], "emotionSignals": [], "foreshadowing": []}],
            "emotionCurve": [], "contentTags": [], "highlightCandidates": [],
        }
        coarse = AnalysisEnvelope("1.0.0", "coarse-1", "coarse", "succeeded", {"episode": 1, "durationSeconds": 10}, {}, {"episode": 1, "durationSeconds": 10, "transcript": [], "ocr": []})

        def semantic_result(_task, _payload, *_args, **kwargs):
            diagnostics = kwargs["diagnostics"]
            diagnostics["requestCount"] += 1
            diagnostics["wallClockSeconds"] += 0.012
            return copy.deepcopy(provider_result)

        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "qwen-vl-max"}):
            cache_dir = Path(directory) / "analysis-cache"
            with patch("processor.semantic_analysis._semantic_request", side_effect=semantic_result) as first_request:
                first = analyze_detail([coarse], cache_dir=cache_dir)
            with patch("processor.semantic_analysis._semantic_request", side_effect=AssertionError("episode provider must be cached")):
                second = analyze_detail([coarse], cache_dir=cache_dir)

            self.assertEqual(first_request.call_count, 1)
            first_chunk = first.result["diagnostics"]["detailCheckpoints"]["chunks"][0]
            second_chunk = second.result["diagnostics"]["detailCheckpoints"]["chunks"][0]
            self.assertFalse(first_chunk["cacheHit"])
            self.assertEqual(first_chunk["requestCount"], 1)
            self.assertEqual(first_chunk["model"], "qwen-vl-max")
            self.assertTrue(second_chunk["cacheHit"])
            self.assertEqual(second_chunk["requestCount"], 0)
            checkpoint_files = list(cache_dir.glob("drama-detail/by-content-hash/*/qwen-vl-max/drama-detail-checkpoint-v1-20260831/*.json"))
            self.assertEqual(len(checkpoint_files), 1)

    def test_detail_reconciliation_consumes_episode_checkpoints_not_raw_media(self):
        coarse = [
            AnalysisEnvelope("1.0.0", f"coarse-{episode}", "coarse", "succeeded", {"episode": episode, "durationSeconds": 10}, {}, {"episode": episode, "durationSeconds": 10, "transcript": [{"start": 1, "end": 2, "text": f"line {episode}"}], "ocr": []})
            for episode in (1, 2)
        ]
        reconciliation_payloads = []

        def semantic_result(task, payload, *_args, **kwargs):
            diagnostics = kwargs.get("diagnostics")
            if diagnostics is not None:
                diagnostics["requestCount"] += 1
            if task == "detail-drama-analysis":
                episode = payload["episodes"][0]["episode"]
                return {"characters": [], "relationships": [], "episodePlots": [{"episode": episode, "summary": "", "coreEvents": [], "relationshipChanges": [], "emotionSignals": [], "foreshadowing": []}], "emotionCurve": [], "contentTags": [], "highlightCandidates": []}
            if task == "reconcile-drama-storyline":
                reconciliation_payloads.append(payload)
                return {"characters": [], "relationships": [], "emotionCurve": [], "contentTags": []}
            if task == "ground-drama-episode":
                episode = payload["episode"]["episode"]
                return {"episodePlot": {"episode": episode, "summary": "", "coreFacts": [], "evidence": []}}
            if task == "synthesize-drama-overview":
                return {"storyOverview": {"summary": ""}}
            raise AssertionError(task)

        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "qwen-vl-max"}), patch("processor.semantic_analysis._semantic_request", side_effect=semantic_result):
            analyze_detail(coarse, visual_frames=[{"episode": 1, "timecode": {"start": 1, "end": 1}, "base64": "YWJj"}], cache_dir=Path(directory))
        self.assertEqual(len(reconciliation_payloads), 1)
        payload = reconciliation_payloads[0]
        self.assertEqual(len(payload["episodeCheckpoints"]), 2)
        self.assertNotIn("episodes", payload)
        self.assertNotIn("frames", payload)
        self.assertNotIn("episodeBoundaryAnchors", payload)

    @patch("processor.semantic_analysis._semantic_request")
    def test_checkpoint_only_reconcile_uses_max_and_records_per_phase_cost(self, semantic_request):
        def response(task, payload, *_args, **kwargs):
            diagnostics = kwargs.get("diagnostics")
            if diagnostics is not None:
                diagnostics["model"] = "qwen-vl-max"; diagnostics["requestCount"] += 1
            if task == "reconcile-drama-storyline":
                self.assertIn("episodeCheckpoints", payload); self.assertNotIn("frames", payload)
                return {"characters": [], "relationships": [], "emotionCurve": [], "contentTags": []}
            if task == "ground-drama-episode":
                self.assertIn("episodeCheckpoint", payload); self.assertNotIn("transcript", payload)
                episode = payload["episodeCheckpoint"]["episode"]
                return {"episodePlot": {"episode": episode, "summary": f"episode {episode}", "coreEvents": [], "evidence": []}}
            if task == "synthesize-drama-overview":
                return {"storyOverview": {"summary": "overview"}}
            raise AssertionError(task)
        semantic_request.side_effect = response
        checkpoints = []
        for episode in (1, 2):
            checkpoints.append({"episode_number": episode, "result": {"tier": "detail", "status": "succeeded", "source": {"episodes": [episode]}, "checkpoint": {"episode": episode, "durationSeconds": 20}, "result": {"characters": [], "relationships": [], "episodePlots": [{"episode": episode, "summary": "", "coreEvents": []}], "emotionCurve": [], "contentTags": [], "highlightCandidates": []}}})
        with patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "qwen-vl-max", "LUMINA_SEMANTIC_RECALL_MODEL": "qwen3-vl-flash"}):
            result = analyze_detail_reconcile(checkpoints)
        diagnostics = result.result["diagnostics"]["detailReconcile"]
        self.assertTrue(diagnostics["checkpointOnly"])
        self.assertEqual(diagnostics["checkpointCount"], 2)
        self.assertEqual(diagnostics["modelCalls"], 4)
        self.assertEqual(diagnostics["cacheHitRate"], 1.0)
        self.assertTrue(all(item["model"] == "qwen-vl-max" for item in diagnostics["phases"]))

    @patch("processor.job_worker.api_request")
    def test_optional_material_queue_400_does_not_exit_drama_worker(self, api_request_mock):
        api_request_mock.side_effect = ApiRequestError(400, "material collection unavailable")
        self.assertFalse(process_one_endpoint("http://pb", "token", "worker", "/api/lumina/material-analysis", "material", optional=True))

    def test_worker_envelope_contract_round_trip(self):
        original = failed_envelope("detail", {"episodes": [1, 2]}, AnalysisFailed("bad evidence"))
        restored = envelope_from_dict(original.to_dict())
        self.assertEqual(restored.tier, "detail")
        self.assertEqual(restored.error["message"], "bad evidence")

    @patch("processor.job_worker.process_one_endpoint")
    def test_workers_can_be_pinned_to_independent_queues(self, process_mock):
        process_mock.return_value = False
        process_available("http://pb", "token", "drama-worker", "drama")
        self.assertEqual(process_mock.call_args.args[3:5], ("/api/lumina/analysis", "drama"))
        process_mock.reset_mock()
        process_available("http://pb", "token", "material-worker", "material")
        self.assertEqual([call.args[3:5] for call in process_mock.call_args_list], [("/api/lumina/hook-matching", "hook_match"), ("/api/lumina/entry-precision", "entry_precision"), ("/api/lumina/factory-render", "factory_render"), ("/api/lumina/supplemental-highlights", "supplemental_highlight"), ("/api/lumina/material-analysis", "material")])

    @patch("processor.job_worker.process_one_endpoint")
    def test_worker_can_claim_one_exact_material_job(self, process_mock):
        process_mock.return_value = False
        process_available("http://pb", "token", "material-worker", "material", "job-123")
        self.assertEqual(process_mock.call_args.kwargs["job_id"], "job-123")

    @patch.dict("os.environ", {"LUMINA_SEMANTIC_MODEL": "test-model", "LUMINA_WHISPER_MODEL": "test-whisper"})
    @patch("processor.semantic_analysis._semantic_request", side_effect=lambda *_args, **_kwargs: copy.deepcopy(MATERIAL_CONTRACT))
    @patch("processor.semantic_analysis.read_ocr")
    @patch("processor.semantic_analysis.transcribe")
    @patch("processor.semantic_analysis.extract_frames_at")
    @patch("processor.semantic_analysis.detect_audio_events", return_value=[])
    @patch("processor.semantic_analysis.detect_shots", return_value=[])
    @patch("processor.semantic_analysis._duration", return_value=12.0)
    def test_material_retry_reuses_asr_and_ocr_cache(self, _duration_mock, _shots_mock, _audio_mock, frames_mock, transcribe_mock, ocr_mock, _semantic_mock):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            frame = root / "frame.jpg"
            Image.new("RGB", (32, 32), "black").save(frame, format="JPEG")
            frames_mock.return_value = [{"path": str(frame), "timecode": {"start": 0.0, "end": 0.0}}]
            transcribe_mock.return_value = ([{"text": "hello", "start": 0.0, "end": 1.0}], {"backend": "test", "model": "test"})
            ocr_mock.return_value = ([{"text": "caption", "timecode": {"start": 0.0, "end": 0.0}}], {"backend": "test", "language": "en"})
            source = root / "material.mp4"
            source.write_bytes(b"video")
            cache = root / "cache"
            analyze_material(source, root / "first", cache_dir=cache)
            analyze_material(source, root / "second", cache_dir=cache)
        self.assertEqual(transcribe_mock.call_count, 1)
        self.assertEqual(ocr_mock.call_count, 1)
        self.assertEqual(frames_mock.call_count, 1)

    @patch.dict("os.environ", {"LUMINA_QWEN_SEGMENT_SECONDS": "90", "LUMINA_QWEN_SEGMENT_MIN_DURATION": "120", "LUMINA_QWEN_SEGMENT_WORKERS": "3"})
    @patch("processor.semantic_analysis._semantic_request", side_effect=lambda *_args, **_kwargs: copy.deepcopy(MATERIAL_CONTRACT))
    def test_long_material_uses_parallel_segments_and_final_merge(self, semantic_mock):
        stages = []
        result = _material_semantic_analysis({"frames": [], "transcript": [], "ocr": [], "requirements": []}, 181.0, lambda progress, stage: stages.append((progress, stage)))
        self.assertIn("creative", result)
        self.assertGreaterEqual(semantic_mock.call_count, 9)
        self.assertTrue(any("4/4" in stage for _, stage in stages))
        tasks = [call.args[0] for call in semantic_mock.call_args_list]
        self.assertIn("paid-ad-material-event-ledger", tasks)
        self.assertIn("paid-ad-material-story-audit", tasks)

    @patch.dict("os.environ", {"LUMINA_QWEN_SEGMENT_SECONDS": "60", "LUMINA_QWEN_SEGMENT_MIN_DURATION": "75", "LUMINA_QWEN_SEGMENT_WORKERS": "1"})
    @patch("processor.semantic_analysis._semantic_request", side_effect=lambda *_args, **_kwargs: copy.deepcopy(MATERIAL_CONTRACT))
    def test_single_qwen_worker_still_segments_long_material(self, semantic_mock):
        _material_semantic_analysis({"frames": [], "transcript": [], "ocr": [], "requirements": []}, 181.0, lambda *_args: None)
        tasks = [call.args[0] for call in semantic_mock.call_args_list]
        self.assertIn("paid-ad-material-segment-analysis", tasks)
        self.assertNotIn("paid-ad-material-analysis", tasks)

    @patch.dict("os.environ", {"LUMINA_QWEN_SEGMENT_SECONDS": "90", "LUMINA_QWEN_SEGMENT_MIN_DURATION": "120", "LUMINA_QWEN_SEGMENT_WORKERS": "3", "LUMINA_QWEN_RETRY_DELAY": "0"})
    @patch("processor.semantic_analysis.time.sleep")
    @patch("processor.semantic_analysis._semantic_request")
    def test_parallel_qwen_failure_falls_back_to_serial_segments(self, semantic_mock, _sleep_mock):
        semantic_mock.side_effect = [AnalysisFailed("concurrency limited")] * 4 + [copy.deepcopy(MATERIAL_CONTRACT) for _ in range(20)]
        stages = []
        result = _material_semantic_analysis({"frames": [], "transcript": [], "ocr": [], "requirements": []}, 181.0, lambda progress, stage: stages.append((progress, stage)))
        self.assertIn("creative", result)
        self.assertGreaterEqual(semantic_mock.call_count, 13)
        self.assertTrue(any("串行重试" in stage for _, stage in stages))

    @patch("processor.job_worker.download")
    @patch("processor.job_worker.analyze_precision")
    def test_worker_maps_precision_job_interval_and_coarse_envelope(self, analyze_precision_mock, download_mock):
        analyze_precision_mock.return_value = failed_envelope("precision", {"episode": 3}, AnalysisFailed("test"))
        coarse = AnalysisEnvelope("1.0.0", "c3", "coarse", "succeeded", {"episode": 3, "durationSeconds": 20}, {}, {"episode": 3, "transcript": [], "ocr": []}).to_dict()
        job = {"stage": "precision", "video": "ep03.mp4", "episode": "record3", "collection_id": "episodes", "episode_number": 3, "parameters": {"interval": {"start": 4.5, "end": 8.0}}, "coarse_result": coarse}
        with tempfile.TemporaryDirectory() as tmp:
            execute_semantic_job(job, "http://pb", Path(tmp))
        args = analyze_precision_mock.call_args.args
        self.assertEqual(args[1:4], (3, 4.5, 8.0))
        self.assertEqual(args[4].analysis_id, "c3")

    @patch("processor.job_worker.analyze_detail_reconcile")
    @patch("processor.job_worker.extract_frames", side_effect=AssertionError("reconcile must not extract frames"))
    @patch("processor.job_worker.download", side_effect=AssertionError("reconcile must not download media"))
    def test_detail_reconcile_worker_consumes_only_persisted_checkpoints(self, _download, _frames, reconcile_mock):
        reconcile_mock.return_value = AnalysisEnvelope("1.0.0", "detail-parent", "detail", "succeeded", {"episodes": [1], "checkpointOnly": True}, {}, {"highlightCandidates": []})
        checkpoint = {"episode": "episode-1", "episode_number": 1, "result": {"tier": "detail", "status": "succeeded", "result": {"episodePlots": [{"episode": 1}]}}}
        job = {"stage": "detail", "parameters": {"job_kind": "detail_reconcile", "checkpoint_only": True}, "episode_checkpoints": [checkpoint]}
        with tempfile.TemporaryDirectory() as tmp:
            result = execute_semantic_job(job, "http://pb", Path(tmp))
        self.assertEqual(result["source"]["checkpointOnly"], True)
        self.assertEqual(reconcile_mock.call_args.args[0], [checkpoint])

    @patch("processor.job_worker._detail_frame_payload", return_value="encoded-frame")
    @patch("processor.job_worker.extract_frames")
    @patch("processor.job_worker.download")
    @patch("processor.job_worker.analyze_detail")
    def test_detail_episode_worker_downloads_only_its_episode_and_returns_checkpoint(self, detail_mock, download_mock, frames_mock, _frame_payload):
        coarse = AnalysisEnvelope("1.0.0", "coarse-2", "coarse", "succeeded", {"episode": 2, "durationSeconds": 20}, {}, {"episode": 2, "durationSeconds": 20, "transcript": [], "ocr": []})
        detail_mock.return_value = AnalysisEnvelope("1.0.0", "detail-2", "detail", "succeeded", {"episodes": [2]}, {}, {"highlightCandidates": [], "diagnostics": {"detailCheckpoints": {"chunks": [{"episode": 2, "model": "flash", "requestCount": 1, "cacheHit": False}]}}})
        frames_mock.return_value = [{"path": "/does/not/need/to/exist.jpg", "timecode": {"start": 0, "end": 0}, "motionScore": 0}]
        job = {"stage": "detail_episode", "video": "ep02.mp4", "episode": "episode-2", "collection_id": "episodes", "episode_number": 2, "coarse_result": coarse.to_dict(), "parameters": {"job_kind": "detail_episode"}}
        with tempfile.TemporaryDirectory() as tmp:
            result = execute_semantic_job(job, "http://pb", Path(tmp))
        self.assertEqual(download_mock.call_count, 1)
        self.assertEqual(detail_mock.call_args.args[0][0].analysis_id, "coarse-2")
        self.assertEqual(result["checkpoint"]["episode"], 2)
        self.assertEqual(result["checkpoint"]["durationSeconds"], 20.0)
        self.assertEqual(result["checkpoint"]["version"], "detail-episode-v1")

    def test_worker_start_script_checks_credentials_before_python(self):
        script = Path("scripts/start-analysis-worker.ps1").read_text(encoding="utf-8")
        key_check = script.index("LUMINA_SEMANTIC_API_KEY")
        worker_start = script.rindex("processor.job_worker")
        self.assertLess(key_check, worker_start)

    def test_highlight_v2_ranks_hook_potential_not_model_confidence(self):
        def candidate(start, confidence, hook_score):
            return {
                "episode": 1, "start": start, "end": start + 12, "confidence": confidence,
                "title": f"候选 {start}", "audienceQuestion": "接下来会发生什么？", "narrativePromise": "冲突将得到兑现",
                "highlightScores": {"conflict": 90, "relationshipChange": 85, "informationGain": 85, "emotionPeak": 90, "reversalReveal": 85, "futureImpact": 80, "visualPerformance": 85},
                "hookPotentialScores": {"first3sStopPower": hook_score, "coldAudienceClarity": hook_score, "informationGap": hook_score, "narrativePromise": hook_score, "emotionIntensity": hook_score, "visualImpact": hook_score, "conflictClarity": hook_score, "payoffAvailability": hook_score},
                "productionScores": {"dialogueCompleteness": 90, "actionCompleteness": 90, "shotCompleteness": 90, "boundarySafety": 90, "mediaQuality": 90, "transitionability": 90, "compliance": 90},
                "evidence": [{"episode": 1, "source": "transcript", "timecode": {"start": start, "end": start + 2}, "confidence": .9, "text": "证据"}],
            }
        result = _precision_candidates([candidate(0, .99, 76), candidate(20, .80, 94)], {1: 60})
        self.assertEqual([item["start"] for item in result], [20.0, 0.0])
        self.assertTrue(result[0]["precisionEligible"])

    def test_highlight_v2_keeps_weak_candidate_reviewable_but_not_precision_eligible(self):
        raw = {"episode": 1, "start": 2, "end": 5, "confidence": .99, "evidence": [{"episode": 1, "source": "transcript", "timecode": {"start": 2, "end": 5}, "confidence": .99, "text": "普通对白"}]}
        result = _precision_candidates([raw], {1: 30})
        self.assertEqual(len(result), 1)
        self.assertFalse(result[0]["precisionEligible"])
        self.assertIn("缺少三维高光评分", result[0]["qualityGate"]["reasons"])

    def test_render_self_qc_detects_duration_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output.mp4"
            output.write_bytes(b"video")
            technical = {"format": {"duration": "12.0"}, "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac", "duration": "12.0"}]}
            ledger = [{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "hook"}]
            with patch("processor.factory_render._loudnorm_measurement", return_value={"input_i": -14.0, "input_tp": -1.5}):
                report = build_render_quality_report(output=output, technical=technical, expected_duration=10.0, width=1080, height=1920, ledger=ledger)
        self.assertFalse(report["passed"])
        self.assertIn("DURATION_CONSISTENCY", report["failureCodes"])

    def test_render_self_qc_accepts_consistent_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output.mp4"
            output.write_bytes(b"video")
            technical = {"format": {"duration": "10.04"}, "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac", "duration": "10.04"}]}
            ledger = [{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "episode", "flashTailStart": 12.0, "end": 10.0}]
            with patch("processor.factory_render._loudnorm_measurement", return_value={"input_i": -14.0, "input_tp": -1.5}):
                report = build_render_quality_report(output=output, technical=technical, expected_duration=10.0, width=1080, height=1920, ledger=ledger)
        self.assertTrue(report["passed"])

    def test_episode_splice_boundary_contract_rejects_fabricated_or_missing_boundaries(self):
        with self.assertRaisesRegex(AnalysisFailed, "approved highlight"):
            _validated_splice_boundaries({"safeStart": {"status": "verified", "source": "selected_highlight_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}}, first=True, episode=1, start=12)
        with self.assertRaisesRegex(AnalysisFailed, "source-start"):
            _validated_splice_boundaries({"safeStart": {"status": "verified", "source": "episode_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}}, first=False, episode=2, start=1)
        with self.assertRaisesRegex(AnalysisFailed, "source-end"):
            _validated_splice_boundaries({"safeStart": {"status": "verified", "source": "episode_start"}}, first=False, episode=2, start=0)

    def test_episode_splice_boundary_contract_accepts_server_canonical_boundaries(self):
        first = {"safeStart": {"status": "verified", "source": "approved_highlight", "highlightAssetId": "hook1"}, "safeEnd": {"status": "verified", "source": "episode_end"}}
        following = {"safeStart": {"status": "verified", "source": "episode_start"}, "safeEnd": {"status": "verified", "source": "episode_end"}}
        self.assertEqual(_validated_splice_boundaries(first, first=True, episode=1, start=12)[0]["highlightAssetId"], "hook1")
        self.assertEqual(_validated_splice_boundaries(following, first=False, episode=2, start=0)[0]["source"], "episode_start")

    def test_hook_match_uses_only_complete_fragment_evidence(self):
        hook = {
            "id": "hook-1", "source_class": "external_material",
            "hook_type": "关系冲突钩子", "start_seconds": 0, "end_seconds": 23.36,
            "boundary_status": "verified", "conflict": "整部长片里的经济压力",
            "information_gap": "林绵与时凛在卧室发生冲突",
            "evidence": {"transcript": [
                {"start": 3.78, "end": 4.84, "text": "你不是说", "confidence": .99, "verification": "verified"},
                {"start": 6.36, "end": 7.68, "text": "自己很干净吗", "confidence": .97, "verification": "verified"},
                {"start": 11.34, "end": 21.45, "text": "干净", "confidence": .36, "verification": "verified"},
                {"start": 21.45, "end": 32.6, "text": "身体健康", "confidence": .98, "verification": "verified"},
            ]},
        }
        evidence = _external_hook_fragment_evidence(hook)
        self.assertEqual([row["text"] for row in evidence["transcript"]], ["你不是说", "自己很干净吗"])
        safe = _external_hook_match_input(hook)
        self.assertNotIn("conflict", safe)
        self.assertNotIn("information_gap", safe)
        self.assertNotIn("林绵", str(safe))


if __name__ == "__main__":
    unittest.main()
