"""ElevenLabs Scribe v2 adapter with content-aware transcript caching."""

from __future__ import annotations

import hashlib
import json
import os
import random
import time
from pathlib import Path
from typing import Any

import requests

SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
MODEL_ID = "scribe_v2"


def load_api_key() -> str:
    value = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if value:
        return value
    candidates = [
        Path(__file__).resolve().parents[1] / ".env",
        Path.home() / "Developer" / "video-use" / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("ELEVENLABS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("未找到 ELEVENLABS_API_KEY，请复制 .env.example 为 .env 后填写")


def source_fingerprint(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Hash file identity without reading multi-GB footage in full."""
    stat = path.stat()
    digest = hashlib.sha256()
    digest.update(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}".encode())
    with path.open("rb") as source:
        digest.update(source.read(chunk_size))
        if stat.st_size > chunk_size:
            source.seek(max(0, stat.st_size - chunk_size))
            digest.update(source.read(chunk_size))
    return digest.hexdigest()


def transcript_path(source: Path, edit_dir: Path) -> Path:
    safe_stem = f"{source.parent.name}__{source.stem}".replace("/", "_")
    return edit_dir / "transcripts" / f"{safe_stem}.json"


def is_cache_valid(source: Path, output: Path) -> bool:
    if not output.exists():
        return False
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
        return payload.get("_lumina", {}).get("source_fingerprint") == source_fingerprint(source)
    except (OSError, ValueError):
        return False


def call_scribe(
    source: Path,
    api_key: str,
    language: str | None = None,
    num_speakers: int | None = None,
    keyterms: list[str] | None = None,
    retries: int = 3,
) -> dict[str, Any]:
    data: dict[str, str] = {
        "model_id": MODEL_ID,
        "diarize": "true",
        "tag_audio_events": "true",
        "timestamps_granularity": "word",
        "no_verbatim": "false",
    }
    if language:
        data["language_code"] = language
    if num_speakers:
        data["num_speakers"] = str(num_speakers)
    if keyterms:
        data["keyterms"] = json.dumps(keyterms[:1000], ensure_ascii=False)

    for attempt in range(retries):
        try:
            with source.open("rb") as file_obj:
                response = requests.post(
                    SCRIBE_URL,
                    headers={"xi-api-key": api_key},
                    files={"file": (source.name, file_obj, "application/octet-stream")},
                    data=data,
                    timeout=(30, 3600),
                )
            if response.status_code == 200:
                return response.json()
            if response.status_code in {401, 403}:
                raise RuntimeError("ElevenLabs API Key 无效或没有 Scribe 权限")
            if response.status_code not in {408, 429, 500, 502, 503, 504}:
                raise RuntimeError(f"Scribe 请求失败 {response.status_code}: {response.text[:300]}")
        except requests.RequestException as exc:
            if attempt == retries - 1:
                raise RuntimeError(f"Scribe 网络请求失败: {exc}") from exc
        if attempt < retries - 1:
            time.sleep((2**attempt) + random.random())
    raise RuntimeError("Scribe 多次重试后仍未成功")


def transcribe(
    source: Path,
    edit_dir: Path,
    language: str | None = None,
    num_speakers: int | None = None,
    keyterms: list[str] | None = None,
    force: bool = False,
) -> tuple[Path, bool]:
    output = transcript_path(source, edit_dir)
    output.parent.mkdir(parents=True, exist_ok=True)
    if not force and is_cache_valid(source, output):
        return output, True

    payload = call_scribe(source, load_api_key(), language, num_speakers, keyterms)
    payload["_lumina"] = {
        "source": str(source.resolve()),
        "source_fingerprint": source_fingerprint(source),
        "model": MODEL_ID,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verbatim": True,
        "word_timestamps": True,
    }
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)
    return output, False
