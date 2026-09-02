import copy
import base64
import io
import json
import os
import tempfile
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from pathlib import Path

from PIL import Image

from processor.pack import group_phrases, pack_transcripts
from processor.scribe import is_cache_valid, source_fingerprint
from processor.batch_transcribe import select_free_episodes
from processor.job_worker import ApiRequestError, DownloadIntegrityError, api_request, classify_failure, download, envelope_from_dict, execute_entry_precision_job, execute_semantic_job, process_available, process_one_endpoint
from processor.factory_render import build_render_quality_report
from processor.semantic_analysis import AnalysisFailed, AnalysisEnvelope, Evidence, Timecode, _apply_material_evidence_gate, _compact_hook_highlight, _complete_sentence_limit, _downgrade_unsupported_external_hook, _enrich_material_hooks, _external_hook_fragment_evidence, _external_hook_match_input, _extract_chat_stream, _extract_provider_result, _material_evidence_timestamps, _material_output_contract_issues, _material_output_contract_valid, _material_semantic_analysis, _material_story_consistency_issues, _material_story_quality_issues, _material_story_synthesis_request, _normalize_material_format, _normalize_material_output_shape, _normalize_precision_hooks, _openai_request_body, _opening_preface_boundary, _precision_candidates, _read_analysis_cache, _reconstruct_storyline, _reconstruct_highlights, _restore_material_observations, _sanitize_material_provider_input, _semantic_frame_base64, _semantic_request, _story_duration_validation, _storyboard_quality_issues, _storyboard_units_from_event_ledger, _strict_safety_provider_input, _target_duration_spec, _validate_semantic_claims, _write_analysis_cache, analyze_coarse, analyze_detail, analyze_hook_entry_points, analyze_hook_story_match, analyze_material, failed_envelope, transcribe

