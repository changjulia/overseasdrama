import copy
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from processor.pack import group_phrases, pack_transcripts
from processor.scribe import is_cache_valid, source_fingerprint
from processor.batch_transcribe import select_free_episodes
from processor.job_worker import ApiRequestError, envelope_from_dict, execute_entry_precision_job, execute_semantic_job, process_available, process_one_endpoint
from processor.factory_render import build_render_quality_report
from processor.semantic_analysis import AnalysisFailed, AnalysisEnvelope, Evidence, Timecode, _enrich_material_hooks, _extract_chat_stream, _extract_provider_result, _material_output_contract_valid, _material_semantic_analysis, _normalize_material_format, _normalize_precision_hooks, _openai_request_body, _precision_candidates, _reconstruct_storyline, _reconstruct_highlights, _sanitize_material_provider_input, _semantic_request, _story_duration_validation, _target_duration_spec, _validate_semantic_claims, analyze_detail, analyze_hook_entry_points, analyze_hook_story_match, analyze_material, failed_envelope

MATERIAL_CONTRACT = {
    "content": {"summary": {"value": "摘要", "confidence": 0.9, "evidence": []}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {"value": "完整", "confidence": 0.9, "evidence": []}},
    "creative": {"format": {"value": "正片剧集拼接", "confidence": 0.9, "evidence": []}, "tier": {"value": "T1", "confidence": 0.9, "evidence": []}, "hooks": [], "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
    "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
    "review": {"status": "needs_review", "reasons": []},
}


class ProcessorTests(unittest.TestCase):
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
    def test_hook_story_match_requests_supplemental_analysis_without_approved_highlights(self):
        payload = {"hook": {"id": "h1", "source_class": "external_material", "boundary_status": "verified"}, "drama": {"id": "d1"}, "episodes": [{"episode_number": 1, "highlights": []}], "episode_scope": [1]}
        result = analyze_hook_story_match(payload).result
        self.assertEqual(result["matches"], [])
        self.assertEqual(result["supplementalAnalysisRequests"][0]["requestedAnalysis"], "highlight_precision")

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

    def test_external_hook_keeps_model_interval_without_auto_expansion(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "独立开场", "start": 0, "end": 8}]}
        shots = [{"timecode": {"start": 0, "end": 8}}, {"timecode": {"start": 8, "end": 23.36}}, {"timecode": {"start": 23.36, "end": 120}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(len(result["hooks"]), 1)
        self.assertEqual(result["hooks"][0]["end"], 8)

    def test_external_opening_search_area_is_not_accepted_as_one_long_hook(self):
        creative = {"format": {"label": "外搭钩子＋本剧正片"}, "hooks": [{"label": "完整外搭片段", "start": 0, "end": 23.36}]}
        shots = [{"timecode": {"start": 0, "end": 8}}, {"timecode": {"start": 8, "end": 23.36}}, {"timecode": {"start": 23.36, "end": 120}}]
        result = _enrich_material_hooks(creative, [], shots, 120)
        self.assertEqual(result["hooks"], [])

    def test_material_format_v1_keeps_same_drama_hook_as_episode_splice(self):
        verified = lambda label: {"label": label, "confidence": .9, "evidence": [], "verification": "verified"}
        creative, review = _normalize_material_format({"bodyFormat": verified("正片主导"), "hookSourceStatus": verified("已确认同剧")}, {"status": "ready", "reasons": []})
        self.assertEqual(creative["format"]["label"], "正片剧集拼接")
        self.assertFalse(review["reviewRequired"])

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

    def test_material_contract_rejects_single_summary_claim(self):
        self.assertFalse(_material_output_contract_valid({"value": "summary", "confidence": 0.9, "evidence": []}))
        self.assertTrue(_material_output_contract_valid(MATERIAL_CONTRACT))

    def test_material_merge_redacts_explicit_text_but_keeps_timecode(self):
        source = {"value": "explicit sexual scene", "sourceText": "verbatim", "evidence": [{"timecode": {"start": 1, "end": 2}}]}
        cleaned = _sanitize_material_provider_input(source)
        self.assertNotIn("sourceText", cleaned)
        self.assertNotIn("sexual", cleaned["value"])
        self.assertEqual(cleaned["evidence"][0]["timecode"], {"start": 1, "end": 2})

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

    def test_detail_precision_candidates_expand_fragments_to_twelve_seconds(self):
        evidence = [{"episode": 1, "source": "transcript", "confidence": .9, "timecode": {"start": 21, "end": 23}}]
        candidates = _precision_candidates([{"episode": 1, "start": 21, "end": 23, "confidence": .9, "evidence": evidence}], {1: 100})
        self.assertEqual(candidates[0]["end"] - candidates[0]["start"], 12)

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
        self.assertEqual([call.args[3:5] for call in process_mock.call_args_list], [("/api/lumina/material-analysis", "material"), ("/api/lumina/supplemental-highlights", "supplemental_highlight"), ("/api/lumina/hook-matching", "hook_match"), ("/api/lumina/entry-precision", "entry_precision"), ("/api/lumina/factory-render", "factory_render")])

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
            frame.write_bytes(b"jpeg")
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
        self.assertEqual(result["creative"]["format"]["value"], "正片剧集拼接")
        self.assertEqual(semantic_mock.call_count, 5)
        self.assertTrue(any("4/4" in stage for _, stage in stages))
        self.assertEqual(semantic_mock.call_args.args[0], "paid-ad-material-classification-merge")

    @patch.dict("os.environ", {"LUMINA_QWEN_SEGMENT_SECONDS": "90", "LUMINA_QWEN_SEGMENT_MIN_DURATION": "120", "LUMINA_QWEN_SEGMENT_WORKERS": "3", "LUMINA_QWEN_RETRY_DELAY": "0"})
    @patch("processor.semantic_analysis.time.sleep")
    @patch("processor.semantic_analysis._semantic_request")
    def test_parallel_qwen_failure_falls_back_to_serial_segments(self, semantic_mock, _sleep_mock):
        semantic_mock.side_effect = [AnalysisFailed("concurrency limited")] * 4 + [copy.deepcopy(MATERIAL_CONTRACT) for _ in range(5)]
        stages = []
        result = _material_semantic_analysis({"frames": [], "transcript": [], "ocr": [], "requirements": []}, 181.0, lambda progress, stage: stages.append((progress, stage)))
        self.assertEqual(result["creative"]["format"]["value"], "正片剧集拼接")
        self.assertEqual(semantic_mock.call_count, 9)
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
            technical = {"format": {"duration": "12.0"}, "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac"}]}
            ledger = [{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "hook"}]
            report = build_render_quality_report(output=output, technical=technical, expected_duration=10.0, width=1080, height=1920, ledger=ledger)
        self.assertFalse(report["passed"])
        self.assertIn("DURATION_CONSISTENCY", report["failureCodes"])

    def test_render_self_qc_accepts_consistent_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output.mp4"
            output.write_bytes(b"video")
            technical = {"format": {"duration": "10.04"}, "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920}, {"codec_type": "audio", "codec_name": "aac"}]}
            ledger = [{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "episode", "flashTailStart": 12.0, "end": 10.0}]
            report = build_render_quality_report(output=output, technical=technical, expected_duration=10.0, width=1080, height=1920, ledger=ledger)
        self.assertTrue(report["passed"])


if __name__ == "__main__":
    unittest.main()
