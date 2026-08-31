from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from processor.factory_render import (
    _concat_with_audio_crossfades,
    _loudnorm_measurement,
    _normalize_audio_loudness,
    _render_narration_mix,
    _write_narration_ass,
)


ROOT = Path(__file__).resolve().parent.parent
FFMPEG = ROOT / "node_modules/ffmpeg-static/ffmpeg"
FFPROBE = next(
    (item for item in sorted((ROOT / "node_modules/@ffprobe-installer").glob("*/ffprobe*")) if item.is_file() and os.access(item, os.X_OK)),
    ROOT / "node_modules/@ffprobe-installer/missing-ffprobe",
)


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


class FactoryAudioEnhancementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FFMPEG.is_file() or not FFPROBE.is_file():
            raise unittest.SkipTest("project-pinned ffmpeg/ffprobe are unavailable")

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="factory-audio-")
        self.root = Path(self.temp.name)
        self.http = self.root / "http"
        self.http.mkdir()
        handler = partial(_QuietHandler, directory=str(self.http))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    @staticmethod
    def _exe(name: str) -> str:
        return str(FFMPEG if name == "ffmpeg" else FFPROBE)

    def _tone_video(self, target: Path, frequency: int, duration: float, volume: float = .1) -> None:
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=navy:s=64x64:r=25:d={duration}",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration={duration}",
            "-filter:a", f"volume={volume}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(target),
        ], check=True, capture_output=True)

    def _band_mean(self, media: Path, start: float, duration: float, frequency: int) -> float:
        result = subprocess.run([
            str(FFMPEG), "-hide_banner", "-nostats", "-ss", str(start), "-t", str(duration), "-i", str(media),
            "-vn", "-af", f"bandpass=f={frequency}:width_type=h:w=30,volumedetect", "-f", "null", "-",
        ], check=True, capture_output=True, text=True)
        match = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", result.stderr)
        self.assertIsNotNone(match, result.stderr)
        return float(match.group(1))

    def test_two_pass_loudnorm_converges_different_inputs_to_standard_loudness(self) -> None:
        quiet, loud = self.root / "quiet.mp4", self.root / "loud.mp4"
        quiet_out, loud_out = self.root / "quiet-normalized.mp4", self.root / "loud-normalized.mp4"
        self._tone_video(quiet, 440, 3, .01)
        self._tone_video(loud, 440, 3, .5)
        with patch("processor.factory_render._executable", self._exe):
            _normalize_audio_loudness(quiet, quiet_out, target_i=-14.0)
            _normalize_audio_loudness(loud, loud_out, target_i=-14.0)
            quiet_i = _loudnorm_measurement(quiet_out, -14.0)["input_i"]
            loud_i = _loudnorm_measurement(loud_out, -14.0)["input_i"]
        self.assertAlmostEqual(quiet_i, -14.0, delta=.7)
        self.assertAlmostEqual(loud_i, -14.0, delta=.7)
        self.assertAlmostEqual(quiet_i, loud_i, delta=.3)

    def test_audio_boundaries_use_real_acrossfade(self) -> None:
        first, second, output = self.root / "first.mp4", self.root / "second.mp4", self.root / "crossfaded.mp4"
        self._tone_video(first, 440, 1)
        self._tone_video(second, 880, 1)
        with patch("processor.factory_render._executable", self._exe):
            _concat_with_audio_crossfades([first, second], output, fade_seconds=.05)
        probe = subprocess.run([
            str(FFPROBE), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "default=nw=1:nk=1", str(output),
        ], check=True, capture_output=True, text=True)
        # acrossfade overlaps 50 ms of the two one-second streams; a plain
        # concat would retain a two-second audio stream.
        self.assertAlmostEqual(float(probe.stdout.strip()), 1.95, delta=.04)
        self.assertGreater(self._band_mean(output, .955, .035, 440), -55)
        self.assertGreater(self._band_mean(output, .955, .035, 880), -55)

    def test_narration_presence_dynamically_ducks_original_audio(self) -> None:
        source = self.root / "source.mp4"
        narration = self.http / "narration.m4a"
        output = self.root / "mixed.mp4"
        self._tone_video(source, 440, 60, .25)
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "aevalsrc=if(between(t\\,10\\,50)\\,0.25*sin(2*PI*880*t)\\,0):s=48000:d=60",
            "-c:a", "aac", str(narration),
        ], check=True, capture_output=True)
        transition = {
            "start": 0, "end": 60, "script": "Narration begins, bridges the story, and then enters the episode.",
            "voice": {"mode": "manual_audio", "audioUrl": f"{self.base_url}/narration.m4a"},
            "renderConfig": {"subtitleEnabled": False, "originalAudioDuckDb": -18},
        }
        with patch("processor.factory_render._executable", self._exe):
            _render_narration_mix(source, output, transition, self.root, trusted_base_url=self.base_url, subtitle_width=64, subtitle_height=64)
            integrated = _loudnorm_measurement(output, -14.0)["input_i"]
        original_without_voice = self._band_mean(output, 4, 2, 440)
        original_under_voice = self._band_mean(output, 20, 2, 440)
        self.assertLess(original_under_voice, original_without_voice - 4.0)
        self.assertAlmostEqual(integrated, -14.0, delta=.8)

    def test_ass_template_is_wrapped_to_safe_lines_and_really_rendered(self) -> None:
        subtitle = self.root / "template.ass"
        config = {"subtitleTemplateId": "test-yellow", "subtitleStyle": {
            "fontFamily": "Arial", "fontSize": 24, "primaryColor": "#FFE34D", "outlineColor": "#111111",
            "outlineWidth": 3, "shadowDepth": 1, "bold": True, "alignment": "center",
            "marginHorizontalPercent": 10, "marginVerticalPercent": 18, "maxLines": 2,
        }}
        _write_narration_ass(subtitle, [(0, 2, "A long reviewed narration sentence that must remain inside the configured safe subtitle area.")], config, 180, 320)
        document = subtitle.read_text(encoding="utf-8")
        self.assertIn("PlayResX: 180", document)
        self.assertIn("&H004DE3FF&", document)  # ASS stores #FFE34D as BBGGRR.
        self.assertIn(",5,18,18,58,1", document)
        dialogue_lines = [line for line in document.splitlines() if line.startswith("Dialogue:")]
        self.assertGreater(len(dialogue_lines), 1)
        self.assertTrue(all(line.count("\\N") <= 1 for line in dialogue_lines))
        rendered = self.root / "ass-frame.rgb"
        subprocess.run([
            str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=180x320:r=1:d=2",
            "-vf", f"ass='{subtitle.as_posix()}'", "-ss", "1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", str(rendered),
        ], check=True, capture_output=True)
        pixels = rendered.read_bytes()
        yellow_pixels = sum(1 for index in range(0, len(pixels), 3) if pixels[index] > 150 and pixels[index + 1] > 120 and pixels[index + 2] < 130)
        self.assertGreater(yellow_pixels, 20)


if __name__ == "__main__":
    unittest.main()
