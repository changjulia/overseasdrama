"""Offline failure-injection checks for the factory render release gate.

The suite intentionally uses only temporary files and a loopback HTTP server.
It never opens PocketBase and never writes into the public render directory.
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from processor.factory_render import (
    RenderConstraints,
    _download,
    _render_clip,
    build_render_quality_report,
    render_factory_project,
)
from processor.job_worker import classify_failure
from processor.semantic_analysis import AnalysisFailed


ROOT = Path(__file__).resolve().parents[2]
FFMPEG = ROOT / "node_modules" / "ffmpeg-static" / "ffmpeg"
FFPROBE_CANDIDATES = sorted((ROOT / "node_modules" / "@ffprobe-installer").glob("*/ffprobe"))
FFPROBE = FFPROBE_CANDIDATES[0] if FFPROBE_CANDIDATES else ROOT / "node_modules" / "@ffprobe-installer" / "missing-ffprobe"


class ReleaseFailureInjection(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FFMPEG.is_file() or not FFPROBE.is_file():
            raise unittest.SkipTest("project-pinned ffmpeg and ffprobe are required")
        cls.tmp = tempfile.TemporaryDirectory(prefix="lumina-failure-injection-")
        cls.root = Path(cls.tmp.name)
        cls.http_root = cls.root / "http"
        cls.http_root.mkdir()
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(cls.http_root))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def setUp(self) -> None:
        self._path = patch.dict(os.environ, {"LUMINA_FFMPEG_PATH": str(FFMPEG), "LUMINA_FFPROBE_PATH": str(FFPROBE)})
        self._path.start()

    def tearDown(self) -> None:
        self._path.stop()

    def test_missing_or_http_failed_source_is_not_silently_accepted(self) -> None:
        with self.assertRaises(Exception) as caught:
            _download(f"{self.base_url}/absent.mp4", self.root / "absent.mp4")
        self.assertIn("404", str(caught.exception))
        self.assertFalse((self.root / "absent.mp4").exists())

    def test_corrupt_media_is_rejected(self) -> None:
        source = self.root / "corrupt.mp4"
        source.write_bytes(b"not-an-mp4")
        with self.assertRaisesRegex(AnalysisFailed, "clip render failed"):
            _render_clip(source, self.root / "corrupt-output.mp4", 0, 1, False, False, 180, 320, 0)

    def test_video_without_audio_is_rejected_by_qc(self) -> None:
        source = self.root / "silent.mp4"
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "color=c=blue:s=180x320:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source),
        ], check=True)
        rendered = self.root / "silent-output.mp4"
        _render_clip(source, rendered, 0, .8, False, False, 180, 320, 0)
        probe = subprocess.run([
            str(FFPROBE), "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height",
            "-show_entries", "format=duration", "-of", "json", str(rendered),
        ], check=True, capture_output=True, text=True)
        report = build_render_quality_report(
            output=rendered, technical=json.loads(probe.stdout), expected_duration=.8, width=180, height=320,
            ledger=[{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "hook"}],
        )
        self.assertFalse(report["passed"])
        self.assertIn("AUDIO_SPEC", report["failureCodes"])

    def test_qc_rejects_duration_drift_and_codec_mismatch(self) -> None:
        output = self.root / "candidate.mp4"
        output.write_bytes(b"candidate")
        report = build_render_quality_report(
            output=output,
            technical={"format": {"duration": "12"}, "streams": [
                {"codec_type": "video", "codec_name": "vp9", "width": 180, "height": 320},
                {"codec_type": "audio", "codec_name": "opus"},
            ]},
            expected_duration=10, width=180, height=320,
            ledger=[{"status": "verified", "safeStart": {"status": "verified"}, "safeEnd": {"status": "verified"}, "kind": "hook"}],
        )
        self.assertFalse(report["passed"])
        self.assertTrue({"VIDEO_SPEC", "AUDIO_SPEC", "DURATION_CONSISTENCY", "STANDARD_LOUDNESS", "AUDIO_VIDEO_SYNC"}.issubset(set(report["failureCodes"])))

    def test_transient_failure_retries_but_permanent_media_failure_does_not(self) -> None:
        transient = classify_failure(TimeoutError("HTTP 503 connection timed out"))
        permanent = classify_failure(RuntimeError("ffmpeg failed: invalid argument"))
        self.assertEqual(transient, ("transient", True, 30))
        self.assertEqual(permanent, ("media", False, 0))

    def test_failed_qc_never_publishes_staged_or_partial_output(self) -> None:
        media = self.http_root / "episode.mp4"
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=red:s=180x320:r=30:d=1.2",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(media),
        ], check=True)
        served = self.http_root / "api" / "files" / "episodes" / "ep1"
        served.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(media, served / "episode.mp4")
        response = {
            "project": {"mode": "episode-splice", "title": "failure-injection", "ratio": "9:16", "transition": {"type": "direct_cut", "gapDiagnosis": ["causal"], "start": 0, "end": 0, "language": "zh-CN", "evidence": [{"source": "test"}], "renderConfig": {"effect": "hard_cut"}, "reviewStatus": "approved", "reviewerNote": "test approval", "version": 1}, "timeline": [{
                "episode": 1, "startSeconds": 0, "endSeconds": 1,
                "safeStart": {"status": "verified", "source": "approved_highlight", "highlightAssetId": "h1"},
                "safeEnd": {"status": "verified", "source": "episode_end"},
            }]},
            "episodes": [{"id": "ep1", "collectionId": "episodes", "episode_number": 1, "video": "episode.mp4"}],
            "render": {"id": "qc-fail", "version": 1},
        }
        workspace, public = self.root / "workspace", self.root / "public"
        workspace.mkdir(exist_ok=True)
        with patch("processor.factory_render.build_render_quality_report", return_value={"passed": False, "failureCodes": ["INJECTED_QC_FAILURE"]}):
            with self.assertRaisesRegex(AnalysisFailed, "INJECTED_QC_FAILURE"):
                render_factory_project(response, self.base_url, workspace, public, constraints=RenderConstraints(dimensions={"9:16": (180, 320)}, episode_splice_duration=(.5, 2)))
        self.assertFalse(public.exists(), "public directory must not be created before QC passes")
        self.assertEqual(list(self.root.rglob("*.partial")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
