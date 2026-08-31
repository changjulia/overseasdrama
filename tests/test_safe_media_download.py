from __future__ import annotations

import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from processor.factory_render import _narration_cues, _validated_original_audio_windows
from processor.safe_media_download import download_same_origin_media
from processor.semantic_analysis import AnalysisFailed


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        if self.path == "/audio":
            body = b"audio-bytes"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/large":
            self.send_response(200)
            self.send_header("Content-Length", "1000")
            self.end_headers()
        elif self.path == "/stream-large":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"x" * 20)
        elif self.path == "/redirect-safe":
            self.send_response(302)
            self.send_header("Location", "/audio")
            self.end_headers()
        elif self.path == "/redirect-private":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data")
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


class SafeNarrationDownloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="safe-narration-")
        self.root = Path(self.temp.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def test_accepts_bounded_same_origin_upload_and_safe_redirect(self) -> None:
        for path in ("/audio", "/redirect-safe"):
            target = self.root / (path.removeprefix("/") + ".bin")
            self.assertEqual(download_same_origin_media(self.base + path, target, trusted_base_url=self.base), 11)
            self.assertEqual(target.read_bytes(), b"audio-bytes")

    def test_rejects_arbitrary_origin_and_cross_origin_redirect(self) -> None:
        with self.assertRaisesRegex(AnalysisFailed, "trusted media origin"):
            download_same_origin_media("http://127.0.0.1:1/private", self.root / "private", trusted_base_url=self.base)
        with self.assertRaisesRegex(AnalysisFailed, "trusted media origin"):
            download_same_origin_media(self.base + "/redirect-private", self.root / "metadata", trusted_base_url=self.base)

    def test_enforces_declared_and_streamed_size_without_publishing_partial_file(self) -> None:
        for path in ("/large", "/stream-large"):
            target = self.root / (path.removeprefix("/") + ".bin")
            with self.assertRaisesRegex(AnalysisFailed, "exceeds"):
                download_same_origin_media(self.base + path, target, trusted_base_url=self.base, max_bytes=12)
            self.assertFalse(target.exists())

    def test_subtitles_are_split_into_readable_duration_weighted_cues(self) -> None:
        cues = _narration_cues("<font size=99>First</font> sentence creates suspense. Second sentence explains the relationship. Third sentence enters the episode.", 60)
        self.assertGreaterEqual(len(cues), 3)
        self.assertEqual(cues[0][0], 0)
        self.assertEqual(cues[-1][1], 60)
        self.assertTrue(all(end > start and len(text) <= 48 for start, end, text in cues))
        self.assertNotIn("<", "".join(text for _, _, text in cues))

    def test_original_audio_windows_must_be_bounded_sorted_and_non_overlapping(self) -> None:
        self.assertEqual(_validated_original_audio_windows({"keyOriginalAudioWindows": [{"start": 2, "end": 4}, {"start": 5, "end": 7}]}, 10), [(2, 4), (5, 7)])
        for windows in ([{"start": -1, "end": 2}], [{"start": 2, "end": 11}], [{"start": 3, "end": 5}, {"start": 4, "end": 6}]):
            with self.assertRaises(AnalysisFailed):
                _validated_original_audio_windows({"keyOriginalAudioWindows": windows}, 10)
        with self.assertRaises(AnalysisFailed):
            _validated_original_audio_windows({"keyOriginalAudioWindows": [{"start": float("nan"), "end": 2}]}, 10)


if __name__ == "__main__":
    unittest.main()
