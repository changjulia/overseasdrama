"""Convert raw word-level Scribe responses into compact scene-ready text."""

from __future__ import annotations

import json
from pathlib import Path


def group_phrases(words: list[dict], silence: float = 0.5) -> list[dict]:
    phrases: list[dict] = []
    current: list[dict] = []
    speaker = None
    previous_end = None

    def flush() -> None:
        nonlocal current, speaker
        if not current:
            return
        parts = []
        for word in current:
            text = str(word.get("text", "")).strip()
            if not text:
                continue
            if word.get("type") == "audio_event" and not text.startswith("("):
                text = f"({text})"
            parts.append(text)
        text = " ".join(parts)
        for mark in [",", ".", "?", "!", ":", ";"]:
            text = text.replace(f" {mark}", mark)
        if text:
            phrases.append({
                "start": current[0].get("start", 0.0),
                "end": current[-1].get("end", current[-1].get("start", 0.0)),
                "speaker_id": speaker,
                "text": text,
            })
        current = []
        speaker = None

    for word in words:
        if word.get("type") == "spacing":
            if float(word.get("end", 0)) - float(word.get("start", 0)) >= silence:
                flush()
            continue
        start = word.get("start")
        if start is None:
            continue
        next_speaker = word.get("speaker_id")
        if current and ((speaker and next_speaker and speaker != next_speaker) or (previous_end is not None and start - previous_end >= silence)):
            flush()
        if not current:
            speaker = next_speaker
        current.append(word)
        previous_end = word.get("end", start)
    flush()
    return phrases


def pack_transcripts(edit_dir: Path, silence: float = 0.5) -> Path:
    transcript_files = sorted((edit_dir / "transcripts").glob("*.json"))
    if not transcript_files:
        raise RuntimeError(f"没有找到转写结果：{edit_dir / 'transcripts'}")
    lines = ["# 剧集词级转写包", "", f"按说话人切换或 ≥ {silence:.1f}s 静音分句。", ""]
    manifest = []
    for transcript_file in transcript_files:
        payload = json.loads(transcript_file.read_text(encoding="utf-8"))
        phrases = group_phrases(payload.get("words", []), silence)
        source = payload.get("_lumina", {}).get("source", transcript_file.stem)
        lines.extend([f"## {transcript_file.stem}", f"源文件：`{source}`", ""])
        for phrase in phrases:
            tag = str(phrase.get("speaker_id") or "S?").replace("speaker_", "S")
            lines.append(f"[{phrase['start']:08.2f}-{phrase['end']:08.2f}] {tag} {phrase['text']}")
        lines.append("")
        manifest.append({"name": transcript_file.stem, "source": source, "phrases": len(phrases)})
    packed = edit_dir / "takes_packed.md"
    packed.write_text("\n".join(lines), encoding="utf-8")
    (edit_dir / "transcript_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return packed