MATERIAL_CONTRACT = {
    "content": {"summary": {"value": "摘要", "confidence": 0.9, "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 1}, "confidence": 0.9, "text": "开场对白"}], "basedOnFactIds": ["F1"], "verification": "verified"}, "observations": [{"factId": "F1", "actorObserved": "说话者", "actionObserved": "说出开场对白", "evidence": [{"source": "transcript", "timecode": {"start": 0, "end": 1}, "confidence": 0.9, "text": "开场对白"}], "verification": "verified"}], "inferences": [], "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {"value": "完整", "confidence": 0.9, "evidence": []}},
    "creative": {"format": {"value": "正片剧集拼接", "confidence": 0.9, "evidence": []}, "tier": {"value": "T1", "confidence": 0.9, "evidence": []}, "hooks": [], "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
    "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
    "review": {"status": "needs_review", "reasons": []},
}


class ProcessorTests(unittest.TestCase):
    def test_analysis_cache_allows_eight_concurrent_writers(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "semantic-segments-v6.json"
            with ThreadPoolExecutor(max_workers=8) as executor:
                futures = [
                    executor.submit(_write_analysis_cache, cache, "same-content-hash", [{"segment": 1}], {"backend": "test"})
                    for _ in range(8)
                ]
                for future in futures:
                    future.result()
            self.assertEqual(_read_analysis_cache(cache, "same-content-hash"), ([{"segment": 1}], {"backend": "test"}))
            self.assertEqual(list(cache.parent.glob(f".{cache.name}.*.tmp")), [])

    @patch("processor.semantic_analysis.os.replace")
    def test_analysis_cache_cleans_unique_temporary_after_replace_failure(self, replace):
        replace.side_effect = OSError("replace failed")
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "semantic-segments-v6.json"
            with self.assertRaisesRegex(AnalysisFailed, r"atomic write failed \(OSError\)") as raised:
                _write_analysis_cache(cache, "signature", [{"segment": 1}], {"backend": "test"})
            self.assertNotIn(str(cache), str(raised.exception))
            self.assertFalse(cache.exists())
            self.assertEqual(list(cache.parent.glob(f".{cache.name}.*.tmp")), [])

    @patch("processor.semantic_analysis.os.replace")
    def test_analysis_cache_preserves_existing_target_when_replace_fails(self, replace):
        replace.side_effect = OSError("replace failed")
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "semantic-segments-v6.json"
            original = b'{"signature":"old","data":[],"engine":{"backend":"old"}}'
            cache.write_bytes(original)
            with self.assertRaises(AnalysisFailed):
                _write_analysis_cache(cache, "new", [{"segment": 2}], {"backend": "new"})
            self.assertEqual(cache.read_bytes(), original)
            self.assertEqual(list(cache.parent.glob(f".{cache.name}.*.tmp")), [])

    @patch("processor.semantic_analysis.time.sleep")
    def test_analysis_cache_retries_transient_windows_replace_race(self, _sleep):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "semantic-segments-v6.json"
            real_replace = os.replace
            attempts = []

            def transient_once(source, destination):
                attempts.append(True)
                if len(attempts) == 1:
                    error = PermissionError("sharing violation")
                    error.winerror = 5
                    raise error
                real_replace(source, destination)

            with patch("processor.semantic_analysis.os.replace", side_effect=transient_once):
                _write_analysis_cache(cache, "signature", [{"segment": 1}], {"backend": "test"})
            self.assertEqual(len(attempts), 2)
            self.assertEqual(_read_analysis_cache(cache, "signature"), ([{"segment": 1}], {"backend": "test"}))
            self.assertEqual(list(cache.parent.glob(f".{cache.name}.*.tmp")), [])

    @patch("processor.semantic_analysis._semantic_request")
    def test_material_story_synthesis_retries_length_once_with_compact_contract(self, semantic_request):
        repair_payload = {
            "requirements": ["repair every consistency issue"],
            "draftStory": {"summary": "原始草稿"},
            "resolvedEntities": {"characters": [{"name": "角色甲"}]},
            "storyAudit": {"missingEvents": [{"eventId": "E1"}]},
            "consistencyIssues": ["缺少事件 E1"],
        }
        repaired = {"summary": "完整修复结果"}
        semantic_request.side_effect = [AnalysisFailed("provider response is incomplete; finish_reason=length"), repaired]
        retried = []

        result = _material_story_synthesis_request(repair_payload, on_compact_retry=lambda: retried.append(True))

        self.assertEqual(result, repaired)
        self.assertEqual(semantic_request.call_count, 2)
        first_task, first_payload = semantic_request.call_args_list[0].args
        second_task, compact_payload = semantic_request.call_args_list[1].args
        self.assertEqual(first_task, "paid-ad-material-story-synthesis")
        self.assertEqual(second_task, first_task)
        self.assertIs(first_payload, repair_payload)
        self.assertTrue(compact_payload["compactRetry"])
        self.assertEqual(compact_payload["draftStory"], repair_payload["draftStory"])
        self.assertEqual(compact_payload["resolvedEntities"], repair_payload["resolvedEntities"])
        self.assertEqual(compact_payload["storyAudit"], repair_payload["storyAudit"])
        self.assertEqual(compact_payload["consistencyIssues"], repair_payload["consistencyIssues"])
        self.assertEqual(repair_payload["requirements"], ["repair every consistency issue"])
        self.assertEqual(retried, [True])

    @patch("processor.semantic_analysis._semantic_request")
    def test_material_story_synthesis_stops_after_one_compact_retry(self, semantic_request):
        semantic_request.side_effect = AnalysisFailed("provider response is incomplete; finish_reason=length")

        with self.assertRaisesRegex(AnalysisFailed, "finish_reason=length"):
            _material_story_synthesis_request({"requirements": []})

        self.assertEqual(semantic_request.call_count, 2)

    @patch("processor.semantic_analysis._semantic_request")
    def test_material_story_synthesis_does_not_retry_non_length_failure(self, semantic_request):
        semantic_request.side_effect = AnalysisFailed("schema validation failed")

        with self.assertRaisesRegex(AnalysisFailed, "schema validation failed"):
            _material_story_synthesis_request({"requirements": []})

        semantic_request.assert_called_once()

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
        self.assertEqual(result["content"]["inferences"][0]["verification"], "unverified")

    def test_material_evidence_gate_rejects_visual_motive_inference(self):
        result = _apply_material_evidence_gate({
            "content": {
                "observations": [{"factId": "F1", "actionObserved": "女人拿起信封", "verification": "verified", "evidence": [{"source": "frame", "text": "女人拿起信封", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
                "inferences": [{"label": "她为了钱背叛朋友", "statement": "她为了钱背叛朋友", "inferenceType": "motive", "basedOnFactIds": ["F1"], "verification": "verified", "evidence": [{"source": "frame", "text": "女人拿起信封", "timecode": {"start": 1, "end": 1}, "confidence": .9}]}],
                "characters": [], "relationships": [],
            }, "creative": {}, "review": {"status": "ready", "reviewRequired": False},
        })
        self.assertFalse(result["qualityGate"]["passed"])
        self.assertEqual(result["content"]["inferences"][0]["verification"], "unverified")

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
        self.assertEqual(result["content"]["observations"][0]["verification"], "unverified")

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
        with patch.dict("sys.modules", {"faster_whisper": fake_whisper}), patch.dict(
            "os.environ",
            {"LUMINA_WHISPER_MODEL": "tiny", "LUMINA_WHISPER_DEVICE": "cpu", "LUMINA_WHISPER_COMPUTE_TYPE": "int8"},
            clear=False,
        ):
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

    def test_failure_classifier_retries_explicit_winsock_interruptions_despite_mojibake(self):
        failures=[
            OSError(10053,"����������������"),
            RuntimeError("[WinError 10054] ������������"),
            RuntimeError("WSA socket error 10060: ��������"),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                self.assertEqual(classify_failure(failure),("transient",True,30))

    def test_failure_classifier_does_not_retry_unscoped_number_or_invalid_media(self):
        self.assertEqual(classify_failure(RuntimeError("frame 10053 is malformed")),("permanent",False,0))
        kind,retryable,delay=classify_failure(RuntimeError("ffprobe.exe failed: Invalid data found when processing input"))
        self.assertEqual((kind,retryable,delay),("permanent",False,0))

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

    def test_failure_classifier_retries_windows_native_loader_error(self):
        kind, retryable, delay = classify_failure(
            OSError(127, "[WinError 127] The specified procedure could not be found")
        )
        self.assertEqual(kind, "transient")
        self.assertTrue(retryable)
        self.assertEqual(delay, 60)

    def test_failure_classifier_retries_material_contract_repairs(self):
        kind, retryable, delay = classify_failure(RuntimeError("素材分析输出契约可修复失败（content.summary.evidence:missing）"))
        self.assertEqual(kind, "validation")
        self.assertTrue(retryable)
        self.assertEqual(delay, 120)

    def test_failure_classifier_retries_empty_ffprobe_failure_but_not_invalid_media(self):
        for executable in ("ffprobe", "ffprobe.exe"):
            with self.subTest(executable=executable):
                kind, retryable, delay = classify_failure(RuntimeError(f"{executable} failed: "))
                self.assertEqual((kind, retryable, delay), ("transient", True, 30))
        kind, retryable, delay = classify_failure(RuntimeError("ffprobe.exe failed: Invalid data found when processing input"))
        self.assertEqual(kind, "permanent");self.assertFalse(retryable);self.assertEqual(delay, 0)

    def test_download_validates_content_length_then_atomically_replaces_destination(self):
        class Response(io.BytesIO):
            def __init__(self,value):super().__init__(value);self.headers={"Content-Length":str(len(value))}
            def __enter__(self):return self
            def __exit__(self,*_):self.close();return False
        with tempfile.TemporaryDirectory() as directory:
            destination=Path(directory)/"source.mp4";destination.write_bytes(b"old")
            with patch("processor.job_worker.urllib.request.urlopen",return_value=Response(b"complete-media")):
                download("https://media.invalid/hidden",destination)
            self.assertEqual(destination.read_bytes(),b"complete-media")
            self.assertEqual(list(Path(directory).glob("*.part")),[])

    def test_download_rejects_truncation_without_replacing_existing_file(self):
        class Response(io.BytesIO):
            headers={"Content-Length":"99"}
            def __enter__(self):return self
            def __exit__(self,*_):self.close();return False
        with tempfile.TemporaryDirectory() as directory:
            destination=Path(directory)/"source.mp4";destination.write_bytes(b"known-good")
            with patch("processor.job_worker.urllib.request.urlopen",return_value=Response(b"short")):
                with self.assertRaisesRegex(DownloadIntegrityError,"declared content length"):
                    download("https://media.invalid/hidden",destination)
            self.assertEqual(destination.read_bytes(),b"known-good")
            self.assertEqual(list(Path(directory).glob("*.part")),[])

    def test_download_without_content_length_streams_to_atomic_destination(self):
        class Response(io.BytesIO):
            headers={}
            def __enter__(self):return self
            def __exit__(self,*_):self.close();return False
        with tempfile.TemporaryDirectory() as directory:
            destination=Path(directory)/"source.mp4"
            with patch("processor.job_worker.urllib.request.urlopen",return_value=Response(b"streamed-media")):
                download("https://media.invalid/hidden",destination)
            self.assertEqual(destination.read_bytes(),b"streamed-media")
            self.assertEqual(list(Path(directory).glob("*.part")),[])

    def test_download_failure_does_not_expose_signed_url(self):
        signed="https://media.invalid/video.mp4?signature=secret-token"
        with tempfile.TemporaryDirectory() as directory,patch("processor.job_worker.urllib.request.urlopen",side_effect=urllib.error.URLError(signed)):
            with self.assertRaises(DownloadIntegrityError) as raised:
                download(signed,Path(directory)/"source.mp4")
            self.assertEqual(list(Path(directory).glob("*.part")),[])
        self.assertNotIn("signature",str(raised.exception));self.assertNotIn("secret-token",str(raised.exception))
        self.assertEqual(classify_failure(raised.exception),("transient",True,30))

    @patch("processor.job_worker.urllib.request.urlopen")
    def test_api_request_replaces_nonfinite_numbers_before_pocketbase(self, mocked_urlopen):
        response = MagicMock()
        response.status = 200
        response.read.return_value = b"{}"
        mocked_urlopen.return_value.__enter__.return_value = response
        api_request("http://pb", "token", "/jobs/1", "PATCH", {"score": float("nan"), "nested": [float("inf")]})
        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data), {"score": None, "nested": [None]})

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

    def test_hook_highlight_provider_view_drops_heavy_fields_and_bounds_evidence(self):
        highlight = {
            "id": "eh1", "start_seconds": 1, "end_seconds": 9,
            "boundary_status": "verified", "review_status": "approved",
            "base64": "secret", "embedding": [1] * 1000,
            "evidence": [{"text": "证" * 1200, "timecode": {"start": 1, "end": 2}}] * 30,
        }
        compact = _compact_hook_highlight(highlight)
        self.assertEqual(compact["id"], "eh1")
        self.assertNotIn("base64", compact)
        self.assertNotIn("embedding", compact)
        self.assertEqual(len(compact["evidence"]), 14)
        self.assertLessEqual(len(compact["evidence"][0]["text"]), 701)

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

    def test_openai_chat_stream_rejects_parseable_json_finished_by_length(self):
        stream = [
            b'data: {"choices":[{"delta":{"content":"{\\"summary\\":{}}"},"finish_reason":"length"}]}\n',
            b'data: [DONE]\n',
        ]
        with self.assertRaisesRegex(AnalysisFailed, "finish_reason=length"):
            _extract_chat_stream(stream)

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

    def test_material_contract_rejects_single_summary_claim(self):
        self.assertFalse(_material_output_contract_valid({"value": "summary", "confidence": 0.9, "evidence": []}))
        empty_summary = copy.deepcopy(MATERIAL_CONTRACT)
        empty_summary["content"]["summary"] = {"value": "", "confidence": 0.9, "evidence": []}
        self.assertFalse(_material_output_contract_valid(empty_summary))
        self.assertTrue(_material_output_contract_valid(MATERIAL_CONTRACT))

    def test_material_contract_diagnostics_name_missing_lineage(self):
        value = copy.deepcopy(MATERIAL_CONTRACT)
        value["content"]["summary"].pop("evidence")
        value["content"]["summary"].pop("basedOnFactIds")
        issues = _material_output_contract_issues(value)
        self.assertIn("content.summary.evidence:missing", issues)
        self.assertIn("content.summary.basedOnFactIds:missing", issues)

    def test_material_shape_restores_summary_lineage_only_from_verified_observations(self):
        value = copy.deepcopy(MATERIAL_CONTRACT)
        value["content"]["summary"] = {"value": "基于已验证事实形成的剧情摘要"}
        normalized = _normalize_material_output_shape(value)
        summary = normalized["content"]["summary"]
        self.assertEqual(summary["basedOnFactIds"], ["F1"])
        self.assertEqual(summary["verification"], "verified")
        self.assertEqual(summary["evidence"][0]["source"], "transcript")

    def test_material_observations_restore_only_verified_cached_segment_facts(self):
        result = copy.deepcopy(MATERIAL_CONTRACT)
        result["content"]["observations"] = []
        verified = copy.deepcopy(MATERIAL_CONTRACT["content"]["observations"][0])
        unverified = {**verified, "factId": "F2", "verification": "unverified"}
        restored = _restore_material_observations(result, {"segmentAnalyses": [{"content": {"observations": [verified, unverified]}}]})
        self.assertEqual([item["factId"] for item in restored["content"]["observations"]], ["F1"])

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

    @patch("processor.semantic_analysis.urllib.request.urlopen")
    def test_hook_story_match_http_400_retries_with_compact_context(self, urlopen_mock):
        oversized = urllib.error.HTTPError(
            "https://dashscope", 400, "bad request", {}, io.BytesIO(b'{"error":{"code":"invalid_parameter"}}')
        )
        retry_context = MagicMock()
        retry_response = retry_context.__enter__.return_value
        retry_response.__iter__.return_value = iter([
            b'data: {"choices":[{"delta":{"content":"{\\"matches\\":[]}"}}]}\n',
            b'data: [DONE]\n',
        ])
        urlopen_mock.side_effect = [oversized, retry_context]
        payload = {
            "episodes": [{
                "episode": 1,
                "analysis": {"episodeSummary": "剧情" * 1000},
                "highlights": [{
                    "id": "eh1", "start_seconds": 1, "end_seconds": 9,
                    "evidence": [{"text": "对白" * 1000, "timecode": {"start": 1, "end": 2}}] * 30,
                }],
            }],
        }
        with patch.dict("os.environ", {
            "DASHSCOPE_API_KEY": "local-test-key",
            "LUMINA_SEMANTIC_ENDPOINT": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "LUMINA_SEMANTIC_MODEL": "qwen3-vl-plus",
            "LUMINA_SEMANTIC_PROVIDER": "openai-chat-completions",
        }, clear=True):
            self.assertEqual(_semantic_request("hook-story-match", payload), {"matches": []})
        first_size = len(urlopen_mock.call_args_list[0].args[0].data)
        retry_size = len(urlopen_mock.call_args_list[1].args[0].data)
        self.assertLess(retry_size, first_size)

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
        with patch.dict("os.environ", {"LUMINA_INTERACTIVE_MATERIAL_FALLBACK":"0"}, clear=False):
            process_available("http://pb", "token", "material-worker", "material")
        self.assertEqual([call.args[3:5] for call in process_mock.call_args_list], [("/api/lumina/hook-matching", "hook_match"), ("/api/lumina/entry-precision", "entry_precision"), ("/api/lumina/factory-render", "factory_render"), ("/api/lumina/supplemental-highlights", "supplemental_highlight")])

    @patch("processor.job_worker.process_one_endpoint")
    def test_interactive_worker_only_falls_back_to_batch_with_explicit_opt_in(self, process_mock):
        process_mock.return_value=False
        with patch.dict("os.environ", {"LUMINA_INTERACTIVE_MATERIAL_FALLBACK":"1"}, clear=False):
            process_available("http://pb", "token", "material-worker", "material")
        self.assertEqual(process_mock.call_args_list[-1].args[3:5],("/api/lumina/material-analysis","material"))

    @patch("processor.job_worker.process_one_endpoint")
    def test_worker_can_claim_one_exact_material_job(self, process_mock):
        process_mock.return_value = False
        with patch.dict("os.environ", {"LUMINA_INTERACTIVE_MATERIAL_FALLBACK":"0"}, clear=False):
            process_available("http://pb", "token", "material-worker", "material", "job-123")
        self.assertEqual([call.args[3:5] for call in process_mock.call_args_list],[("/api/lumina/hook-matching","hook_match"),("/api/lumina/entry-precision","entry_precision"),("/api/lumina/factory-render","factory_render"),("/api/lumina/supplemental-highlights","supplemental_highlight")])
        self.assertTrue(all(call.kwargs["job_id"]=="job-123" for call in process_mock.call_args_list))

    @patch("processor.job_worker.process_one_endpoint")
    def test_material_batch_queue_keeps_dedicated_material_analysis_path(self, process_mock):
        process_mock.return_value=False
        process_available("http://pb","token","batch-worker","material-batch")
        self.assertEqual(process_mock.call_args.args[3:5],("/api/lumina/material-analysis","material"))

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
