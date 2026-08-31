"""Small, isolated, real-media acceptance tests for factory rendering.

The suite creates its own MP4 sources, serves them from a temporary HTTP root,
and publishes into a temporary render directory.  It never opens PocketBase or
the repository's pb_data directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from processor.factory_render import RenderConstraints, _render_clip, _render_transition_card, render_factory_project
from processor.semantic_analysis import AnalysisFailed


PROJECT_ROOT = Path(__file__).resolve().parent.parent
FFMPEG = PROJECT_ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg"
FFPROBE = next(
    (
        candidate
        for candidate in sorted((PROJECT_ROOT / "node_modules" / "@ffprobe-installer").glob("*/ffprobe*"))
        if candidate.is_file() and os.access(candidate, os.X_OK)
    ),
    PROJECT_ROOT / "node_modules" / "@ffprobe-installer" / "missing-ffprobe",
)
TEST_CONSTRAINTS = RenderConstraints(
    dimensions={"9:16": (180, 320), "16:9": (320, 180), "1:1": (180, 180)},
    episode_splice_duration=(1.0, 20.0),
    external_hook_duration=(1.0, 20.0),
)


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


class FactoryRenderMediaE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FFMPEG.is_file() or not FFPROBE.is_file():
            raise unittest.SkipTest("project-pinned ffmpeg/ffprobe executables are not installed")

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="factory-media-e2e-")
        self.root = Path(self.temp.name)
        self.http_root = self.root / "http"
        self.workspace = self.root / "workspace"
        self.output_root = self.root / "renders"
        self.workspace.mkdir()
        self._create_source("materials", "hook-1", "hook.mp4", "red", 1.2, 440)
        self._create_source("episodes", "episode-1", "episode-1.mp4", "blue", 2.0, 550)
        self._create_source("episodes", "episode-2", "episode-2.mp4", "green", 2.0, 660)
        handler = partial(_QuietHandler, directory=str(self.http_root))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def _create_source(self, collection: str, record: str, name: str, color: str, duration: float, frequency: int) -> None:
        target = self.http_root / "api" / "files" / collection / record / name
        target.parent.mkdir(parents=True, exist_ok=True)
        command = [
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={color}:s=160x90:r=30:d={duration}",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={duration}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(target),
        ]
        subprocess.run(command, check=True, capture_output=True)

    @staticmethod
    def _pinned_executable(name: str) -> str:
        return str(FFMPEG if name == "ffmpeg" else FFPROBE)

    @staticmethod
    def _episodes() -> list[dict[str, object]]:
        return [
            {"collectionId": "episodes", "id": "episode-1", "episode_number": 1, "video": "episode-1.mp4"},
            {"collectionId": "episodes", "id": "episode-2", "episode_number": 2, "video": "episode-2.mp4"},
        ]

    def _assert_published_media(self, result: dict[str, object], expected_episodes: list[int], expected_clips: int) -> None:
        validation = result["validation"]
        self.assertTrue(validation["passed"])
        self.assertEqual(validation["failureCodes"], [])
        output = Path(validation["file"])
        self.assertTrue(output.is_file())
        self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), result["output_sha256"])
        self.assertEqual(result["logs"]["timelineOrder"], expected_episodes)
        self.assertEqual(result["logs"]["clips"], expected_clips)
        self.assertFalse(list(self.output_root.glob("*.partial")))
        probe = subprocess.run(
            [str(FFPROBE), "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "json", str(output)],
            check=True, capture_output=True, text=True,
        )
        streams = json.loads(probe.stdout)["streams"]
        self.assertTrue(any(item.get("codec_name") == "h264" and item.get("width") == 180 and item.get("height") == 320 for item in streams))
        self.assertTrue(any(item.get("codec_name") == "aac" for item in streams))

    def _pixel(self, media: Path, timestamp: float, x: int = 10, y: int = 160) -> tuple[int, int, int]:
        sample = subprocess.run(
            [str(FFMPEG), "-hide_banner", "-loglevel", "error", "-ss", f"{timestamp:.3f}", "-i", str(media),
             "-frames:v", "1", "-vf", f"format=rgb24,crop=1:1:{x}:{y}", "-f", "rawvideo", "-"],
            check=True, capture_output=True,
        ).stdout
        self.assertEqual(len(sample), 3)
        return tuple(sample)  # type: ignore[return-value]

    def test_transition_effects_have_distinct_real_media_semantics(self) -> None:
        outgoing = self.http_root / "api/files/materials/hook-1/hook.mp4"
        incoming = self.http_root / "api/files/episodes/episode-1/episode-1.mp4"
        outputs: dict[str, Path] = {}
        with patch("processor.factory_render._executable", self._pinned_executable):
            for effect in ("hard_cut", "fade", "black", "flash_avoidance"):
                target = self.workspace / f"effect-{effect}.mp4"
                _render_transition_card(
                    target,
                    {"copy": "Meanwhile", "evidence": [{"source": "test"}], "renderConfig": {"effect": effect, "durationSeconds": .8, "fadeSeconds": .48}},
                    180, 320, outgoing=outgoing, incoming=incoming,
                )
                outputs[effect] = target

        # hard_cut preserves the outgoing red shot and switches instantly to
        # the incoming blue shot instead of manufacturing a black title card.
        hard_before, hard_after = self._pixel(outputs["hard_cut"], .15), self._pixel(outputs["hard_cut"], .65)
        self.assertGreater(hard_before[0], hard_before[2] + 60)
        self.assertGreater(hard_after[2], hard_after[0] + 60)
        # fade contains an actual mixed frame; black is a true black bridge;
        # flash avoidance dips to black at the boundary without a white spike.
        fade_mid = self._pixel(outputs["fade"], .24)
        self.assertGreater(fade_mid[0], 20)
        self.assertGreater(fade_mid[2], 20)
        self.assertLess(max(self._pixel(outputs["black"], .4)), 12)
        flash_mid = self._pixel(outputs["flash_avoidance"], .4)
        self.assertLess(max(flash_mid), 45)
        self.assertEqual(len({hashlib.sha256(path.read_bytes()).hexdigest() for path in outputs.values()}), 4)

    def test_match_cut_refuses_to_claim_unproven_visual_alignment(self) -> None:
        outgoing = self.http_root / "api/files/materials/hook-1/hook.mp4"
        incoming = self.http_root / "api/files/episodes/episode-1/episode-1.mp4"
        transition = {"copy": "Meanwhile", "evidence": [{"source": "test"}], "renderConfig": {"effect": "match_cut", "durationSeconds": .8}}
        with patch("processor.factory_render._executable", self._pinned_executable):
            with self.assertRaisesRegex(AnalysisFailed, "visual feature evidence"):
                _render_transition_card(self.workspace / "unproven-match.mp4", transition, 180, 320, outgoing=outgoing, incoming=incoming)
            transition["renderConfig"]["matchCutEvidence"] = {
                "feature": "centered circular object and clockwise motion",
                "outgoing": "approved shot tail frame 00:00:01.100",
                "incoming": "approved episode head frame 00:00:00.000",
            }
            target = self.workspace / "proven-match.mp4"
            _render_transition_card(target, transition, 180, 320, outgoing=outgoing, incoming=incoming)
        self.assertTrue(target.is_file())
        self.assertGreater(self._pixel(target, .15)[0], self._pixel(target, .15)[2] + 60)
        self.assertGreater(self._pixel(target, .65)[2], self._pixel(target, .65)[0] + 60)

    def test_episode_splice_renders_qcs_hashes_and_atomically_publishes(self) -> None:
        response = {
            "project": {
                "mode": "episode-splice", "title": "media-e2e-splice", "ratio": "9:16", "language": "英语",
                "transition": {"type": "direct_cut", "gapDiagnosis": ["causal"], "start": 0, "end": 0, "language": "zh-CN", "evidence": [{"source": "test"}], "renderConfig": {"effect": "hard_cut"}, "reviewStatus": "approved", "reviewerNote": "test approval", "version": 1},
                "timeline": [
                    {"episode": 1, "startSeconds": 0.25, "endSeconds": 2.0,
                     "safeStart": {"status": "verified", "source": "approved_highlight", "highlightAssetId": "highlight-1"},
                     "safeEnd": {"status": "verified", "source": "episode_end"}},
                    {"episode": 2, "startSeconds": 0, "endSeconds": 2.0,
                     "safeStart": {"status": "verified", "source": "episode_start"},
                     "safeEnd": {"status": "verified", "source": "episode_end"}},
                ],
            },
            "episodes": self._episodes(),
            "render": {"id": "splice-render", "version": 1},
        }
        with patch("processor.factory_render._executable", self._pinned_executable):
            result = render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=TEST_CONSTRAINTS)
        self._assert_published_media(result, [1, 2], 2)
        self.assertEqual([item["kind"] for item in result["boundary_ledger"]], ["episode", "episode"])

    def test_unapproved_transition_is_a_hard_worker_gate(self) -> None:
        response = {"project": {"mode": "episode-splice", "transition": {"type": "direct_cut", "gapDiagnosis": ["causal"], "language": "zh-CN", "version": 1, "reviewStatus": "pending"}}}
        with self.assertRaisesRegex(AnalysisFailed, "must be approved"):
            render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=TEST_CONSTRAINTS)

    def test_narration_without_real_audio_pipeline_fails_explicitly(self) -> None:
        response = {"project": {"mode": "episode-splice", "transition": {"type": "continuous_narration", "gapDiagnosis": ["causal"], "language": "zh-CN", "version": 1, "reviewStatus": "approved"}}}
        with self.assertRaisesRegex(AnalysisFailed, "real uploaded"):
            render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=TEST_CONSTRAINTS)

    def test_transition_review_preview_renders_real_bounded_media_while_pending(self) -> None:
        response = {
            "project": {"mode": "external-hook", "title": "review-preview", "ratio": "9:16", "transition": {"type": "transition_copy", "gapDiagnosis": ["causal"], "start": .9, "end": .9, "copy": "Meanwhile", "language": "en", "evidence": [{"source": "test"}], "renderConfig": {"transitionStyle": "black", "durationSeconds": .8}, "reviewStatus": "pending", "version": 3}, "timeline": [{"episode": 1, "startSeconds": .5, "endSeconds": 2}]},
            "hook": {"boundary_status": "verified", "start_seconds": .1, "end_seconds": .9, "safe_start": {"status": "verified"}, "safe_end": {"status": "verified"}},
            "material": {"collectionId": "materials", "id": "hook-1", "video": "hook.mp4"},
            "match": {"segments": [{"episode": 1, "start": .5, "end": 2, "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}}]},
            "episodes": self._episodes(), "render": {"id": "preview", "version": 4, "render_config": {"purpose": "transition_review", "transitionVersion": 3}},
        }
        with patch("processor.factory_render._executable", self._pinned_executable):
            result = render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=TEST_CONSTRAINTS)
        self.assertTrue(result["validation"]["passed"])
        self.assertEqual([item["kind"] for item in result["boundary_ledger"]], ["hook", "episode", "transition"])

    def test_continuous_narration_downloads_mixes_and_burns_subtitles(self) -> None:
        self._create_source("episodes", "episode-long", "episode-long.mp4", "purple", 62, 330)
        audio = self.http_root / "narration.m4a"
        subprocess.run([str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=60", "-c:a", "aac", str(audio)], check=True)
        response = {
            "project": {"mode": "episode-splice", "title": "narration-real", "ratio": "9:16", "transition": {"type": "continuous_narration", "gapDiagnosis": ["causal"], "start": 0, "end": 60, "copy": "", "script": "A real continuous narration subtitle.", "language": "en", "voice": {"mode": "manual_audio", "audioUrl": f"{self.base_url}/narration.m4a", "speakingRate": 1}, "evidence": [{"source": "test"}], "renderConfig": {"subtitleEnabled": True, "originalAudioDuckDb": -18, "keyOriginalAudioWindows": [{"start": 10, "end": 12}]}, "reviewStatus": "approved", "reviewerNote": "approved real audio", "version": 1}, "timeline": [{"episode": 3, "startSeconds": 0, "endSeconds": 60, "safeStart": {"status": "verified", "source": "approved_highlight", "highlightAssetId": "h3"}, "safeEnd": {"status": "verified", "source": "episode_end"}}]},
            "episodes": [{"collectionId": "episodes", "id": "episode-long", "episode_number": 3, "video": "episode-long.mp4"}], "render": {"id": "narration", "version": 1},
        }
        constraints = RenderConstraints(dimensions={"9:16": (180, 320)}, episode_splice_duration=(50, 70), external_hook_duration=(50, 70))
        with patch("processor.factory_render._executable", self._pinned_executable):
            result = render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=constraints)
        self.assertTrue(result["validation"]["passed"])
        self.assertEqual(result["validation"]["transition"], "continuous_narration")
        self.assertEqual(result["validation"]["transitionVersion"], 1)
        self.assertIsNone(result["validation"]["audioAssetId"])

    def test_external_hook_renders_hook_and_sequential_drama_body(self) -> None:
        response = {
            "project": {
                "mode": "external-hook", "title": "media-e2e-external", "ratio": "9:16", "language": "英语",
                "transition": {"type": "transition_copy", "gapDiagnosis": ["causal"], "start": 0.9, "end": 0.9, "copy": "Meanwhile", "language": "en", "evidence": [{"source": "test", "verification": "verified"}], "renderConfig": {"effect": "fade", "durationSeconds": 0.8, "fadeSeconds": 0.1}, "reviewStatus": "approved", "reviewerNote": "test approval", "version": 1, "bodyAssemblyMode": "sequential_from_highlight"},
                "timeline": [
                    {"episode": 1, "startSeconds": 0.5, "endSeconds": 2.0},
                    {"episode": 2, "startSeconds": 0, "endSeconds": 2.0},
                ],
            },
            "hook": {
                "source_class": "narration_opening", "boundary_status": "verified", "start_seconds": 0.1, "end_seconds": 0.9,
                "safe_start": {"status": "verified", "source": "material_boundary"},
                "safe_end": {"status": "verified", "source": "material_boundary"},
            },
            "material": {"collectionId": "materials", "id": "hook-1", "video": "hook.mp4"},
            "match": {"segments": [{
                "episode": 1, "start": 0.5, "end": 2.0,
                "safeStart": {"status": "verified", "source": "approved_highlight_start"},
                "safeEnd": {"status": "verified", "source": "episode_end"},
            }]},
            "episodes": self._episodes(),
            "render": {"id": "external-render", "version": 2},
        }
        with patch("processor.factory_render._executable", self._pinned_executable):
            result = render_factory_project(response, self.base_url, self.workspace, self.output_root, constraints=TEST_CONSTRAINTS)
        self._assert_published_media(result, [1, 2], 4)
        self.assertEqual([item["kind"] for item in result["boundary_ledger"]], ["hook", "episode", "episode", "transition"])
        self.assertGreater(result["boundary_ledger"][-1]["renderedDuration"], 0)


if __name__ == "__main__":
    unittest.main()
