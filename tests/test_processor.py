import copy
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from processor.pack import group_phrases, pack_transcripts
from processor.scribe import is_cache_valid, source_fingerprint
from processor.batch_transcribe import select_free_episodes
from processor.job_worker import ApiRequestError, envelope_from_dict, execute_semantic_job, process_available, process_one_endpoint
from processor.semantic_analysis import AnalysisFailed, AnalysisEnvelope, Evidence, Timecode, _extract_chat_stream, _extract_provider_result, _material_output_contract_valid, _material_semantic_analysis, _openai_request_body, _precision_candidates, _sanitize_material_provider_input, _semantic_request, _validate_semantic_claims, analyze_detail, analyze_material, failed_envelope

MATERIAL_CONTRACT = {
    "content": {"summary": {"value": "摘要", "confidence": 0.9, "evidence": []}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {"value": "完整", "confidence": 0.9, "evidence": []}},
    "creative": {"format": {"value": "正片剧集拼接", "confidence": 0.9, "evidence": []}, "tier": {"value": "T1", "confidence": 0.9, "evidence": []}, "hooks": [], "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
    "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
    "review": {"status": "needs_review", "reasons": []},
}


class ProcessorTests(unittest.TestCase):
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
        self.assertEqual(process_mock.call_args.args[3:5], ("/api/lumina/material-analysis", "material"))

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
        self.assertEqual(semantic_mock.call_args.args[0], "paid-ad-material-analysis-merge")

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


if __name__ == "__main__":
    unittest.main()
