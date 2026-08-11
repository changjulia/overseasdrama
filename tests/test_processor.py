import json
import tempfile
import unittest
from pathlib import Path

from processor.pack import group_phrases, pack_transcripts
from processor.scribe import is_cache_valid, source_fingerprint
from processor.batch_transcribe import select_free_episodes


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
            text = packed.read_text()
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


if __name__ == "__main__":
    unittest.main()
