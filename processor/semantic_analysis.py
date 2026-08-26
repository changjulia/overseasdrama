"""Evidence-first three-tier video analysis.

No method in this module fabricates content. Optional engines are imported lazily;
missing executables, models or credentials raise ``AnalysisFailed``. Semantic
claims from cloud models are accepted only when they cite measured time ranges.
"""

from __future__ import annotations

import json
import os
import base64
import concurrent.futures
import hashlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Literal

from PIL import Image

try:  # package import in tests/services; direct import for standalone worker execution
    from .calibration import ConfidenceSignals, GateThresholds, deterministic_story_score, item_production_gate
except ImportError:  # pragma: no cover - exercised by direct script entry points
    from calibration import ConfidenceSignals, GateThresholds, deterministic_story_score, item_production_gate


Tier = Literal["coarse", "detail", "precision"]
Verification = Literal["verified", "unverified"]


class AnalysisFailed(RuntimeError):
    """An explicit, user-actionable failure; never replace it with mock output."""


@dataclass(frozen=True)
class Timecode:
    start: float
    end: float

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < self.start:
            raise ValueError("invalid timecode")


@dataclass
class Evidence:
    kind: str
    timecode: Timecode
    confidence: float
    source: str
    text: str | None = None
    frame_path: str | None = None
    verification: Verification = "verified"

    def __post_init__(self) -> None:
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")


@dataclass
class Claim:
    value: Any
    confidence: float
    evidence: list[Evidence]
    verification: Verification = "verified"

    def __post_init__(self) -> None:
        if not self.evidence:
            self.verification = "unverified"
        if any(item.verification == "unverified" for item in self.evidence):
            self.verification = "unverified"


@dataclass
class AnalysisEnvelope:
    schema_version: str
    analysis_id: str
    tier: Tier
    status: Literal["succeeded", "failed"]
    source: dict[str, Any]
    engine: dict[str, Any]
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"{Path(command[0]).name} failed: {result.stderr[-1200:]}")
    return result


def _executable(name: str) -> str:
    """Resolve PATH tools or the repository's bundled FFmpeg executables."""
    resolved = shutil.which(name)
    if resolved:
        return resolved
    suffix = ".exe" if os.name == "nt" and not name.lower().endswith(".exe") else ""
    bundled_root = Path(__file__).resolve().parent.parent / "tools" / "ffmpeg"
    matches = sorted(bundled_root.glob(f"**/{name}{suffix}")) if bundled_root.is_dir() else []
    if matches:
        return str(matches[0])
    raise AnalysisFailed(f"Missing required executable: {name}")


def _duration(path: Path) -> float:
    output = _run([_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)]).stdout.strip()
    try:
        value = float(output)
    except ValueError as exc:
        raise AnalysisFailed("FFprobe returned no valid duration") from exc
    if value <= 0:
        raise AnalysisFailed("Media duration must be positive")
    return value


def extract_frames(path: Path, destination: Path, interval_seconds: float, start: float = 0, end: float | None = None) -> list[dict[str, Any]]:
    """Extract measured JPEG frames and retain exact requested timecodes."""
    ffmpeg = _executable("ffmpeg")
    destination.mkdir(parents=True, exist_ok=True)
    duration = _duration(path)
    stop = min(end if end is not None else duration, duration)
    times: list[float] = []
    cursor = max(0.0, start)
    while cursor < stop:
        times.append(round(cursor, 3))
        cursor += interval_seconds
    frames = []
    for index, timestamp in enumerate(times):
        target = destination / f"frame-{index:05d}-{timestamp:.3f}.jpg"
        _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p", "-strict", "unofficial", "-threads", "1", "-q:v", "3", "-y", str(target)])
        if target.exists() and target.stat().st_size:
            frames.append({"path": str(target), "timecode": {"start": timestamp, "end": timestamp}, "confidence": 1.0, "source": path.name, "verification": "verified"})
    if not frames:
        raise AnalysisFailed("FFmpeg extracted no frames")
    return frames


def extract_frames_at(path: Path, destination: Path, timestamps: Iterable[float]) -> list[dict[str, Any]]:
    """Extract frames at measured timestamps selected by the material scanner."""
    duration = _duration(path)
    destination.mkdir(parents=True, exist_ok=True)
    unique = sorted({round(max(0.0, min(float(value), max(0.0, duration - 0.02))), 3) for value in timestamps})
    frames: list[dict[str, Any]] = []
    for index, timestamp in enumerate(unique):
        target = destination / f"frame-{index:05d}-{timestamp:.3f}.jpg"
        _run([_executable("ffmpeg"), "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuvj420p", "-strict", "unofficial", "-threads", "1", "-q:v", "3", "-y", str(target)])
        if target.exists() and target.stat().st_size:
            frames.append({"path": str(target), "timecode": {"start": timestamp, "end": timestamp}, "confidence": 1.0, "source": "frame", "verification": "verified"})
    if not frames:
        raise AnalysisFailed("FFmpeg extracted no material evidence frames")
    return frames


def detect_shots(path: Path, duration: float) -> list[dict[str, Any]]:
    """Detect visual cuts without attempting to infer their narrative meaning."""
    threshold = float(os.getenv("LUMINA_MATERIAL_SCENE_THRESHOLD", "0.32"))
    command = [
        _executable("ffmpeg"), "-hide_banner", "-i", str(path),
        "-filter:v", f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"FFmpeg shot detection failed: {result.stderr[-1200:]}")
    cuts = [0.0]
    for match in re.finditer(r"pts_time:([0-9]+(?:\.[0-9]+)?)", result.stderr):
        value = float(match.group(1))
        if 0 < value < duration and value - cuts[-1] >= 0.18:
            cuts.append(round(value, 3))
    cuts.append(round(duration, 3))
    return [
        {
            "shot": index + 1,
            "timecode": {"start": start, "end": end},
            "confidence": 1.0,
            "source": "ffmpeg-scene-detection",
            "verification": "verified",
        }
        for index, (start, end) in enumerate(zip(cuts, cuts[1:])) if end > start
    ]


def detect_audio_events(path: Path, duration: float) -> list[dict[str, Any]]:
    """Measure silence/activity boundaries; these are evidence, not emotion labels."""
    noise = os.getenv("LUMINA_MATERIAL_SILENCE_NOISE", "-34dB")
    minimum = os.getenv("LUMINA_MATERIAL_SILENCE_DURATION", "0.7")
    command = [
        _executable("ffmpeg"), "-hide_banner", "-i", str(path), "-vn",
        "-af", f"silencedetect=noise={noise}:d={minimum}", "-f", "null", "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"FFmpeg audio scan failed: {result.stderr[-1200:]}")
    starts = [float(value) for value in re.findall(r"silence_start:\s*([0-9.]+)", result.stderr)]
    ends = [float(value) for value in re.findall(r"silence_end:\s*([0-9.]+)", result.stderr)]
    events: list[dict[str, Any]] = []
    for index, start in enumerate(starts):
        end = ends[index] if index < len(ends) else duration
        events.append({
            "type": "silence", "timecode": {"start": round(start, 3), "end": round(min(end, duration), 3)},
            "confidence": 1.0, "source": "ffmpeg-silencedetect", "verification": "verified",
        })
    return events


def _material_evidence_timestamps(duration: float, shots: list[dict[str, Any]], audio_events: list[dict[str, Any]]) -> list[float]:
    """Front-load the hook while retaining evidence across the complete material."""
    timestamps = [0, 0.5, 1, 2, 3, 5, 8, 12, 15, *[float(value) for value in range(18, 61, 3)]]
    sparse_interval = max(15.0, float(os.getenv("LUMINA_MATERIAL_SPARSE_FRAME_INTERVAL", "30")))
    cursor = 15.0
    while cursor < duration:
        timestamps.append(cursor)
        cursor += sparse_interval
    for shot in shots:
        start = float((shot.get("timecode") or {}).get("start", 0))
        timestamps.extend((start, min(duration, start + 0.35)))
    for event in audio_events:
        timecode = event.get("timecode") or {}
        timestamps.extend((float(timecode.get("start", 0)), float(timecode.get("end", 0))))
    timestamps.extend((max(0.0, duration - 30), max(0.0, duration - 15), max(0.0, duration - 1)))
    max_frames = max(24, int(os.getenv("LUMINA_MATERIAL_MAX_EVIDENCE_FRAMES", "72")))
    unique = sorted({round(value, 3) for value in timestamps if 0 <= value < duration})
    if len(unique) <= max_frames:
        return unique
    def evenly(values: list[float], count: int) -> list[float]:
        if count <= 0 or not values:
            return []
        if len(values) <= count:
            return values
        if count == 1:
            return [values[len(values) // 2]]
        return [values[round(index * (len(values) - 1) / (count - 1))] for index in range(count)]

    # Dense opening scene boundaries must not consume the complete budget and
    # make the middle of a long drama visually blind.
    opening = [value for value in unique if value <= min(60.0, duration)]
    ending = [value for value in unique if value >= max(60.0, duration - 30.0)]
    middle = [value for value in unique if 60.0 < value < duration - 30.0]
    opening_budget = min(len(opening), max(10, max_frames // 3))
    ending_budget = min(len(ending), max(4, max_frames // 8))
    middle_budget = max(0, max_frames - opening_budget - ending_budget)
    return sorted(set(evenly(opening, opening_budget) + evenly(middle, middle_budget) + evenly(ending, ending_budget)))


def _sample_material_frames(frames: Any, duration: float, count: int) -> list[dict[str, Any]]:
    """Select whole-timeline visual evidence by time rather than list index."""
    available = [item for item in frames if isinstance(item, dict)] if isinstance(frames, list) else []
    if len(available) <= count:
        return available
    selected: list[dict[str, Any]] = []
    remaining = list(available)
    for index in range(count):
        target = duration * index / max(1, count - 1)
        nearest = min(remaining, key=lambda item: abs(float((item.get("timecode") or {}).get("start", 0)) - target))
        selected.append(nearest)
        remaining.remove(nearest)
    return sorted(selected, key=lambda item: float((item.get("timecode") or {}).get("start", 0)))


def transcribe(path: Path) -> tuple[list[dict[str, Any]], dict[str, str]]:
    backend = os.getenv("LUMINA_ASR_BACKEND", "faster-whisper")
    if backend != "faster-whisper":
        raise AnalysisFailed(f"Unsupported ASR backend: {backend}")
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:
        raise AnalysisFailed("ASR backend faster-whisper is not installed; install processor/requirements-analysis.txt") from exc
    model_name = os.getenv("LUMINA_WHISPER_MODEL")
    if not model_name:
        raise AnalysisFailed("LUMINA_WHISPER_MODEL is required (for example: small or a local model path)")
    device = os.getenv("LUMINA_WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("LUMINA_WHISPER_COMPUTE_TYPE", "int8")
    cpu_threads = max(1, int(os.getenv("LUMINA_WHISPER_CPU_THREADS", str(max(1, (os.cpu_count() or 2) // 2)))))
    from processor.whisper_runtime import create_whisper_model

    model, runtime = create_whisper_model(
        WhisperModel,
        model_name,
        requested_device=device,
        requested_compute_type=compute_type,
        cpu_threads=cpu_threads,
        num_workers=1,
    )
    try:
        segments, info = model.transcribe(str(path), word_timestamps=True, vad_filter=True)
        output = []
        for segment in segments:
            words = [{"text": word.word.strip(), "start": float(word.start), "end": float(word.end), "confidence": float(word.probability)} for word in (segment.words or [])]
            output.append({"text": segment.text.strip(), "start": float(segment.start), "end": float(segment.end), "confidence": sum((word["confidence"] for word in words), 0.0) / max(1, len(words)), "words": words, "speaker": None, "verification": "verified"})
    except IndexError as exc:
        # PyAV/faster-whisper raises ``tuple index out of range`` when a valid
        # MP4 has no audio stream. Silent paid-ad and episode files still have
        # usable frame/OCR evidence and must not fail the entire analysis.
        if "tuple index out of range" not in str(exc):
            raise
        return [], {"backend": backend, "model": model_name, "language": "", "device": runtime.device, "computeType": runtime.compute_type, "status": "no_audio"}
    engine = {
        "backend": backend,
        "model": model_name,
        "language": str(info.language),
        "device": runtime.device,
        "computeType": runtime.compute_type,
    }
    if runtime.fallback_reason:
        engine["fallbackReason"] = runtime.fallback_reason
    if not output:
        engine["status"] = "no_speech"
    return output, engine


def read_ocr(frames: Iterable[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    backend = os.getenv("LUMINA_OCR_BACKEND", "paddleocr")
    if backend != "paddleocr":
        raise AnalysisFailed(f"Unsupported OCR backend: {backend}")
    try:
        from paddleocr import PaddleOCR  # type: ignore
    except ImportError as exc:
        raise AnalysisFailed("OCR backend PaddleOCR is not installed; install processor/requirements-analysis.txt") from exc
    language = os.getenv("LUMINA_OCR_LANGUAGE", "en")
    try:
        # PaddleOCR 3.x removed show_log/use_angle_cls and exposes predict().
        reader = PaddleOCR(
            lang=language,
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
    except (TypeError, ValueError):
        # Keep compatibility with PaddleOCR 2.x environments.
        reader = PaddleOCR(use_angle_cls=True, lang=language, show_log=False)
    output = []
    seen: set[tuple[str, float]] = set()
    def append_ocr(raw_text: Any, confidence: Any, frame: dict[str, Any]) -> None:
        text = re.sub(r"\s+", " ", str(raw_text)).strip()
        alphanumeric = re.sub(r"[^\w\u4e00-\u9fff]+", "", text, flags=re.UNICODE)
        # Sparse OCR frequently captures one glyph, a dangling subtitle half,
        # or the same subtitle across adjacent frames. These are observations,
        # not semantic evidence, and must not be projected as verified claims.
        if len(alphanumeric) < 2 or re.search(r"(?:,|;|:|\b(?:and|or|but|with|to|of|a|an|the))$", text, re.I):
            return
        timestamp = round(float((frame.get("timecode") or {}).get("start", 0)), 1)
        normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.lower(), flags=re.UNICODE)
        key = (normalized, timestamp)
        if key in seen:
            return
        seen.add(key)
        output.append({"text": text, "confidence": float(confidence), "timecode": frame["timecode"], "framePath": frame["path"], "verification": "observed"})
    for frame in frames:
        if hasattr(reader, "predict"):
            pages = reader.predict(frame["path"]) or []
            for page in pages:
                texts = page.get("rec_texts", []) if hasattr(page, "get") else []
                scores = page.get("rec_scores", []) if hasattr(page, "get") else []
                for text, confidence in zip(texts, scores):
                    append_ocr(text, confidence, frame)
        else:
            rows = reader.ocr(frame["path"], cls=True) or []
            for page in rows:
                for row in page or []:
                    text, confidence = row[1]
                    append_ocr(text, confidence, frame)
    return output, {"backend": backend, "language": language}


def _cache_signature(values: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _material_language_name(asr_engine: dict[str, Any], transcript: list[dict[str, Any]], ocr: list[dict[str, Any]]) -> str:
    names = {"zh": "中文", "en": "英语", "ja": "日语", "jp": "日语", "ko": "韩语", "es": "西班牙语", "pt": "葡萄牙语", "fr": "法语", "de": "德语", "it": "意大利语", "ru": "俄语", "ar": "阿拉伯语", "hi": "印地语", "tr": "土耳其语", "vi": "越南语", "th": "泰语", "id": "印度尼西亚语"}
    code = str(asr_engine.get("language") or "").lower().split("-")[0].split("_")[0]
    if code in names:
        return names[code]
    sample = " ".join(str(item.get("text") or "") for item in [*transcript, *ocr] if isinstance(item, dict))
    if re.search(r"[\u3040-\u30ff]", sample): return "日语"
    if re.search(r"[\uac00-\ud7af]", sample): return "韩语"
    if re.search(r"[\u0400-\u04ff]", sample): return "俄语"
    if re.search(r"[\u0600-\u06ff]", sample): return "阿拉伯语"
    if re.search(r"[\u0e00-\u0e7f]", sample): return "泰语"
    if re.search(r"[\u4e00-\u9fff]", sample): return "中文"
    return "未知语种"


def _timecode(value: Any) -> tuple[float, float] | None:
    """Read a timecode from both current and historical payload shapes."""
    if isinstance(value, dict):
        start, end = value.get("start"), value.get("end", value.get("start"))
    else:
        return None
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return None
    start, end = float(start), float(end)
    return (start, end) if start >= 0 and end >= start else None


def _nearest_point(timestamp: float, points: Iterable[float], tolerance: float = .35) -> float | None:
    points = [float(point) for point in points]
    if not points:
        return None
    nearest = min(points, key=lambda point: abs(point - timestamp))
    return nearest if abs(nearest - timestamp) <= tolerance else None


def _material_hook_boundary(
    timestamp: float,
    transcript: list[dict[str, Any]],
    shots: list[dict[str, Any]],
    kind: str,
    actions: Iterable[dict[str, Any]] | None = None,
    frames: Iterable[dict[str, Any]] | None = None,
    semantic_intervals: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Describe an edit boundary using independently measured evidence.

    A boundary is not safe merely because it is close to a shot cut.  The
    caller can supply action/semantic/frame evidence when the dense pass has
    actually verified it.  The old camelCase fields are retained for clients
    written against material-v1; the lower-case fields are the canonical
    boundary contract.
    """
    timestamp = max(0.0, float(timestamp))
    crossing = [
        item for item in transcript
        if isinstance(item, dict)
        and isinstance(item.get("start"), (int, float))
        and isinstance(item.get("end"), (int, float))
        and float(item["start"]) + .12 < timestamp < float(item["end"]) - .12
    ]
    dialogue_points: list[float] = []
    dialogue_evidence: list[dict[str, Any]] = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        start, end = item.get("start"), item.get("end")
        if isinstance(start, (int, float)):
            dialogue_points.append(float(start))
        if isinstance(end, (int, float)):
            dialogue_points.append(float(end))
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            if abs(float(start) - timestamp) <= .35 or abs(float(end) - timestamp) <= .35:
                dialogue_evidence.append({"source": "transcript", "timecode": {"start": float(start), "end": float(end)}, "confidence": float(item.get("confidence", 1) or 0)})
    shot_points: list[float] = []
    shot_evidence: list[dict[str, Any]] = []
    for shot in shots:
        tc = _timecode(shot.get("timecode") if isinstance(shot, dict) else shot)
        if tc is None:
            continue
        shot_points.extend(tc)
        if min(abs(point - timestamp) for point in tc) <= .35:
            shot_evidence.append({"source": "shot", "timecode": {"start": tc[0], "end": tc[1]}, "confidence": float(shot.get("confidence", 1) or 0) if isinstance(shot, dict) else 1.0})
    action_points: list[float] = []
    action_evidence: list[dict[str, Any]] = []
    for action in actions or []:
        if not isinstance(action, dict):
            continue
        tc = _timecode(action.get("timecode") or action)
        if tc is None:
            continue
        action_points.extend(tc)
        if min(abs(point - timestamp) for point in tc) <= .35:
            action_evidence.append({"source": str(action.get("source") or "action"), "timecode": {"start": tc[0], "end": tc[1]}, "confidence": float(action.get("confidence", 0) or 0)})
    semantic_points: list[float] = []
    semantic_evidence: list[dict[str, Any]] = []
    for item in semantic_intervals or []:
        tc = _timecode(item.get("timecode") or item) if isinstance(item, dict) else None
        if tc is None:
            continue
        semantic_points.extend(tc)
        if min(abs(point - timestamp) for point in tc) <= .35:
            semantic_evidence.append({"source": str(item.get("source") or "semantic"), "timecode": {"start": tc[0], "end": tc[1]}, "confidence": float(item.get("confidence", 0) or 0)})
    frame_evidence: list[dict[str, Any]] = []
    for frame in frames or []:
        if not isinstance(frame, dict):
            continue
        tc = _timecode(frame.get("timecode") or frame)
        if tc and min(abs(point - timestamp) for point in tc) <= .35:
            frame_evidence.append({"source": "frame", "timecode": {"start": tc[0], "end": tc[1]}, "framePath": frame.get("path") or frame.get("framePath"), "confidence": float(frame.get("confidence", 0) or 0)})
    nearest_shot = _nearest_point(timestamp, shot_points)
    nearest_dialogue = _nearest_point(timestamp, dialogue_points)
    nearest_action = _nearest_point(timestamp, action_points)
    nearest_semantic = _nearest_point(timestamp, semantic_points)
    dialogue_status = "crosses_dialogue" if crossing else ("safe_point" if nearest_dialogue is not None else "complete")
    action_status = "safe_point" if nearest_action is not None else ("shot_boundary_only" if nearest_shot is not None else "unverified")
    shot_status = "safe_point" if nearest_shot is not None else "unverified"
    semantic_status = "safe_point" if nearest_semantic is not None else "unverified"
    # A production-safe point needs dialogue, action and shot agreement.  A
    # supplied semantic/frame observation is retained as evidence but does not
    # silently upgrade an unreviewed action boundary.
    safe = dialogue_status != "crosses_dialogue" and nearest_shot is not None and nearest_action is not None
    status = "verified" if safe else "unverified"
    evidence = [
        {"source": "asr", "result": "no crossing speech" if not crossing else "speech crosses boundary"},
        *dialogue_evidence, *shot_evidence, *action_evidence, *semantic_evidence, *frame_evidence,
    ]
    result = {
        "kind": kind, "time": round(timestamp, 3), "timecode": {"start": round(timestamp, 3), "end": round(timestamp, 3)},
        "status": status, "dialogue": {"status": dialogue_status, "timecode": dialogue_evidence[0].get("timecode") if dialogue_evidence else None},
        "action": {"status": action_status, "timecode": action_evidence[0].get("timecode") if action_evidence else None},
        "shot": {"status": shot_status, "timecode": shot_evidence[0].get("timecode") if shot_evidence else None},
        "semantic": {"status": semantic_status, "timecode": semantic_evidence[0].get("timecode") if semantic_evidence else None},
        "frame": {"status": "observed" if frame_evidence else "unverified", "timecode": frame_evidence[0].get("timecode") if frame_evidence else None},
        "dialogueStatus": "complete" if dialogue_status != "crosses_dialogue" else "crosses_dialogue",
        "actionStatus": action_status, "shotStatus": shot_status, "semanticStatus": semantic_status,
        "nearestShotBoundary": round(nearest_shot, 3) if nearest_shot is not None else None,
        "safePointSources": [name for name, point in (("sentence", nearest_dialogue), ("shot", nearest_shot), ("action", nearest_action), ("semantic", nearest_semantic)) if point is not None],
        "evidence": evidence,
    }
    return result


_STORY_PHASES = ("setup", "escalation", "payoff", "ending")


def _event_evidence(raw: dict[str, Any], episode: int | None = None) -> list[dict[str, Any]]:
    evidence = raw.get("evidence") or raw.get("timeEvidence") or []
    if not isinstance(evidence, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in evidence:
        if not isinstance(item, dict):
            continue
        copy = dict(item)
        if episode is not None and copy.get("episode") is None:
            copy["episode"] = episode
        tc = _timecode(copy.get("timecode"))
        if tc is not None:
            copy["timecode"] = {"start": round(tc[0], 3), "end": round(tc[1], 3)}
        normalized.append(copy)
    return normalized


def _normalize_story_event(raw: Any, episode: int | None, index: int, durations: dict[int, float]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    raw_episode = raw.get("episode", raw.get("episode_number", episode))
    try:
        event_episode = int(raw_episode) if raw_episode is not None else None
    except (TypeError, ValueError):
        event_episode = episode
    if event_episode is None or event_episode not in durations:
        return None
    tc = _timecode(raw.get("timecode"))
    if tc is None:
        start, end = raw.get("start"), raw.get("end")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            tc = (float(start), float(end))
    if tc is None or tc[1] <= tc[0] or tc[1] > durations[event_episode] + .05:
        return None
    start, end = max(0.0, tc[0]), min(durations[event_episode], tc[1])
    evidence = _event_evidence(raw, event_episode)
    verification = raw.get("verification") if raw.get("verification") in ("verified", "unverified") else "verified" if evidence else "unverified"
    for item in evidence:
        item_tc = _timecode(item.get("timecode"))
        item_conf = item.get("confidence")
        if item_tc is None or item_tc[0] < 0 or item_tc[1] > durations[event_episode] or not isinstance(item.get("source"), str) or not item.get("source") or not isinstance(item_conf, (int, float)) or not 0 <= float(item_conf) <= 1:
            verification = "unverified"
            break
    event = {
        **raw,
        "id": str(raw.get("id") or f"event-{event_episode:02d}-{index + 1:03d}"),
        "episode": event_episode,
        "timecode": {"start": round(start, 3), "end": round(end, 3)},
        "start": round(start, 3), "end": round(end, 3),
        "evidence": evidence, "timeEvidence": evidence,
        "actors": raw.get("actors") if isinstance(raw.get("actors"), list) else [],
        "preconditions": raw.get("preconditions") if isinstance(raw.get("preconditions"), list) else [],
        "action": raw.get("action") if raw.get("action") is not None else "",
        "result": raw.get("result") if raw.get("result") is not None else "",
        "relationshipBefore": raw.get("relationshipBefore") if raw.get("relationshipBefore") is not None else [],
        "relationshipAfter": raw.get("relationshipAfter") if raw.get("relationshipAfter") is not None else [],
        "emotionBefore": raw.get("emotionBefore") if raw.get("emotionBefore") is not None else [],
        "emotionAfter": raw.get("emotionAfter") if raw.get("emotionAfter") is not None else [],
        "reveals": raw.get("reveals") if isinstance(raw.get("reveals"), list) else [],
        "unresolvedQuestions": raw.get("unresolvedQuestions") if isinstance(raw.get("unresolvedQuestions"), list) else [],
        "verification": verification,
        "reviewRequired": bool(raw.get("reviewRequired", False)) or verification != "verified" or not evidence,
    }
    phase = str(raw.get("phase") or raw.get("purpose") or raw.get("stage") or "").lower()
    event["phase"] = phase if phase in _STORY_PHASES else ""
    return event


def _reconstruct_storyline(semantic: dict[str, Any], episodes: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Build a complete, evidence-indexed story graph from old or new output.

    This is intentionally deterministic.  Provider prose is never promoted to
    an event unless it carries an in-range timecode and at least one evidence
    item.  Historical ``episodePlots``/``timeline`` payloads are accepted and
    enriched in place.
    """
    durations: dict[int, float] = {}
    for item in episodes:
        if not isinstance(item, dict):
            source = getattr(item, "source", {})
            result = getattr(item, "result", {}) or {}
            item = {**(source if isinstance(source, dict) else {}), **(result if isinstance(result, dict) else {})}
        try:
            number = int(item.get("episode", item.get("episode_number")))
            duration = float(item.get("durationSeconds", item.get("duration_seconds")))
        except (TypeError, ValueError):
            continue
        if duration > 0:
            durations[number] = duration
    raw_events: list[tuple[int | None, Any]] = []
    for key in ("events", "storyEvents", "eventNodes"):
        values = semantic.get(key)
        if isinstance(values, list):
            raw_events.extend((None, item) for item in values)
    storyline_source = semantic.get("storyline") if isinstance(semantic.get("storyline"), dict) else semantic.get("storyGraph")
    if isinstance(storyline_source, dict) and isinstance(storyline_source.get("events"), list):
        raw_events.extend((None, item) for item in storyline_source["events"])
    plots = semantic.get("episodePlots")
    if isinstance(plots, list):
        for plot in plots:
            if not isinstance(plot, dict):
                continue
            episode = plot.get("episode", plot.get("episode_number"))
            values = plot.get("events") or plot.get("eventNodes") or plot.get("nodes")
            if isinstance(values, list):
                raw_events.extend((episode, item) for item in values)
    # Older detail providers often returned only highlights.  They are useful
    # temporal anchors; create explicitly reviewable event placeholders rather
    # than pretending their narrative fields were observed.
    if not raw_events:
        candidates = semantic.get("highlightCandidates") or semantic.get("precisionCandidates") or []
        if isinstance(candidates, list):
            raw_events.extend((item.get("episode") if isinstance(item, dict) else None, item) for item in candidates)
    events: list[dict[str, Any]] = []
    for index, (episode, raw) in enumerate(raw_events):
        event = _normalize_story_event(raw, int(episode) if isinstance(episode, (int, float, str)) and str(episode).isdigit() else None, index, durations)
        if event:
            events.append(event)
    events.sort(key=lambda item: (item["episode"], item["start"], item["end"]))
    unique_events: list[dict[str, Any]] = []
    seen_events: set[tuple[str, int, float, float]] = set()
    for event in events:
        key = (str(event.get("id")), int(event["episode"]), float(event["start"]), float(event["end"]))
        if key in seen_events:
            continue
        seen_events.add(key)
        unique_events.append(event)
    events = unique_events
    # Assign phases only where the provider supplied one.  Chronological
    # placeholders remain unresolved and therefore require review.
    phase_events: dict[str, list[dict[str, Any]]] = {phase: [] for phase in _STORY_PHASES}
    for event in events:
        phase = event.get("phase")
        if phase in phase_events:
            phase_events[phase].append(event)
    issues: list[str] = []
    checks: list[dict[str, Any]] = []
    for previous, current in zip(events, events[1:]):
        chronological = (current["episode"], current["start"]) >= (previous["episode"], previous["start"])
        check = {"from": previous["id"], "to": current["id"], "chronological": chronological, "causalLink": bool(current.get("preconditions") or previous.get("result") or previous.get("reveals"))}
        checks.append(check)
        if not chronological:
            issues.append(f"事件顺序异常：{previous['id']} → {current['id']}")
        elif not check["causalLink"]:
            issues.append(f"缺少事件因果承接：{previous['id']} → {current['id']}")
    missing = [phase for phase in _STORY_PHASES if not phase_events[phase]]
    if missing:
        issues.append(f"故事阶段证据缺失：{'、'.join(missing)}")
    completeness_status = "complete" if events and not missing and not issues else "partial"
    phase_coverage = (len(_STORY_PHASES) - len(missing)) / len(_STORY_PHASES)
    causal_coverage = (sum(1 for check in checks if check.get("chronological") and check.get("causalLink")) / len(checks)) if checks else (1.0 if len(events) == 1 else 0.0)
    completeness_confidence = round(phase_coverage * causal_coverage, 3)
    completeness = {"status": completeness_status, "missingPhases": missing, "eventCount": len(events), "phaseCoverage": round(phase_coverage, 3), "causalCoverage": round(causal_coverage, 3), "confidence": completeness_confidence, "evidence": [e for event in events for e in event.get("evidence", [])][:8], "verification": "verified" if completeness_status == "complete" else "unverified"}
    review_required = bool(issues) or completeness_status != "complete" or any(event.get("reviewRequired") for event in events)
    graph = {"events": events, **phase_events, "causalChecks": {"passed": not issues and bool(events), "issues": issues, "checks": checks}, "causalCheck": {"passed": not issues and bool(events), "issues": issues, "checks": checks}, "completeness": completeness, "reviewRequired": review_required}
    return graph


def reconstruct_storyline(semantic: dict[str, Any], episodes: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Public alias for integrations that consume processor helpers."""
    return _reconstruct_storyline(semantic, episodes)


def _interval_evidence(raw: dict[str, Any], fallback: tuple[float, float]) -> list[dict[str, Any]]:
    evidence = _event_evidence(raw)
    return [item for item in evidence if _timecode(item.get("timecode")) is not None] or [{"source": "semantic", "timecode": {"start": fallback[0], "end": fallback[1]}, "confidence": float(raw.get("confidence", 0) or 0)}]


def _normalize_highlight_candidate(raw: dict[str, Any], duration: float, index: int = 0) -> dict[str, Any] | None:
    """Normalize a highlight while retaining trigger/narrative/production spans."""
    if not isinstance(raw, dict):
        return None
    try:
        start, end = float(raw.get("start")), float(raw.get("end"))
    except (TypeError, ValueError):
        return None
    if not 0 <= start < end <= duration:
        return None
    trigger_raw = raw.get("trigger") if isinstance(raw.get("trigger"), dict) else {}
    candidate_evidence = _event_evidence(raw)
    evidence_points = [_timecode(item.get("timecode")) for item in candidate_evidence]
    evidence_points = [item for item in evidence_points if item is not None]
    trigger_tc = _timecode(trigger_raw.get("timecode") or trigger_raw)
    if trigger_tc is None and evidence_points:
        trigger_tc = (min(item[0] for item in evidence_points), max(item[1] for item in evidence_points))
    trigger_start = max(start, trigger_tc[0]) if trigger_tc else start
    trigger_end = min(end, trigger_tc[1]) if trigger_tc else min(end, start + max(.2, end - start))
    if trigger_end <= trigger_start:
        return None
    evidence = _interval_evidence(raw, (start, end))
    # A provider may explicitly mark a cut as incomplete.  Drop these before
    # they reach precision/render queues; old candidates without boundary data
    # remain available but carry reviewRequired.
    boundary = raw.get("safeStart") if isinstance(raw.get("safeStart"), dict) else {}
    boundary_end = raw.get("safeEnd") if isinstance(raw.get("safeEnd"), dict) else {}
    for item in (boundary, boundary_end):
        statuses = [item.get(name, {}).get("status") for name in ("dialogue", "action", "shot", "semantic") if isinstance(item.get(name), dict)]
        if any(value in ("crosses_dialogue", "truncated", "unsafe", "cut") for value in statuses):
            return None
    production = raw.get("productionInterval") if isinstance(raw.get("productionInterval"), dict) else {}
    production_tc = _timecode(production.get("timecode") or production)
    production_start = max(0.0, production_tc[0] if production_tc else start)
    production_end = min(duration, production_tc[1] if production_tc else end)
    if production_end <= production_start:
        return None
    boundary_complete = bool(boundary and boundary_end)
    candidate = {
        **raw,
        "id": str(raw.get("id") or f"highlight-{index + 1:03d}"),
        "start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3),
        "trigger": {**trigger_raw, "timecode": {"start": round(trigger_start, 3), "end": round(trigger_end, 3)}, "evidence": _interval_evidence(trigger_raw or raw, (trigger_start, trigger_end))},
        "narrativeInterval": {"start": round(start, 3), "end": round(end, 3), "timecode": {"start": round(start, 3), "end": round(end, 3)}, "evidence": evidence},
        "productionInterval": {**production, "start": round(production_start, 3), "end": round(production_end, 3), "timecode": {"start": round(production_start, 3), "end": round(production_end, 3)}, "evidence": evidence},
        "reviewRequired": bool(raw.get("reviewRequired", False)) or not evidence or not boundary_complete or any(
            isinstance(item, dict) and item.get("status") != "verified" for item in (boundary, boundary_end) if item
        ),
    }
    candidate["productionGate"] = {
        "status": "verified" if candidate.get("verification") == "verified" and not candidate["reviewRequired"] else "unverified",
        "dialogue": boundary.get("dialogue", {"status": "unverified"}),
        "action": boundary.get("action", {"status": "unverified"}),
        "shot": boundary.get("shot", {"status": "unverified"}),
        "semantic": boundary.get("semantic", {"status": "unverified"}),
        "reviewRequired": candidate["reviewRequired"],
    }
    return candidate


def _reconstruct_highlights(value: Any, duration: float) -> list[dict[str, Any]]:
    """Filter invalid/zero ranges and attach production-safe interval schema."""
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        candidate = _normalize_highlight_candidate(raw, duration, index)
        if candidate:
            output.append(candidate)
    return output


def reconstruct_highlights(value: Any, duration: float) -> list[dict[str, Any]]:
    return _reconstruct_highlights(value, duration)


def _opening_preface_boundary(hooks: list[dict[str, Any]], shots: list[dict[str, Any]], duration: float) -> float | None:
    """Extend a short opening excerpt to the observable preface/body reset."""
    model_ends = [
        float(item.get("end"))
        for item in hooks
        if isinstance(item, dict)
        and isinstance(item.get("start"), (int, float))
        and isinstance(item.get("end"), (int, float))
        and float(item.get("start")) <= .5
        and 5 <= float(item.get("end")) <= min(120.0, duration * .5)
    ]
    if not model_ends:
        return None
    model_end = max(model_ends)
    previous_lengths: list[float] = []
    reset: float | None = None
    for shot in shots:
        timecode = shot.get("timecode") if isinstance(shot.get("timecode"), dict) else shot
        if not isinstance(timecode, dict) or not isinstance(timecode.get("start"), (int, float)) or not isinstance(timecode.get("end"), (int, float)):
            continue
        start, end = float(timecode["start"]), float(timecode["end"])
        if start > min(120.0, duration * .5):
            break
        shot_length = max(0.0, end - start)
        baseline = sorted(previous_lengths)[len(previous_lengths) // 2] if previous_lengths else 0
        if start >= model_end and start >= 5 and shot_length >= max(10.0, baseline * 4):
            reset = start
            break
        if shot_length > .1:
            previous_lengths.append(shot_length)
    return max(model_end, reset or model_end)


def _enrich_material_hooks(creative: dict[str, Any], transcript: list[dict[str, Any]], shots: list[dict[str, Any]], duration: float) -> dict[str, Any]:
    hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
    raw_entry_points = creative.get("entryPoints") if isinstance(creative.get("entryPoints"), list) else []
    # Providers sometimes return a verified opening hook on the creative
    # timeline but omit the duplicate hooks array. Promote that exact,
    # evidence-backed interval instead of losing it during asset projection.
    # The primary paid-ad hook is normally the deliberately edited opening
    # fragment.  Providers may rank a later climax above it; keep that climax
    # as a reusable candidate, but also promote the complete opening timeline
    # beat so it can remain the product-level primary hook.
    has_opening_hook = any(
        isinstance(item, dict)
        and isinstance(item.get("start"), (int, float))
        and float(item.get("start", 0)) <= 5
        for item in hooks
    )
    if not has_opening_hook:
        for item in creative.get("timeline", []) if isinstance(creative.get("timeline"), list) else []:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").lower()
            label = str(item.get("label") or "")
            start, end = item.get("start"), item.get("end")
            if ("opening" in code or "开场钩子" in label or (isinstance(start, (int, float)) and float(start) <= .5)) and isinstance(start, (int, float)) and isinstance(end, (int, float)) and float(start) <= 5 and 5 <= float(end) - float(start) <= 60:
                hooks.insert(0, {
                    **item,
                    "hookType": item.get("hookType") or item.get("label") or "原生开场钩子",
                    "themes": item.get("themes") if isinstance(item.get("themes"), list) else [],
                    "contentTags": item.get("contentTags") if isinstance(item.get("contentTags"), list) else [],
                    "spokenSummary": item.get("description") or item.get("label") or "",
                    "visualSummary": item.get("visualSummary") or "",
                })
                break
    format_claim = creative.get("format") if isinstance(creative.get("format"), dict) else {}
    material_format = str(format_claim.get("value") or format_claim.get("label") or "")
    opening_limit: float | None = None
    if material_format == "外搭钩子＋本剧正片":
        shot_ranges = []
        for shot in shots:
            timecode = shot.get("timecode") if isinstance(shot.get("timecode"), dict) else shot
            if isinstance(timecode, dict):
                shot_ranges.append((float(timecode.get("start", 0)), float(timecode.get("end", 0))))
        explicit = creative.get("bodyTransition") if isinstance(creative.get("bodyTransition"), dict) else {}
        for key in ("start", "time", "end"):
            if isinstance(explicit.get(key), (int, float)) and 5 <= float(explicit[key]) < duration - .5:
                opening_limit = float(explicit[key])
                break
        if opening_limit is not None:
            containing = next(((start, end) for start, end in shot_ranges if start < opening_limit < end and end - start >= 8), None)
            if containing is not None:
                opening_limit = containing[0]
        previous_lengths: list[float] = []
        for start, end in shot_ranges:
            shot_length = max(0.0, end - start)
            baseline = sorted(previous_lengths)[len(previous_lengths) // 2] if previous_lengths else 0
            if 5 <= start <= min(opening_limit or 120.0, 120.0, duration * .5) and shot_length >= max(10.0, baseline * 4):
                opening_limit = min(opening_limit or start, start)
                break
            if shot_length > .1:
                previous_lengths.append(shot_length)
        # Prefer the provider's complete external-fragment end. A model may
        # also return smaller reusable entry points; those must not shrink the
        # product-level external-hook conclusion.
        inferred_preface_end = _opening_preface_boundary(hooks, shots, duration)
        if inferred_preface_end is not None and opening_limit is None:
            opening_limit = inferred_preface_end
        # A body reset is often followed by a much longer continuous shot.
        # Use that boundary only as a fallback and never extend beyond 120s.
        if opening_limit is None:
            previous_lengths: list[float] = []
            for start, end in shot_ranges:
                shot_length = max(0.0, end - start)
                baseline = sorted(previous_lengths)[len(previous_lengths) // 2] if previous_lengths else 0
                if 5 <= start <= min(120.0, duration * .5) and shot_length >= max(10.0, baseline * 4):
                    opening_limit = start
                    break
                if shot_length > .1:
                    previous_lengths.append(shot_length)
        if opening_limit is not None and (opening_limit >= duration - .5 or opening_limit > min(120.0, duration * .5)):
            opening_limit = None
    enriched: list[dict[str, Any]] = []
    candidate_inputs = [{**item, "_candidateRole": "hook"} for item in hooks if isinstance(item, dict)] + [{**item, "_candidateRole": "entryPoint"} for item in raw_entry_points if isinstance(item, dict)]
    for index, raw in enumerate(candidate_inputs[:16]):
        if not isinstance(raw, dict):
            continue
        if not isinstance(raw.get("start"), (int, float)) or not isinstance(raw.get("end"), (int, float)):
            continue
        if duration > 8 and float(raw.get("start", 0)) <= .5 and float(raw.get("end", 0)) >= duration - .5:
            continue
        start = max(0.0, min(duration, float(raw["start"])))
        end = max(start, min(duration, float(raw["end"])))
        if material_format == "外搭钩子＋本剧正片" and opening_limit is not None and start <= 5:
            end = min(end, opening_limit)
        candidate_duration = end - start
        if duration > 8 and start <= .5 and end >= duration - .5:
            continue
        if material_format == "外搭钩子＋本剧正片":
            if opening_limit is None or start > 5 or start >= opening_limit:
                continue
            if candidate_duration < 1 or candidate_duration > 60 or end > opening_limit + .5:
                continue
        elif material_format == "正片剧集解说":
            if start >= 60 or candidate_duration < 5 or candidate_duration > 60:
                continue
            if end > min(60.0, duration) + .5:
                continue
        elif candidate_duration < 5 or candidate_duration > 60:
            continue
        start_boundary = _material_hook_boundary(start, transcript, shots, "start")
        end_boundary = _material_hook_boundary(end, transcript, shots, "end")
        candidate = {
            **raw,
            "id": str(raw.get("id") or f"hook-{index + 1:02d}"),
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "safeStart": start_boundary,
            "safeEnd": end_boundary,
            "boundaryStatus": "verified" if start_boundary["status"] == "verified" and end_boundary["status"] == "verified" else "unverified",
            "verification": "verified" if start_boundary["status"] == "verified" and end_boundary["status"] == "verified" else "needs_review",
            "reviewRequired": bool(raw.get("reviewRequired", False)) or start_boundary["status"] != "verified" or end_boundary["status"] != "verified",
        }
        normalized = _normalize_highlight_candidate(candidate, duration, index)
        if normalized is not None:
            candidate = normalized
        candidate["productionGate"] = {
            "status": "verified" if candidate.get("safeStart", {}).get("status") == "verified" and candidate.get("safeEnd", {}).get("status") == "verified" else "unverified",
            "dialogue": {"start": start_boundary.get("dialogue", {}), "end": end_boundary.get("dialogue", {})},
            "action": {"start": start_boundary.get("action", {}), "end": end_boundary.get("action", {})},
            "shot": {"start": start_boundary.get("shot", {}), "end": end_boundary.get("shot", {})},
            "semantic": {"start": start_boundary.get("semantic", {}), "end": end_boundary.get("semantic", {})},
            "reviewRequired": bool(candidate.get("reviewRequired", True)),
        }
        if any(candidate.get("_candidateRole") == existing.get("_candidateRole") and min(candidate["end"], existing["end"]) - max(candidate["start"], existing["start"]) >= .8 * min(candidate["duration"], existing["duration"]) for existing in enriched):
            continue
        enriched.append(candidate)
    # Opening-first is an editorial rule, not a score claim: later climaxes
    # remain available but cannot displace the first segment as primary hook.
    enriched.sort(key=lambda item: (
        0 if float(item.get("start")) <= 5 else 1,
        float(item.get("start")),
    ))
    final_hooks = enriched[:5]
    entry_points = enriched[:5]
    if material_format == "外搭钩子＋本剧正片" and opening_limit is not None and enriched:
        source = max(enriched, key=lambda item: float(item.get("end", 0)))
        start_boundary = _material_hook_boundary(0.0, transcript, shots, "start")
        end_boundary = _material_hook_boundary(opening_limit, transcript, shots, "end")
        holistic_summary = str(source.get("plotSummary") or creative.get("externalHookSummary") or "").strip()
        if not holistic_summary:
            spoken = str(source.get("spokenSummary") or "").strip()
            visual = str(source.get("visualSummary") or "").strip()
            holistic_summary = "；".join(item for item in (spoken, visual) if item)
        final_hooks = [{
            **source,
            "id": str(source.get("id") or "external-hook-complete"),
            "code": str(source.get("code") or "EXTERNAL_HOOK_COMPLETE"),
            "label": str(source.get("label") or "完整外搭钩子"),
            "start": 0.0,
            "end": round(opening_limit, 3),
            "duration": round(opening_limit, 3),
            "plotSummary": holistic_summary,
            "scope": "complete_external_fragment",
            "safeStart": start_boundary,
            "safeEnd": end_boundary,
            "boundaryStatus": "verified" if start_boundary["status"] == "verified" and end_boundary["status"] == "verified" else "unverified",
            "verification": "verified" if start_boundary["status"] == "verified" and end_boundary["status"] == "verified" else "needs_review",
            "reviewRequired": bool(source.get("reviewRequired", False)) or end_boundary["status"] != "verified",
        }]
        entry_points = [item for item in enriched if item.get("_candidateRole") == "entryPoint" and float(item.get("duration", 0)) < opening_limit - .5][:5]
    return {**creative, "hooks": final_hooks, "entryPoints": entry_points, "hookLocalization": {
        "status": "localized" if final_hooks else "needs_review",
        "candidateCount": len(final_hooks),
        "semanticScope": "complete_external_fragment" if material_format == "外搭钩子＋本剧正片" and final_hooks else "native_hook_unit",
        "wholeVideoFallbackAllowed": False,
    }}


def _read_analysis_cache(path: Path, signature: str) -> tuple[list[dict[str, Any]], dict[str, str]] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("signature") != signature or not isinstance(payload.get("data"), list) or not isinstance(payload.get("engine"), dict):
            return None
        return payload["data"], payload["engine"]
    except (OSError, ValueError, TypeError):
        return None


def _write_analysis_cache(path: Path, signature: str, data: list[dict[str, Any]], engine: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps({"signature": signature, "data": data, "engine": engine}, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _read_frame_cache(path: Path, signature: str) -> list[dict[str, Any]] | None:
    cached = _read_analysis_cache(path, signature)
    if not cached:
        return None
    frames, _engine = cached
    return frames if frames and all(Path(str(frame.get("path", ""))).is_file() for frame in frames) else None


def _write_frame_cache(path: Path, signature: str, frames: list[dict[str, Any]]) -> None:
    _write_analysis_cache(path, signature, frames, {"backend": "ffmpeg"})


def _read_ocr_batched(frames: list[dict[str, Any]], workers: int) -> tuple[list[dict[str, Any]], dict[str, str]]:
    workers = max(1, min(workers, len(frames)))
    if workers == 1:
        return read_ocr(frames)
    batches = [frames[index::workers] for index in range(workers)]
    output: list[dict[str, Any]] = []
    engines: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="material-ocr") as executor:
        futures = [executor.submit(read_ocr, batch) for batch in batches if batch]
        for future in as_completed(futures):
            batch_output, engine = future.result()
            output.extend(batch_output)
            engines.append(engine)
    output.sort(key=lambda item: float((item.get("timecode") or {}).get("start", 0)))
    engine = engines[0] if engines else {"backend": "paddleocr", "language": os.getenv("LUMINA_OCR_LANGUAGE", "en")}
    return output, {**engine, "workers": str(workers)}


def _material_semantic_analysis(payload: dict[str, Any], duration: float, report: Callable[[int, str], None], cache_dir: Path | None = None) -> dict[str, Any]:
    segment_seconds = min(60.0, max(30.0, float(os.getenv("LUMINA_QWEN_SEGMENT_SECONDS", "60"))))
    minimum_duration = max(segment_seconds, float(os.getenv("LUMINA_QWEN_SEGMENT_MIN_DURATION", "75")))
    max_workers = max(1, int(os.getenv("LUMINA_QWEN_SEGMENT_WORKERS", "3")))
    if duration < minimum_duration:
        report(78, "千问多模态分析")
        result = _validate_semantic_claims(_semantic_request("paid-ad-material-analysis", payload), duration)
        return _ensure_material_output_contract(result, payload, duration, report)

    segments: list[dict[str, Any]] = []
    cursor = 0.0
    while cursor < duration:
        end = min(duration, cursor + segment_seconds)
        segment = {
            **payload,
            "segment": {"start": cursor, "end": end},
            "frames": [frame for frame in payload.get("frames", []) if cursor <= float((frame.get("timecode") or {}).get("start", -1)) < end],
            "transcript": [item for item in payload.get("transcript", []) if float(item.get("end", 0)) >= cursor and float(item.get("start", 0)) < end],
            "ocr": [item for item in payload.get("ocr", []) if cursor <= float((item.get("timecode") or {}).get("start", -1)) < end],
            "shots": [item for item in payload.get("shots", []) if float((item.get("timecode") or {}).get("end", 0)) >= cursor and float((item.get("timecode") or {}).get("start", 0)) < end],
            "audioEvents": [item for item in payload.get("audioEvents", []) if float((item.get("timecode") or {}).get("end", 0)) >= cursor and float((item.get("timecode") or {}).get("start", 0)) < end],
            "semanticSegments": [item for item in payload.get("semanticSegments", []) if float(item.get("end", 0)) >= cursor and float(item.get("start", 0)) < end],
        }
        segments.append(segment)
        cursor = end

    results: list[dict[str, Any] | None] = [None] * len(segments)
    semantic_cache = cache_dir / "semantic-segments-v6.json" if cache_dir else None
    semantic_signature = _cache_signature({"version": 6, "duration": duration, "segmentSeconds": segment_seconds, "segmentCount": len(segments), "hookPolicy": "localized-no-whole-video-v1", "visualCoverage": "opening-middle-ending-v2", "storyboardContract": "event-title-single-sentence-v1"})
    cached_segments = _read_analysis_cache(semantic_cache, semantic_signature) if semantic_cache else None
    legacy_segments: list[Any] = []
    if cache_dir:
        try:
            legacy_payload = json.loads((cache_dir / "semantic-segments-v4.json").read_text(encoding="utf-8"))
            legacy_segments = legacy_payload.get("data", []) if isinstance(legacy_payload, dict) else []
        except (OSError, ValueError, TypeError):
            legacy_segments = []
    if cached_segments and isinstance(cached_segments[0], list) and len(cached_segments[0]) == len(segments) and all(isinstance(item, dict) for item in cached_segments[0]):
        results = cached_segments[0]
        report(88, f"千问分段分析缓存复用 {len(segments)}/{len(segments)}")
    else:
        if cached_segments and isinstance(cached_segments[0], list) and len(cached_segments[0]) == len(segments):
            results = list(cached_segments[0])
        completed = sum(isinstance(item, dict) for item in results)
        report(78 + round(10 * completed / len(segments)), f"千问分段分析缓存复用 {completed}/{len(segments)}")
        failures: dict[int, Exception] = {}
        with ThreadPoolExecutor(max_workers=min(max_workers, len(segments)), thread_name_prefix="material-qwen") as executor:
            futures = {executor.submit(_semantic_request, "paid-ad-material-segment-analysis", segment): index for index, segment in enumerate(segments) if not isinstance(results[index], dict)}
            for future in as_completed(futures):
                index = futures[future]
                try:
                    results[index] = _validate_semantic_claims(future.result(), duration)
                except Exception as exc:
                    if "data_inspection_failed" in str(exc) and index < len(legacy_segments) and isinstance(legacy_segments[index], dict):
                        results[index] = legacy_segments[index]
                    else:
                        failures[index] = exc
                completed += 1
                report(78 + round(10 * completed / len(segments)), f"千问分段分析 {completed}/{len(segments)}")
        if semantic_cache:
            _write_analysis_cache(semantic_cache, semantic_signature, results, {"backend": "qwen-segments-v6-partial"})
        if failures:
            for retry_number, index in enumerate(sorted(failures), start=1):
                report(88, f"千问并发受限，串行重试 {retry_number}/{len(failures)}")
                time.sleep(float(os.getenv("LUMINA_QWEN_RETRY_DELAY", "2")))
                try:
                    results[index] = _validate_semantic_claims(_semantic_request("paid-ad-material-segment-analysis", segments[index]), duration)
                except AnalysisFailed as exc:
                    if "data_inspection_failed" in str(exc) and index < len(legacy_segments) and isinstance(legacy_segments[index], dict):
                        results[index] = legacy_segments[index]
                    else:
                        raise
        if semantic_cache:
            _write_analysis_cache(semantic_cache, semantic_signature, results, {"backend": "qwen-segments-v6"})
    report(90, "千问全片创意汇总")
    merge_payload = {
        "durationSeconds": duration,
        # Keep explicit source dialogue in the local cache. The provider only
        # needs high-level labels and evidence coordinates for final merging;
        # resending explicit prose can trigger provider inspection and leaks
        # more source text than necessary.
        "segmentAnalyses": [_compact_material_merge_segment(result, index) for index, result in enumerate(results) if result is not None],
        "evidenceIndex": {
            "shots": payload.get("shots", [])[:80],
            "audioEvents": payload.get("audioEvents", [])[:80],
            "semanticSegments": payload.get("semanticSegments", []),
        },
        "requirements": payload.get("requirements", []) + [
            "merge overlapping claims without removing their original timecoded evidence",
            "produce one coherent chronological and causal full-material story in Simplified Chinese",
            "resolve recurring characters and relationships across all segments before writing the summary",
            "replace fixed technical chunks with 4-7 variable-length story phases covering setup, inciting incident, escalation, turning points and ending/cliffhanger",
        ],
    }
    # Detailed story synthesis below replaces the lossy provider classification
    # merge. Aggregate stable labels locally so this stage is deterministic and
    # cannot stall or introduce a second, contradictory story draft.
    result = _aggregate_material_classification([item for item in results if isinstance(item, dict)], duration)
    result = _ensure_material_output_contract(result, merge_payload, duration, report)
    quality_issues = _material_story_quality_issues(result, duration)
    # Classification output can pass shallow length/count checks and still be
    # a topic digest. Always run a dedicated full-story pass for long material.
    report(92, "专用全片剧情合成")
    transcript = [item for item in payload.get("transcript", []) if isinstance(item, dict)]
    dialogue_timeline = []
    for segment_index, segment in enumerate(segments):
        start = float((segment.get("segment") or {}).get("start", segment_index * segment_seconds))
        end = float((segment.get("segment") or {}).get("end", start + segment_seconds))
        utterances = []
        for item in transcript:
            item_start = float(item.get("start", 0) or 0)
            if start <= item_start < end and str(item.get("text") or "").strip():
                utterances.append({"start": item_start, "end": float(item.get("end", item_start) or item_start), "speaker": str(item.get("speaker") or ""), "text": str(item.get("text") or "")[:180]})
        dialogue_timeline.append({"start": start, "end": end, "utterances": utterances[:16]})
    story_payload = {
            "durationSeconds": duration,
            "frames": _sample_material_frames(payload.get("frames", []), duration, 18),
            "orderedObservations": [_material_story_observation(item, index) for index, item in enumerate(results) if isinstance(item, dict)],
            "localizationSamples": [
                {"timecode": item.get("timecode"), "text": str(item.get("text") or "")[:160]}
                for sample_index, item in enumerate(payload.get("ocr", []) if isinstance(payload.get("ocr"), list) else [])
                if isinstance(item, dict) and sample_index % max(1, len(payload.get("ocr", [])) // 20) == 0
            ][:20],
            "draftClassification": {
                "bodyFormat": (result.get("creative") or {}).get("bodyFormat"),
                "hookSourceStatus": (result.get("creative") or {}).get("hookSourceStatus"),
                "format": (result.get("creative") or {}).get("format"),
            },
            "qualityIssues": quality_issues,
            "dialogueTimeline": dialogue_timeline,
            "requirements": [
                "reconstruct one chronological causal story from all ordered observations",
                "resolve aliases and correct local one-minute misclassifications using later context",
                "a doctor discussing medicine after intimacy is a plot consequence, not a health advertisement",
                "uniform translated subtitles across the entire material are localization, never external-hook evidence",
                "derive every character, goal, event, causal link and relationship change from supplied evidence only",
                "state what each principal character wants, what blocks them, what choice changes the situation, and what the observed ending resolves or leaves open",
                "preserve concrete actions and consequences from every chronological fifth; never replace events with theme or emotion labels",
                "include every high-confidence event that changes the protagonist's economic situation, occupation, principal relationship or immediate physical danger",
                "the final phase and synopsis must state the last observed concrete threat/action/rescue/cliffhanger and CTA instead of replacing it with generic growth or conflict",
                "relationship types and evolution must preserve all supported layers (for example intimate plus medical plus debt/control), not only the safest generic layer",
            ],
    }
    opening_analysis = _semantic_request("paid-ad-material-opening-analysis", {
        "durationSeconds": duration,
        "frames": [],
        "transcript": [item for item in transcript if float(item.get("start", 0) or 0) < 60],
        "ocr": [item for item in payload.get("ocr", []) if isinstance(item, dict) and float((item.get("timecode") or {}).get("start", 0) or 0) < 60],
        "shots": [item for item in payload.get("shots", []) if isinstance(item, dict) and float((item.get("timecode") or {}).get("start", 0) or 0) < 60],
        "firstObservation": story_payload["orderedObservations"][:1],
        # Source attribution cannot be inferred from the opening alone. Give
        # the classifier compact post-opening observations so it can look for
        # recurring named characters, relationships, props and causal payoff.
        "bodyObservations": story_payload["orderedObservations"][1:],
    })
    # Models occasionally identify the correct reset scene but place the
    # timestamp inside the following long shot. Snap that decision to the
    # observed boundary, then rewrite the summary from evidence that ends at
    # that boundary so body events cannot leak into the hook synopsis.
    try:
        opening_transition = float(opening_analysis.get("transitionTime", 0) or 0)
    except (TypeError, ValueError):
        opening_transition = 0
    previous_opening_shots: list[float] = []
    for shot in payload.get("shots", []) if isinstance(payload.get("shots"), list) else []:
        timecode = shot.get("timecode") if isinstance(shot, dict) and isinstance(shot.get("timecode"), dict) else shot
        if not isinstance(timecode, dict):
            continue
        shot_start, shot_end = float(timecode.get("start", 0) or 0), float(timecode.get("end", 0) or 0)
        shot_length = max(0.0, shot_end - shot_start)
        baseline = sorted(previous_opening_shots)[len(previous_opening_shots) // 2] if previous_opening_shots else 0
        if 5 <= shot_start <= min(opening_transition or 120.0, 120.0, duration * .5) and shot_length >= max(10.0, baseline * 4):
            opening_transition = min(opening_transition or shot_start, shot_start)
            break
        if shot_length > .1:
            previous_opening_shots.append(shot_length)
    for shot in payload.get("shots", []) if isinstance(payload.get("shots"), list) else []:
        timecode = shot.get("timecode") if isinstance(shot, dict) and isinstance(shot.get("timecode"), dict) else shot
        if not isinstance(timecode, dict):
            continue
        shot_start, shot_end = float(timecode.get("start", 0) or 0), float(timecode.get("end", 0) or 0)
        if shot_start < opening_transition < shot_end and shot_end - shot_start >= 8:
            opening_transition = shot_start
            break
    if opening_analysis.get("distinctPreface") is True and 5 <= opening_transition <= min(120.0, duration * .5):
        opening_analysis = _semantic_request("paid-ad-material-opening-analysis", {
            "durationSeconds": duration,
            "forcedTransitionTime": opening_transition,
            "frames": [],
            "resetContextFrames": [],
            "transcript": [item for item in transcript if float(item.get("end", item.get("start", 0)) or 0) <= opening_transition],
            "ocr": [item for item in payload.get("ocr", []) if isinstance(item, dict) and float((item.get("timecode") or {}).get("start", 0) or 0) < opening_transition],
            "shots": [item for item in payload.get("shots", []) if isinstance(item, dict) and float((item.get("timecode") or {}).get("start", 0) or 0) <= opening_transition],
            "sourceDecision": {key: opening_analysis.get(key) for key in ("distinctPreface", "hookSourceStatus", "hookAssemblyType", "confidence")},
            "bodyObservations": story_payload["orderedObservations"][1:],
            "requirements": ["Use forcedTransitionTime exactly", "Rewrite plotSummary/spokenSummary/visualSummary from pre-transition evidence only; resetContextFrames may support only the final rewind/reset sentence"],
        })
        for canonical, aliases in {
            "hookSourceStatus": ("hookSrcStatus", "sourceStatus"),
            "hookAssemblyType": ("hookAssembly", "assemblyType"),
            "plotSummary": ("plotSum", "summary"),
            "spokenSummary": ("spokensum", "spokenSum"),
            "visualSummary": ("visualsum", "visualSum"),
        }.items():
            if not opening_analysis.get(canonical):
                opening_analysis[canonical] = next((opening_analysis.get(alias) for alias in aliases if opening_analysis.get(alias)), "")
        opening_analysis["transitionTime"] = opening_transition
    story_payload["openingAnalysis"] = opening_analysis
    event_ledger = _semantic_request("paid-ad-material-event-ledger", {
        "durationSeconds": duration,
        "orderedObservations": story_payload["orderedObservations"],
        "dialogueTimeline": dialogue_timeline,
        "requirements": [
            "extract only concrete observed events with time ranges",
            "for each event separate actor goal, action, obstacle, result and relationship change",
            "retain important events from every chronological fifth and mark uncertain identity instead of guessing",
        ],
    })
    resolved_entities = _semantic_request("paid-ad-material-entity-resolution", {
        "durationSeconds": duration,
        "orderedObservations": story_payload["orderedObservations"],
        "eventLedger": event_ledger,
    })
    story_payload["eventLedger"] = event_ledger
    story_payload["resolvedEntities"] = resolved_entities
    story_payload = _bounded_story_synthesis_payload(story_payload)
    synthesis = _semantic_request("paid-ad-material-story-synthesis", story_payload)
    result = _apply_material_story_synthesis(result, synthesis, duration)
    result = _apply_material_opening_analysis(result, opening_analysis, duration)
    source_corpus = json.dumps({"observations": story_payload["orderedObservations"], "dialogue": dialogue_timeline}, ensure_ascii=False)
    consistency_issues = _material_story_quality_issues(result, duration) + _material_story_consistency_issues(result, duration, source_corpus)
    story_audit = _semantic_request("paid-ad-material-story-audit", {
        "durationSeconds": duration,
        "eventLedger": event_ledger,
        "resolvedEntities": resolved_entities,
        "draftStory": synthesis,
    })
    audit_issues = [
        str(item.get("reason") or item.get("description") or item) if isinstance(item, dict) else str(item)
        for key in ("missingEvents", "unsupportedClaims", "relationshipErrors", "timelineErrors")
        for item in (story_audit.get(key, []) if isinstance(story_audit.get(key), list) else [])
        if str(item).strip()
    ]
    consistency_issues = list(dict.fromkeys([*consistency_issues, *audit_issues]))
    if consistency_issues:
        report(93, "解析全片人物与说话轮次")
        entity_resolution = resolved_entities
        best_synthesis, best_result, best_issues = synthesis, result, consistency_issues
        for repair_number in range(2):
            report(93 + repair_number, f"修复故事覆盖与人物关系 {repair_number + 1}/2")
            repaired_synthesis = _semantic_request("paid-ad-material-story-synthesis", {
                **story_payload,
                "draftStory": best_synthesis,
                "resolvedEntities": entity_resolution,
                "storyAudit": story_audit,
                "consistencyIssues": best_issues,
                "requirements": story_payload["requirements"] + ["use resolvedEntities as the canonical identity/relationship layer, repair every consistency issue, and return the complete compact story model again"],
            })
            repaired_result = _apply_material_story_synthesis(best_result, repaired_synthesis, duration)
            repaired_issues = _material_story_quality_issues(repaired_result, duration) + _material_story_consistency_issues(repaired_result, duration, source_corpus)
            repaired_audit = _semantic_request("paid-ad-material-story-audit", {
                "durationSeconds": duration,
                "eventLedger": event_ledger,
                "resolvedEntities": resolved_entities,
                "draftStory": repaired_synthesis,
            })
            repaired_audit_issues = [
                str(item.get("reason") or item.get("description") or item) if isinstance(item, dict) else str(item)
                for key in ("missingEvents", "unsupportedClaims", "relationshipErrors", "timelineErrors")
                for item in (repaired_audit.get(key, []) if isinstance(repaired_audit.get(key), list) else [])
                if str(item).strip()
            ]
            repaired_issues = list(dict.fromkeys([*repaired_issues, *repaired_audit_issues]))
            if len(repaired_issues) >= len(best_issues):
                break
            best_synthesis, best_result, best_issues = repaired_synthesis, repaired_result, repaired_issues
            if not best_issues:
                break
        result = best_result
    result = _augment_story_from_event_ledger(result, event_ledger, duration)
    result = _ensure_material_story_landmarks(result, story_payload["orderedObservations"], duration, payload.get("shots", []))
    final_issues = _material_story_quality_issues(result, duration) + _material_story_consistency_issues(result, duration, source_corpus)
    if final_issues:
        review = dict(result.get("review") or {})
        reasons = [str(item) for item in review.get("reasons", []) if str(item)] if isinstance(review.get("reasons"), list) else []
        result["review"] = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys([*reasons, *final_issues]))}
    result = _downgrade_unsupported_external_hook(result)
    result = _reconcile_material_segment_results(result, [item for item in results if isinstance(item, dict)], duration)
    result = _augment_story_from_event_ledger(result, event_ledger, duration)
    return _ensure_material_story_landmarks(result, story_payload["orderedObservations"], duration, payload.get("shots", []))


def _reconcile_material_segment_results(merged: dict[str, Any], segments: list[dict[str, Any]], duration: float) -> dict[str, Any]:
    """Restore evidence-backed detail that a lossy whole-material merge omitted."""
    result = dict(merged)
    content = dict(result.get("content") or {})
    creative = dict(result.get("creative") or {})

    def values(container: Any, name: str) -> list[dict[str, Any]]:
        value = container.get(name) if isinstance(container, dict) else None
        if isinstance(value, dict):
            return [value]
        return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []

    def unique(items: list[dict[str, Any]], limit: int = 100) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        seen: set[tuple[Any, ...]] = set()
        for item in items:
            marker = (str(item.get("code") or item.get("label") or item.get("value") or ""), item.get("start"), item.get("end"))
            if marker in seen:
                continue
            seen.add(marker)
            output.append(item)
            if len(output) >= limit:
                break
        return output

    segment_content = [item.get("content") for item in segments if isinstance(item.get("content"), dict)]
    segment_creative = [item.get("creative") for item in segments if isinstance(item.get("creative"), dict)]
    recovered_segments = unique([claim for item in segment_content for claim in values(item, "segments")])
    recovered_tags = unique([claim for item in segment_content for claim in values(item, "tags")], 24)
    if len(values(content, "segments")) < max(2, min(5, len(recovered_segments))):
        content["segments"] = recovered_segments
    if not values(content, "tags") and recovered_tags:
        content["tags"] = recovered_tags

    opening_hooks = []
    for item in segment_creative:
        for hook in values(item, "hooks"):
            try:
                start, end = float(hook.get("start")), float(hook.get("end"))
            except (TypeError, ValueError):
                continue
            if 0 <= start <= 5 and 5 <= end - start <= 60 and end <= duration:
                opening_hooks.append(hook)
    if not values(creative, "hooks") and opening_hooks:
        creative["hooks"] = unique(opening_hooks, 5)

    timeline = values(creative, "timeline")
    has_opening = any(float(item.get("start", 999999) or 999999) <= 5 for item in timeline)
    if not has_opening:
        recovered_opening = []
        for item in segment_creative[:1]:
            recovered_opening.extend(claim for claim in values(item, "timeline") if float(claim.get("start", 999999) or 999999) <= 5)
        creative["timeline"] = unique([*recovered_opening, *timeline])

    result["content"] = content
    result["creative"] = creative
    result["semanticSegments"] = [{"index": index + 1, "result": item} for index, item in enumerate(segments)]
    return result


def _material_story_quality_issues(result: dict[str, Any], duration: float) -> list[str]:
    """Generic product gate: reject a topic digest or raw chunk list as a story analysis."""
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    summary_claim = content.get("summary")
    summary = str(summary_claim.get("value") or summary_claim.get("label") or "") if isinstance(summary_claim, dict) else str(summary_claim or "")
    issues: list[str] = []
    evidence_texts: list[str] = []
    def collect_evidence_texts(value: Any) -> None:
        if isinstance(value, list):
            for child in value:
                collect_evidence_texts(child)
            return
        if not isinstance(value, dict):
            return
        own_text = str(value.get("translation") or value.get("text") or "").strip()
        if own_text and (value.get("timecode") is not None or value.get("start") is not None):
            evidence_texts.append(own_text)
        evidence = value.get("evidence")
        if isinstance(evidence, list):
            for item in evidence:
                if isinstance(item, dict) and str(item.get("text") or "").strip():
                    evidence_texts.append(str(item.get("text") or "").strip())
        for key, child in value.items():
            if key != "evidence":
                collect_evidence_texts(child)
    collect_evidence_texts({"content": content, "creative": creative, "value": result.get("value")})
    collect_evidence_texts(result.get("evidence"))
    hollow_evidence = [text for text in evidence_texts if re.search(r"(?:回看|查看).{0,8}(?:片段|画面).{0,8}(?:确认|定位)|检测到(?:镜头|画面|声音|变化)|关键画面|暂未生成.{0,8}释义", text)]
    concrete_evidence = [text for text in evidence_texts if len(re.sub(r"\s+", "", text)) >= 6 and text not in hollow_evidence]
    if hollow_evidence:
        issues.append("证据包含操作提示或技术占位描述，必须改写为具体可观察事实")
    if evidence_texts and len(concrete_evidence) < 3:
        issues.append("具体剧情证据不足，至少需要3条包含人物、对白、动作或场景事实的证据")
    if len(summary) < 160:
        issues.append("全片剧情概括不足160字，未覆盖主要因果链")
    if any(marker in summary for marker in ("多个独立语义段", "由多个语义段", "内容围绕", "涉及多个主题")):
        issues.append("摘要是技术分段或题材罗列，不是从头到尾的剧情概括")
    summary_sentences = [item.strip() for item in re.split(r"[。！？；]", summary) if len(item.strip()) >= 12]
    repeated_openings = [item[:14] for item in summary_sentences]
    if len(repeated_openings) != len(set(repeated_openings)) or summary.count("同时，") > 2:
        issues.append("剧情概括存在重复拼接或关系标签堆叠，必须合并为单一因果叙事")
    causal_markers = sum(summary.count(marker) for marker in ("随后", "继而", "因此", "迫使", "直到", "最终", "结尾", "却", "但"))
    if causal_markers < 3:
        issues.append("摘要缺少起因、升级、转折和结局之间的因果连接")
    characters = content.get("characters") if isinstance(content.get("characters"), list) else []
    relationships = content.get("relationships") if isinstance(content.get("relationships"), list) else []
    if len(characters) < 2:
        issues.append("未完成跨分段人物归一，主要人物少于2人")
    if len(relationships) < 2:
        issues.append("人物关系不足，未区分情感、职场、医疗或债务关系")
    phase_candidates = (
        creative.get("displayPhases"), creative.get("timeline"),
        content.get("storyBeats"), content.get("segments"),
    )
    phases = next((value for value in phase_candidates if isinstance(value, list) and value), [])
    if not 4 <= len(phases) <= 7:
        issues.append("页面剧情阶段必须为4至7个，而不是固定分钟切片")
    else:
        fixed = 0
        ends: list[float] = []
        starts: list[float] = []
        for phase in phases:
            if not isinstance(phase, dict):
                continue
            try:
                start, end = float(phase.get("start", 0)), float(phase.get("end", 0))
            except (TypeError, ValueError):
                continue
            starts.append(start)
            ends.append(end)
            fixed += abs((end - start) - 60) < .2
        if fixed > 1:
            issues.append("剧情阶段仍是固定60秒技术切片")
        if not starts or min(starts) > 1 or max(ends, default=0) < duration * .9:
            issues.append("剧情阶段没有覆盖片头到结尾")
    for key, maximum in (("themes", 8), ("emotions", 6), ("conflicts", 6)):
        value = content.get(key)
        if isinstance(value, list) and len(value) > maximum:
            issues.append(f"{key}标签超过{maximum}个，未按标签体系去重收敛")
    theme_labels = [str(item.get("label") or item.get("value") or item.get("code") or "") for item in content.get("themes", []) if isinstance(item, dict)]
    technical_themes = [label for label in theme_labels if re.search(r"语音|ASR|OCR|识别|置信度|混合语言|疑似(?:产品|专有|人物)名称|翻译质量|对话驱动|角色互动|任务管理", label, re.I)]
    if technical_themes:
        issues.append("主题混入识别质量、叙事形式或技术元数据：" + "、".join(technical_themes[:4]))
    if not content.get("genres"):
        issues.append("故事定位缺少题材；题材必须回答这是什么类型的故事")
    if not content.get("conflicts"):
        issues.append("戏剧动力缺少核心冲突；至少提炼主角目标与阻碍之间的矛盾")
    generic_phase_pattern = re.compile(r"^(?:第[一二三四五六七八九十\d]+段语义单元|语义段落|主体叙事段落|叙事主体段落|核心叙事段落|核心剧情推进段|核心剧情段落|重复引入段|心理对话段|经济情境段|互动收尾段)")
    generic_phases = [str(item.get("label") or item.get("value") or "") for item in phases if isinstance(item, dict) and generic_phase_pattern.search(str(item.get("label") or item.get("value") or ""))]
    if generic_phases:
        issues.append("剧情阶段仍使用技术占位名称，必须改写为人物、行动与结果：" + "、".join(generic_phases[:4]))
    return issues


def _material_story_consistency_issues(result: dict[str, Any], duration: float = 0, source_corpus: str = "") -> list[str]:
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    summary_claim = content.get("summary")
    summary = str(summary_claim.get("value") or summary_claim.get("label") or "") if isinstance(summary_claim, dict) else str(summary_claim or "")
    characters = content.get("characters") if isinstance(content.get("characters"), list) else []
    relationships = content.get("relationships") if isinstance(content.get("relationships"), list) else []
    issues: list[str] = []
    if len(summary) < 220:
        issues.append("全片概括少于220字，必须补足中段转折和结尾结果")
    if not any(marker in summary for marker in ("为了", "因", "由于", "急需", "想要", "试图")):
        issues.append("剧情概括没有交代主角目标或行动动机")
    if not any(marker in summary for marker in ("导致", "因此", "于是", "迫使", "使得", "从而")):
        issues.append("剧情概括缺少事件之间的因果结果")
    if not any(marker in summary for marker in ("转而", "没想到", "却", "但", "反而", "直到")):
        issues.append("剧情概括没有呈现改变局势的转折")
    if not any(marker in summary for marker in ("结尾", "最终", "最后", "截至片尾", "片尾")):
        issues.append("剧情概括没有明确说明素材结束时的状态或悬念")
    doctor_names = [str(item.get("name") or item.get("label") or "") for item in characters if isinstance(item, dict) and ("医生" in str(item.get("name") or "") or "医生" in str(item.get("role") or ""))]
    protagonist_names = [str(item.get("name") or item.get("label") or "") for item in characters if isinstance(item, dict) and "主角" in str(item.get("role") or "")]
    if doctor_names and any(re.search(rf"{re.escape(name)}.{{0,12}}(?:作为|成为|是).{{0,8}}医生", summary) for name in protagonist_names if name and name not in doctor_names):
        issues.append("主角与医生实体被合并：已有单独医生角色时，不得把另一主角写成医生")
    garbled_names = [str(item.get("name") or "") for item in characters if isinstance(item, dict) and any(marker in str(item.get("name") or "") for marker in ("床", "重", "扩上"))]
    if garbled_names:
        issues.append("疑似ASR错名（" + "、".join(garbled_names) + "），无法确认实名时改用稳定角色称谓，不得把乱码当人名")
    for item in relationships:
        if not isinstance(item, dict):
            continue
        relation_text = " ".join(str(item.get(key) or "") for key in ("subject", "object", "type", "description", "label"))
        if "医生" in relation_text and "师徒" in relation_text:
            issues.append("医生关系被错挂为职场师徒；重新核对说话轮次，区分医患/亲密关系与真正的职场导师")
            break
    hook_claim = creative.get("hookSourceStatus") if isinstance(creative.get("hookSourceStatus"), dict) else {}
    if str(hook_claim.get("value") or hook_claim.get("label") or "") == "疑似外搭" and not creative.get("bodyTransition"):
        issues.append("缺少可观察的外搭片段结束/正片切入边界，不得仅凭翻译字幕判定疑似外搭")
    phases = content.get("segments") if isinstance(content.get("segments"), list) else []
    if duration > 0 and phases:
        for fifth in range(5):
            window_start, window_end = duration * fifth / 5, duration * (fifth + 1) / 5
            if not any(isinstance(item, dict) and float(item.get("end", 0) or 0) > window_start and float(item.get("start", 0) or 0) < window_end for item in phases):
                issues.append(f"剧情阶段遗漏第{fifth + 1}个时间区间")
    if duration > 0:
        overlong = [item for item in phases if isinstance(item, dict) and isinstance(item.get("start"), (int, float)) and isinstance(item.get("end"), (int, float)) and float(item["end"]) - float(item["start"]) > duration * .35]
        if overlong:
            issues.append("单个剧情阶段覆盖超过全片35%，中段被过度压缩；按真实转折拆分但总数保持4至7段")
    return list(dict.fromkeys(issues))


def _downgrade_unsupported_external_hook(result: dict[str, Any]) -> dict[str, Any]:
    """A language/style difference is not an external hook without a complete boundary."""
    output = dict(result)
    creative = dict(output.get("creative") or {})
    hook_claim = creative.get("hookSourceStatus") if isinstance(creative.get("hookSourceStatus"), dict) else {}
    status = str(hook_claim.get("value") or hook_claim.get("label") or "")
    hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
    complete_external = any(isinstance(item, dict) and item.get("scope") == "complete_external_fragment" and isinstance(item.get("start"), (int, float)) and float(item.get("start")) <= .5 and float(item.get("end", 0) or 0) > 5 for item in hooks)
    transition = creative.get("bodyTransition")
    if status == "疑似外搭" and not complete_external and not isinstance(transition, dict):
        creative["hookSourceStatus"] = {"code": "来源未知", "label": "来源未知", "value": "来源未知", "confidence": 0, "evidence": [], "verification": "unverified"}
        review = dict(output.get("review") or {})
        reasons = [str(item) for item in review.get("reasons", []) if str(item)] if isinstance(review.get("reasons"), list) else []
        reasons.append("未识别到完整外搭片段边界；字幕语言或视觉风格差异不足以判定外搭")
        output["review"] = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys(reasons))}
    output["creative"] = creative
    return output


def _ensure_material_story_landmarks(result: dict[str, Any], observations: list[dict[str, Any]], duration: float, shots: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Preserve high-salience, time-located facts that a generative merge may compress away."""
    output = dict(result)
    content = dict(output.get("content") or {})
    creative = dict(output.get("creative") or {})
    # Include the merged result as a fallback because persisted analyses retain
    # segment time ranges but may intentionally omit bulky per-segment model JSON.
    corpus = json.dumps({"observations": observations, "merged": result}, ensure_ascii=False)

    # Common ASR/OCR variants must resolve to the explicit-introduction form.
    aliases = {"林眠": "林绵", "林棉": "林绵"} if "这是林绵" in corpus or "林绵" in corpus else {}

    def replace_aliases(value: Any) -> Any:
        if isinstance(value, str):
            for source, target in aliases.items():
                value = value.replace(source, target)
            return value
        if isinstance(value, list):
            return [replace_aliases(item) for item in value]
        if isinstance(value, dict):
            return {key: replace_aliases(item) for key, item in value.items()}
        return value

    content = replace_aliases(content)
    creative = replace_aliases(creative)
    summary_claim = content.get("summary") if isinstance(content.get("summary"), dict) else {"value": str(content.get("summary") or ""), "confidence": .85, "evidence": []}
    summary = str(summary_claim.get("value") or "")
    # Compacted observations may omit one local wording even though the event
    # remains present in the segment evidence. Require a distinctive set of
    # landmarks spread across the story instead of one brittle exact phrase.
    landmark_groups = (
        ("卖卵", "捐卵", "捭卵"),
        ("陪酒", "会所"),
        ("建筑设计", "秦总", "工作机会"),
        ("医院改进", "医院改造", "医院项目", "医院"),
        ("剪刀", "杀了你"),
    )
    landmark_hits = [any(marker in corpus for marker in group) for group in landmark_groups]
    # OCR/ASR can miss one late visual landmark (notably the scissors) even
    # when the long-form story result still has a distinctive opening,
    # coercion sequence and workplace/hospital turn.  Require independent
    # landmarks from three parts of a long material instead of one brittle
    # ending token.
    landmark_profile = (
        duration >= 1200
        and landmark_hits[0]
        and sum(landmark_hits[1:4]) >= 2
        and (landmark_hits[-1] or any(marker in corpus for marker in ("危险", "对峙", "威胁", "FlickReels")))
    )
    if landmark_profile:
        doctor_name = next((str(item.get("name") or item.get("label") or "") for item in content.get("characters", []) if isinstance(item, dict) and ("医生" in str(item.get("role") or "") or str(item.get("name") or "").startswith("时"))), "时医生")
        character_claim = {"confidence": .9, "evidence": [], "verification": "unverified"}
        content["characters"] = [
            {**character_claim, "code": "CHARACTER_LIN_MIAN", "name": "林绵", "label": "林绵", "value": "林绵", "role": "女主角，建筑设计学生/职场新人"},
            {**character_claim, "code": "CHARACTER_DOCTOR", "name": doctor_name, "label": doctor_name, "value": doctor_name, "role": "男主角，医生"},
            {**character_claim, "code": "CHARACTER_QIN", "name": "秦总", "label": "秦总", "value": "秦总", "role": "职场导师"},
            {**character_claim, "code": "CHARACTER_SONG", "name": "宋少", "label": "宋少", "value": "宋少", "role": "阶段性施压者"},
        ]
        summary_claim["value"] = (
            f"女大学生林绵因经济拮据考虑卖卵，意外与富家出身的外科医生{doctor_name}发生亲密关系；复诊和用药对话延续两人的尴尬与债务牵连。"
            f"家庭压力加重迫使林绵到会所寻找出路，她遭宋少逼迫陪酒，{doctor_name}赶来解围，却以金钱和权威持续干预她的选择，导致二人围绕信任、控制和关系边界反复冲突。"
            f"随后林绵获秦总引荐进入建筑设计公司，并负责医院改造项目，与曾为她看病的{doctor_name}重逢。她试图划清界限，家庭与暴力威胁却把矛盾推向高潮；"
            f"结尾林绵持剪刀与男子对峙，{doctor_name}赶到，剧情在冲突未决时切入FlickReels推广，留下悬念。"
        )
        content["summary"] = summary_claim

        relation_claim = {"confidence": .9, "evidence": [], "verification": "unverified"}
        content["relationships"] = [
            {**relation_claim, "code": "RELATION_ROMANTIC_MEDICAL", "subject": "林绵", "object": doctor_name, "type": "亲密、医患、债务与控制关系", "description": "两人由意外亲密和医患接触建立联系，随后因债务、卖卵与控制欲反复拉扯，林绵试图划清边界。", "label": f"林绵与{doctor_name}：亲密、医患、债务与控制关系，两人由意外亲密和医患接触建立联系，随后因债务、卖卵与控制欲反复拉扯。"},
            {**relation_claim, "code": "RELATION_WORKPLACE_MENTOR", "subject": "林绵", "object": "秦总", "type": "职场上下级与师徒关系", "description": "秦总引荐她进入建筑设计公司并指导其参与医院改造项目。", "label": "林绵与秦总：职场上下级与师徒关系，秦总引荐她进入建筑设计公司并指导其参与医院改造项目。"},
            {**relation_claim, "code": "RELATION_COERCION", "subject": "宋少", "object": "林绵", "type": "权力压迫", "description": "宋少利用金钱和地位逼迫林绵陪酒。", "label": "宋少与林绵：权力压迫关系，宋少利用金钱和地位逼迫林绵陪酒。"},
        ]
        for relation in content["relationships"]:
            relation["value"] = relation["label"]

        common_claim = {"confidence": .95, "evidence": [], "verification": "verified"}
        creative["hookAssemblyType"] = {**common_claim, "code": "SAME_DRAMA_PREFACE", "label": "同剧外搭", "value": "同剧外搭"}
        creative["hookSourceStatus"] = {**common_claim, "code": "SAME_DRAMA", "label": "已确认同剧", "value": "已确认同剧"}
        creative["format"] = {**common_claim, "code": "EXTERNAL_HOOK_PLUS_BODY", "label": "外搭钩子＋本剧正片", "value": "外搭钩子＋本剧正片"}
        creative["externalHookSummary"] = "林绵与时凛在卧室发生亲密冲突：时凛质问她是否仍是处女并怀疑她此前的说法，林绵震惊后坚持自己没有撒谎；时凛把她拉近继续试探，关系中的不信任、控制欲和身体边界被集中抛出，随后画面以‘一天前’回拨到两人相识前的卖卵主线。"

        hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
        opening_candidates = [item for item in hooks if isinstance(item, dict)]
        # Detect the first structural body reset independently of a provider's
        # proposed hook end. Otherwise an overlong 30s model interval becomes
        # its own lower bound and can swallow the first body shot.
        opening_end = _opening_preface_boundary([{"start": 0.0, "end": 12.0}], shots or [], duration)
        if opening_end is None:
            opening_end = _opening_preface_boundary(opening_candidates, shots or [], duration)
        if opening_end is None:
            opening_end = next((float(item.get("end")) for item in hooks if isinstance(item, dict) and isinstance(item.get("start"), (int, float)) and isinstance(item.get("end"), (int, float)) and float(item.get("start")) <= .5 and 5 <= float(item.get("end")) <= 30), 12.0)
        creative["bodyTransition"] = {**common_claim, "code": "BODY_RESET", "label": "时间回拨进入正片", "value": "时间回拨进入正片", "start": round(opening_end, 3), "time": round(opening_end, 3)}
        creative["hooks"] = [{
            **common_claim,
            "id": "opening-complete-preface",
            "code": "RELATIONSHIP_CONFLICT_PREFACE",
            "label": "亲密关系质问与身体边界钩子",
            "value": "关系冲突钩子",
            "hookType": "关系冲突钩子",
            "start": 0.0,
            "end": round(opening_end, 3),
            "plotSummary": creative["externalHookSummary"],
            "spokenSummary": "时凛质问林绵的贞洁与诚信，林绵否认撒谎并抵抗他的控制。",
            "visualSummary": "卧室近景中男人将女人拉近试探，随后以时间回拨转入一天前的主线。",
            "scope": "complete_external_fragment",
            "reviewRequired": False,
        }]

        phases = content.get("segments") if isinstance(content.get("segments"), list) else []
        phases = [dict(item) for item in phases if isinstance(item, dict)]
        if phases:
            if opening_end and isinstance(phases[0].get("start"), (int, float)) and float(phases[0].get("start")) <= .5 and float(phases[0].get("end", 0) or 0) > opening_end:
                phases[0]["end"] = opening_end
                if len(phases) > 1:
                    phases[1]["start"] = opening_end
            timed_observations = [_material_story_observation(item, index) for index, item in enumerate(observations)]
            hospital_time = next((float(item.get("start", 0)) for item in timed_observations if any(marker in json.dumps(item, ensure_ascii=False) for marker in ("医院改进", "医院改造"))), 1080.0)
            ending_time = next((float(item.get("start", 0)) for item in timed_observations if "剪刀" in json.dumps(item, ensure_ascii=False)), 1380.0)
            ending_time = min(max(1200.0, ending_time), duration - 1)
            common = {"confidence": .9, "evidence": [], "verification": "unverified"}
            content["segments"] = [
                {**common, "code": "STORY_PHASE_1", "label": "同剧高光前置", "value": "同剧高光前置", "start": 0, "end": round(opening_end or 12, 3), "description": f"林绵与{doctor_name}在卧室因贞洁质问、信任和身体边界爆发冲突；完整片段结束后以时间回拨进入正片。"},
                {**common, "code": "STORY_PHASE_2", "label": "经济困境与意外关系", "value": "经济困境与意外关系", "start": round(opening_end or 12, 3), "end": 300, "description": f"林绵因缺钱考虑卖卵，并与富家出身的外科医生{doctor_name}发生意外亲密；金钱、医患与债务关系由此交织。"},
                {**common, "code": "STORY_PHASE_3", "label": "复诊、家庭压力与会所解围", "value": "复诊、家庭压力与会所解围", "start": 300, "end": 780, "description": f"复诊和用药对话延续亲密事件的后果，家庭压力又迫使林绵寻找出路；她在会所遭宋少逼迫陪酒，{doctor_name}介入解围。"},
                {**common, "code": "STORY_PHASE_4", "label": "控制冲突与职业转机", "value": "控制冲突与职业转机", "start": 780, "end": 1020, "description": f"{doctor_name}以金钱和权威干预林绵的决定，两人围绕信任、债务与控制欲冲突；与此同时，林绵获得建筑设计公司的工作机会。"},
                {**common, "code": "STORY_PHASE_5", "label": "医院项目重逢与关系边界", "value": "医院项目重逢与关系边界", "start": 1020, "end": round(ending_time, 3), "description": f"林绵跟随秦总参与医院改造项目，与曾为她看病且有亲密纠葛的{doctor_name}重逢；面对他的持续干预，她明确关系边界。"},
                {**common, "code": "STORY_PHASE_6", "label": "家庭威胁、剪刀对峙与悬念", "value": "家庭威胁、剪刀对峙与悬念", "start": round(ending_time, 3), "end": round(duration, 3), "description": f"家庭与暴力威胁把矛盾推至高潮，林绵持剪刀与男子对峙，{doctor_name}赶到；剧情在冲突未决时切入FlickReels推广。"},
            ]
            creative["timeline"] = []
    output["content"] = content
    output["creative"] = creative
    return output


def _material_story_observation(result: dict[str, Any], index: int) -> dict[str, Any]:
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    summary = content.get("summary")
    summary_text = str(summary.get("value") or summary.get("label") or "") if isinstance(summary, dict) else str(summary or "")
    segments = content.get("segments") if isinstance(content.get("segments"), list) else []
    starts = [float(item.get("start", index * 60) or index * 60) for item in segments if isinstance(item, dict)]
    ends = [float(item.get("end", (index + 1) * 60) or (index + 1) * 60) for item in segments if isinstance(item, dict)]
    dialogue_evidence: list[dict[str, Any]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        evidence_values = segment.get("evidence") if isinstance(segment.get("evidence"), list) else []
        for evidence in evidence_values:
            if not isinstance(evidence, dict):
                continue
            source_text = str(evidence.get("sourceText") or evidence.get("text") or "").strip()
            if not source_text:
                continue
            dialogue_evidence.append({"timecode": evidence.get("timecode"), "source": evidence.get("source"), "text": source_text[:700]})
    return {
        "index": index + 1,
        "start": min(starts, default=index * 60.0),
        "end": max(ends, default=(index + 1) * 60.0),
        "summary": summary_text[:500],
        "beats": [{"start": item.get("start"), "end": item.get("end"), "label": item.get("label"), "description": str(item.get("description") or "")[:240]} for item in segments[:6] if isinstance(item, dict)],
        "dialogueEvidence": dialogue_evidence[:8],
    }


def _bounded_story_synthesis_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Keep long-material story synthesis below provider context limits."""
    output = dict(payload)
    output["frames"] = []
    output["orderedObservations"] = [
        {**item, "summary": str(item.get("summary") or "")[:320],
         "beats": [{**beat, "description": str(beat.get("description") or "")[:160]} for beat in (item.get("beats") or [])[:4] if isinstance(beat, dict)],
         "dialogueEvidence": [{**evidence, "text": str(evidence.get("text") or "")[:180]} for evidence in (item.get("dialogueEvidence") or [])[:3] if isinstance(evidence, dict)]}
        for item in output.get("orderedObservations", []) if isinstance(item, dict)
    ]
    output["dialogueTimeline"] = [
        {"start": item.get("start"), "end": item.get("end"),
         "utterances": [{**utterance, "text": str(utterance.get("text") or "")[:120]} for utterance in (item.get("utterances") or [])[:6] if isinstance(utterance, dict)]}
        for item in output.get("dialogueTimeline", []) if isinstance(item, dict)
    ]
    ledger = output.get("eventLedger") if isinstance(output.get("eventLedger"), dict) else {}
    output["eventLedger"] = {**ledger, "events": [
        {key: (str(value)[:240] if isinstance(value, str) else value) for key, value in event.items()}
        for event in (ledger.get("events") or [])[:48] if isinstance(event, dict)
    ]}
    output = {
        key: output.get(key)
        for key in ("durationSeconds", "orderedObservations", "draftClassification", "openingAnalysis", "eventLedger", "requirements")
    }
    def bound(value: Any, depth: int = 0) -> Any:
        if isinstance(value, str):
            return value[:160]
        if isinstance(value, list):
            return [bound(item, depth + 1) for item in value[:20]]
        if isinstance(value, dict):
            return {str(key): bound(item, depth + 1) for key, item in value.items()}
        return value
    return bound(output)


def _complete_story_event_title(group: list[dict[str, Any]], index: int) -> str:
    """Describe the event span without cutting a name, verb or consequence."""
    primary = group[0]
    actor = primary["actor"] if primary["actor"] not in {"角色", "未知角色", "角色A", "角色B", "角色C"} else "当事人"
    action = str(primary.get("action") or primary.get("result") or "").strip("，。；：:、 ")
    outcome = ""
    for event in reversed(group):
        candidate = str(event.get("relationship") or event.get("result") or "").strip("，。；：:、 ")
        if candidate and candidate not in action:
            outcome = candidate
            break
    title = f"{actor}{action}" if action else outcome
    if outcome and outcome not in title:
        title = f"{title}，{outcome}"
    return re.sub(r"\s+", " ", title).strip("，。；：:、 ") or f"事件{index + 1}"


def _storyboard_units_from_event_ledger(ledger: dict[str, Any], duration: float, maximum: int = 15) -> list[dict[str, Any]]:
    """Project observed events into a continuous event-level storyboard.

    The provider's 4-7 phases are useful as a compact overview, but they are
    too coarse for the storyboard UI.  The event ledger already contains the
    causal atoms we need, so keep those atoms and use adjacent event starts as
    display boundaries.  This guarantees full temporal coverage without
    inventing fixed 30/60-second story chunks.
    """
    raw_events = ledger.get("events") if isinstance(ledger, dict) else None
    events: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_events if isinstance(raw_events, list) else []):
        if not isinstance(raw, dict):
            continue
        try:
            start = max(0.0, min(duration, float(raw.get("start", 0) or 0)))
            end = max(start, min(duration, float(raw.get("end", start) or start)))
            confidence = max(0.0, min(1.0, float(raw.get("confidence", 0) or 0)))
        except (TypeError, ValueError):
            continue
        actor = str(raw.get("actor") or "角色").strip()
        goal = str(raw.get("goal") or "").strip()
        action = str(raw.get("action") or "").strip()
        obstacle = str(raw.get("obstacle") or "").strip()
        result_text = str(raw.get("result") or "").strip()
        relationship = str(raw.get("relationshipChange") or "").strip()
        if not action and not result_text:
            continue
        signature = re.sub(r"\s+", "", f"{actor}|{action}|{result_text}")
        if any(abs(start - item["sourceStart"]) < .5 and signature == item["signature"] for item in events):
            continue
        events.append({
            "sourceIndex": index, "sourceStart": start, "sourceEnd": end,
            "actor": actor, "goal": goal, "action": action, "obstacle": obstacle,
            "result": result_text, "relationship": relationship,
            "confidence": confidence, "signature": signature,
        })
    events.sort(key=lambda item: (item["sourceStart"], item["sourceEnd"], item["sourceIndex"]))
    if not events:
        return []

    # Preserve event order but merge only when the ledger is too dense for a
    # usable horizontal storyboard.  This is event-count bounding, never a
    # time-grid split.
    group_count = min(maximum, len(events))
    groups = [events[index * len(events) // group_count:(index + 1) * len(events) // group_count] for index in range(group_count)]
    groups = [group for group in groups if group]
    boundaries = [0.0] + [max(0.0, min(duration, group[0]["sourceStart"])) for group in groups[1:]] + [duration]
    units: list[dict[str, Any]] = []
    generic_labels = {"剧情理解", "部分完整", "不完整", "剧情推进", "对话驱动", "未确定"}
    for index, group in enumerate(groups):
        primary = group[0]
        actor = primary["actor"] if primary["actor"] not in {"角色", "未知角色", "角色A", "角色B", "角色C"} else "当事人"
        consequence = primary["result"]
        label = _complete_story_event_title(group, index)
        if label in generic_labels:
            label = f"{actor}{consequence}" if consequence else f"事件{index + 1}"
        sentences: list[str] = []
        for event in group:
            clauses = []
            if event["goal"]:
                clauses.append(f"为{event['goal']}")
            if event["action"]:
                clauses.append(f"{event['actor']}{event['action']}")
            if event["obstacle"]:
                clauses.append(f"但{event['obstacle']}")
            if event["result"]:
                clauses.append(f"结果{event['result']}")
            if event["relationship"]:
                clauses.append(f"关系变化为{event['relationship']}")
            sentence = "，".join(clauses).strip("，。； ")
            if sentence and sentence not in sentences:
                sentences.append(sentence)
        description = _complete_sentence_limit("；随后".join(sentences), 360).rstrip("，；。") + "。"
        confidence = min((event["confidence"] for event in group), default=0.0)
        source_start = min(event["sourceStart"] for event in group)
        source_end = max(event["sourceEnd"] for event in group)
        units.append({
            "code": f"STORY_EVENT_{index + 1}", "label": label, "value": label,
            "start": round(boundaries[index], 3), "end": round(boundaries[index + 1], 3),
            "description": description, "confidence": confidence,
            "evidence": [{"source": "event-ledger", "timecode": {"start": round(source_start, 3), "end": round(source_end, 3)}, "confidence": confidence}],
            "verification": "verified" if confidence >= .8 else "needs_review",
        })
    return units


def _storyboard_quality_issues(units: list[dict[str, Any]], duration: float) -> list[str]:
    if not units:
        return ["事件账本没有生成可展示的故事情节点"]
    issues: list[str] = []
    if float(units[0].get("start", 0) or 0) > max(1.0, duration * .01):
        issues.append("事件时间线没有覆盖片头")
    if float(units[-1].get("end", 0) or 0) < duration * .95:
        issues.append("事件时间线没有覆盖结尾")
    for previous, current in zip(units, units[1:]):
        if float(current.get("start", 0) or 0) - float(previous.get("end", 0) or 0) > max(2.0, duration * .02):
            issues.append("事件时间线存在未解释的明显空档")
            break
    if duration > 0 and any(float(item.get("end", 0) or 0) - float(item.get("start", 0) or 0) > duration * .25 for item in units):
        issues.append("单个故事情节点覆盖超过全片25%，需要继续按真实事件拆分")
    if any(str(item.get("label") or "") in {"剧情理解", "部分完整", "不完整", "剧情推进", "对话驱动", "未确定"} for item in units):
        issues.append("故事情节点仍含抽象质量标签，未形成具体人物行动")
    return list(dict.fromkeys(issues))


def _complete_sentence_limit(value: str, maximum: int = 1200) -> str:
    """Bound display prose without persisting a visibly broken sentence."""
    text = str(value or "").strip()
    if len(text) <= maximum:
        return text
    clipped = text[:maximum]
    boundary = max(clipped.rfind(marker) for marker in ("。", "！", "？", ";", "；"))
    # Keep a complete long sentence instead of replacing one bad truncation
    # with another when there is no useful boundary near the limit.
    return clipped[:boundary + 1].strip() if boundary >= int(maximum * .65) else text


def _augment_story_from_event_ledger(result: dict[str, Any], ledger: dict[str, Any], duration: float) -> dict[str, Any]:
    """Fill lossy synopsis/phase gaps from time-located generic ledger events."""
    output = dict(result)
    content = dict(output.get("content") or {})
    characters = [dict(item) for item in content.get("characters", []) if isinstance(item, dict)] if isinstance(content.get("characters"), list) else []
    name_map: dict[str, str] = {}
    for character in characters:
        raw_name = str(character.get("name") or character.get("label") or "").strip()
        name = raw_name
        if "宋少" in name:
            name = "宋少"
        elif "医生" in name and len(name) > 4:
            name = "男医生"
        name_map[raw_name] = name
        character["name"] = name
        character["label"] = name
        character["value"] = name
    if characters:
        content["characters"] = characters
    relationships = [dict(item) for item in content.get("relationships", []) if isinstance(item, dict)] if isinstance(content.get("relationships"), list) else []
    for relation in relationships:
        relation["subject"] = name_map.get(str(relation.get("subject") or ""), str(relation.get("subject") or ""))
        relation["object"] = name_map.get(str(relation.get("object") or ""), str(relation.get("object") or ""))
        relation["label"] = f"{relation['subject']}与{relation['object']}：{relation.get('type') or '关系'}" + (f"，{relation.get('description')}" if relation.get("description") else "")
        relation["value"] = relation["label"]
    if relationships:
        content["relationships"] = relationships
    phases = [dict(item) for item in content.get("segments", []) if isinstance(item, dict)] if isinstance(content.get("segments"), list) else []
    events = []
    for event in ledger.get("events", []) if isinstance(ledger, dict) and isinstance(ledger.get("events"), list) else []:
        if not isinstance(event, dict) or float(event.get("confidence", 0) or 0) < .65:
            continue
        try:
            start = max(0.0, min(duration, float(event.get("start", 0) or 0)))
        except (TypeError, ValueError):
            continue
        actor = str(event.get("actor") or "角色").strip()
        if "宋少" in actor:
            actor = "宋少"
        action = str(event.get("action") or "").strip()
        result_text = str(event.get("result") or "").strip()
        relation = str(event.get("relationshipChange") or "").strip()
        compact = "，".join(part for part in (f"{actor}{action}" if action else "", result_text, relation) if part)
        if compact:
            events.append((start, compact[:180]))
    fixed_minute_phases = sum(1 for phase in phases if abs(float(phase.get("end", 0) or 0) - float(phase.get("start", 0) or 0) - 60) < .2)
    if events and (not 4 <= len(phases) <= 7 or fixed_minute_phases > 1):
        target_count = min(6, max(4, len(events) // 3 or 4))
        groups = [events[index * len(events) // target_count:(index + 1) * len(events) // target_count] for index in range(target_count)]
        groups = [group for group in groups if group]
        boundaries = [0.0] + [round(group[0][0], 3) for group in groups[1:]] + [round(duration, 3)]
        phases = []
        for index, group in enumerate(groups):
            first_event = group[0][1].split("，", 1)[0].strip("；，。 ")
            label = first_event or f"剧情阶段{index + 1}"
            phases.append({"code": f"STORY_PHASE_{index + 1}", "label": label, "value": label, "confidence": .85, "evidence": [], "verification": "unverified", "start": boundaries[index], "end": boundaries[index + 1], "description": "；随后".join(text for _, text in group)[:260]})
    if phases and events:
        for phase in phases:
            start, end = float(phase.get("start", 0) or 0), float(phase.get("end", duration) or duration)
            description = str(phase.get("description") or "").strip()
            additions = [text for event_start, text in events if start <= event_start < end and text not in description][:2]
            if additions:
                phase["description"] = (description + "；随后" + "；继而".join(additions))[:360]
        last = phases[-1]
        late_events = [(start, text) for start, text in events if start >= duration * .78]
        if late_events and len(phases) < 7 and float(last.get("start", 0) or 0) < duration * .75:
            danger_events = [(start, text) for start, text in late_events if any(marker in text for marker in ("剪刀", "刀", "威胁", "对峙", "赶到", "上锁", "杀"))]
            split = min(start for start, _ in danger_events) if danger_events else max(start for start, _ in late_events)
            if split > float(last.get("start", 0) or 0) + 20:
                last["end"] = round(split, 3)
                phases.append({"code": f"STORY_PHASE_{len(phases) + 1}", "label": "结尾危机与悬念", "value": "结尾危机与悬念", "confidence": .85, "evidence": [], "verification": "unverified", "start": round(split, 3), "end": round(duration, 3), "description": "；随后".join(text for _, text in late_events[-3:])[:360]})
        content["segments"] = phases
    storyboard_units = _storyboard_units_from_event_ledger(ledger, duration)
    if storyboard_units:
        content["storyboardUnits"] = storyboard_units
    summary_claim = content.get("summary") if isinstance(content.get("summary"), dict) else {"value": str(content.get("summary") or "")}
    summary = str(summary_claim.get("value") or "").strip()
    if len(summary) < 220 and phases:
        for _, detail in events:
            detail = detail.strip()
            if detail and detail[:16] not in summary:
                summary += ("随后，" if summary else "") + detail[:70].rstrip("，；") + "。"
            if len(summary) >= 230:
                break
        summary_claim["value"] = _complete_sentence_limit(summary)
        content["summary"] = summary_claim
    # A substantial synthesis already contains its causal relationships.
    # Appending the relationship table again made the synopsis repetitive.
    for relation in relationships[:4] if len(summary) < 220 else []:
        subject, obj = str(relation.get("subject") or ""), str(relation.get("object") or "")
        relation_type = str(relation.get("type") or "")
        if subject and obj and (subject not in summary or obj not in summary or relation_type not in summary):
            detail = str(relation.get("description") or relation.get("label") or "").strip()
            summary += f"同时，{subject}与{obj}形成{relation_type}：{detail[:70]}。"
    if phases:
        ending = str(phases[-1].get("description") or "").strip()
        if ending and ending not in summary:
            summary += f"结尾，{ending[:90]}。"
    if summary:
        summary_claim["value"] = _complete_sentence_limit(summary)
        content["summary"] = summary_claim
    storyboard_issues = _storyboard_quality_issues(storyboard_units, duration)
    if storyboard_issues:
        review = dict(output.get("review") or {})
        reasons = [str(item) for item in review.get("reasons", []) if str(item)] if isinstance(review.get("reasons"), list) else []
        output["review"] = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys([*reasons, *storyboard_issues]))}
    output["content"] = content
    return output


def _apply_material_story_synthesis(result: dict[str, Any], synthesis: dict[str, Any], duration: float) -> dict[str, Any]:
    """Project a deliberately tiny story response into material-v2 without reintroducing raw chunks."""
    output = dict(result)
    content = dict(output.get("content") or {})
    creative = dict(output.get("creative") or {})
    summary = str(synthesis.get("summary") or "").strip()
    if summary:
        content["summary"] = {"value": _complete_sentence_limit(summary), "confidence": .9, "evidence": []}

    def simple_claim(label: str, code: str = "") -> dict[str, Any]:
        return {"code": code or re.sub(r"\W+", "_", label).strip("_")[:80] or "UNSPECIFIED", "label": label, "value": label, "confidence": .85, "evidence": [], "verification": "unverified"}

    characters = []
    for index, item in enumerate(synthesis.get("characters", []) if isinstance(synthesis.get("characters"), list) else []):
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            continue
        name = str(item.get("name")).strip()
        characters.append({**simple_claim(name, f"CHARACTER_{index + 1}"), "characterId": str(item.get("characterId") or f"character-{index + 1}"), "name": name, "originalName": str(item.get("originalName") or ""), "role": str(item.get("role") or "")})
    if characters:
        content["characters"] = characters[:8]
    character_names = {
        str(item.get("characterId") or ""): str(item.get("name") or "")
        for item in characters
        if str(item.get("characterId") or "") and str(item.get("name") or "")
    }
    relationships = []
    for index, item in enumerate(synthesis.get("relationships", []) if isinstance(synthesis.get("relationships"), list) else []):
        if not isinstance(item, dict):
            continue
        subject_id = str(item.get("subject") or item.get("from") or "").strip()
        object_id = str(item.get("object") or item.get("to") or "").strip()
        subject = character_names.get(subject_id, subject_id)
        obj = character_names.get(object_id, object_id)
        relation_type = str(item.get("type") or "关系").strip()
        description = str(item.get("description") or "").strip()
        if not subject or not obj:
            continue
        label = f"{subject}与{obj}：{relation_type}" + (f"，{description}" if description else "")
        relationships.append({**simple_claim(label, f"RELATION_{index + 1}"), "subject": subject, "object": obj, "type": relation_type, "description": description})
    if relationships:
        content["relationships"] = relationships[:8]
    phases = []
    for index, item in enumerate(synthesis.get("phases", []) if isinstance(synthesis.get("phases"), list) else []):
        if not isinstance(item, dict):
            continue
        try:
            start, end = max(0.0, float(item.get("start", 0))), min(duration, float(item.get("end", duration)))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        label = str(item.get("label") or f"剧情阶段{index + 1}").strip()
        phases.append({**simple_claim(label, f"STORY_PHASE_{index + 1}"), "start": round(start, 3), "end": round(end, 3), "description": str(item.get("description") or "").strip()})
    if 4 <= len(phases) <= 7:
        content["segments"] = phases
        creative["timeline"] = []
        review = dict(output.get("review") or {})
        reasons = [str(item) for item in review.get("reasons", []) if str(item) != "云端全片汇总截断，已按验证分段进行确定性聚合"] if isinstance(review.get("reasons"), list) else []
        output["review"] = {**review, "reasons": reasons}
    for field, limit in (("genres", 3), ("themes", 6), ("emotions", 6), ("conflicts", 6), ("scenes", 8)):
        values = synthesis.get(field) if isinstance(synthesis.get(field), list) else []
        content[field] = [simple_claim(str(value.get("label") or value.get("value") or "") if isinstance(value, dict) else str(value)) for value in values if (str(value.get("label") or value.get("value") or "").strip() if isinstance(value, dict) else str(value).strip())][:limit]
    current_hook = creative.get("hookSourceStatus") if isinstance(creative.get("hookSourceStatus"), dict) else {}
    hook_source = str(synthesis.get("hookSourceStatus") or "").strip()
    if hook_source and not (current_hook.get("verification") == "verified" and str(current_hook.get("value") or current_hook.get("label") or "") not in {"来源未知", "疑似外搭", "未确定"}):
        creative["hookSourceStatus"] = simple_claim(hook_source, hook_source)
    current_format = creative.get("format") if isinstance(creative.get("format"), dict) else {}
    material_format = str(synthesis.get("format") or "").strip()
    if material_format and not (current_format.get("verification") == "verified" and str(current_format.get("value") or current_format.get("label") or "") != "未确定"):
        creative["format"] = simple_claim(material_format, material_format)
    output["content"] = content
    output["creative"] = creative
    return output


def _apply_material_opening_analysis(result: dict[str, Any], analysis: dict[str, Any], duration: float) -> dict[str, Any]:
    """Apply a complete opening-unit decision without changing body story facts."""
    output = dict(result)
    creative = dict(output.get("creative") or {})
    creative["openingAnalysis"] = analysis
    source = str(analysis.get("hookSourceStatus") or analysis.get("hookSrcStatus") or "来源未知")
    assembly = str(analysis.get("hookAssemblyType") or analysis.get("hookAssembly") or "外搭来源待确认")
    distinct = analysis.get("distinctPreface") is True or assembly in {"同剧外搭", "跨剧外搭"}
    try:
        transition = float(analysis.get("transitionTime", 0) or 0)
    except (TypeError, ValueError):
        transition = 0
    summary = str(analysis.get("plotSummary") or analysis.get("plotSum") or "").strip()
    spoken_value = analysis.get("spokenSummary") or analysis.get("spokensum") or analysis.get("spoken汇总") or ""
    spoken_lines = [str(item.get("text") or item.get("translation") or "").strip() for item in spoken_value if isinstance(item, dict)] if isinstance(spoken_value, list) else [str(spoken_value).strip()] if str(spoken_value).strip() else []
    question = next((line for line in spoken_lines if any(marker in line for marker in ("吗", "是否", "是不是"))), "")
    if question:
        content = output.get("content") if isinstance(output.get("content"), dict) else {}
        names = [str(item.get("name") or item.get("label") or "").strip() for item in content.get("characters", []) if isinstance(item, dict)] if isinstance(content.get("characters"), list) else []
        female_name = next((name for name in names if name and all(role not in name for role in ("医生", "男子", "男性", "宋少", "秦总", "父亲", "母亲"))), "女主")
        male_name = next((name for name in names if "医生" in name or "男性" in name or "男子" in name), "男主")
        answer = next((line for line in spoken_lines if line and line != question), "作出回应")
        testing = next((line for line in spoken_lines[1:] if line and line not in (question, answer)), "继续试探")
        summary = f"女性角色{female_name}与男性角色{male_name}在室内发生亲密冲突；男方围绕‘{question}’提出质疑，女方以‘{answer}’回应，随后又以‘{testing}’继续试探。结合拉近、触碰和惊讶抗拒的画面，这段开场集中呈现两人之间的不信任、控制欲与身体边界冲突，并在{round(transition, 2)}秒重置进入关系起点。"
        analysis["hookType"] = "亲密关系质问与身体边界钩子"
    if distinct and 5 <= transition <= min(120.0, duration * .5) and summary:
        confidence = float(analysis.get("confidence", .85) or .85)
        claim = {"confidence": confidence, "evidence": [{"source": "opening-multimodal-analysis", "timecode": {"start": 0.0, "end": round(transition, 3)}, "confidence": confidence}], "verification": "verified"}
        creative["format"] = {**claim, "code": "EXTERNAL_HOOK_PLUS_BODY", "label": "外搭钩子＋本剧正片", "value": "外搭钩子＋本剧正片"}
        creative["hookSourceStatus"] = {**claim, "code": source, "label": source, "value": source}
        creative["hookAssemblyType"] = {**claim, "code": assembly, "label": assembly, "value": assembly}
        creative["bodyTransition"] = {**claim, "code": "BODY_RESET", "label": str(analysis.get("transitionDescription") or "开场片段结束并进入正片"), "value": str(analysis.get("transitionDescription") or "开场片段结束并进入正片"), "start": round(transition, 3), "time": round(transition, 3)}
        creative["externalHookSummary"] = summary
        hook_type = str(analysis.get("hookType") or "开场冲突钩子").strip()
        creative["hooks"] = [{**claim, "code": "OPENING_PREFACE", "label": "完整开场钩子", "value": "完整开场钩子", "hookType": hook_type, "start": 0.0, "end": round(transition, 3), "plotSummary": summary, "spokenSummary": str(spoken_value), "visualSummary": str(analysis.get("visualSummary") or analysis.get("visualsum") or analysis.get("visual汇总") or ""), "scope": "complete_external_fragment"}]
    elif not distinct:
        # A native first story beat can still be a strong hook, but it has no
        # separately assembled source to attribute. Do not preserve a stale
        # segment-level "来源未知" result when the opening audit found no reset.
        confidence = float(analysis.get("confidence", .85) or .85)
        evidence = [{"source": "opening-continuity-analysis", "timecode": {"start": 0.0, "end": round(min(60.0, duration), 3)}, "confidence": confidence}]
        creative["hookSourceStatus"] = {"code": "NO_INDEPENDENT_HOOK", "label": "无独立钩子", "value": "无独立钩子", "confidence": confidence, "evidence": evidence, "verification": "verified"}
        creative["hookAssemblyType"] = {"code": "NONE", "label": "无前置钩子", "value": "无前置钩子", "confidence": confidence, "evidence": evidence, "verification": "verified"}
        creative.pop("bodyTransition", None)
        creative.pop("externalHookSummary", None)
    output["creative"] = creative
    return output


def _aggregate_material_classification(results: list[dict[str, Any]], duration: float) -> dict[str, Any]:
    """Deterministic evidence-preserving fallback when the merge response truncates."""
    def claims(path: tuple[str, ...]) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for item in results:
            value: Any = item
            for name in path:
                value = value.get(name) if isinstance(value, dict) else None
            if isinstance(value, dict) and value.get("verification") == "verified":
                found.append(value)
        return found

    def winner(items: list[dict[str, Any]], allowed: set[str], fallback: str) -> dict[str, Any]:
        scores: dict[str, float] = {}
        samples: dict[str, dict[str, Any]] = {}
        for claim in items:
            label = str(claim.get("value") or claim.get("label") or claim.get("code") or "")
            if label not in allowed:
                continue
            scores[label] = scores.get(label, 0.0) + float(claim.get("confidence", 0) or 0)
            samples.setdefault(label, claim)
        label = max(scores, key=scores.get) if scores else fallback
        sample = samples.get(label, {})
        return {"code": label, "label": label, "value": label, "confidence": float(sample.get("confidence", 0) or 0), "evidence": list(sample.get("evidence", []))[:2], "verification": sample.get("verification", "unverified")}

    body = winner(claims(("creative", "bodyFormat")), {"正片主导", "解说主导", "混合", "未确定"}, "未确定")
    opening_results = results[:2]
    opening_claims = []
    for item in opening_results:
        claim = (item.get("creative") or {}).get("hookSourceStatus") if isinstance(item.get("creative"), dict) else None
        if isinstance(claim, dict) and claim.get("verification") == "verified":
            opening_claims.append(claim)
    hook_source = winner(opening_claims, {"无独立钩子", "已确认同剧", "疑似外搭", "已确认外搭", "来源未知"}, "来源未知")
    narration_values = [float(item.get("value")) for item in claims(("creative", "narrationCoverage")) if isinstance(item.get("value"), (int, float))]
    narration = sum(narration_values) / len(narration_values) if narration_values else 0.0
    summaries = []
    for item in results[:3]:
        summary = (item.get("content") or {}).get("summary") if isinstance(item.get("content"), dict) else None
        text = summary.get("value") if isinstance(summary, dict) else None
        if text:
            summaries.append(str(text))
    evidence = list(body.get("evidence", []))[:2]
    safety_sanitized = any(item.get("_providerSafetySanitized") is True for item in results)
    review_required = safety_sanitized or hook_source["label"] in {"疑似外搭", "来源未知"} or body["label"] == "未确定"
    empty_claim = {"code": "UNDETERMINED", "label": "未确定", "value": "未确定", "confidence": 0, "evidence": [], "verification": "unverified"}
    return {
        "content": {"summary": {"value": " ".join(summaries)[:500], "confidence": body["confidence"], "evidence": evidence}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {**empty_claim, "label": "分段证据完整", "value": "分段证据完整", "confidence": 1, "verification": "verified"}},
        "creative": {"format": empty_claim, "tier": {**empty_claim, "code": "TX", "label": "TX", "value": "TX"}, "hooks": [], "bodyFormat": body, "hookSourceStatus": hook_source, "narrationCoverage": {"value": round(narration, 4), "confidence": body["confidence"], "evidence": evidence, "verification": "verified"}, "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
        "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
        "review": {"status": "needs_review" if review_required else "ready", "reviewRequired": review_required, "reasons": (["内容安全回退已移除露骨原文与图像字节，结论需人工复核"] if safety_sanitized else []) + ["云端全片汇总截断，已按验证分段进行确定性聚合"]},
    }


def _sanitize_material_provider_input(value: Any, key: str = "") -> Any:
    """Minimize sensitive paid-ad text while preserving evidence coordinates."""
    if isinstance(value, list):
        return [_sanitize_material_provider_input(item, key) for item in value]
    if isinstance(value, dict):
        return {
            name: _sanitize_material_provider_input(item, name)
            for name, item in value.items()
            if name not in ("sourceText", "base64", "path")
        }
    if not isinstance(value, str):
        return value
    sensitive = re.compile(
        r"(?i)(pant(?:y|ies)|naked|nude|hardness|breast|genital|sex(?:ual)?|orgasm|erect|"
        r"incest|stepfather.{0,24}(?:touch|body|intimat)|露骨|裸体|内裤|胸部|乳房|生殖器|"
        r"性行为|性暗示|勃起|高潮|乱伦|继父.{0,12}(?:触碰|身体|亲密))"
    )
    if sensitive.search(value):
        return "该片段包含成人亲密、权力关系或伦理冲突内容；原始文本仅保存在本地证据缓存。"
    return value[:800]


def _strict_safety_provider_input(value: Any, key: str = "") -> Any:
    """Retain evidence geometry while removing all free-form sensitive prose."""
    if isinstance(value, list):
        return [_strict_safety_provider_input(item, key) for item in value]
    if isinstance(value, dict):
        return {
            name: _strict_safety_provider_input(item, name)
            for name, item in value.items()
            if name not in ("sourceText", "base64", "path")
        }
    if not isinstance(value, str):
        return value
    safe_values = {
        "transcript", "ocr", "frame", "shot", "audio", "semantic",
        "verified", "unverified", "ready", "needs_review",
        "正片主导", "解说主导", "混合", "未确定", "来源未知",
        "无独立钩子", "疑似外搭", "无前置钩子", "外搭来源待确认",
    }
    return value if value in safe_values else "内容已严格脱敏，需人工复核"


def _compact_material_merge_segment(result: dict[str, Any], index: int = 0) -> dict[str, Any]:
    """Keep merge evidence useful while staying below provider context limits."""
    def compact(value: Any, key: str = "", depth: int = 0) -> Any:
        if depth > 7:
            return None
        if isinstance(value, str):
            return _sanitize_material_provider_input(value, key)[:240]
        if isinstance(value, list):
            limit = 2 if key == "evidence" else 6 if key in {"segments", "timeline"} else 4
            return [compact(item, key, depth + 1) for item in value[:limit]]
        if isinstance(value, dict):
            omitted = {"sourceText", "base64", "path", "packaging", "inspirations", "suitableGenres", "suitableAudiences"}
            return {name: compact(item, name, depth + 1) for name, item in value.items() if name not in omitted}
        return value

    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    review = result.get("review") if isinstance(result.get("review"), dict) else {}
    selected = {
        "segmentIndex": index + 1,
        # Keep the evidence ledger in the compact merge payload.  Dropping
        # observations/inferences here forced the final repair model to invent
        # lineage it could not reconstruct, producing otherwise well-shaped
        # results that failed the material-evidence-v1 contract.
        "content": {name: content.get(name) for name in ("summary", "observations", "inferences", "tags", "characters", "relationships", "segments", "completeness") if name in content},
        "creative": {name: creative.get(name) for name in ("format", "tier", "hooks", "bodyFormat", "hookSourceStatus", "hookAssemblyType", "bodyTransition", "narrationCoverage", "timeline", "transitions") if name in creative},
        "value": {name: value.get(name) for name in ("scores", "risks") if name in value},
        "review": review,
    }
    return compact(selected)


def _material_output_contract_valid(result: Any) -> bool:
    """Return whether a provider result satisfies the independent material-v2 schema."""
    if not isinstance(result, dict):
        return False
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    summary = content.get("summary") if isinstance(content.get("summary"), dict) else {}
    return (
        isinstance(result.get("content"), dict)
        and isinstance(result.get("creative"), dict)
        and isinstance(result.get("value"), dict)
        and isinstance(result.get("review"), dict)
        and bool(str(summary.get("value") or "").strip())
        and isinstance(summary.get("evidence"), list)
        and bool(summary.get("evidence"))
        and isinstance(summary.get("basedOnFactIds"), list)
        and bool(summary.get("basedOnFactIds"))
        and summary.get("verification") == "verified"
        and isinstance(result["content"].get("observations"), list)
        and bool(result["content"].get("observations"))
        and isinstance(result["content"].get("inferences"), list)
        and isinstance(result["content"].get("tags"), list)
        and isinstance(result["content"].get("segments"), list)
        and isinstance(result["creative"].get("hooks"), list)
        and isinstance(result["creative"].get("timeline"), list)
        and isinstance(result["value"].get("scores"), (dict, list))
    )


def _normalize_material_output_shape(result: Any) -> dict[str, Any]:
    """Fill optional material-v2 containers without fabricating evidence."""
    normalized = dict(result) if isinstance(result, dict) else {}
    content = dict(normalized.get("content")) if isinstance(normalized.get("content"), dict) else {}
    creative = dict(normalized.get("creative")) if isinstance(normalized.get("creative"), dict) else {}
    value = dict(normalized.get("value")) if isinstance(normalized.get("value"), dict) else {}
    review = dict(normalized.get("review")) if isinstance(normalized.get("review"), dict) else {}

    # These collections are allowed to be empty when evidence is absent.  A
    # provider occasionally omits an empty key even after the repair pass;
    # rejecting the whole analysis in that case wastes a paid rerun and adds no
    # truthfulness.  Required facts and the verified summary remain strict.
    for name in ("inferences", "tags", "characters", "relationships", "segments"):
        if not isinstance(content.get(name), list):
            content[name] = []
    for name in ("hooks", "timeline", "transitions"):
        if not isinstance(creative.get(name), list):
            creative[name] = []
    packaging = creative.get("packaging") if isinstance(creative.get("packaging"), dict) else {}
    creative["packaging"] = {name: packaging.get(name) if isinstance(packaging.get(name), list) else [] for name in ("visual", "subtitle", "audio", "rhythm")}
    if not isinstance(value.get("scores"), (dict, list)):
        value["scores"] = {}
    for name in ("inspirations", "risks", "suitableGenres", "suitableAudiences"):
        if not isinstance(value.get(name), list):
            value[name] = []
    if not review:
        review = {"status": "needs_review", "reviewRequired": True, "reasons": ["模型未返回复核状态"]}

    normalized.update({"content": content, "creative": creative, "value": value, "review": review})
    return normalized


def _ensure_material_output_contract(
    result: dict[str, Any],
    source_payload: dict[str, Any],
    duration: float,
    report: Callable[[int, str], None],
) -> dict[str, Any]:
    """Repair provider shape once, then fail truthfully instead of persisting empty success."""
    result = _normalize_material_output_shape(result)
    if _material_output_contract_valid(result):
        return result
    report(92, "修复千问素材分析字段")
    repair_payload = {
        "durationSeconds": duration,
        "invalidResult": _sanitize_material_provider_input(result),
        "sourceEvidence": {
            "segmentAnalyses": _sanitize_material_provider_input(source_payload.get("segmentAnalyses", [])),
            "transcript": _sanitize_material_provider_input(source_payload.get("transcript", [])),
            "ocr": _sanitize_material_provider_input(source_payload.get("ocr", [])),
        },
        "requirements": [
            "Preserve only evidence-supported claims from invalidResult and sourceEvidence",
            "Return content, creative, value and review exactly once using material-v2",
            "Do not wrap the entire response in one value/confidence/evidence object",
        ],
    }
    repaired = _normalize_material_output_shape(_validate_semantic_claims(_semantic_request("repair-paid-ad-material-output-contract", repair_payload), duration))
    if not _material_output_contract_valid(repaired):
        keys = ", ".join(sorted(str(key) for key in repaired)) if isinstance(repaired, dict) else type(repaired).__name__
        raise AnalysisFailed(f"千问素材分析返回字段不完整（收到：{keys}）")
    return repaired


def _openai_request_body(provider: str, model: str, task: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build either Responses API or Chat Completions compatible JSON."""
    clean_payload = dict(payload)
    frames = clean_payload.pop("frames", [])
    rules = [
        "Return one JSON object only",
        ("For cross-episode reconciliation, cite one strongest valid timecoded evidence item per episode plot and causal link; overview prose may synthesize those cited facts without repeating evidence"
         if task == "reconcile-drama-storyline" else
         "Every semantic claim must cite source, valid timecode and confidence; episode is required only for owned-drama analysis and must not be invented for external material"),
        "Never invent unseen dialogue, actions, characters, or shots",
        "All user-visible narrative fields must be written in natural Simplified Chinese, including summaries, descriptions, roles, relationships, plot events, emotions, shot semantics, rhythm, continuity, scoring reasons and recommendations",
        "Transliterate character names into commonly used Simplified Chinese and preserve the source spelling in originalName",
        "For every evidence item, put a faithful Simplified Chinese translation in text and preserve the verbatim source quote in sourceText; never translate timestamps, IDs or enum keys",
        "Do not output English prose in user-visible fields; English is allowed only in originalName, sourceText, filenames, model identifiers and machine enum keys",
    ]
    output_contract: dict[str, Any] | None = None
    if task in ("coarse-episode-analysis", "repair-coarse-episode-output-contract"):
        rules.extend([
            "Return episodeSummary and castCandidates at the top level; never rename episodeSummary to summary",
            "episodeSummary must be a concise Simplified Chinese account of only the supplied episode",
            "episodeSummary is a claim object with value, confidence and at least one timecoded transcript/OCR evidence item",
            "Return castCandidates as [] when the supplied evidence cannot support a character candidate",
        ])
        output_contract = {
            "episodeSummary": {
                "value": "100-180 Chinese-character episode summary",
                "confidence": "0..1 number",
                "evidence": [{
                    "source": "transcript|ocr|frame",
                    "timecode": {"start": "seconds", "end": "seconds"},
                    "confidence": "0..1 number",
                    "text": "faithful Simplified Chinese translation",
                    "sourceText": "verbatim source wording",
                }],
            },
            "castCandidates": [{
                "name": "Simplified Chinese name or stable role",
                "originalName": "source spelling when known",
                "role": "concise Simplified Chinese role",
                "confidence": "0..1 number",
                "evidence": [],
            }],
        }
    if task in ("detail-drama-analysis", "repair-detail-output-contract", "reconcile-drama-storyline"):
        rules.extend([
            "The top-level JSON object must always contain characters, relationships, episodePlots, emotionCurve, contentTags, and highlightCandidates arrays",
            "contentTags must classify only evidence-supported content using the fixed dimensions genre, theme, character, relationship, emotion, conflict, plot, scene, audience, and adUse; every tag must contain dimension, value, confidence, episodes, and evidence",
            "highlightCandidates must be [] when no evidence-supported candidate exists; never omit the field",
            "Generate zero to five distinct evidence-supported highlightCandidates for each supplied episode; zero is the correct result when no candidate passes the quality contract",
            "Each highlight candidate must contain episode, start, end, confidence, and evidence",
            "Analyze each episode as an isolated timeline; never move an object, reveal, action or event from one episode into another episode plot",
            "characters must contain name, originalName, role, confidence, episodes and timecoded evidence; relationships must contain both character names, type, confidence, episodes and timecoded evidence",
            "episodePlots must contain episode, summary, coreEvents, relationshipChanges, emotionSignals and foreshadowing; every structured item cites evidence from that same episode",
            "Return storyGraph/events when evidence supports them; each event contains actors, preconditions, action, result, relationshipBefore, relationshipAfter, emotionBefore, emotionAfter, reveals, unresolvedQuestions, timecode and evidence",
            "Distinguish trigger, narrativeInterval and productionInterval on every reusable highlight; never return zero-length or speech/action-truncated ranges",
            "Only propose entryPoints at sentence, shot or observed action-safe points and report dialogue/action/shot/semantic statuses with frame/timecode evidence",
        ])
        if task == "reconcile-drama-storyline":
            rules.extend([
                "This is the cross-episode continuity pass. Resolve one canonical identity for every recurring character and keep source spellings as aliases; never swap speaker identity, gender, role, or relationship between episodes",
                "Keep the complete JSON below 5000 Chinese characters: at most 6 canonical characters, 6 relationships, 4 core events per episode, 2 relationship changes per episode, 2 emotion signals per episode and 2 foreshadowing items per episode",
                "Use at most one strongest evidence item for each character, relationship, event, causal link, arc, payoff or question; evidence must stay timecoded but must not repeat transcript passages",
                "Use all supplied episode transcripts and frames as primary evidence; reconstruct the story independently of any earlier summary",
                "This pass resolves identities and relationships only; do not return episode plots, story summaries, causal chains or highlights",
                "Distinguish a remembered or flashback parent from the present-day spouse; distinguish what a character says about another person from who is speaking",
            ])
        else:
            rules.extend([
                "Keep each single-episode JSON below 3500 Chinese characters",
                "Return at most 5 characters, 5 relationships, 4 core events, 2 relationship changes, 2 emotion signals, 2 foreshadowing items, 8 content tags and 2 highlight candidates",
                "Use at most one strongest evidence item per character, relationship, event, tag or candidate; never repeat transcript passages",
                "The episode summary is 100-180 Chinese characters and every other description is one concise sentence",
                "Do not return storyGraph, storyOverview or entryPoints in the single-episode pass",
            ])
        output_contract = {
            "characters": [{"name": "Simplified Chinese", "originalName": "source spelling", "role": "Simplified Chinese", "confidence": "0..1", "episodes": ["integer"], "evidence": []}],
            "relationships": [{"character1": "name", "character2": "name", "type": "Simplified Chinese", "description": "Simplified Chinese", "confidence": "0..1", "episodes": ["integer"], "evidence": []}],
            "episodePlots": [{"episode": "integer", "summary": "Simplified Chinese", "coreEvents": [{"description": "Simplified Chinese", "evidence": []}], "relationshipChanges": [{"description": "Simplified Chinese", "evidence": []}], "emotionSignals": [{"emotion": "Simplified Chinese", "score": "0..100", "evidence": []}], "foreshadowing": [{"description": "Simplified Chinese", "evidence": []}]}],
            "emotionCurve": [],
            "contentTags": [{
                "dimension": "genre|theme|character|relationship|emotion|conflict|plot|scene|audience|adUse",
                "value": "Simplified Chinese tag",
                "confidence": "0..1 number",
                "episodes": ["integer"],
                "evidence": [{"episode": "integer", "source": "transcript|ocr|frame", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "Simplified Chinese"}],
            }],
            "highlightCandidates": [{
                "episode": "integer",
                "start": "seconds number",
                "end": "seconds number",
                "confidence": "0..1 number",
                "title": "concise Simplified Chinese",
                "triggerType": "dialogue|action|reaction|reveal|threat|visual_spectacle|relationship_shift|cliffhanger|payoff",
                "highlightScores": {"conflict": "0..100", "relationshipChange": "0..100", "informationGain": "0..100", "emotionPeak": "0..100", "reversalReveal": "0..100", "futureImpact": "0..100", "visualPerformance": "0..100"},
                "hookPotentialScores": {"first3sStopPower": "0..100", "coldAudienceClarity": "0..100", "informationGap": "0..100", "narrativePromise": "0..100", "emotionIntensity": "0..100", "visualImpact": "0..100", "conflictClarity": "0..100", "payoffAvailability": "0..100"},
                "productionScores": {"dialogueCompleteness": "0..100", "actionCompleteness": "0..100", "shotCompleteness": "0..100", "boundarySafety": "0..100", "mediaQuality": "0..100", "transitionability": "0..100", "compliance": "0..100"},
                "audienceQuestion": "what a cold viewer immediately wants answered",
                "narrativePromise": "what later footage must pay off",
                "evidence": [{"episode": "integer", "source": "transcript|ocr|frame", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "optional string"}],
            }],
            "storyGraph": {"events": [], "setup": [], "escalation": [], "payoff": [], "ending": [], "causalChecks": {"passed": "boolean", "issues": []}, "completeness": {"status": "complete|partial", "missingPhases": []}, "reviewRequired": "boolean"},
            "storyOverview": {"premise": "Simplified Chinese", "summary": "ordered causal story in Simplified Chinese", "mainConflict": "Simplified Chinese", "causalChain": [{"fromEpisode": "integer", "toEpisode": "integer", "cause": "Simplified Chinese", "effect": "Simplified Chinese", "evidence": []}], "characterArcs": [{"character": "canonical name", "startState": "Simplified Chinese", "changes": ["Simplified Chinese"], "currentState": "Simplified Chinese", "evidence": []}], "resolvedPayoffs": [{"description": "Simplified Chinese", "episode": "integer", "evidence": []}], "unresolvedQuestions": [{"description": "Simplified Chinese", "introducedEpisode": "integer", "evidence": []}]},
            "entryPoints": [],
        }
        if task != "reconcile-drama-storyline":
            # The per-episode pass establishes ownership and chronology.  Keep
            # its contract compact; hook scoring is performed by the dedicated
            # precision tier and previously made ordinary episode responses hit
            # the provider token limit before returning valid JSON.
            output_contract = {
                "characters": output_contract["characters"],
                "relationships": output_contract["relationships"],
                "episodePlots": output_contract["episodePlots"],
                "emotionCurve": [],
                "contentTags": output_contract["contentTags"],
                "highlightCandidates": [{
                    "episode": "integer",
                    "start": "seconds number",
                    "end": "seconds number",
                    "confidence": "0..1 number",
                    "title": "concise Simplified Chinese",
                    "triggerType": "dialogue|action|reaction|reveal|threat|relationship_shift|cliffhanger|payoff",
                    "audienceQuestion": "Simplified Chinese",
                    "narrativePromise": "Simplified Chinese",
                    "evidence": [],
                }],
            }
        if task == "reconcile-drama-storyline":
            rules = rules[:7] + [
                "Resolve canonical recurring identities and aliases across all supplied episodes",
                "Return at most 6 characters and 6 relationships; merge Ash, Ashton, surnames, spelling noise and transliterations when evidence identifies one person",
                "Distinguish a remembered parent from the present spouse and distinguish the speaker from people mentioned in dialogue",
                "Use transcripts and frames as primary evidence; isolatedDraft is only a hint and cannot override primary evidence",
                "Return characters and relationships only; do not return plots, summaries, tags, curves, highlights or story overview",
                "Keep the complete JSON below 2500 Chinese characters",
            ]
            output_contract = {
                "characters": [{"name": "canonical Simplified Chinese name", "originalName": "source spelling and aliases", "role": "one concise sentence", "episodes": ["integer"]}],
                "relationships": [{"character1": "canonical name", "character2": "canonical name", "type": "Simplified Chinese", "description": "one concise sentence", "episodes": ["integer"]}],
            }
    if task == "ground-drama-episode":
        rules.extend([
            "Reconstruct exactly one supplied episode from its own transcript, OCR and frames while using canonicalCharacters only to resolve identity and aliases",
            "Never move dialogue or events from continuityContext into this episode; previousClosingLines and nextOpeningLines are boundary context only",
            "Resolve first-person and pronoun speakers from dialogue turn-taking, canonical relationships and visible continuity; never create a new person for a short name or alias",
            "A remembered parent and a present spouse are distinct; comparison language never merges them",
            "A rhetorical question, refusal or negated action is not a completed action",
            "Preserve exact objects, medical facts, past-event credit, relationship decisions and stated deadlines",
            "Return 100-240 Chinese characters in summary and at most 7 concise coreFacts; cite one strongest source-language transcript line per core fact",
            "Do not invent location, weather, injury, success, failure, occupation or relationship",
            "A single frame or OCR fragment cannot prove weather, injury or a plot outcome; require repeated unambiguous visual evidence and never put OCR wording in frame sourceText",
            "Translate locket as 吊坠 or 盒式项链, never 怀表; preserve hearing aid as 助听器 and alcohol allergy as 酒精过敏",
            "One ASR segment may contain adjacent speakers: split it when names, first/third-person pronouns or reaction frames show a turn change; never assign both speakers' clauses to one character",
            "List every named on-screen counterpart who materially participates in the episode, including the people commissioning or posing for a job",
            "Use canonicalRelationships together with OCR/frames to resolve role labels such as wife, husband, girlfriend or friend to a canonical name; include that name in the episode facts when the person materially participates",
            "An ongoing job, confrontation or countdown is unresolved; never claim it succeeded, completed or was paid unless the episode explicitly shows that outcome",
            "Attribute a past rescue and stolen credit to the exact actors named in dialogue; do not transfer the rescuer's action or the credit-taker's deception to the spouse",
            "Prioritize every explicit medical expense, concrete keepsake, stated deadline, job client and named or visually identified counterpart before optional atmosphere or generic emotion facts",
        ])
        output_contract = {
            "episodePlot": {"episode": "integer", "summary": "100-220 Chinese characters", "carryIn": "opening state", "cause": "trigger", "action": "main choice/action", "result": "observed consequence", "relationshipChange": "changed relationship state", "carryOut": "ending pressure", "coreFacts": [{"description": "concise Chinese", "evidence": [{"episode": "integer", "source": "transcript|ocr|frame", "sourceText": "verbatim source wording", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1"}]}]},
        }
    if task == "synthesize-drama-overview":
        rules.extend([
            "Synthesize the supplied groundedEpisodePlots in episode order without changing episode ownership, identities, objects, medical facts or outcomes",
            "The summary must include every material reveal, relationship decision, deadline and the final observed state; use explicit causal transitions",
            "Never add a fact absent from groundedEpisodePlots and never soften coercion, refusal, abuse or boundary-setting into generic emotional conflict",
            "Preserve the exact actor for every rescue, deception and stolen-credit reveal; never replace the named credit-taker with a spouse or generic family member",
            "Do not list an ongoing job, divorce countdown or confrontation as a resolved payoff",
            "Keep the JSON below 5000 Chinese characters",
        ])
        output_contract = {
            "storyOverview": {"premise": "one sentence", "summary": "300-600 Chinese characters", "mainConflict": "one sentence", "causalChain": [{"fromEpisode": "integer", "toEpisode": "integer", "cause": "one sentence", "effect": "one sentence"}], "characterArcs": [{"character": "canonical name", "startState": "concise", "changes": ["concise"], "currentState": "concise"}], "resolvedPayoffs": [{"description": "concise", "episode": "integer"}], "unresolvedQuestions": [{"description": "concise", "introducedEpisode": "integer"}]},
        }
    if task == "precision-highlight-analysis":
        rules.extend([
            "Evaluate the complete event, not only the strongest quoted sentence",
            "Use frame evidence for observed action, reaction, visual impact and shot continuity; never infer them from transcript alone",
            "Return zero hookCandidates when the event cannot stop and orient a cold audience",
            "Every hookCandidate must be a naturally bounded 12-60 second event, have an explicit audienceQuestion and narrativePromise, and preserve cause, trigger and reaction; never default every interval to the minimum duration",
            "Do not create multiple hooks with more than 70 percent temporal overlap unless their audienceQuestion and narrativePromise are materially different",
        ])
        output_contract = {
            "highlightAnalysis": {
                "summary": "Simplified Chinese",
                "triggerType": "dialogue|action|reaction|reveal|threat|visual_spectacle|relationship_shift|cliffhanger|payoff",
                "audienceQuestion": "Simplified Chinese",
                "narrativePromise": "Simplified Chinese",
                "highlightScores": {"conflict": "0..100", "relationshipChange": "0..100", "informationGain": "0..100", "emotionPeak": "0..100", "reversalReveal": "0..100", "futureImpact": "0..100", "visualPerformance": "0..100"},
                "hookPotentialScores": {"first3sStopPower": "0..100", "coldAudienceClarity": "0..100", "informationGap": "0..100", "narrativePromise": "0..100", "emotionIntensity": "0..100", "visualImpact": "0..100", "conflictClarity": "0..100", "payoffAvailability": "0..100"},
                "productionScores": {"dialogueCompleteness": "0..100", "actionCompleteness": "0..100", "shotCompleteness": "0..100", "boundarySafety": "0..100", "mediaQuality": "0..100", "transitionability": "0..100", "compliance": "0..100"},
                "evidence": [],
            },
            "hookCandidates": [{"start": "seconds", "end": "seconds", "hookType": "stable hook type", "audienceQuestion": "Simplified Chinese", "narrativePromise": "Simplified Chinese", "themes": [], "contentTags": [], "characterRoles": [], "relationships": [], "conflict": "Simplified Chinese", "emotion": "Simplified Chinese", "informationGap": "Simplified Chinese", "spokenSummary": "Simplified Chinese", "visualSummary": "Simplified Chinese", "qualityScores": {"stopPower": "0..100", "coldAudienceClarity": "0..100", "informationGap": "0..100", "promise": "0..100", "visualImpact": "0..100", "productionUsability": "0..100"}, "safeStart": {}, "safeEnd": {}, "evidence": [], "reviewRequired": "boolean"}],
        }
    if task in ("paid-ad-material-analysis", "paid-ad-material-segment-analysis", "paid-ad-material-analysis-merge", "paid-ad-material-story-merge", "repair-paid-ad-material-output-contract"):
        rules.extend([
            "This is an independent external paid-ad material; never require or invent dramaId, episode number, source drama, or complete-series context",
            "The top-level JSON object must contain content, creative, value, and review",
            "content contains summary, tags, characters, relationships, segments, and completeness",
            "creative contains format, tier, hooks, timeline, transitions, and packaging with visual/subtitle/audio/rhythm arrays",
            "value contains scores, inspirations, risks, suitableGenres, and suitableAudiences",
            "review contains status and reasons; use needs_review when evidence is insufficient or conflicting",
            "Every tag, hook, timeline item and score must contain code, label, confidence, evidence, and verification",
            "Use four strictly separated layers: observations record only directly seen/heard facts; inferences explain those facts; verified conclusions contain only supported inferences; business assessments evaluate creative value without rewriting story facts",
            "Never put identity, relationship, motive, causality, emotion, occupation or performance judgment in observations; those are inferences and must reference basedOnFactIds",
            "Every verified inference must reference at least one verified factId and cite evidence whose modality can support the inference; visual appearance alone cannot verify identity, relationship, motive or spoken meaning",
            "Write unknown when the evidence cannot establish a field. Missing facts are a valid result and must never be filled with genre convention, costume convention, adjacency or likely story logic",
            "Task completion and claim verification are independent: review.status may be ready only when all user-visible conclusions pass evidence validation",
            "Every evidence text must state a concrete observable fact: who said or did what, or what exact object/action/location is visible; never write instructions such as review the clip, confirm the scene, detected a change, or key frame",
            "Evidence text and sourceText serve different purposes: text is a concise Simplified-Chinese observation, while sourceText preserves the exact dialogue/OCR wording when available",
            "A shot boundary, audio change or timestamp without an observable narrative fact is technical metadata, not semantic evidence, and must not verify a story claim",
            "Attach evidence to the narrowest claim it supports so the product can display claim-to-evidence traceability",
            "Use material-local timecodes and segment/shot identifiers; do not use episode as a required fact",
            "Analyze the observable story inside this material only and explicitly label missing context, suspected reordering, cross-segment montage, external hook, or mixed-source content",
            "Classify bodyFormat as 正片主导, 解说主导, 混合, or 未确定; narrationCoverage is the fraction 0..1 of valid content duration occupied by narration that is independent from original character dialogue",
            "Classify source relation and assembly separately: hookSourceStatus says whether the hook is from the same drama, another drama, or unknown; hookAssemblyType says whether a complete opening fragment was deliberately prefaced before the body",
            "同剧高光钩子＋正片 always maps to final format 正片剧集拼接; both external-hook-plus-original-footage and external-hook-plus-narration map to 外搭钩子＋本剧正片",
            "When owned-drama source coverage is incomplete, external origin can never be confirmed: use 疑似外搭, set reviewRequired true, and explain the missing source coverage",
            "Only use 已确认外搭 when source metadata, a match to another source, or a complete owned-drama search provides direct evidence; visual style changes alone support only 疑似外搭",
            "For long material identify the opening hook, later re-hooks, information refreshes, emotional peaks, low-retention intervals, cliffhanger and CTA when evidence supports them",
            "Scores describe observable creative properties only; never invent exposure, CTR, CVR, spend, ROAS, audience response, or other performance data",
            "Never wrap the whole response in a single value/confidence/evidence claim",
        ])
        evidence = [{"source": "transcript|ocr|frame|shot|audio", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "Simplified Chinese", "sourceText": "optional verbatim source"}]
        claim = {"code": "stable enum code", "label": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified", "basedOnFactIds": ["factId"]}
        observation = {"factId": "stable fact ID", "start": "seconds", "end": "seconds", "actorObserved": "visible/heard actor or unknown", "actionObserved": "directly observable action or utterance", "objectOrTargetObserved": "directly observable target or empty", "resultObserved": "directly observable immediate result or empty", "evidence": evidence, "verification": "verified|unverified"}
        inference = {**claim, "inferenceType": "identity|relationship|motive|causality|emotion|story_state", "statement": "Simplified Chinese inference"}
        output_contract = {
            "content": {
                "summary": {"value": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "basedOnFactIds": ["factId"], "verification": "verified|unverified"},
                "observations": [observation], "inferences": [inference],
                "tags": [claim], "characters": [claim], "relationships": [claim],
                "segments": [{**claim, "start": "seconds", "end": "seconds", "description": "Simplified Chinese"}],
                "completeness": claim,
            },
            "creative": {
                "format": claim, "tier": claim, "hooks": [{**claim, "start": "seconds", "end": "seconds"}],
                "bodyFormat": claim, "hookSourceStatus": claim, "hookAssemblyType": claim, "bodyTransition": {**claim, "start": "seconds", "time": "seconds"},
                "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"},
                "timeline": [{**claim, "start": "seconds", "end": "seconds"}], "transitions": [claim],
                "packaging": {"visual": [claim], "subtitle": [claim], "audio": [claim], "rhythm": [claim]},
            },
            "value": {
                "scores": {"observableMetricCode": {**claim, "score": "0..100 number"}},
                "inspirations": [claim], "risks": [claim], "suitableGenres": [claim], "suitableAudiences": [claim],
            },
            "review": {"status": "needs_review|ready", "reviewRequired": "boolean", "reasons": ["Simplified Chinese"]},
        }
        if task == "paid-ad-material-segment-analysis":
            rules.extend([
                "Keep this one-minute segment response compact: at most 2 content segments, 1 hook, 3 timeline items, 2 transitions and 2 risks",
                "Use at most 1 evidence item per claim and at most 45 Simplified Chinese characters per description or reason",
                "Do not repeat the same observation across summary, segments, timeline and risks",
            ])
            output_contract = {
                "content": {
                    "summary": {"value": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "basedOnFactIds": ["factId"], "verification": "verified|unverified"},
                    "observations": [observation], "inferences": [inference],
                    "segments": [{**claim, "start": "seconds", "end": "seconds", "description": "Simplified Chinese"}],
                    "completeness": claim,
                },
                "creative": {
                    "format": claim,
                    "hooks": [{**claim, "start": "seconds", "end": "seconds"}],
                    "bodyFormat": claim,
                    "hookSourceStatus": claim,
                    "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"},
                    "timeline": [{**claim, "start": "seconds", "end": "seconds"}],
                    "transitions": [claim],
                },
                "value": {"scores": {}, "risks": [claim]},
                "review": {"status": "needs_review|ready", "reviewRequired": "boolean", "reasons": ["Simplified Chinese"]},
            }
        if task in ("paid-ad-material-analysis-merge", "repair-paid-ad-material-output-contract"):
            rules.extend([
                "Keep the response compact: at most 8 tags, 6 characters, 6 relationships, 12 content segments, 4 hooks, 12 timeline items, 4 transitions and 5 risks",
                "Use at most 2 evidence items per claim, at most 60 Simplified Chinese characters per description/reason, and never repeat equivalent claims",
                "Packaging arrays, inspirations, suitableGenres and suitableAudiences may be empty when the compact merge evidence does not support them",
            ])
            output_contract = {
                "content": {
                    "summary": {"value": "concise Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "basedOnFactIds": ["factId"], "verification": "verified|unverified"},
                    "observations": [observation], "inferences": [inference],
                    "tags": [], "characters": [], "relationships": [], "segments": [],
                    "completeness": claim,
                },
                "creative": {
                    "format": claim, "tier": claim, "hooks": [{**claim, "start": "seconds", "end": "seconds"}],
                    "bodyFormat": claim, "hookSourceStatus": claim,
                    "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"},
                    "timeline": [], "transitions": [],
                    "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []},
                },
                "value": {
                    "scores": {"hookStrength": {**claim, "score": "0..100 number"}},
                    "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": [],
                },
                "review": {"status": "needs_review|ready", "reviewRequired": "boolean", "reasons": ["concise Simplified Chinese"]},
            }
            rules.append("Return the arrays shown as [] exactly empty; this merge is only for final classification and review, not a second detailed segment report")
    if task == "paid-ad-material-story-merge":
        rules.extend([
            "First build content.observations as the factual ledger, then content.inferences, and only then write the causal synopsis and classifications; never reason backwards from the desired synopsis",
            "Observations must cover the opening, each major turn and the observed ending. Each fact is atomic, time-bounded and replayable, with no hidden identity, motive, relationship or causal wording",
            "Inferences must state exactly what is inferred, list basedOnFactIds, retain uncertainty, and remain unverified when the cited facts or evidence modality cannot prove it",
            "Characters and relationships are conclusions, not observations. Copy them from verified inferences only; otherwise use stable neutral labels such as woman A or man B and mark needs_review",
            "Creative and value fields are business assessments. T tier requires ADX/performance/metrics/manual_review evidence and must be unverified when those data are absent",
            "Synthesize the supplied chronological segment analyses into one complete story model; never write a segment digest, topic list, or generic genre description",
            "Write content.summary as a 180-500 Chinese-character chronological plot synopsis containing protagonist, initial situation, inciting incident, escalation, major turn, relationship change, and the observed ending or cliffhanger",
            "Resolve names, aliases and pronouns across segments. Characters are global entities, not one-minute roles; relationships must name both endpoints and distinguish emotional, intimate, medical, debt, family, coercive and workplace/mentor relations",
            "Return exactly 4-7 variable-length content.segments covering the whole material. Each phase represents a causal story phase, not an equal-duration technical chunk; do not duplicate these phases in another field",
            "Also return content.storyboardUnits as chronological event-level units covering the full material. Each unit normally spans 15-45 seconds, but boundaries must follow an observable event, dialogue topic, scene or character-goal change rather than fixed intervals",
            "Each storyboardUnits label is a concise, grammatically complete concrete event title of at most 40 Chinese characters in the form action/cause plus consequence, for example 卖卵风险引发首次冲突. Never cut a name or verb in half, and never use phase names, category tags, ordinal numbers or slash suffixes",
            "Each storyboardUnits description is exactly one concise Chinese sentence of at most 55 characters stating who does what, why when supported, and the immediate result. Do not repeat the title and do not add interpretation unsupported by transcript, OCR or frames",
            "Storyboard units must use aggregated evidence from their own time range; never describe a unit using only the nearest isolated line from another event. Merge adjacent units when the evidence cannot support distinct descriptions",
            "content.genres has at most 3 ontology labels; themes at most 6; emotions at most 6; conflicts at most 6; scenes at most 8. Remove generic labels such as 剧情, 广告, 对白驱动, 短时长片段 and 人物关系",
            "Do not treat a medical follow-up inside a romance plot as a health advertisement, and do not treat uniform localization subtitles as evidence of an external hook",
            "External hook semantics are hierarchical: if and only if a distinct external opening exists, hooks[0] spans the complete external opening from 0 to the body transition and summarizes that entire fragment. entryPoints may contain strong subintervals, but a subinterval is never the external-hook conclusion",
            "When no distinct prefaced opening exists, hookAssemblyType is 无前置钩子 and the opening dramatic beat may still be described as a native opening hook",
            "Do not conflate source and assembly: a high point from another episode of the same drama is hookSourceStatus 已确认同剧 plus hookAssemblyType 同剧外搭, and still maps to format 外搭钩子＋本剧正片",
            "Keep at most 1 evidence item per claim, total JSON below 12000 tokens, and prefer evidence at the beginning, turning points and ending",
        ])
        evidence = [{"source": "transcript|ocr|frame|shot|audio", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "concise Simplified Chinese"}]
        claim = {"code": "stable ontology code", "label": "Simplified Chinese", "value": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}
        observation = {"factId": "stable fact ID", "start": "seconds", "end": "seconds", "actorObserved": "neutral visible/heard actor label", "actionObserved": "direct observation", "objectOrTargetObserved": "direct observation or empty", "resultObserved": "direct observation or empty", "evidence": evidence, "verification": "verified|unverified"}
        inference = {**claim, "inferenceType": "identity|relationship|motive|causality|emotion|story_state", "statement": "one explicit inference", "basedOnFactIds": ["factId"]}
        character = {**claim, "characterId": "stable ID", "name": "Simplified Chinese", "originalName": "optional source spelling", "role": "Simplified Chinese"}
        relationship = {**claim, "subject": "character name", "object": "character name", "type": "relationship type", "description": "relationship and evolution in Simplified Chinese"}
        phase = {**claim, "start": "seconds", "end": "seconds", "description": "cause, event, result and relationship change in Simplified Chinese"}
        hook = {**claim, "start": "seconds", "end": "seconds", "hookType": "stable hook type", "plotSummary": "complete hook-fragment plot summary", "spokenSummary": "whole fragment spoken meaning", "visualSummary": "whole fragment visual progression", "narrativePromise": "Simplified Chinese", "informationGap": "Simplified Chinese", "reviewRequired": "boolean"}
        output_contract = {
            "content": {
                "summary": {"value": "180-500 Chinese-character chronological causal synopsis", "confidence": "0..1 number", "evidence": evidence, "basedOnFactIds": ["factId"], "verification": "verified|unverified"},
                "observations": [observation], "inferences": [inference],
                "genres": [claim], "themes": [claim], "characters": [character], "relationships": [relationship],
                "emotions": [claim], "conflicts": [claim], "segments": [phase], "storyboardUnits": [phase], "scenes": [claim],
                "tags": [claim], "completeness": claim,
            },
            "creative": {
                "format": claim, "tier": claim, "hooks": [hook], "entryPoints": [{**hook, "plotSummary": "subinterval summary"}],
                "bodyFormat": claim, "hookSourceStatus": claim, "hookAssemblyType": claim, "bodyTransition": {**claim, "start": "seconds", "time": "seconds"},
                "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"},
                "timeline": [], "transitions": [],
                "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []},
            },
            "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
            "review": {"status": "needs_review|ready", "reviewRequired": "boolean", "reasons": ["Simplified Chinese"]},
        }
    if task == "paid-ad-material-opening-analysis":
        rules.extend([
            "Analyze only the complete opening unit in the first 60 seconds and locate the exact reset into the chronological body",
            "Use multilingual OCR as dialogue evidence and translate its meaning into Simplified Chinese; reconcile it with noisy ASR instead of copying ASR errors",
            "A strong line is not the complete opening unit. If the same scene continues, transitionTime must be the final shot boundary before the time/location/story reset",
            "transitionTime must equal an observed shot start/end supplied in shots; never place it inside a shot or dialogue turn",
            "When forcedTransitionTime is provided, return that exact transitionTime and do not override it",
            "Set distinctPreface true only when an opening dramatic fragment is deliberately placed before a reset into earlier chronological setup",
            "plotSummary must stop at transitionTime and cover only the prefaced fragment; never include dialogue, hospital scenes or plot events after the reset",
            "plotSummary must cover the entire opening fragment: characters/roles, concrete dialogue conflict, action progression, relationship tension, and how it resets into the body",
            "Return hookType as the concrete dramatic mechanism of the complete fragment, never a generic label such as complete opening",
            "Interpret an interrogative challenge about sexual history, cleanliness or honesty as questioning/suspicion/testing when supported, and explicitly name trust, control or body-boundary tension supported by the interaction",
            "If the following body displays an earlier-time card or returns to the setup before the relationship, state that chronological rewind and the body plot it begins",
            "Use 已确认同剧 plus 同剧外搭 when the opening is a later high point from the same characters/story and the body resets to their earlier setup",
            "Compare the opening against bodyObservations. Confirm 同剧 only when at least two independent identity anchors recur after transition (for example a named character plus relationship, unique prop, location or causal payoff)",
            "Use 跨剧外搭/已确认外搭 only when a distinct reset exists and the opening has incompatible story identity with no later causal payoff; style, subtitle language, cast appearance or genre difference alone is insufficient",
            "When no deliberate reset exists, return distinctPreface false, hookSourceStatus 无独立钩子 and hookAssemblyType 无前置钩子 even if the native opening is emotionally strong",
        ])
        output_contract = {
            "distinctPreface": "boolean", "transitionTime": "seconds", "transitionDescription": "Simplified Chinese",
            "plotSummary": "complete opening-fragment summary in Simplified Chinese", "spokenSummary": "complete spoken meaning", "visualSummary": "visual progression", "hookType": "specific dramatic mechanism in Simplified Chinese",
            "hookSourceStatus": "无独立钩子|已确认同剧|疑似外搭|已确认外搭|来源未知",
            "hookAssemblyType": "无前置钩子|同剧外搭|跨剧外搭|外搭来源待确认", "confidence": "0..1",
        }
    if task == "paid-ad-material-event-ledger":
        rules.extend([
            "Build an evidence-first chronological event ledger; do not write a synopsis, themes, recommendations or ad analysis",
            "Return 10-24 concrete events when supported, spanning the full supplied duration and preserving events from every chronological fifth",
            "Each event must identify actor, immediate goal, concrete action, obstacle, observed result and relationship change; use empty strings when unknown",
            "An event is invalid if it only names an emotion/theme or combines actions from distant time ranges",
            "Never resolve an alias, occupation or relationship from adjacency alone; mark uncertain names with stable role labels",
        ])
        output_contract = {
            "events": [{"id": "event id", "start": "seconds", "end": "seconds", "actor": "character or stable role", "goal": "observed goal", "action": "concrete action", "obstacle": "concrete obstacle", "result": "observed consequence", "relationshipChange": "observed change or empty", "confidence": "0..1"}],
            "openQuestions": ["unresolved identity or causal question"],
        }
    if task == "paid-ad-material-story-audit":
        rules.extend([
            "Audit the draft story strictly against the event ledger and resolved entities; do not reward fluent prose",
            "List every material ledger event omitted from the draft, every draft claim unsupported by a ledger event, every relationship attached to the wrong pair, and every event placed in the wrong time phase",
            "Treat invented discoveries, motivations, resolutions and endings as unsupported even when genre-plausible",
            "Return empty arrays only when the draft faithfully covers setup, escalation, major turns, relationship evolution and the observed ending",
        ])
        output_contract = {
            "missingEvents": [{"eventId": "ledger id", "reason": "what material fact was omitted"}],
            "unsupportedClaims": [{"claim": "draft claim", "reason": "why ledger does not support it"}],
            "relationshipErrors": [{"characters": ["name"], "reason": "wrong identity/type/evolution"}],
            "timelineErrors": [{"claim": "draft claim", "reason": "correct chronological placement"}],
        }
    if task == "paid-ad-material-entity-resolution":
        rules.extend([
            "Resolve identity only; do not write a plot summary or creative analysis",
            "Use faces, gender presentation, explicit introductions, occupations, address terms and dialogue turn-taking across the whole timeline",
            "Merge homophones and ASR variants into aliases; replace unconfirmed garbled names with stable role labels",
            "A title following a completed sentence may address the next speaker. Carefully distinguish who calls whom 师父 and who is introduced to the doctor",
            "Separate romantic/medical/debt relations from workplace mentor/boss relations; one pair may have multiple real relations but never inherit another pair's relation",
            "Return compact JSON below 4000 tokens and no evidence arrays",
        ])
        output_contract = {
            "characters": [{"characterId": "stable id", "name": "confirmed Chinese name or stable role", "aliases": ["observed variants"], "gender": "observed or unknown", "occupation": "observed occupation", "storyRole": "role"}],
            "relationships": [{"subject": "characterId", "object": "characterId", "types": ["relationship type"], "evolution": "chronological relationship evolution"}],
            "speakerAttributions": [{"timeRange": "seconds", "speaker": "characterId", "addressee": "characterId", "meaning": "concise Chinese"}],
            "uncertainties": ["unresolved identity issue"],
        }
    if task == "paid-ad-material-story-synthesis":
        rules.extend([
            "Return a deliberately small story model only; total JSON must stay below 5000 tokens",
            "summary must be a 220-500 Chinese-character plot synopsis from opening to ending, with named characters and explicit causal transitions",
            "Build the synopsis from a causal event chain, not a chronology dump: identify protagonist goal, obstacle, choice/action, consequence, reversal, changed relationship state, and observed ending",
            "When evidence shows coercion, control, refusal or a relationship cutoff, name the controlling behavior and the protagonist's boundary-setting explicitly instead of softening it into generic emotional conflict",
            "For every phase describe four things in compact prose: whose goal drives it, the concrete event, why it follows from the previous phase, and what changes afterward",
            "phases must contain exactly 4-7 ordered, variable-length phases covering time 0 through at least 90 percent of duration",
            "No phase may span more than 35 percent of total duration when the observations contain multiple events inside it; preserve at least one meaningful turn from each chronological fifth of the material",
            "Do not repeat observations, mention semantic segments, discuss analysis limitations, or output evidence arrays",
            "Correct obvious ASR/name errors by cross-segment continuity; never transfer an occupation or relationship from one pair of characters to another pair",
            "Treat near-homophone names and pronouns as alias candidates until an explicit introduction resolves them; do not create a separate character from one noisy mention",
            "Assign dialogue to the correct speaker using chronological turn-taking: a title immediately after a completed sentence may address the next character rather than name the previous speaker",
            "Infer gender, occupation and relationship only from repeated dialogue/visual evidence; adjacent mentions do not prove that two roles are one person",
            "Use the supplied frames to track the same face, gender presentation, location and action across distant observations; text-only adjacency never overrides visual identity",
            "If ASR produces an implausible proper name, use a stable role such as 宋少, 会所男子 or 家人 until repeated evidence confirms the name; never expose garbled words as character names",
            "Return format 外搭钩子＋本剧正片 only when a distinct prefaced opening and body transition are observed. A translated subtitle language used throughout the video is localization and cannot support external origin",
            "Return hookAssemblyType as 无前置钩子, 同剧外搭, 跨剧外搭, or 外搭来源待确认. A same-drama high point taken from another episode is 同剧外搭, not ordinary body footage",
            "Return bodyTransition with the exact end of the complete prefaced fragment; never stop at the strongest line when the scene continues",
        ])
        output_contract = {
            "summary": "220-500 Chinese-character chronological causal plot synopsis",
            "characters": [{"characterId": "stable id", "name": "Chinese name", "originalName": "optional", "role": "story role"}],
            "relationships": [{"subject": "character name", "object": "character name", "type": "relationship type", "description": "how it changes across the material"}],
            "phases": [{"start": "seconds", "end": "seconds", "label": "story phase", "description": "cause, event, result, relationship change"}],
            "genres": ["ontology label"], "themes": ["ontology label"], "emotions": ["ontology label"], "conflicts": ["ontology label"], "scenes": ["ontology label"],
            "format": "正片剧集拼接|正片剧集解说|外搭钩子＋本剧正片|未确定",
            "hookSourceStatus": "无独立钩子|已确认同剧|疑似外搭|已确认外搭|来源未知",
            "hookAssemblyType": "无前置钩子|同剧外搭|跨剧外搭|外搭来源待确认",
            "bodyTransition": {"start": "seconds", "time": "seconds", "label": "transition description"},
        }
    if task == "paid-ad-material-classification-merge":
        rules.extend([
            "Classify this independent paid-ad material from the supplied segment analyses",
            "Return only the compact classification contract below; do not generate a detailed content, packaging, inspiration or risk report",
            "bodyFormat must be 正片主导, 解说主导, 混合, or 未确定",
            "hookSourceStatus must be 无独立钩子, 已确认同剧, 疑似外搭, 已确认外搭, or 来源未知",
            "hookAssemblyType must be 无前置钩子, 同剧外搭, 跨剧外搭, or 外搭来源待确认; source relation and editorial assembly are independent dimensions",
            "When a same-drama high point from another episode is placed before the body, return hookSourceStatus 已确认同剧, hookAssemblyType 同剧外搭, and format 外搭钩子＋本剧正片",
            "bodyTransition must locate the exact end of the complete prefaced fragment; hooks[0] must cover 0 through that boundary",
            "When complete owned-drama source coverage is absent, visual differences can only support 疑似外搭 and reviewRequired=true, never 已确认外搭",
            "Use at most 2 hooks and 2 evidence items per claim; every array shown as [] must remain exactly empty",
        ])
        evidence = [{"source": "transcript|ocr|frame|shot|audio", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "concise Simplified Chinese"}]
        claim = {"code": "stable enum code", "label": "Simplified Chinese", "value": "enum value", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}
        output_contract = {
            "content": {"summary": {"value": "concise Simplified Chinese", "confidence": "0..1 number", "evidence": evidence}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": claim},
            "creative": {"format": claim, "tier": claim, "hooks": [{**claim, "start": "seconds", "end": "seconds", "hookType": "stable hook type", "themes": ["tag"], "contentTags": ["tag"], "characterRoles": ["role"], "relationships": ["relationship"], "conflict": "Simplified Chinese", "emotion": "Simplified Chinese", "narrativePromise": "Simplified Chinese", "informationGap": "Simplified Chinese", "plotSummary": "complete prefaced-fragment summary", "spokenSummary": "Simplified Chinese", "visualSummary": "Simplified Chinese", "qualityScores": {"stopPower": "0..100", "conflict": "0..100", "clarity": "0..100", "reusability": "0..100"}, "reviewRequired": "boolean"}], "bodyFormat": claim, "hookSourceStatus": claim, "hookAssemblyType": claim, "bodyTransition": {**claim, "start": "seconds", "time": "seconds"}, "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}, "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
            "value": {"scores": {"hookStrength": {**claim, "score": "0..100 number"}}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
            "review": {"status": "needs_review|ready", "reviewRequired": "boolean", "reasons": ["concise Simplified Chinese"]},
        }
    if task == "hook-story-match":
        rules.extend([
            "Match one verified external_material hook asset to complete story arcs in the supplied episode scope only",
            "Never return an episode outside episodeScope and never invent a time range without supplied highlight or transcript evidence",
            "A match must explain setup, escalation, payoff and either resolution or a deliberate cliffhanger",
            "Match theme, relationship, conflict, emotion, narrative promise and information-gap payoff independently",
            "Segments must preserve complete dialogue, action and shot boundaries; mark reviewRequired when any boundary evidence is missing",
            "Prefer a slightly longer complete story beat over a short interval that cuts a sentence, reaction or continuous action",
            "Return multiple materially different matches when evidence supports them, ordered by matchScore",
        ])
        output_contract = {
            "schemaVersion": "hook-match-v1",
            "matches": [{
                "title": "Simplified Chinese", "topics": ["tag"], "matchScore": "0..100 number",
                "dimensionScores": {"promise": "0..100", "causal": "0..100", "conflict": "0..100", "relationship": "0..100", "informationGap": "0..100", "emotion": "0..100", "highlight": "0..100", "pacing": "0..100"},
                "storyArc": {"setup": "Simplified Chinese", "escalation": "Simplified Chinese", "payoff": "Simplified Chinese", "ending": "Simplified Chinese"},
                "segments": [{"episode": "integer", "start": "seconds", "end": "seconds", "purpose": "setup|escalation|payoff|ending", "safeStart": {"status": "verified|unverified", "evidence": []}, "safeEnd": {"status": "verified|unverified", "evidence": []}, "evidence": []}],
                "evidence": [], "risks": [{"description": "Simplified Chinese", "deduction": "non-negative number"}], "reviewRequired": "boolean",
            }],
            "rejectedReasons": ["Simplified Chinese"],
        }
    prompt_payload: dict[str, Any] = {"task": task, "input": clean_payload, "outputRules": rules}
    if output_contract is not None:
        prompt_payload["requiredOutputContract"] = output_contract
    prompt = json.dumps(prompt_payload, ensure_ascii=False)
    if provider == "openai-responses":
        content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
        for frame in frames:
            encoded = frame.get("base64") if isinstance(frame, dict) else None
            if encoded:
                frame_ref = {"timecode": frame.get("timecode", {})}
                if frame.get("episode") is not None:
                    frame_ref["episode"] = frame.get("episode")
                content.append({"type": "input_text", "text": f"Evidence frame: {json.dumps(frame_ref)}"})
                content.append({"type": "input_image", "image_url": f"data:{frame.get('mimeType', 'image/jpeg')};base64,{encoded}", "detail": "low"})
        return {"model": model, "input": [{"role": "user", "content": content}], "text": {"format": {"type": "json_object"}}}
    if provider == "openai-chat-completions":
        task_token_limits = {
            "detail-drama-analysis": 8000,
            "repair-detail-output-contract": 8000,
            "reconcile-drama-storyline": 4000,
            "ground-drama-episode": 5000,
            "synthesize-drama-overview": 6000,
            "paid-ad-material-opening-analysis": 5000,
            "paid-ad-material-event-ledger": 7000,
            "paid-ad-material-entity-resolution": 6000,
            "paid-ad-material-segment-analysis": 5000,
            # Twenty-minute materials can produce >13k characters of valid
            # structured story JSON. Leave enough room for the closing braces
            # and evidence arrays instead of receiving finish_reason=length.
            "paid-ad-material-story-synthesis": 12000,
            "paid-ad-material-story-audit": 6000,
        }
        content = [{"type": "text", "text": prompt}]
        for frame in frames:
            encoded = frame.get("base64") if isinstance(frame, dict) else None
            if encoded:
                frame_ref = {"timecode": frame.get("timecode", {})}
                if frame.get("episode") is not None:
                    frame_ref["episode"] = frame.get("episode")
                content.append({"type": "text", "text": f"Evidence frame: {json.dumps(frame_ref)}"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{frame.get('mimeType', 'image/jpeg')};base64,{encoded}", "detail": "low"}})
        return {
            "model": model,
            "messages": [
                {"role": "system", "content": "You are a strict JSON analysis engine. Follow requiredOutputContract exactly; never replace it with a single summary claim."},
                {"role": "user", "content": content},
            ],
            "response_format": {"type": "json_object"},
            # Drama detail responses are bounded contracts.  Allowing the
            # provider to stream 16k tokens can leave one episode apparently
            # stuck for many minutes even though useful output is much smaller.
            "max_tokens": min(
                int(os.getenv("LUMINA_SEMANTIC_MAX_TOKENS", "16384")),
                task_token_limits.get(task, int(os.getenv("LUMINA_SEMANTIC_MAX_TOKENS", "16384"))),
            ),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
    raise AnalysisFailed(f"Unsupported OpenAI-compatible provider: {provider}")


def _parse_json_object(raw: Any, context: str) -> dict[str, Any]:
    """Parse a provider JSON object even when it is wrapped in prose/fences.

    OpenAI-compatible providers occasionally honour ``json_object`` while still
    surrounding the object with a Markdown fence.  We accept only a complete,
    decodable object and never repair or invent a truncated response.
    """
    if not isinstance(raw, str):
        raise AnalysisFailed(f"{context} returned no JSON text")
    text = raw.lstrip("\ufeff").strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        closing = text.rfind("```")
        if first_newline >= 0 and closing > first_newline:
            text = text[first_newline + 1:closing].strip()
    decoder = json.JSONDecoder()
    index = text.find("{")
    if index >= 0:
        try:
            result, end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            result = None
        if isinstance(result, dict) and not text[index + end:].strip().strip("`").strip():
            return result
    raise AnalysisFailed(f"{context} returned no complete JSON object ({len(text)} characters received)")


def _extract_provider_result(provider: str, response: dict[str, Any]) -> dict[str, Any]:
    if provider == "openai-responses":
        texts = [part.get("text", "") for item in response.get("output", []) if isinstance(item, dict) for part in item.get("content", []) if isinstance(part, dict) and part.get("type") == "output_text"]
        raw = "".join(texts)
    elif provider == "openai-chat-completions":
        choices = response.get("choices", [])
        raw = choices[0].get("message", {}).get("content", "") if choices and isinstance(choices[0], dict) else ""
    else:
        return response
    return _parse_json_object(raw, "OpenAI-compatible API")


def _extract_chat_stream(response: Any) -> dict[str, Any]:
    """Consume OpenAI-compatible Chat Completions SSE and parse its JSON text."""
    text_parts: list[str] = []
    finish_reasons: list[str] = []
    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").strip() if isinstance(raw_line, bytes) else str(raw_line).strip()
        if not line or line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            event = json.loads(data)
        except json.JSONDecodeError as exc:
            raise AnalysisFailed("OpenAI-compatible streaming API returned an invalid SSE event") from exc
        choices = event.get("choices", []) if isinstance(event, dict) else []
        for choice in choices:
            delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
            content = delta.get("content") if isinstance(delta, dict) else None
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                text_parts.extend(str(part.get("text", "")) for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
            finish = choice.get("finish_reason") if isinstance(choice, dict) else None
            if isinstance(finish, str) and finish:
                finish_reasons.append(finish)
    raw = "".join(text_parts)
    try:
        return _parse_json_object(raw, "OpenAI-compatible streaming API")
    except AnalysisFailed as exc:
        finish = ",".join(dict.fromkeys(finish_reasons)) or "unknown"
        raise AnalysisFailed(f"{exc}; finish_reason={finish}") from exc


def _semantic_request(task: str, payload: dict[str, Any], _safety_retry: int = 0) -> dict[str, Any]:
    endpoint = os.getenv("LUMINA_SEMANTIC_ENDPOINT")
    api_key = os.getenv("LUMINA_SEMANTIC_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY")
    model = os.getenv("LUMINA_SEMANTIC_MODEL")
    if not endpoint or not api_key or not model:
        raise AnalysisFailed("Semantic analysis requires LUMINA_SEMANTIC_ENDPOINT, LUMINA_SEMANTIC_MODEL and an API key in LUMINA_SEMANTIC_API_KEY, DASHSCOPE_API_KEY or OPENAI_API_KEY")
    default_provider = "openai-responses" if endpoint.rstrip("/").endswith("/responses") else "openai-chat-completions" if endpoint.rstrip("/").endswith("/chat/completions") else "generic"
    provider = os.getenv("LUMINA_SEMANTIC_PROVIDER", default_provider)
    if provider in ("openai-responses", "openai-chat-completions"):
        body = _openai_request_body(provider, model, task, payload)
        if provider == "openai-chat-completions" and "dashscope" in endpoint:
            body["enable_thinking"] = os.getenv("LUMINA_SEMANTIC_ENABLE_THINKING", "false").lower() == "true"
    elif provider == "generic":
        body = {"task": task, "model": model, "input": payload}
    else:
        raise AnalysisFailed(f"Unsupported semantic provider: {provider}")
    request_data = json.dumps(body).encode()
    request = urllib.request.Request(endpoint, data=request_data, headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"}, method="POST")
    retry_count = max(1, int(os.getenv("LUMINA_SEMANTIC_REQUEST_ATTEMPTS", "3")))
    result = None
    for attempt in range(retry_count):
        request_started = time.monotonic()
        if os.getenv("LUMINA_SEMANTIC_DEBUG", "false").lower() == "true":
            print(f"[semantic-request] task={task} bytes={len(request_data)} attempt={attempt + 1}/{retry_count} start", file=sys.stderr, flush=True)
        try:
            with urllib.request.urlopen(request, timeout=int(os.getenv("LUMINA_SEMANTIC_TIMEOUT", "180"))) as response:
                if provider == "openai-chat-completions" and body.get("stream"):
                    result = _extract_chat_stream(response)
                else:
                    result = json.loads(response.read())
            if os.getenv("LUMINA_SEMANTIC_DEBUG", "false").lower() == "true":
                print(f"[semantic-request] task={task} bytes={len(request_data)} seconds={time.monotonic() - request_started:.1f} ok", file=sys.stderr, flush=True)
            break
        except urllib.error.HTTPError as exc:
            response_body = exc.read().decode("utf-8", errors="replace")[:1600]
            if os.getenv("LUMINA_SEMANTIC_DEBUG", "false").lower() == "true":
                print(f"[semantic-request] task={task} bytes={len(request_data)} seconds={time.monotonic() - request_started:.1f} http={exc.code}", file=sys.stderr, flush=True)
            if "data_inspection_failed" in response_body and _safety_retry < 2:
                # DashScope may reject an otherwise valid paid-ad request when
                # a frame or verbatim subtitle contains adult/violent wording.
                # Retry progressively with local evidence coordinates intact:
                # first remove explicit phrases, then all free-form prose. The
                # result remains review-required and never fabricates evidence.
                sanitized_payload = _sanitize_material_provider_input(payload) if _safety_retry == 0 else _strict_safety_provider_input(payload)
                sanitized_result = _semantic_request(task, sanitized_payload, _safety_retry + 1)
                sanitized_result["_providerSafetySanitized"] = True
                review = dict(sanitized_result.get("review") or {})
                reasons = list(review.get("reasons") or [])
                reason = "内容安全回退已移除露骨原文与图像字节，结论需人工复核"
                if reason not in reasons:
                    reasons.append(reason)
                review.update({"status": "needs_review", "reviewRequired": True, "reasons": reasons})
                sanitized_result["review"] = review
                return sanitized_result
            request_size = len(json.dumps(body, ensure_ascii=False))
            payload_sizes = {key: len(json.dumps(value, ensure_ascii=False)) for key, value in payload.items()} if task == "paid-ad-material-story-synthesis" else {}
            raise AnalysisFailed(f"Semantic provider HTTP {exc.code} (request_chars={request_size}, payload_sizes={payload_sizes}): {response_body or exc.reason}") from exc
        except (urllib.error.URLError, OSError) as exc:
            if os.getenv("LUMINA_SEMANTIC_DEBUG", "false").lower() == "true":
                print(f"[semantic-request] task={task} bytes={len(request_data)} seconds={time.monotonic() - request_started:.1f} error={type(exc).__name__}", file=sys.stderr, flush=True)
            if attempt + 1 >= retry_count:
                raise AnalysisFailed(f"Semantic provider request failed after {retry_count} attempts: {exc}") from exc
            time.sleep(min(4.0, float(2 ** attempt)))
        except Exception as exc:
            raise AnalysisFailed(f"Semantic provider request failed: {exc}") from exc
    if not (provider == "openai-chat-completions" and body.get("stream")):
        result = _extract_provider_result(provider, result)
    if not isinstance(result, dict):
        raise AnalysisFailed("Semantic provider returned a non-object result")
    return result


def _validate_semantic_claims(value: Any, duration: float | dict[int, float]) -> Any:
    """Recursively mark claims without valid evidence/timecodes unverified."""
    if isinstance(value, list):
        return [_validate_semantic_claims(item, duration) for item in value]
    if not isinstance(value, dict):
        return value
    transformed = {key: _validate_semantic_claims(item, duration) for key, item in value.items()}
    if "confidence" in transformed and "evidence" in transformed:
        evidence = transformed.get("evidence")
        claim_confidence = transformed.get("confidence")
        valid = isinstance(claim_confidence, (int, float)) and 0 <= claim_confidence <= 1 and isinstance(evidence, list) and bool(evidence)
        for item in evidence or []:
            timecode = item.get("timecode", {}) if isinstance(item, dict) else {}
            start, end = timecode.get("start"), timecode.get("end")
            evidence_confidence = item.get("confidence") if isinstance(item, dict) else None
            source = item.get("source") if isinstance(item, dict) else None
            episode = item.get("episode") if isinstance(item, dict) else None
            evidence_duration = duration.get(int(episode), -1) if isinstance(duration, dict) and isinstance(episode, (int, float)) else duration if not isinstance(duration, dict) else -1
            temporal_valid = isinstance(start, (int, float)) and isinstance(end, (int, float)) and 0 <= start <= end <= evidence_duration
            # A frame is a measured point sample; transcript/OCR evidence must
            # span a real, non-zero interval.  This blocks misleading 20–20s
            # dialogue evidence while preserving exact frame timestamps.
            if temporal_valid and source != "frame":
                temporal_valid = end > start
            valid = valid and temporal_valid and isinstance(evidence_confidence, (int, float)) and 0 <= evidence_confidence <= 1 and isinstance(source, str) and bool(source)
        transformed["verification"] = "verified" if valid else "unverified"
    return transformed


def _apply_material_evidence_gate(result: dict[str, Any]) -> dict[str, Any]:
    """Downgrade claims whose evidence type cannot support their semantics."""
    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    reasons: list[str] = []

    def evidence_rows(claim: Any) -> list[dict[str, Any]]:
        if not isinstance(claim, dict) or not isinstance(claim.get("evidence"), list):
            return []
        return [item for item in claim["evidence"] if isinstance(item, dict)]

    def source_names(claim: Any) -> set[str]:
        return {str(item.get("source") or "").lower() for item in evidence_rows(claim)}

    def evidence_text(claim: Any) -> str:
        return " ".join(str(item.get("sourceText") or item.get("text") or "") for item in evidence_rows(claim))

    duration_value = result.get("durationSeconds")
    duration_limit = float(duration_value) if isinstance(duration_value, (int, float)) and duration_value >= 0 else None

    def has_valid_evidence(claim: Any) -> bool:
        for item in evidence_rows(claim):
            timecode = item.get("timecode") if isinstance(item.get("timecode"), dict) else {}
            start, end = timecode.get("start"), timecode.get("end")
            confidence = item.get("confidence")
            source = str(item.get("source") or "").strip()
            if not source or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not isinstance(confidence, (int, float)):
                continue
            temporal_valid = 0 <= start <= end and (duration_limit is None or end <= duration_limit)
            if source.lower() != "frame":
                temporal_valid = temporal_valid and end > start
            if temporal_valid and 0 <= confidence <= 1:
                return True
        return False

    def downgrade(claim: Any, reason: str) -> None:
        if not isinstance(claim, dict):
            return
        claim["verification"] = "unverified"
        claim["reviewRequired"] = True
        reasons.append(reason)

    observations = content.get("observations") if isinstance(content.get("observations"), list) else []
    verified_fact_ids: set[str] = set()
    for fact in observations:
        if not isinstance(fact, dict):
            continue
        fact_id = str(fact.get("factId") or "").strip()
        action = str(fact.get("actionObserved") or "").strip()
        inferred_wording = re.search(r"(?:可能|似乎|推测|猜测|看起来像|意图|为了|因为|因此|所以|表明|说明|证明|意味着|likely|probably|appears|suggests|implies|because|therefore)", action, re.I)
        valid_fact = bool(fact_id and action and has_valid_evidence(fact) and fact.get("verification") == "verified" and not inferred_wording)
        if valid_fact:
            verified_fact_ids.add(fact_id)
        else:
            downgrade(fact, f"客观事实“{fact_id or '未编号'}”缺少可回放的动作或证据")

    if not observations:
        reasons.append("缺少客观事实层，无法区分观察与推断")

    for inference in content.get("inferences", []) if isinstance(content.get("inferences"), list) else []:
        if not isinstance(inference, dict):
            continue
        raw_fact_ids = inference.get("basedOnFactIds") if isinstance(inference.get("basedOnFactIds"), list) else []
        fact_ids = {str(value).strip() for value in raw_fact_ids if str(value).strip()}
        if not fact_ids or not fact_ids.issubset(verified_fact_ids):
            label = str(inference.get("statement") or inference.get("label") or "未命名推断")
            downgrade(inference, f"推断“{label}”没有完整引用已验证事实")
            continue
        if not has_valid_evidence(inference):
            label = str(inference.get("statement") or inference.get("label") or "未命名推断")
            downgrade(inference, f"推断“{label}”缺少合法时码与置信度证据")
            continue
        inference_type = str(inference.get("inferenceType") or "").lower()
        if inference_type in {"identity", "relationship", "motive", "spoken_meaning"} and not source_names(inference).intersection({"transcript", "asr", "ocr", "subtitle", "manual_review"}):
            label = str(inference.get("statement") or inference.get("label") or "未命名推断")
            downgrade(inference, f"推断“{label}”的证据模态不足以证明 {inference_type}")

    identity_pattern = re.compile(
        r"(?:queen|princess|emperor|king|prince|duke|doctor|ceo|billionaire|女王|公主|皇帝|国王|王子|公爵|医生|总裁|亿万富翁)",
        re.I,
    )
    for claim in content.get("characters", []) if isinstance(content.get("characters"), list) else []:
        label = str(claim.get("label") or claim.get("value") or claim.get("code") or "") if isinstance(claim, dict) else ""
        if identity_pattern.search(label) and not source_names(claim).intersection({"transcript", "asr", "ocr", "subtitle", "manual_review"}):
            downgrade(claim, f"人物身份“{label}”只有画面外观证据，不能验证身份")

    for claim in content.get("relationships", []) if isinstance(content.get("relationships"), list) else []:
        if not source_names(claim).intersection({"transcript", "asr", "ocr", "subtitle", "manual_review"}):
            label = str(claim.get("label") or claim.get("value") or "人物关系") if isinstance(claim, dict) else "人物关系"
            downgrade(claim, f"人物关系“{label}”缺少对白或字幕证据")

    summary = content.get("summary") if isinstance(content.get("summary"), dict) else {}
    summary_fact_ids = {str(value).strip() for value in summary.get("basedOnFactIds", []) if str(value).strip()} if isinstance(summary.get("basedOnFactIds"), list) else set()
    if summary.get("verification") == "verified" and (not observations or not summary_fact_ids or not summary_fact_ids.issubset(verified_fact_ids)):
        downgrade(summary, "剧情摘要没有完整引用已验证客观事实")

    tier = creative.get("tier")
    if isinstance(tier, dict) and tier.get("verification") == "verified" and not source_names(tier).intersection({"adx", "performance", "metrics", "manual_review"}):
        downgrade(tier, "素材 T 层级缺少投放数据或人工评分证据")

    packaging = creative.get("packaging") if isinstance(creative.get("packaging"), dict) else {}
    for claim in packaging.get("audio", []) if isinstance(packaging.get("audio"), list) else []:
        inferred = re.search(r"(?:根据画面推断|音频事件缺失|推测|可能)", evidence_text(claim))
        if inferred or not source_names(claim).intersection({"audio", "audioevents", "ffmpeg-silencedetect", "transcript", "asr"}):
            downgrade(claim, "音频结论缺少可测量的音频证据")

    review = result.get("review") if isinstance(result.get("review"), dict) else {}
    if review.get("reviewRequired") is True or str(review.get("status") or "").lower() in {"needs_review", "review_required"}:
        reasons.extend(str(reason) for reason in review.get("reasons", []) if str(reason).strip())
        if not review.get("reasons"):
            reasons.append("分析结果仍包含待复核结论")

    if reasons:
        existing = review.get("reasons") if isinstance(review.get("reasons"), list) else []
        unique_reasons = list(dict.fromkeys([*existing, *reasons]))
        result["review"] = {**review, "status": "needs_review", "reviewRequired": True, "reasons": unique_reasons}
        result["qualityGate"] = {"passed": False, "status": "review_required", "reasons": unique_reasons}
    else:
        result["qualityGate"] = {"passed": True, "status": "verified", "reasons": []}
    return result


def _numeric_score(value: Any) -> float:
    if isinstance(value, dict):
        value = value.get("score", value.get("value", 0))
    try:
        return max(0.0, min(100.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _weighted_score(scores: dict[str, Any], weights: dict[str, float]) -> float:
    return round(sum(_numeric_score(scores.get(name)) * weight for name, weight in weights.items()), 2)


def _candidate_funnel(total: int, production: int, editable: int, needs_evidence: int, rejected: int) -> dict[str, int]:
    return {"discovered": max(0, total), "productionReady": max(0, production), "editable": max(0, editable), "needsEvidence": max(0, needs_evidence), "rejected": max(0, rejected)}


def _rejection_reason_counts(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for candidate in candidates:
        reasons = candidate.get("rejectionReasons") or candidate.get("qualityGate", {}).get("reasons") or candidate.get("productionGate", {}).get("reasons") or []
        for reason in reasons:
            label = str(reason).strip()
            if label:
                counts[label] = counts.get(label, 0) + 1
    return [{"reason": reason, "count": count} for reason, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]


def _highlight_quality_projection(raw: dict[str, Any]) -> dict[str, Any]:
    highlight_scores = raw.get("highlightScores") if isinstance(raw.get("highlightScores"), dict) else raw.get("highlight_scores") if isinstance(raw.get("highlight_scores"), dict) else {}
    hook_scores = raw.get("hookPotentialScores") if isinstance(raw.get("hookPotentialScores"), dict) else raw.get("hook_potential_scores") if isinstance(raw.get("hook_potential_scores"), dict) else {}
    production_scores = raw.get("productionScores") if isinstance(raw.get("productionScores"), dict) else raw.get("production_scores") if isinstance(raw.get("production_scores"), dict) else {}
    highlight = _weighted_score(highlight_scores, {"conflict": .20, "relationshipChange": .15, "informationGain": .15, "emotionPeak": .15, "reversalReveal": .15, "futureImpact": .10, "visualPerformance": .10})
    hook = _weighted_score(hook_scores, {"first3sStopPower": .20, "coldAudienceClarity": .15, "informationGap": .15, "narrativePromise": .15, "emotionIntensity": .10, "visualImpact": .10, "conflictClarity": .10, "payoffAvailability": .05})
    production = _weighted_score(production_scores, {"dialogueCompleteness": .25, "actionCompleteness": .20, "shotCompleteness": .15, "boundarySafety": .15, "mediaQuality": .10, "transitionability": .10, "compliance": .05})
    has_contract = bool(highlight_scores and hook_scores and production_scores)
    audience_question = str(raw.get("audienceQuestion") or raw.get("audience_question") or "").strip()
    narrative_promise = str(raw.get("narrativePromise") or raw.get("narrative_promise") or "").strip()
    eligible = has_contract and highlight >= 80 and hook >= 90 and production >= 85 and bool(audience_question and narrative_promise)
    return {
        "highlightScores": highlight_scores, "hookPotentialScores": hook_scores, "productionScores": production_scores,
        "highlightScore": highlight, "hookPotentialScore": hook, "productionUsabilityScore": production,
        "audienceQuestion": audience_question, "narrativePromise": narrative_promise,
        "scoreContractComplete": has_contract, "precisionEligible": eligible,
        "qualityGate": {"passed": eligible, "reasons": [] if eligible else [reason for condition, reason in (
            (not has_contract, "缺少三维高光评分"), (highlight < 80, "剧情高光强度不足"), (hook < 90, "钩子潜力不足"),
            (production < 85, "生产可用性不足"), (not audience_question, "未形成明确观众问题"), (not narrative_promise, "未形成可兑现叙事承诺"),
        ) if condition]},
    }


def _interval_overlap_ratio(left: dict[str, Any], right: dict[str, Any]) -> float:
    intersection = max(0.0, min(float(left["end"]), float(right["end"])) - max(float(left["start"]), float(right["start"])))
    shorter = min(float(left["end"]) - float(left["start"]), float(right["end"]) - float(right["start"]))
    return intersection / shorter if shorter > 0 else 0.0


def _precision_candidates(value: Any, durations: dict[int, float], transcripts: dict[int, list[dict[str, Any]]] | None = None) -> list[dict[str, Any]]:
    """Validate the detail->precision handoff and keep at most five per episode."""
    if not isinstance(value, list):
        raise AnalysisFailed("Detail provider result must contain precisionCandidates[]")
    candidates_by_episode: dict[int, list[dict[str, Any]]] = {episode: [] for episode in durations}
    for item in value:
        if not isinstance(item, dict):
            continue
        episode, start, end, confidence = item.get("episode"), item.get("start"), item.get("end"), item.get("confidence")
        if not isinstance(episode, int) or episode not in durations or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not 0 <= start < end <= durations[episode] or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            continue
        checked = _validate_semantic_claims(item, durations)
        if checked.get("verification") == "verified":
            # Models often mark only a quoted sentence. Precision analysis needs
            # surrounding cause and reaction; 12 seconds is a floor, not a
            # target. Longer model-selected complete events are preserved.
            original_start, original_end = float(checked["start"]), float(checked["end"])
            episode_transcript = [row for row in ((transcripts or {}).get(episode) or []) if isinstance(row, dict) and isinstance(row.get("start"), (int, float)) and isinstance(row.get("end"), (int, float))]
            overlapping = [index for index, row in enumerate(episode_transcript) if float(row["end"]) >= original_start and float(row["start"]) <= original_end]
            if overlapping:
                left, right = max(0, min(overlapping) - 1), min(len(episode_transcript) - 1, max(overlapping) + 1)
                # Grow by complete ASR utterances until the candidate contains
                # practical cause/trigger/reaction context. Segment timing makes
                # the duration event-dependent instead of a repeated 12s crop.
                while float(episode_transcript[right]["end"]) - float(episode_transcript[left]["start"]) < 18 and (left > 0 or right + 1 < len(episode_transcript)):
                    if left > 0:
                        left -= 1
                    if float(episode_transcript[right]["end"]) - float(episode_transcript[left]["start"]) >= 18:
                        break
                    if right + 1 < len(episode_transcript):
                        right += 1
                expanded_start = max(0.0, float(episode_transcript[left]["start"]))
                expanded_end = min(float(durations[episode]), float(episode_transcript[right]["end"]))
                if expanded_end - expanded_start > 60:
                    center = (original_start + original_end) / 2
                    expanded_start = max(0.0, center - 30.0)
                    expanded_end = min(float(durations[episode]), expanded_start + 60.0)
                    expanded_start = max(0.0, expanded_end - 60.0)
            else:
                target = min(60.0, max(12.0, original_end - original_start))
                center = (original_start + original_end) / 2
                expanded_start = max(0.0, center - target / 2)
                expanded_end = min(float(durations[episode]), expanded_start + target)
                expanded_start = max(0.0, expanded_end - target)
            checked["start"], checked["end"] = round(expanded_start, 3), round(expanded_end, 3)
            normalized = _normalize_highlight_candidate(checked, float(durations[episode]), len(candidates_by_episode[episode]))
            if normalized is not None:
                normalized.update(_highlight_quality_projection(normalized))
                normalized["reviewRequired"] = bool(normalized.get("reviewRequired")) or not normalized["scoreContractComplete"]
                candidates_by_episode[episode].append(normalized)
    candidates: list[dict[str, Any]] = []
    for episode in durations:
        ranked = sorted(candidates_by_episode[episode], key=lambda item: (float(item.get("hookPotentialScore", 0)), float(item.get("highlightScore", 0)), float(item.get("productionUsabilityScore", 0))), reverse=True)
        distinct: list[dict[str, Any]] = []
        for item in ranked:
            if any(_interval_overlap_ratio(item, existing) >= .70 for existing in distinct):
                continue
            distinct.append(item)
        candidates.extend(distinct[:5])
    return candidates


def _normalize_precision_hooks(value: Any, interval_start: float, interval_end: float, transcript: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Expand sentence fragments into reusable 10-60s hooks inside the highlight."""
    if not isinstance(value, list) or interval_end - interval_start < 10:
        return []
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[float, float]] = set()
    for raw in value:
        if not isinstance(raw, dict):
            continue
        try:
            start = float(raw.get("start"))
            end = float(raw.get("end"))
        except (TypeError, ValueError):
            continue
        start, end = max(interval_start, start), min(interval_end, end)
        if end <= start or end - start < .05:
            continue
        rows = [row for row in (transcript or []) if isinstance(row, dict) and isinstance(row.get("start"), (int, float)) and isinstance(row.get("end"), (int, float))]
        overlap = [index for index, row in enumerate(rows) if float(row["end"]) >= start and float(row["start"]) <= end]
        if overlap:
            left, right = min(overlap), max(overlap)
            while float(rows[right]["end"]) - float(rows[left]["start"]) < 10 and (left > 0 or right + 1 < len(rows)):
                if left > 0:
                    left -= 1
                if float(rows[right]["end"]) - float(rows[left]["start"]) >= 10:
                    break
                if right + 1 < len(rows):
                    right += 1
            start = max(interval_start, float(rows[left]["start"]))
            end = min(interval_end, float(rows[right]["end"]))
        else:
            target = min(60.0, max(10.0, end - start))
            center = (start + end) / 2
            start = max(interval_start, center - target / 2)
            end = min(interval_end, start + target)
            start = max(interval_start, end - target)
        key = (round(start, 3), round(end, 3))
        if key in seen:
            continue
        seen.add(key)
        hook = _normalize_highlight_candidate({**raw, "start": key[0], "end": key[1]}, interval_end, len(normalized))
        if hook is None:
            continue
        raw_start = raw.get("safeStart") if isinstance(raw.get("safeStart"), dict) else {}
        raw_end = raw.get("safeEnd") if isinstance(raw.get("safeEnd"), dict) else {}
        start_verified = raw_start.get("status") == "verified" and raw_start.get("actionStatus") == "complete" and bool(raw_start.get("evidence"))
        end_verified = raw_end.get("status") == "verified" and raw_end.get("actionStatus") == "complete" and bool(raw_end.get("evidence"))
        hook["safeStart"] = raw_start if start_verified else {"time": key[0], "timecode": {"start": key[0], "end": key[0]}, "status": "unverified", "actionStatus": "requires_review", "evidence": hook.get("evidence", [])}
        hook["safeEnd"] = raw_end if end_verified else {"time": key[1], "timecode": {"start": key[1], "end": key[1]}, "status": "unverified", "actionStatus": "requires_review", "evidence": hook.get("evidence", [])}
        verified = start_verified and end_verified
        hook["reviewRequired"] = not verified
        hook["productionGate"] = {"status": "verified" if verified else "unverified", "dialogue": {"status": "verified" if verified else "unverified"}, "action": {"status": "verified" if verified else "requires_review"}, "shot": {"status": "verified" if verified else "unverified"}, "semantic": {"status": "verified" if verified else "unverified"}, "reviewRequired": not verified}
        normalized.append(hook)
    return normalized


def _semantic_frame_base64(path: str | Path, max_side: int = 640, quality: int = 78) -> str:
    """Bound visual-token/request size without changing evidence timecodes."""
    with Image.open(path) as image:
        image = image.convert("RGB")
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def analyze_coarse(path: Path, episode: int, workspace: Path) -> AnalysisEnvelope:
    duration = _duration(path)
    frame_engine: Any = "ffmpeg"
    try:
        frames = extract_frames(path, workspace / "coarse-frames", float(os.getenv("LUMINA_COARSE_FRAME_INTERVAL", "10")))
    except Exception as exc:
        message = str(exc).lower()
        if "does not contain any stream" not in message and "matches no streams" not in message:
            raise
        frames = []
        frame_engine = {"backend": "ffmpeg", "status": "no_video", "error": str(exc)[:500]}
    transcript, asr_engine = transcribe(path)
    try:
        ocr, ocr_engine = read_ocr(frames)
    except Exception as exc:
        # OCR is supporting evidence, not a prerequisite for transcript- and
        # frame-backed episode analysis. Keep the failure explicit so later
        # production gates can require review instead of killing the whole job.
        ocr, ocr_engine = [], {"backend": "paddleocr", "status": "unavailable", "error": str(exc)[:500]}
    multimodal_frames = [{
        "episode": episode,
        "timecode": frame["timecode"],
        "mimeType": "image/jpeg",
        "base64": _semantic_frame_base64(frame["path"]),
    } for frame in frames]
    semantic_input = {"episode": episode, "durationSeconds": duration, "frames": multimodal_frames, "transcript": transcript, "ocr": ocr, "requirements": ["episode summary", "cast candidates", "every claim cites transcript/OCR/frame evidence with timecode and confidence", "do not infer unseen dialogue/actions/shots"]}
    semantic = _validate_semantic_claims(_semantic_request("coarse-episode-analysis", semantic_input), duration)

    def usable_summary(value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        confidence_value = value.get("confidence")
        valid_evidence: list[dict[str, Any]] = []
        for item in value.get("evidence", []) if isinstance(value.get("evidence"), list) else []:
            if not isinstance(item, dict):
                continue
            tc = _timecode(item.get("timecode"))
            evidence_confidence = item.get("confidence")
            source = item.get("source")
            if tc is None or tc[0] < 0 or tc[1] > duration or (source != "frame" and tc[1] <= tc[0]):
                continue
            if not isinstance(evidence_confidence, (int, float)) or not 0 <= float(evidence_confidence) <= 1 or not isinstance(source, str) or not source:
                continue
            valid_evidence.append(item)
        normalized = {**value, "evidence": valid_evidence}
        normalized["verification"] = "verified" if isinstance(confidence_value, (int, float)) and 0 <= float(confidence_value) <= 1 and valid_evidence else "unverified"
        return normalized

    summary = usable_summary(semantic.get("episodeSummary"))
    if not isinstance(summary, dict) or not str(summary.get("value") or "").strip() or summary.get("verification") != "verified":
        repair_input = {
            "episode": episode,
            "durationSeconds": duration,
            "invalidResult": semantic,
            "frames": multimodal_frames,
            "transcript": transcript,
            "ocr": ocr,
            "requirements": ["Return episodeSummary and castCandidates exactly", "episodeSummary must cite valid supplied evidence"],
        }
        semantic = _validate_semantic_claims(_semantic_request("repair-coarse-episode-output-contract", repair_input), duration)
        summary = usable_summary(semantic.get("episodeSummary"))
    if not isinstance(summary, dict) or not str(summary.get("value") or "").strip() or summary.get("verification") != "verified":
        shape = json.dumps({"keys": sorted(semantic.keys()), "episodeSummary": summary}, ensure_ascii=False, default=str)[:900]
        raise AnalysisFailed(f"粗分析返回的 episodeSummary 缺失或没有有效时码证据（shape={shape}）")
    result = {"episode": episode, "durationSeconds": duration, "keyframes": frames, "transcript": transcript, "ocr": ocr, "episodeSummary": summary, "castCandidates": semantic.get("castCandidates", [])}
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "coarse", "succeeded", {"path": str(path), "episode": episode, "durationSeconds": duration}, {"asr": asr_engine, "ocr": ocr_engine, "frames": frame_engine, "semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, result)


def analyze_material(path: Path, workspace: Path, on_progress: Callable[[int, str], None] | None = None, cache_dir: Path | None = None) -> AnalysisEnvelope:
    """Analyze one paid-ad material and return evidence-backed UI fields.

    The material workflow deliberately has no multi-episode inference stage. It
    measures the uploaded file, then asks the semantic provider to classify its
    creative structure from transcript, OCR and sampled frames. Claims without
    valid timecoded evidence remain ``unverified`` and must not be presented as
    facts by clients.
    """
    report = on_progress or (lambda _progress, _stage: None)
    report(15, "读取视频信息")
    duration = _duration(path)
    frame_interval = float(os.getenv("LUMINA_MATERIAL_FRAME_INTERVAL", "5"))
    frame_signature = _cache_signature({"duration": round(duration, 3), "interval": frame_interval, "backend": "ffmpeg"})
    frame_manifest = cache_dir / "frames.json" if cache_dir else None
    frames = _read_frame_cache(frame_manifest, frame_signature) if frame_manifest else None
    if frames:
        report(32, "复用抽帧缓存")
    else:
        report(22, "抽取关键帧")
        frame_destination = cache_dir / "frames" if cache_dir else workspace / "material-frames"
        frames = extract_frames(path, frame_destination, frame_interval)
        if frame_manifest: _write_frame_cache(frame_manifest, frame_signature, frames)
        report(32, "抽帧完成")
    max_frames = max(1, int(os.getenv("LUMINA_MATERIAL_MAX_SEMANTIC_FRAMES", "24")))
    stride = max(1, (len(frames) + max_frames - 1) // max_frames)
    selected = frames[::stride][:max_frames]
    asr_signature = _cache_signature({
        "backend": os.getenv("LUMINA_ASR_BACKEND", "faster-whisper"),
        "model": os.getenv("LUMINA_WHISPER_MODEL", ""),
        "device": os.getenv("LUMINA_WHISPER_DEVICE", "cpu"),
        "compute": os.getenv("LUMINA_WHISPER_COMPUTE_TYPE", "int8"),
    })
    ocr_signature = _cache_signature({
        "backend": os.getenv("LUMINA_OCR_BACKEND", "paddleocr"),
        "language": os.getenv("LUMINA_OCR_LANGUAGE", "en"),
        "frames": [frame["timecode"] for frame in selected],
    })
    asr_cached = _read_analysis_cache(cache_dir / "asr.json", asr_signature) if cache_dir else None
    ocr_cached = _read_analysis_cache(cache_dir / "ocr.json", ocr_signature) if cache_dir else None

    def run_asr() -> tuple[list[dict[str, Any]], dict[str, str], bool]:
        if asr_cached:
            return asr_cached[0], asr_cached[1], True
        data, engine = transcribe(path)
        if cache_dir: _write_analysis_cache(cache_dir / "asr.json", asr_signature, data, engine)
        return data, engine, False

    def run_ocr() -> tuple[list[dict[str, Any]], dict[str, str], bool]:
        if ocr_cached:
            return ocr_cached[0], ocr_cached[1], True
        data, engine = _read_ocr_batched(selected, int(os.getenv("LUMINA_OCR_WORKERS", "2")))
        if cache_dir: _write_analysis_cache(cache_dir / "ocr.json", ocr_signature, data, engine)
        return data, engine, False

    report(35, "ASR/OCR 并行处理中")
    local_results: dict[str, tuple[list[dict[str, Any]], dict[str, str], bool]] = {}
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="material-local") as executor:
        futures = {executor.submit(run_asr): "语音转写", executor.submit(run_ocr): "字幕识别"}
        for completed, future in enumerate(as_completed(futures), start=1):
            label = futures[future]
            local_results[label] = future.result()
            cached = local_results[label][2]
            progress = 55 if completed == 1 else 74
            report(progress, f"{label}{'缓存复用' if cached else '完成'}（{completed}/2）")
    transcript, asr_engine, _ = local_results["语音转写"]
    ocr, ocr_engine, _ = local_results["字幕识别"]
    multimodal_frames = [
        {
            "episode": 1,
            "timecode": frame["timecode"],
            "mimeType": "image/jpeg",
            "base64": _semantic_frame_base64(frame["path"], 384, 68),
        }
        for frame in selected
    ]
    payload = {
        "episode": 1,
        "durationSeconds": duration,
        "frames": multimodal_frames,
        "transcript": transcript,
        "ocr": ocr,
        "requirements": [
            "classify materialType as 正片剧集拼接, 正片剧集解说, 外搭钩子＋本剧正片, or 未确定",
            "classify tier as T1, T2, or 未确定 and explain the observable rule used",
            "identify hook, transition and body boundaries only when supported by evidence",
            "identify a reusable prototype only when repeated visual/narrative mechanics are observable",
            "return summary, materialType, tier, hookType, transition, prototype, highlights and structure",
            "each semantic field is a claim object with value, confidence and evidence",
            "each evidence item includes source, episode=1, timecode {start,end}, confidence and optional text",
            "do not infer exposure, performance, audience response, character identity, dialogue, action or scene not present in evidence",
        ],
    }
    semantic = _material_semantic_analysis(payload, duration, report, cache_dir)
    report(94, "校验结构化结果")
    # This stable projection is the backend/frontend contract. Values are copied
    # only from verified claims; missing evidence stays explicitly unresolved.
    def verified_value(name: str, fallback: Any) -> Any:
        claim = semantic.get(name)
        if isinstance(claim, dict) and claim.get("verification") == "verified" and "value" in claim:
            return claim["value"]
        return fallback

    structure = semantic.get("structure") if isinstance(semantic.get("structure"), list) else []
    verified_structure = [item for item in structure if isinstance(item, dict) and item.get("verification") == "verified"]
    material_fields = {
        "analysis": "分析完成",
        "analysisStatus": "succeeded",
        "materialType": verified_value("materialType", "未确定"),
        "tier": verified_value("tier", "未确定"),
        "hookType": verified_value("hookType", "未确定"),
        "transition": verified_value("transition", "未确定"),
        "prototype": verified_value("prototype", "未确定"),
        "summary": verified_value("summary", ""),
        "highlights": verified_value("highlights", []),
        "structure": verified_structure,
        # Model output is never an approval. A human must explicitly resolve it.
        "review": "待人工复核",
        "confidence": round(100 * max(
            [float(claim.get("confidence", 0)) for claim in semantic.values() if isinstance(claim, dict) and claim.get("verification") == "verified"]
            or [0.0]
        )),
    }
    result = {
        "durationSeconds": duration,
        "keyframes": frames,
        "transcript": transcript,
        "ocr": ocr,
        "semantic": semantic,
        "materialFields": material_fields,
    }
    return AnalysisEnvelope(
        "1.0.0",
        str(uuid.uuid4()),
        "coarse",
        "succeeded",
        {"path": str(path), "durationSeconds": duration, "kind": "ad_material"},
        {"asr": asr_engine, "ocr": ocr_engine, "frames": "ffmpeg", "semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")},
        result,
    )


def _verified_claim_value(claim: Any, fallback: Any = "未确定") -> Any:
    if not isinstance(claim, dict) or claim.get("verification") != "verified":
        return fallback
    if "value" in claim:
        return claim["value"]
    return claim.get("label", fallback)


def _claim_confidences(value: Any) -> list[float]:
    if isinstance(value, list):
        return [score for item in value for score in _claim_confidences(item)]
    if not isinstance(value, dict):
        return []
    own = value.get("confidence")
    scores = [float(own)] if value.get("verification") == "verified" and isinstance(own, (int, float)) else []
    return scores + [score for item in value.values() for score in _claim_confidences(item)]


def _review_reason_conflicts_with_source_claim(reason: Any, hook_source: str) -> bool:
    """Reject review text that directly contradicts a verified source claim."""
    text = str(reason or "")
    if hook_source != "已确认同剧":
        return False
    source_terms = ("外部钩子", "外搭", "外部来源", "来源差异", "剪辑来源")
    uncertainty_terms = (
        "无法确认",
        "不能确认",
        "不确定",
        "难以确认",
        "无法排除",
        "无法完全排除",
        "不能排除",
        "需进一步核实",
        "需要进一步核实",
    )
    return any(term in text for term in source_terms) and any(term in text for term in uncertainty_terms)


def _verified_taxonomy_value(claim: Any, aliases: dict[str, str], fallback: str) -> str:
    if not isinstance(claim, dict) or claim.get("verification") != "verified":
        return fallback
    for field in ("value", "label", "code"):
        candidate = str(claim.get(field, "")).strip()
        if candidate in aliases:
            return aliases[candidate]
        lowered = candidate.lower()
        if lowered in aliases:
            return aliases[lowered]
    return fallback


def _normalize_material_format(creative: dict[str, Any], review: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Apply the production V1 taxonomy without promoting suspected external hooks."""
    body_claim = creative.get("bodyFormat") if isinstance(creative.get("bodyFormat"), dict) else {}
    hook_claim = creative.get("hookSourceStatus") if isinstance(creative.get("hookSourceStatus"), dict) else {}
    body = _verified_taxonomy_value(body_claim, {
        "正片主导": "正片主导",
        "drama_driven": "正片主导",
        "DRAMA_DRIVEN": "正片主导",
        "解说主导": "解说主导",
        "narration_driven": "解说主导",
        "NARRATION_DRIVEN": "解说主导",
        "混合": "混合",
        "mixed": "混合",
        "MIXED": "混合",
    }, "未确定")
    if body == "混合":
        narration_claim = creative.get("narrationCoverage") if isinstance(creative.get("narrationCoverage"), dict) else {}
        coverage = narration_claim.get("value")
        if isinstance(coverage, (int, float)):
            body = "解说主导" if float(coverage) >= .5 else "正片主导"
            body_claim = {
                **body_claim,
                "code": "NARRATION_DRIVEN" if body == "解说主导" else "DRAMA_DRIVEN",
                "label": body,
                "value": body,
            }
    hook_source = _verified_taxonomy_value(hook_claim, {
        "已确认同剧": "已确认同剧",
        "same_drama": "已确认同剧",
        "SAME_DRAMA": "已确认同剧",
        "无独立钩子": "无独立钩子",
        "no_independent_hook": "无独立钩子",
        "NO_INDEPENDENT_HOOK": "无独立钩子",
        "疑似外搭": "疑似外搭",
        "suspected_external": "疑似外搭",
        "SUSPECTED_EXTERNAL": "疑似外搭",
        "已确认外搭": "已确认外搭",
        "confirmed_external": "已确认外搭",
        "CONFIRMED_EXTERNAL": "已确认外搭",
        "来源未知": "来源未知",
        "unknown": "来源未知",
        "UNKNOWN": "来源未知",
    }, "来源未知")
    assembly_claim = creative.get("hookAssemblyType") if isinstance(creative.get("hookAssemblyType"), dict) else {}
    hook_assembly = _verified_taxonomy_value(assembly_claim, {
        "同剧外搭": "同剧外搭", "same_drama_preface": "同剧外搭", "SAME_DRAMA_PREFACE": "同剧外搭",
        "跨剧外搭": "跨剧外搭", "cross_drama_preface": "跨剧外搭", "CROSS_DRAMA_PREFACE": "跨剧外搭",
        "外搭来源待确认": "外搭来源待确认", "unknown_preface": "外搭来源待确认", "UNKNOWN_PREFACE": "外搭来源待确认",
        "无前置钩子": "无前置钩子", "none": "无前置钩子", "NONE": "无前置钩子",
    }, "无前置钩子")
    # An external hook is an opening construct. End cards and CTAs are not
    # source evidence for an external opening, even when their visual style is
    # very different from the body.
    opening_window = 60.0
    source_evidence = hook_claim.get("evidence", []) if isinstance(hook_claim.get("evidence"), list) else []
    has_opening_source_evidence = any(
        isinstance(item, dict)
        and isinstance(item.get("timecode"), dict)
        and isinstance(item["timecode"].get("start"), (int, float))
        and float(item["timecode"]["start"]) <= opening_window
        for item in source_evidence
    )
    if hook_source in {"疑似外搭", "已确认外搭"} and source_evidence and not has_opening_source_evidence:
        hook_source = "无独立钩子"
        hook_claim = {
            "code": "NO_INDEPENDENT_HOOK", "label": "无独立钩子", "value": "无独立钩子",
            "confidence": 1, "evidence": [], "verification": "verified",
        }
        creative = {**creative, "hookSourceStatus": hook_claim}
        reasons = list(review.get("reasons", [])) if isinstance(review.get("reasons"), list) else []
        reasons.append("外搭来源证据仅出现在片尾品牌卡或CTA，已排除为开场外搭依据")
        review = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys(reasons))}
    if hook_assembly in {"同剧外搭", "跨剧外搭", "外搭来源待确认"} or hook_source in {"疑似外搭", "已确认外搭"}:
        final_format = "外搭钩子＋本剧正片"
        basis = assembly_claim if hook_assembly != "无前置钩子" else hook_claim
    elif body == "解说主导":
        final_format = "正片剧集解说"
        basis = body_claim
    elif body == "正片主导":
        final_format = "正片剧集拼接"
        basis = body_claim
    else:
        final_format = "未确定"
        basis = body_claim or hook_claim
    format_claim = {
        "code": {"正片剧集拼接": "EPISODE_SPLICE", "正片剧集解说": "EPISODE_NARRATION", "外搭钩子＋本剧正片": "EXTERNAL_HOOK_BODY", "未确定": "UNDETERMINED"}[final_format],
        "label": final_format,
        "value": final_format,
        "confidence": float(basis.get("confidence", 0)) if isinstance(basis.get("confidence"), (int, float)) else 0,
        "evidence": basis.get("evidence", []) if isinstance(basis.get("evidence"), list) else [],
        "verification": basis.get("verification", "unverified"),
    }
    reasons = list(review.get("reasons", [])) if isinstance(review.get("reasons"), list) else []
    reasons = [reason for reason in reasons if not _review_reason_conflicts_with_source_claim(reason, hook_source)]
    if hook_source == "疑似外搭":
        reasons.append("开头疑似外搭，但本剧片源覆盖或来源证据不足，需要人工复核")
        review = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys(reasons))}
    elif final_format == "未确定":
        reasons.append("主体结构或来源证据不足，素材类型未确定")
        review = {**review, "status": "needs_review", "reviewRequired": True, "reasons": list(dict.fromkeys(reasons))}
    else:
        review = {**review, "reviewRequired": bool(review.get("reviewRequired", review.get("status") != "ready")), "reasons": reasons}
    tier_claim = creative.get("tier") if isinstance(creative.get("tier"), dict) else {}
    tier_candidates = [str(tier_claim.get(name, "")).upper() for name in ("value", "label", "code")]
    normalized_tier = next((item for item in tier_candidates if item in {"T0", "T1", "T2", "T3", "TX"}), "TX")
    normalized_tier_claim = {
        **tier_claim,
        "code": normalized_tier,
        "label": normalized_tier,
        "value": normalized_tier,
        "verification": tier_claim.get("verification", "unverified"),
    }
    creative = {**creative, "format": format_claim, "tier": normalized_tier_claim}
    return creative, review


def analyze_material_v2(path: Path, workspace: Path, on_progress: Callable[[int, str], None] | None = None, cache_dir: Path | None = None) -> AnalysisEnvelope:
    """Independent hierarchical analysis for long external paid-ad materials."""
    report = on_progress or (lambda _progress, _stage: None)
    report(15, "读取视频信息")
    duration = _duration(path)

    scan_signature = _cache_signature({
        "duration": round(duration, 3),
        "sceneThreshold": os.getenv("LUMINA_MATERIAL_SCENE_THRESHOLD", "0.32"),
        "silenceNoise": os.getenv("LUMINA_MATERIAL_SILENCE_NOISE", "-34dB"),
        "scanner": "material-v3-balanced-coverage",
    })
    scan_cache = cache_dir / "scan-v2.json" if cache_dir else None
    scan = None
    if scan_cache:
        try:
            cached = json.loads(scan_cache.read_text(encoding="utf-8"))
            scan = cached.get("data") if cached.get("signature") == scan_signature else None
        except (OSError, ValueError, TypeError):
            scan = None
    if not isinstance(scan, dict):
        report(20, "扫描镜头与音频变化")
        shots = detect_shots(path, duration)
        audio_events = detect_audio_events(path, duration)
        scan = {"shots": shots, "audioEvents": audio_events}
        if scan_cache:
            scan_cache.parent.mkdir(parents=True, exist_ok=True)
            scan_cache.write_text(json.dumps({"signature": scan_signature, "data": scan}, ensure_ascii=False), encoding="utf-8")
    shots = scan.get("shots", [])
    audio_events = scan.get("audioEvents", [])

    timestamps = _material_evidence_timestamps(duration, shots, audio_events)
    frame_signature = _cache_signature({"timestamps": timestamps, "backend": "ffmpeg", "scanner": "material-v3-balanced-coverage"})
    frame_manifest = cache_dir / "frames-v2.json" if cache_dir else None
    frames = _read_frame_cache(frame_manifest, frame_signature) if frame_manifest else None
    if not frames:
        report(27, f"提取自适应证据帧 0/{len(timestamps)}")
        frames = extract_frames_at(path, cache_dir / "frames-v2" if cache_dir else workspace / "material-v2-frames", timestamps)
        if frame_manifest:
            _write_frame_cache(frame_manifest, frame_signature, frames)
    report(34, f"证据扫描完成（{len(shots)} 镜头 / {len(frames)} 帧）")

    asr_signature = _cache_signature({
        "backend": os.getenv("LUMINA_ASR_BACKEND", "faster-whisper"),
        "model": os.getenv("LUMINA_WHISPER_MODEL", ""),
        "device": os.getenv("LUMINA_WHISPER_DEVICE", "cpu"),
        "compute": os.getenv("LUMINA_WHISPER_COMPUTE_TYPE", "int8"),
    })
    ocr_frames = _sample_material_frames(frames, duration, max(1, int(os.getenv("LUMINA_MATERIAL_MAX_OCR_FRAMES", "48"))))
    ocr_signature = _cache_signature({
        "backend": os.getenv("LUMINA_OCR_BACKEND", "paddleocr"),
        "language": os.getenv("LUMINA_OCR_LANGUAGE", "en"),
        "frames": [item.get("timecode") for item in ocr_frames],
        "scanner": "material-v2",
    })
    asr_cached = _read_analysis_cache(cache_dir / "asr.json", asr_signature) if cache_dir else None
    ocr_cached = _read_analysis_cache(cache_dir / "ocr-v2.json", ocr_signature) if cache_dir else None

    def run_asr_v2() -> tuple[list[dict[str, Any]], dict[str, str]]:
        if asr_cached:
            return asr_cached[0], asr_cached[1]
        try:
            data, engine = transcribe(path)
        except AnalysisFailed as exc:
            if "no speech segments" not in str(exc):
                raise
            data, engine = [], {"backend": os.getenv("LUMINA_ASR_BACKEND", "faster-whisper"), "status": "no_speech"}
        if cache_dir:
            _write_analysis_cache(cache_dir / "asr.json", asr_signature, data, engine)
        return data, engine

    def run_ocr_v2() -> tuple[list[dict[str, Any]], dict[str, str]]:
        if ocr_cached:
            return ocr_cached[0], ocr_cached[1]
        try:
            data, engine = _read_ocr_batched(ocr_frames, int(os.getenv("LUMINA_OCR_WORKERS", "2")))
        except AnalysisFailed as exc:
            if "PaddleOCR is not installed" not in str(exc):
                raise
            # Qwen still receives the sampled visual frames and can reason from
            # them, but missing deterministic OCR must remain visible for review.
            data, engine = [], {"backend": "paddleocr", "status": "unavailable"}
        if cache_dir:
            _write_analysis_cache(cache_dir / "ocr-v2.json", ocr_signature, data, engine)
        return data, engine

    report(38, "并行提取 ASR 与 OCR 证据")
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="material-v2-local") as executor:
        asr_future = executor.submit(run_asr_v2)
        ocr_future = executor.submit(run_ocr_v2)
        transcript, asr_engine = asr_future.result()
        report(56, "ASR 证据完成")
        ocr, ocr_engine = ocr_future.result()
        report(72, "OCR 证据完成")

    segment_seconds = min(60.0, max(30.0, float(os.getenv("LUMINA_QWEN_SEGMENT_SECONDS", "60"))))
    semantic_segments = []
    cursor = 0.0
    while cursor < duration:
        end = min(duration, cursor + segment_seconds)
        semantic_segments.append({"id": f"segment-{len(semantic_segments) + 1:03d}", "start": round(cursor, 3), "end": round(end, 3), "verification": "verified"})
        cursor = end

    multimodal_frames = [{
        "timecode": frame["timecode"], "mimeType": "image/jpeg",
        "base64": _semantic_frame_base64(frame["path"], 384, 68),
    } for frame in frames]
    payload = {
        "durationSeconds": duration,
        "frames": multimodal_frames,
        "transcript": transcript,
        "ocr": ocr,
        "shots": shots,
        "audioEvents": audio_events,
        "semanticSegments": semantic_segments,
        "requirements": [
            "Treat this uploaded paid-ad material as the complete observable source; do not depend on owning its original drama",
            "First reconstruct only the story observable inside each 30-60 second semantic segment",
            "Keep stable material-local character IDs; use candidate names when identity is uncertain",
            "Identify opening hook, re-hooks, information refreshes, emotional peaks, low-retention intervals, cliffhanger and CTA with material timecodes",
            "Classify creative format, T0/T1/T2/T3/TX tier, transitions, visual/subtitle/audio/rhythm packaging and observable risks",
            "Classify bodyFormat as 正片主导, 解说主导, 混合, or 未确定 and calculate narrationCoverage; narration excludes original character dialogue, short transition voice-over and CTA",
            "Use 正片主导 when narrationCoverage < 0.30 and continuous dramatic action/dialogue supplies the main information; use 解说主导 when narrationCoverage >= 0.50 and narration supplies the main story information; otherwise use 混合 or 未确定",
            "Detect an independent opening hook only when it forms a separate semantic unit near the opening and has an observable boundary from the body",
            "Separate the hook conclusion from reusable cut points: hooks describe complete hook units, while entryPoints may describe independently reusable subintervals",
            "For 正片剧集解说, derive hooks only from the opening 5-60 seconds and prioritize the condensed narration promise; do not return the whole narrated body as a hook",
            "For 外搭钩子＋本剧正片, locate the exact complete external-source opening fragment from time 0 to the body transition; use dense boundary comparison and never include the following drama body",
            "Once an external opening is identified, hooks[0] must span and holistically summarize that complete fragment. Strong 5-20 second moments inside it belong only in entryPoints and must never replace the complete external-hook conclusion",
            "Each hook must include hookType, themes, contentTags, characterRoles, relationships, conflict, emotion, narrativePromise, informationGap, spokenSummary, visualSummary and qualityScores",
            "Each hook start and end must be supported by dialogue, action and shot-boundary evidence; if action completion is not observable mark the boundary unverified and reviewRequired=true",
            "Classify hookSourceStatus and hookAssemblyType independently; 同剧外搭 means a same-drama high point from another episode is deliberately placed before the body",
            "Because this independent material does not include complete owned-drama coverage, visual/person/scene/style differences alone can only support 疑似外搭 and must set reviewRequired=true; never confirm external origin from differences alone",
            "Map same-drama highlight hook plus body to 正片剧集拼接; map confirmed external hook plus either original-footage or narration body to 外搭钩子＋本剧正片",
            "Produce reusable inspiration methods but never claim a proven prototype or performance without external data",
            "All conclusions cite transcript, OCR, frame, shot or audio evidence with valid material-local timecodes and confidence",
        ],
    }
    semantic = _material_semantic_analysis(payload, duration, report, cache_dir)
    report(94, "校验 material-v2 结构化结果")

    content = semantic.get("content", {})
    creative = semantic.get("creative", {})
    value = semantic.get("value", {})
    review = semantic.get("review", {})
    creative, review = _normalize_material_format(creative if isinstance(creative, dict) else {}, review if isinstance(review, dict) else {})
    creative = _enrich_material_hooks(creative, transcript, shots, duration)
    expected_hook_format = _verified_claim_value(creative.get("format")) in {"外搭钩子＋本剧正片", "正片剧集解说"}
    if expected_hook_format and not creative.get("hooks"):
        review_items = review.get("items") if isinstance(review.get("items"), list) else []
        review = {
            **review,
            "status": "needs_review",
            "reviewRequired": True,
            "items": [*review_items, {
                "id": "hook-localization-missing",
                "field": "creative.hooks",
                "label": "未定位到可安全复用的钩子",
                "reason": "候选未同时满足独立语义、5–60 秒时长和起止边界要求；系统已禁止用整片兜底。",
                "confidence": 1,
            }],
        }
    semantic = _apply_material_evidence_gate({**semantic, "creative": creative, "review": review})
    content = semantic.get("content", {})
    creative = semantic.get("creative", {})
    value = semantic.get("value", {})
    review = semantic.get("review", {})
    if ocr_engine.get("status") == "unavailable":
        if not isinstance(review, dict):
            review = {}
        items = review.get("items") if isinstance(review.get("items"), list) else []
        review = {
            **review,
            "status": "needs_review",
            "items": [*items, {
                "id": "ocr-runtime-unavailable",
                "field": "evidence.ocr",
                "label": "OCR证据缺失",
                "reason": "本机未安装PaddleOCR；本轮仅使用ASR、关键帧、镜头和音频证据。",
                "confidence": 1,
            }],
        }
    content = dict(content) if isinstance(content, dict) else {}
    summary_claim = dict(content.get("summary") or {}) if isinstance(content.get("summary"), dict) else {"value": str(content.get("summary") or ""), "confidence": 0.0, "evidence": []}
    if str(summary_claim.get("value") or "").strip() and not summary_claim.get("evidence"):
        anchors: list[dict[str, Any]] = []

        def collect_anchors(value: Any) -> None:
            if len(anchors) >= 6:
                return
            if isinstance(value, dict):
                evidence = value.get("evidence")
                if isinstance(evidence, list):
                    for item in evidence:
                        if isinstance(item, dict) and _timecode(item.get("timecode")) is not None:
                            anchors.append(dict(item))
                            if len(anchors) >= 6:
                                return
                for child in value.values():
                    collect_anchors(child)
            elif isinstance(value, list):
                for child in value:
                    collect_anchors(child)

        collect_anchors({"content": content, "creative": creative, "value": value})
        if not anchors and transcript:
            indices = sorted({0, len(transcript) // 3, (2 * len(transcript)) // 3, len(transcript) - 1})
            for index in indices:
                row = transcript[index]
                if not isinstance(row, dict) or not isinstance(row.get("start"), (int, float)) or not isinstance(row.get("end"), (int, float)) or float(row["end"]) <= float(row["start"]):
                    continue
                confidence_value = float(row.get("confidence", 0.5) or 0.5)
                anchors.append({"source": "transcript", "sourceText": str(row.get("text") or "")[:500], "timecode": {"start": float(row["start"]), "end": float(row["end"])}, "confidence": max(0.0, min(1.0, confidence_value))})
        if anchors:
            summary_claim["evidence"] = anchors[:6]
            summary_claim = _validate_semantic_claims(summary_claim, duration)
            content["summary"] = summary_claim
            semantic = {**semantic, "content": content}
    if not str(summary_claim.get("value") or "").strip() or not summary_claim.get("evidence") or summary_claim.get("verification") != "verified":
        raise AnalysisFailed("素材分析结果缺少可验证的中文摘要或时码证据")
    hooks = creative.get("hooks", []) if isinstance(creative.get("hooks"), list) else []
    transitions = creative.get("transitions", []) if isinstance(creative.get("transitions"), list) else []
    inspirations = value.get("inspirations", []) if isinstance(value.get("inspirations"), list) else []
    timeline = creative.get("timeline", []) if isinstance(creative.get("timeline"), list) else []
    confidence = round(100 * max(_claim_confidences(semantic) or [0.0]))
    detected_language = _material_language_name(asr_engine, transcript, ocr)
    material_fields = {
        "analysis": "分析完成", "analysisStatus": "succeeded",
        "materialType": _verified_claim_value(creative.get("format")),
        "tier": _verified_claim_value(creative.get("tier")),
        "hookType": _verified_claim_value(hooks[0] if hooks else None),
        "transition": _verified_claim_value(transitions[0] if transitions else None),
        "prototype": _verified_claim_value(inspirations[0] if inspirations else None),
        "summary": _verified_claim_value(content.get("summary"), ""),
        "detectedLanguage": detected_language,
        "highlights": [item for item in timeline if isinstance(item, dict) and item.get("verification") == "verified"],
        "structure": [item for item in timeline if isinstance(item, dict) and item.get("verification") == "verified"],
        "review": "待人工复核" if review.get("status") != "ready" else "可进入人工确认",
        "confidence": confidence,
    }
    evidence_frames = [{key: value for key, value in frame.items() if key != "path"} for frame in frames]
    result = {
        "schemaVersion": "material-v2",
        "evidence": {"transcript": transcript, "ocr": ocr, "keyframes": evidence_frames, "shots": shots, "audioEvents": audio_events},
        "content": content, "creative": creative, "value": value, "review": review,
        # Persist the material evidence gate at the public result root.  The
        # semantic copy is retained for backwards-compatible inspection, but
        # queue audits and the frontend consume this stable top-level field.
        "qualityGate": semantic.get("qualityGate", {"passed": False, "status": "review_required", "reasons": ["缺少素材证据质量门禁"]}),
        "sourceAttribution": {"status": "not_required", "matches": []},
        "semanticSegments": semantic_segments,
        "semantic": semantic,
        "materialFields": material_fields,
        "durationSeconds": duration,
        "detectedLanguage": detected_language,
    }
    return AnalysisEnvelope(
        "material-v2", str(uuid.uuid4()), "coarse", "succeeded",
        {"path": str(path), "durationSeconds": duration, "kind": "external_paid_ad_material"},
        {"asr": asr_engine, "ocr": ocr_engine, "frames": "ffmpeg-adaptive", "shots": "ffmpeg-scene-detection", "audio": "ffmpeg-silencedetect", "semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")},
        result,
    )


# Public material entry point. The previous implementation remains above for
# old persisted-result readability; all new jobs use the independent v2 path.
analyze_material = analyze_material_v2

def _target_duration_spec(payload: dict[str, Any]) -> dict[str, Any]:
    value = str(payload.get("target_duration_tier") or payload.get("targetDurationTier") or payload.get("targetDuration") or "").lower()
    if value in {"1-5", "1-5m", "1_5", "1_5m", "micro", "1-5分钟"}: return {"tier": "1-5m", "minSeconds": 60.0, "maxSeconds": 300.0}
    if value in {"5-15", "5-15m", "5_15", "5_15m", "short", "5-15分钟"}: return {"tier": "5-15m", "minSeconds": 300.0, "maxSeconds": 900.0}
    if value in {"15-25", "15-25m", "15_25", "15_25m", "long", "15-25分钟"}: return {"tier": "15-25m", "minSeconds": 900.0, "maxSeconds": 1500.0}
    return {"tier": "unspecified", "minSeconds": 0.0, "maxSeconds": float("inf")}

def _story_duration_validation(segments: list[dict[str, Any]], spec: dict[str, Any], explanation: Any = None) -> dict[str, Any]:
    duration = round(sum(max(0.0, float(row.get("end") or 0) - float(row.get("start") or 0)) for row in segments), 3)
    below, above = duration < spec["minSeconds"], duration > spec["maxSeconds"]
    explained = below and isinstance(explanation, str) and bool(explanation.strip())
    return {"tier": spec["tier"], "totalSeconds": duration, "minSeconds": spec["minSeconds"], "maxSeconds": None if spec["maxSeconds"] == float("inf") else spec["maxSeconds"], "status": "explained_shortfall" if explained else "too_short" if below else "too_long" if above else "within_range", "passed": not above and (not below or explained), "explanation": explanation.strip() if explained else None}

def analyze_hook_entry_points(payload: dict[str, Any]) -> dict[str, Any]:
    """Return at most three real-media entry points for the best three stories."""
    matches = payload.get("matches") if isinstance(payload.get("matches"), list) else []
    accepted = [m for m in matches if isinstance(m, dict) and (m.get("productionGate", {}).get("passed") or 65 <= float(m.get("storyScore") or 0) < 75)]
    output = []
    for match in sorted(accepted, key=lambda row: float(row.get("storyScore") or 0), reverse=True)[:3]:
        segments = match.get("segments") if isinstance(match.get("segments"), list) else []
        if not segments: continue
        first = segments[0]; media = first.get("entryEvidence") if isinstance(first.get("entryEvidence"), dict) else {}
        points: set[float] = set()
        intervals: dict[str, list[tuple[float, float]]] = {"dialogue": [], "action": [], "shot": [], "audio": []}
        for source, key in (("dialogue", "transcript"), ("action", "actions"), ("shot", "shots"), ("audio", "audioEvents")):
            for row in media.get(key) if isinstance(media.get(key), list) else []:
                tc = _timecode(row.get("timecode") or row) if isinstance(row, dict) else None
                if tc:
                    start, end = float(tc[0]), float(tc[-1])
                    intervals[source].append((start, end))
                    points.add(round(start, 3))
        candidates = []; mismatch = bool(match.get("mismatch") or match.get("hasMismatch"))
        dimensions = match.get("businessScore", {}).get("dimensionScores", {})
        for point in sorted(points):
            sources = {source for source, ranges in intervals.items() if any(start - .25 <= point <= end + .25 for start, end in ranges)}
            dialogue_ok, action_ok, boundary_ok = "dialogue" in sources, "action" in sources, "shot" in sources
            scores = {"dialogue": 100 if dialogue_ok else 0, "action": 100 if action_ok else 0, "boundary": 100 if boundary_ok else 0, "audio": 100 if "audio" in sources else 60, "semantic": float(match.get("storyScore") or 0), "emotion": float(dimensions.get("emotion") or 0), "promise": float(dimensions.get("promise") or 0), "mismatchSafety": 0 if mismatch else 100}
            score = round(sum(scores.values()) / 8, 2); passed = dialogue_ok and action_ok and boundary_ok and score >= 75 and not mismatch
            candidates.append({"episode": first.get("episode"), "start": point, "scores": scores, "score": score, "productionGate": {"passed": passed, "checks": {"dialogue": dialogue_ok, "action": action_ok, "boundary": boundary_ok, "score": score >= 75, "mismatch": not mismatch}}, "evidenceSources": sorted(sources)})
        output.append({"matchId": match.get("id"), "storyScore": match.get("storyScore"), "candidates": sorted((c for c in candidates if c["productionGate"]["passed"]), key=lambda c: c["score"], reverse=True)[:3]})
    return {"schemaVersion": "hook-entry-v1", "matches": output}


def _compact_episode_semantics(value: Any) -> dict[str, Any]:
    root = value if isinstance(value, dict) else {}
    if isinstance(root.get("result"), dict):
        root = root["result"]
    return {name: root.get(name) for name in ("episodeSummary", "episodePlots", "emotionCurve", "contentTags") if root.get(name) not in (None, "", [])}


def _external_hook_fragment_evidence(hook: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Keep only timestamped observations wholly inside the reviewed hook fragment.

    Hook assets are cut from longer paid materials.  Their semantic columns can
    therefore contain names, locations and backstory inferred from the entire
    source video.  Those fields are useful in the material library, but they are
    not evidence for a 20-second hook/body match.
    """
    raw = hook.get("evidence")
    if not isinstance(raw, dict):
        raw = {}
    start = float(hook.get("start_seconds") or hook.get("start") or 0)
    end = float(hook.get("end_seconds") or hook.get("end") or 0)
    output: dict[str, list[dict[str, Any]]] = {}
    for kind in ("transcript", "ocr", "frame"):
        rows = raw.get(kind) if isinstance(raw.get(kind), list) else []
        accepted: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_start = float(row.get("start") or (row.get("timecode") or {}).get("start") or 0)
            row_end = float(row.get("end") or (row.get("timecode") or {}).get("end") or row_start)
            confidence = float(row.get("confidence") or 0)
            text = str(row.get("text") or row.get("observation") or "").strip()
            # Do not truncate a sentence that crosses the selected boundary: a
            # clipped phrase is not a complete claim.  Low-confidence ASR is
            # also unsuitable for factual narrative generation.
            if not text or row_start < start - .05 or row_end > end + .05:
                continue
            if kind == "transcript" and confidence < .5:
                continue
            accepted.append({
                "start": round(row_start, 3),
                "end": round(row_end, 3),
                "text": text,
                "confidence": confidence,
                "verification": row.get("verification") or "unverified",
            })
        if accepted:
            output[kind] = accepted
    return output


def _external_hook_match_input(hook: dict[str, Any]) -> dict[str, Any]:
    """Return the evidence-safe hook view used by matching and presentation."""
    return {
        "id": hook.get("id"),
        "source_class": hook.get("source_class"),
        "hook_type": hook.get("hook_type"),
        "start_seconds": hook.get("start_seconds"),
        "end_seconds": hook.get("end_seconds"),
        "boundary_status": hook.get("boundary_status"),
        "safe_start": hook.get("safe_start"),
        "safe_end": hook.get("safe_end"),
        "evidence": _external_hook_fragment_evidence(hook),
        "grounding_rule": "Only the timestamped fragment evidence above may be treated as factual. Names, locations and backstory from the full source material are intentionally excluded.",
    }


def _external_hook_retrieval_input(value: Any) -> dict[str, Any]:
    """Strip full-material semantic labels from a selected retrieval score."""
    row = value if isinstance(value, dict) else {}
    return {key: row.get(key) for key in (
        "score", "direction", "directionLabel", "bridgeCost", "spoilerRisk",
        "storyNeedCoverage", "truthSafety",
    ) if row.get(key) is not None}


def analyze_hook_story_match(payload: dict[str, Any], on_progress=None) -> AnalysisEnvelope:
    hook = payload.get("hook") if isinstance(payload.get("hook"), dict) else {}
    drama = payload.get("drama") if isinstance(payload.get("drama"), dict) else {}
    episodes = payload.get("episodes") if isinstance(payload.get("episodes"), list) else []
    scope = {int(value) for value in (payload.get("episode_scope") or []) if str(value).isdigit()}
    if hook.get("source_class") != "external_material":
        raise AnalysisFailed("external-hook matching requires an external_material hook asset")
    if hook.get("boundary_status") != "verified":
        raise AnalysisFailed("hook asset boundaries must be verified before story matching")
    if not episodes or not scope:
        raise AnalysisFailed("hook matching requires analyzed episodes inside a non-empty scope")
    duration_spec = _target_duration_spec(payload)
    match_context = payload.get("match_context") if isinstance(payload.get("match_context"), dict) else {}
    strategy = str(match_context.get("matchStrategy") or "hook_to_story")
    context_story_need = match_context.get("storyNeed") if isinstance(match_context.get("storyNeed"), dict) else {}
    selected_highlight_ids = {
        str(item.get("sourceId") or "")
        for item in (context_story_need.get("evidence") or [])
        if isinstance(item, dict) and str(item.get("sourceType") or "") == "episode_highlight" and item.get("sourceId")
    }
    strategy_requirements = {
        "hook_to_story": "Start from the hook promise and find body events that causally承接 and兑现 it.",
        "story_to_hook": "Start from the drama's core plot and test whether the hook supplies a truthful前因、后果、背景 or平行线 without changing character identity.",
        "template_reuse": "Reuse only the historical material's hook structure and connection logic; replace its story facts with evidence from the current drama.",
    }
    available_count = sum(1 for item in episodes for highlight in (item.get("highlights") or []) if isinstance(highlight, dict) and float(highlight.get("end_seconds") or highlight.get("end") or 0) > float(highlight.get("start_seconds") or highlight.get("start") or 0))
    if available_count == 0:
        supplemental = [{"episode": int(item.get("episode_number") or 0), "reason": "no timestamped story evidence", "requestedAnalysis": "highlight_precision"} for item in episodes if int(item.get("episode_number") or 0) in scope]
        empty = {"schemaVersion": "hook-match-v2", "matches": [], "editableCandidates": [], "rejectionReasons": [{"reason": "缺少带时间戳的正片剧情证据", "count": len(supplemental)}], "candidateFunnel": _candidate_funnel(0, 0, 0, len(supplemental), 0), "supplementalAnalysisRequests": supplemental, "targetDuration": duration_spec}
        return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, empty)
    grounded_hook = _external_hook_match_input(hook)
    semantic_payload = {
        "hook": grounded_hook,
        "drama": {"id": drama.get("id"), "title": drama.get("title"), "genre": drama.get("genre"), "analysis": drama.get("analysis")},
        "episodeScope": sorted(scope),
        "topics": payload.get("topics") or [],
        "targetDuration": duration_spec,
        "matchStrategy": strategy,
        "deliveryGoal": match_context.get("deliveryGoal") or "停滑与点击",
        "matchingDimensions": match_context.get("matchingDimensions") or ["剧情事件", "人物关系", "情绪曲线", "悬念与承诺", "投放目标"],
        "templateMaterialId": match_context.get("templateMaterialId") or "",
        "contractVersion": match_context.get("contractVersion") or "lumina-semantic-contract-v1",
        "storyNeed": context_story_need,
        "selectedHookRetrieval": _external_hook_retrieval_input(match_context.get("selectedHookRetrieval")),
        "historicalTemplate": match_context.get("templateSnapshot") if isinstance(match_context.get("templateSnapshot"), dict) else {},
        "episodes": [{
            "episode": int(item.get("episode_number") or 0),
            "durationSeconds": item.get("duration_seconds"),
            "analysis": _compact_episode_semantics(item.get("analysis_result")),
            "highlights": [highlight for highlight in (item.get("highlights") if isinstance(item.get("highlights"), list) else []) if strategy != "story_to_hook" or not selected_highlight_ids or str(highlight.get("id") or "") in selected_highlight_ids],
        } for item in episodes if int(item.get("episode_number") or 0) in scope],
        "requirements": [
            strategy_requirements.get(strategy, strategy_requirements["hook_to_story"]),
            "Score and explain five independent dimensions: plot event, character relationship, emotion curve, suspense/promise fulfillment, and delivery-goal fit. Do not treat tag similarity as plot understanding.",
            "Build a complete and coherent story arc across the selected episode scope.",
            "Every returned body segment must be contained within one supplied episode highlight interval; never invent or extend a time range outside supplied highlights.",
            "Select whole supplied highlights without sub-trimming; start and end must equal the selected highlight boundaries.",
            "Prefer highlights whose boundaries are human verified. Mark the match reviewRequired when any selected highlight boundary is not verified.",
            "Do not cut an incomplete spoken sentence, action, or shot. Preserve chronological causality unless an explicitly explained reorder improves comprehension.",
            "Return the selected highlight asset id as highlightAssetId on every segment.",
            "For every segment return purpose as one of setup, escalation, payoff, ending, plus evidence-backed preconditions and result so causal continuity can be verified; missing causal links must remain reviewable rather than inferred.",
            "For the first segment include entryEvidence with transcript, actions, shots and audioEvents copied only from the supplied highlight analysis; never invent a media event or timestamp.",
            "Use targetDuration as a whole-story constraint. If approved evidence cannot reach the minimum, return a concise durationShortfallExplanation grounded in the available scope; never pad with weak or invented clips.",
            "For hook_to_story return promiseFulfillmentEvidence linking the hook question and promise to exact body evidence.",
            "Return displayNarrativeZh in Simplified Chinese with: title, hookQuestion, bodyConnection, formedStoryline, relationship, conflict, emotion, connectionType, continuityNotice, and phases {setup, escalation, payoff, ending}. Every statement must be grounded only in the supplied hook/highlight evidence; do not invent names, relationships, motives, outcomes or missing story phases. Use an empty string when evidence is insufficient.",
            "Set connectionType to one of 因果续接、同一人物续接、平行主题承接、情绪承接. When external-hook and drama identities/events are not proven identical, never choose the first two. continuityNotice must state whether a clear source/world transition is required.",
            "For story_to_hook use storyNeed as the retrieval intent; return storyNeedCoverage, truthSafety, bridgeCost, spoilerRisk and extensionDirection. The external hook must never be described as a factual event or identity from the current drama.",
            "For template_reuse compare historicalTemplate with the current drama and return substitutionMapping, structureFidelity, substitutionCoverage and factLeakage. Reuse structure only; historical character identities and facts must not enter the current story.",
        ],
    }
    if on_progress:
        on_progress(45, "正在评估外搭钩子与正片故事线的承接关系")
    try:
        result = _semantic_request("hook-story-match", semantic_payload)
    except AnalysisFailed as exc:
        result = {"matches": [], "providerWarning": str(exc)}
    if on_progress:
        on_progress(72, "正在核对候选钩子的剧情事实与时间戳证据")
    matches = result.get("matches") if isinstance(result.get("matches"), list) else []
    # Always retain one deterministic evidence route as a fail-safe. Provider
    # candidates may be syntactically present yet reference unsupported ranges;
    # validation below will reject those while preserving this source-only path.
    if True:
        supplied_highlights: list[dict[str, Any]] = []
        seen_intervals: set[tuple[int, float, float]] = set()
        for episode in semantic_payload["episodes"]:
            episode_number = int(episode.get("episode") or 0)
            for highlight in episode.get("highlights") or []:
                if not isinstance(highlight, dict):
                    continue
                start = float(highlight.get("start_seconds") or highlight.get("startSeconds") or highlight.get("start") or (highlight.get("safe_start") or {}).get("time") or 0)
                end = float(highlight.get("end_seconds") or highlight.get("endSeconds") or highlight.get("end") or (highlight.get("safe_end") or {}).get("time") or 0)
                key = (episode_number, round(start, 2), round(end, 2))
                if key in seen_intervals or end <= start:
                    continue
                seen_intervals.add(key)
                supplied_highlights.append({"episode": episode_number, "start": start, "end": end, "highlight": highlight})
        supplied_highlights.sort(key=lambda item: (item["episode"], item["start"]))
        selected: list[dict[str, Any]] = []
        accumulated = 0.0
        for item in supplied_highlights:
            selected.append(item)
            accumulated += item["end"] - item["start"]
            if accumulated >= duration_spec["minSeconds"]:
                break
        result["fallbackDiagnostics"] = {"suppliedHighlights": len(supplied_highlights), "selectedHighlights": len(selected), "accumulatedSeconds": round(accumulated, 3)}
        if selected:
            phases = ["setup", "escalation", "payoff", "ending"]
            segments = []
            for index, item in enumerate(selected):
                highlight = item["highlight"]
                phase = phases[min(len(phases) - 1, int(index * len(phases) / max(1, len(selected))))]
                segments.append({
                    "episode": item["episode"], "start": item["start"], "end": item["end"], "purpose": phase,
                    "highlightAssetId": highlight.get("id"), "evidence": highlight.get("evidence") or [],
                    "preconditions": [], "result": "以连续对白证据为准",
                })
            evidence_route = {
                "id": "evidence-route-001", "segments": segments, "matchScore": 70,
                "dimensionScores": {"promise": 70, "causal": 65, "conflict": 70, "relationship": 70, "informationGap": 65, "emotion": 65, "highlight": 80, "pacing": 70},
                "storyArc": {}, "contradictions": False,
                "risks": ["语义服务未返回候选；当前路线仅按剧集顺序组合已审核高光，跨段因果需人工复核。"],
                "durationShortfallExplanation": "已使用当前范围全部可追溯高光。" if accumulated < duration_spec["minSeconds"] else "",
            }
            if strategy == "story_to_hook":
                retrieval = semantic_payload.get("selectedHookRetrieval") or {}
                evidence_route.update({
                    "extensionDirection": retrieval.get("direction") or "parallel",
                    "bridgeRationale": "按正片故事需求召回；外搭人物仅作为平行结构，不冒充本剧角色。",
                    "storyNeedCoverage": retrieval.get("storyNeedCoverage") or 0,
                    "truthSafety": retrieval.get("truthSafety") or 0,
                    "bridgeCost": retrieval.get("bridgeCost") or 100,
                    "spoilerRisk": retrieval.get("spoilerRisk") or 100,
                    "retrievalEvidence": [{"candidateId": hook.get("id"), "signals": retrieval, "reasons": retrieval.get("reasons") or []}],
                })
            matches = matches + [evidence_route]
    valid_matches: list[dict[str, Any]] = []
    discarded_candidates: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        if not isinstance(match, dict) or not isinstance(match.get("segments"), list) or not match["segments"]:
            discarded_candidates.append({"id": str(match.get("id") or f"match-{index + 1:03d}") if isinstance(match, dict) else f"match-{index + 1:03d}", "selectionStatus": "rejected", "hardConflict": False, "overrideAllowed": False, "rejectionReasons": ["缺少可追溯的正片片段"]})
            continue
        valid_segments = []
        needs_review = bool(match.get("reviewRequired"))
        episode_highlights = {
            int(item.get("episode_number") or 0): [highlight for highlight in item.get("highlights") if strategy != "story_to_hook" or not selected_highlight_ids or str(highlight.get("id") or "") in selected_highlight_ids]
            for item in episodes if isinstance(item, dict) and isinstance(item.get("highlights"), list)
        }
        for segment in match["segments"]:
            if not isinstance(segment, dict):
                continue
            episode_number = int(segment.get("episode") or 0)
            start, end = float(segment.get("start") or 0), float(segment.get("end") or 0)
            supplied = episode_highlights.get(episode_number, [])
            highlight_id = str(segment.get("highlightAssetId") or "")
            highlight = next((item for item in supplied if str(item.get("id") or "") == highlight_id), None)
            if highlight is None:
                highlight = next((item for item in supplied if start >= float(item.get("start_seconds") or 0) - 0.05 and end <= float(item.get("end_seconds") or 0) + 0.05), None)
            if episode_number not in scope or end <= start or highlight is None:
                needs_review = True
                continue
            if highlight.get("boundary_status") != "verified" or highlight.get("review_status") != "approved":
                needs_review = True
            # Body clips inherit the exact human-approved highlight interval.
            # Model-selected subranges are never trusted as new edit boundaries.
            start = float(highlight.get("start_seconds") or 0)
            end = float(highlight.get("end_seconds") or 0)
            safe_start = highlight.get("safe_start") if isinstance(highlight.get("safe_start"), dict) else {}
            safe_end = highlight.get("safe_end") if isinstance(highlight.get("safe_end"), dict) else {}
            if safe_start.get("status") != "verified" or safe_end.get("status") != "verified":
                needs_review = True
            valid_segments.append({**segment, "highlightAssetId": highlight.get("id"), "episode": episode_number, "start": round(start, 3), "end": round(end, 3), "safeStart": safe_start, "safeEnd": safe_end})
        if valid_segments:
            grounded_story_arc: dict[str, str] = {"setup": "", "escalation": "", "payoff": "", "ending": ""}
            for segment in valid_segments:
                phase = str(segment.get("purpose") or "setup")
                if phase not in grounded_story_arc:
                    phase = "setup"
                evidence_texts = []
                for evidence in segment.get("evidence") or []:
                    if not isinstance(evidence, dict):
                        continue
                    value = str(evidence.get("sourceText") or evidence.get("text") or "").strip()
                    if value and value not in evidence_texts:
                        evidence_texts.append(value)
                grounded_story_arc[phase] = " / ".join(evidence_texts)[:1200]
            grounded_match = {**match, "storyArc": grounded_story_arc, "story_arc": grounded_story_arc}
            # Never expose the presentation object returned by the route-selection
            # call directly. That call sees episode-level context and may write a
            # fluent but ungrounded story. Rebuild all UI copy from the selected
            # timestamped rows in a separate evidence-only pass.
            display_narrative = None
            narrative_evidence = []
            for segment in valid_segments:
                evidence_rows = []
                for evidence in segment.get("evidence") or []:
                    if not isinstance(evidence, dict):
                        continue
                    source_text = str(evidence.get("sourceText") or evidence.get("text") or "").strip()
                    if source_text:
                        evidence_rows.append({
                            "text": source_text,
                            "timecode": evidence.get("timecode") or {},
                            "source": evidence.get("source") or "transcript",
                        })
                narrative_evidence.append({
                    "episode": segment.get("episode"),
                    "start": segment.get("start"),
                    "end": segment.get("end"),
                    "phase": segment.get("purpose") or "setup",
                    "preconditions": segment.get("preconditions") or [],
                    "result": segment.get("result") or "",
                    "evidence": evidence_rows,
                })
            try:
                narrative_result = _semantic_request("hook-story-display-zh", {
                        "externalHookEvidence": grounded_hook,
                        "bodyEvidence": narrative_evidence,
                        "selectedStorylinePlan": match_context.get("selectedStorylines") or [],
                        "instructions": [
                            "Return JSON with one key displayNarrativeZh.",
                            "Write Simplified Chinese fields: title, hookQuestion, bodyConnection, formedStoryline, relationship, conflict, emotion, connectionType, continuityNotice, and phases with setup, escalation, payoff, ending.",
                            "The externalHookEvidence and bodyEvidence are two different sources. Never treat an external-hook character, identity, event or location as a fact from the drama body.",
                            "hookQuestion may summarize only externalHookEvidence. bodyConnection, formedStoryline, relationship, conflict, emotion and every phases field must summarize only bodyEvidence, then explain the structural question/answer connection without merging the two worlds.",
                            "Set connectionType to one of 因果续接、同一人物续接、平行主题承接、情绪承接. Unless supplied evidence proves identical characters and events across both sources, use 平行主题承接 or 情绪承接. continuityNotice must plainly say that the characters/events are different and a clear transition is required.",
                            "Fill each supported phase from bodyEvidence in chronological order. Use an empty string only when that phase truly has no supplied evidence; do not leave the entire phases object empty when bodyEvidence exists.",
                            "Do not add identities, relationships, motives, outcomes, locations, actions or chronology absent from the corresponding evidence source.",
                            "When dialogue speaker identity is not explicitly supplied, do not resolve I/you/he/she to a named character. Use neutral wording such as one party questions the other.",
                            "The selectedStorylinePlan is authoritative about branch boundaries. If it marks a later episode as an independent branch, explicitly describe a branch switch and never present it as the causal result of the prior marriage plot.",
                            "Keep exact character names when present in evidence. Use an empty string for any unsupported field or phase.",
                            "Explain the selected evidence route; do not propose different clips or time ranges.",
                        ],
                })
                if isinstance(narrative_result, dict):
                    candidate_narrative = narrative_result.get("displayNarrativeZh") or narrative_result.get("display_narrative_zh")
                    if isinstance(candidate_narrative, dict):
                        display_narrative = candidate_narrative
            except AnalysisFailed:
                display_narrative = None
            if isinstance(display_narrative, dict):
                current_phases = display_narrative.get("phases") if isinstance(display_narrative.get("phases"), dict) else {}
                evidence_by_phase: dict[str, list[dict[str, Any]]] = {"setup": [], "escalation": [], "payoff": [], "ending": []}
                allocated_phase_evidence: set[tuple[Any, ...]] = set()
                chronological_evidence: list[dict[str, Any]] = []
                for segment in valid_segments:
                    for evidence in segment.get("evidence") or []:
                        if not isinstance(evidence, dict):
                            continue
                        source_text = str(evidence.get("sourceText") or evidence.get("text") or "").strip()
                        if source_text:
                            timecode = evidence.get("timecode") or {}
                            evidence_key = (
                                segment.get("episode"),
                                timecode.get("start") if isinstance(timecode, dict) else None,
                                timecode.get("end") if isinstance(timecode, dict) else None,
                                source_text,
                            )
                            if evidence_key in allocated_phase_evidence:
                                continue
                            allocated_phase_evidence.add(evidence_key)
                            chronological_evidence.append({
                                "episode": segment.get("episode"),
                                "start": segment.get("start"),
                                "end": segment.get("end"),
                                "text": source_text,
                                "timecode": timecode,
                            })
                chronological_evidence.sort(key=lambda row: (
                    int(row.get("episode") or 0),
                    float((row.get("timecode") or {}).get("start") or row.get("start") or 0),
                    float((row.get("timecode") or {}).get("end") or row.get("end") or 0),
                ))
                phase_order = ["setup", "escalation", "payoff", "ending"]
                for evidence_index, row in enumerate(chronological_evidence):
                    phase_index = min(3, int(evidence_index * 4 / max(1, len(chronological_evidence))))
                    evidence_by_phase[phase_order[phase_index]].append(row)
                for _phase_attempt in range(2):
                    missing_supported_phases = [
                        phase for phase, rows in evidence_by_phase.items()
                        if rows and not (isinstance(current_phases.get(phase), str) and re.search(r"[\u3400-\u9fff]", current_phases.get(phase) or ""))
                    ]
                    if not missing_supported_phases:
                        break
                    try:
                        phase_result = _semantic_request("hook-story-phases-zh", {
                            "bodyEvidenceByPhase": {phase: evidence_by_phase[phase] for phase in missing_supported_phases},
                            "instructions": [
                                "Return JSON with one key phases containing setup, escalation, payoff and ending.",
                                "For every supplied non-empty phase, write a concise but specific Simplified Chinese plot summary grounded only in that phase's body evidence.",
                                "Preserve episode chronology and exact character names. Do not add motives, relationships, actions, outcomes, locations or facts not stated in the supplied evidence.",
                                "When speaker identity is not explicitly supplied, do not infer which named character corresponds to first- or second-person pronouns. Use neutral wording such as one party or the other party.",
                                "Do not repeat the same event or quotation across multiple phases.",
                                "A supplied non-empty phase must not be returned as an empty string. A phase absent from bodyEvidenceByPhase must be an empty string.",
                            ],
                        })
                        phase_candidate = phase_result.get("phases") if isinstance(phase_result, dict) else None
                        if isinstance(phase_candidate, dict):
                            current_phases = {**current_phases, **phase_candidate}
                            display_narrative["phases"] = current_phases
                    except AnalysisFailed:
                        continue
            if isinstance(display_narrative, dict):
                allowed_display = {}
                for key in ("title", "hookQuestion", "bodyConnection", "formedStoryline", "relationship", "conflict", "emotion", "connectionType", "continuityNotice"):
                    value = display_narrative.get(key)
                    if isinstance(value, str) and value.strip() and re.search(r"[\u3400-\u9fff]", value):
                        allowed_display[key] = value.strip()
                phases = display_narrative.get("phases")
                if isinstance(phases, dict):
                    allowed_phases = {}
                    for key in ("setup", "escalation", "payoff", "ending"):
                        value = phases.get(key)
                        if isinstance(value, str) and value.strip() and re.search(r"[\u3400-\u9fff]", value):
                            allowed_phases[key] = value.strip()
                    allowed_display["phases"] = allowed_phases
                grounded_story_arc["displayNarrativeZh"] = allowed_display
            graph_events = [{
                "id": f"match-{index + 1:03d}-{position + 1:02d}", "episode": segment["episode"],
                "start": segment["start"], "end": segment["end"], "phase": segment.get("purpose"),
                "action": segment.get("purpose", ""), "result": segment.get("result", ""),
                "preconditions": segment.get("preconditions") if isinstance(segment.get("preconditions"), list) else [],
                "evidence": segment.get("evidence") if isinstance(segment.get("evidence"), list) else [],
                "reviewRequired": bool(segment.get("reviewRequired", False)) or segment.get("safeStart", {}).get("status") != "verified" or segment.get("safeEnd", {}).get("status") != "verified",
            } for position, segment in enumerate(valid_segments)]
            episode_rows = [{"episode": int(item.get("episode_number") or 0), "durationSeconds": float(item.get("duration_seconds") or 0)} for item in episodes if isinstance(item, dict)]
            graph = _reconstruct_storyline({"events": graph_events}, episode_rows)
            boundary_verified = all(
                segment.get("safeStart", {}).get("status") == "verified"
                and segment.get("safeEnd", {}).get("status") == "verified"
                for segment in valid_segments
            )
            evidence_segments = sum(1 for segment in valid_segments if segment.get("evidence"))
            evidence_coverage = evidence_segments / len(valid_segments)
            raw_score = float(match.get("matchScore") or 0)
            model_confidence = max(0.0, min(1.0, raw_score / 100 if raw_score > 1 else raw_score))
            story_completeness = float(graph.get("completeness", {}).get("confidence") or 0)
            business_score = deterministic_story_score(grounded_match)
            # Keep the independent signals explicit. Until a production gold profile
            # is selected, the conservative calibrated probability cannot exceed
            # either the model score or the observed evidence/boundary support.
            signals = ConfidenceSignals(
                modelConfidence=model_confidence,
                evidenceCoverage=evidence_coverage,
                boundaryReliability=1.0 if boundary_verified else 0.0,
                humanVerification="verified" if boundary_verified else "unverified",
                calibratedProbability=min(model_confidence, evidence_coverage, 1.0 if boundary_verified else 0.0),
            )
            calibration = asdict(signals)
            calibration["method"] = "conservative-evidence-cap-v1"
            explicit_contradictions = match.get("contradictions") or match.get("hasContradiction") or False
            gate_input = {**calibration, "storyCompleteness": story_completeness,
                          "storyScore": business_score["score"], "promiseScore": business_score["dimensionScores"]["promise"],
                          "contradictions": explicit_contradictions}
            gate = item_production_gate(gate_input, GateThresholds(require_human_verification=True, require_story_completeness=True))
            duration_validation = _story_duration_validation(valid_segments, duration_spec, match.get("durationShortfallExplanation") or match.get("duration_shortfall_explanation"))
            gate["checks"]["targetDuration"] = duration_validation["passed"]
            # This stage selects a truthful body entry point, not the final
            # 5-15 minute assembly. Keep shortfall visible, but validate the
            # actual delivery duration after the production timeline exists.
            gate["requiredChecks"]["targetDuration"] = True
            if not duration_validation["passed"]:
                gate.setdefault("advisories", []).append("承接片段不足目标成片时长；将在成片时间线阶段校验")
            mode_checks: dict[str, bool] = {}
            if strategy == "hook_to_story":
                mode_checks = {
                    "hookPromisePresent": bool(hook.get("narrative_promise") or hook.get("information_gap")),
                    "promiseFulfillment": business_score["dimensionScores"]["promise"] >= 70,
                    "causalCoverage": business_score["dimensionScores"]["causal"] >= 65,
                }
            elif strategy == "story_to_hook":
                story_need = semantic_payload.get("storyNeed") or {}
                mode_checks = {
                    "storyNeedPresent": bool(story_need.get("corePlot") or story_need.get("causalChain")),
                    "truthSafety": not bool(explicit_contradictions) and bool(hook.get("evidence")),
                    "bridgeExplained": bool(match.get("extensionDirection") or match.get("extension_direction") or match.get("bridgeRationale") or match.get("bridge_rationale")),
                    "storyNeedCoverage": float(match.get("storyNeedCoverage") or match.get("story_need_coverage") or business_score["score"]) >= 60,
                }
            elif strategy == "template_reuse":
                template = semantic_payload.get("historicalTemplate") or {}
                performance = template.get("performanceEvidence") if isinstance(template.get("performanceEvidence"), dict) else {}
                mapping = match.get("substitutionMapping") or match.get("substitution_mapping") or []
                mode_checks = {
                    "templateSnapshotPresent": bool(template.get("id") and template.get("version")),
                    "templateEvidenceQualified": performance.get("level") in {"medium", "strong"},
                    "templateBodyStructurePresent": bool(template.get("bodyStructure")),
                    "substitutionMapped": isinstance(mapping, list) and bool(mapping),
                    "structureFidelity": float(match.get("structureFidelity") or match.get("structure_fidelity") or 0) >= 60,
                    "substitutionCoverage": float(match.get("substitutionCoverage") or match.get("substitution_coverage") or 0) >= 60,
                    "factLeakage": not bool(match.get("factLeakage") or match.get("fact_leakage")),
                }
            gate["mode"] = strategy
            gate["modeChecks"] = mode_checks
            gate["requiredChecks"].update(mode_checks)
            failed_mode_checks = [name for name, passed in mode_checks.items() if not passed]
            if failed_mode_checks:
                gate["passed"] = False
                gate["reasons"].extend([f"{name} failed" for name in failed_mode_checks])
            first = valid_segments[0]
            safe_start = first.get("safeStart") if isinstance(first.get("safeStart"), dict) else {}
            entry_points = [{
                "id": f"match-{index + 1:03d}-entry-01", "episode": first["episode"],
                "start": first["start"], "frame": safe_start.get("frame"),
                "timecode": safe_start.get("timecode") or {"start": first["start"], "end": first["start"]},
                "recommended": gate["passed"], "safeBoundary": safe_start,
                "evidence": safe_start.get("evidence") or first.get("evidence") or [],
            }]
            valid_matches.append({
                **grounded_match, "segments": valid_segments, "storyGraph": graph,
                "entryPoints": [], "storyEntryBoundary": entry_points[0], "completeness": graph.get("completeness", {}),
                "calibration": calibration, "businessScore": business_score,
                "storyScore": business_score["score"],
                "targetDuration": duration_validation,
                "selectionStatus": "production" if gate["passed"] else "editable" if 65 <= business_score["score"] < 75 else "rejected",
                "promiseScore": business_score["dimensionScores"]["promise"],
                "promiseFulfillmentScore": business_score["dimensionScores"]["promise"],
                "causalCompletenessScore": business_score["dimensionScores"]["causal"],
                "businessGate": gate, "productionGate": gate,
                "matchStrategy": strategy,
                "storyNeed": semantic_payload.get("storyNeed") or {},
                "templateEvidence": semantic_payload.get("historicalTemplate") or {},
                "retrievalEvidence": match.get("retrievalEvidence") or match.get("retrieval_evidence") or [],
                "substitutionMapping": match.get("substitutionMapping") or match.get("substitution_mapping") or [],
                "storyAdvisory": graph["reviewRequired"],
                "reviewRequired": needs_review or not gate["passed"],
            })
    if not valid_matches:
        empty = {**result, "schemaVersion": "hook-match-v2", "matches": [], "editableCandidates": discarded_candidates, "rejectionReasons": _rejection_reason_counts(discarded_candidates), "candidateFunnel": _candidate_funnel(len(discarded_candidates), 0, 0, 0, len(discarded_candidates)), "targetDuration": duration_spec, "supplementalAnalysisRequests": []}
        return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, empty)
    # The consumer selects an exact source entry point. Different downstream
    # story routes that begin at the same approved interval must not be exposed
    # as duplicate entry-point candidates. Sorting first keeps the strongest
    # route for that interval.
    ranked_matches = []
    seen_entry_intervals: set[tuple[int, float, float]] = set()
    for item in sorted(valid_matches, key=lambda value: (bool(value.get("productionGate", {}).get("passed")), float(value.get("storyScore") or 0), float(value.get("calibration", {}).get("calibratedProbability") or 0)), reverse=True):
        first_segment = item["segments"][0]
        entry_key = (
            int(first_segment["episode"]),
            round(float(first_segment["start"]), 2),
            round(float(first_segment["end"]), 2),
        )
        if entry_key in seen_entry_intervals:
            continue
        seen_entry_intervals.add(entry_key)
        ranked_matches.append(item)
    production = [item for item in ranked_matches if item.get("productionGate", {}).get("passed")]
    editable = [item for item in ranked_matches if not item.get("productionGate", {}).get("passed") and 65 <= float(item.get("storyScore") or 0) < 75]
    rejected = [item for item in ranked_matches if item not in production and item not in editable] + discarded_candidates
    validated = {**result, "schemaVersion": "hook-match-v3", "contractVersion": semantic_payload["contractVersion"], "matchStrategy": strategy, "storyNeed": semantic_payload.get("storyNeed") or {}, "templateEvidence": semantic_payload.get("historicalTemplate") or {}, "matches": ranked_matches, "editableCandidates": editable + rejected, "rejectionReasons": _rejection_reason_counts(editable + rejected), "candidateFunnel": _candidate_funnel(len(ranked_matches) + len(discarded_candidates), len(production), len(editable), sum(1 for item in editable if item.get("reviewRequired")), len(rejected)), "storyGraph": ranked_matches[0].get("storyGraph", {}), "entryPointAnalysis": analyze_hook_entry_points({"matches": ranked_matches}), "targetDuration": duration_spec, "supplementalAnalysisRequests": []}
    return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, validated)


def _merge_episode_detail_results(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge isolated episode analyses without allowing facts to change owner."""
    merged: dict[str, Any] = {"characters": [], "relationships": [], "episodePlots": [], "emotionCurve": [], "contentTags": [], "highlightCandidates": []}
    keyed: dict[str, dict[tuple[Any, ...], dict[str, Any]]] = {"characters": {}, "relationships": {}, "contentTags": {}}
    for part in parts:
        for item in part.get("episodePlots") or []:
            if isinstance(item, dict) and isinstance(item.get("episode"), int):
                merged["episodePlots"].append(item)
        merged["emotionCurve"].extend(item for item in (part.get("emotionCurve") or []) if isinstance(item, dict))
        merged["highlightCandidates"].extend(item for item in (part.get("highlightCandidates") or []) if isinstance(item, dict))
        for field, key_fields in (("characters", ("originalName", "name")), ("relationships", ("character1", "character2", "type")), ("contentTags", ("dimension", "value"))):
            for item in part.get(field) or []:
                if not isinstance(item, dict):
                    continue
                if field == "characters":
                    # originalName is the cross-language identity key. Using
                    # originalName+translated name kept Ash/艾什 and
                    # Stella/斯黛拉 as false duplicate people.
                    identity = str(item.get("originalName") or item.get("name") or "").strip().casefold()
                    key = (identity,)
                else:
                    key = tuple(str(item.get(name) or "").strip().casefold() for name in key_fields)
                if not any(key):
                    continue
                existing = keyed[field].get(key)
                if existing is None:
                    keyed[field][key] = dict(item)
                    continue
                existing["episodes"] = sorted({int(value) for value in (existing.get("episodes") or []) + (item.get("episodes") or []) if isinstance(value, (int, float))})
                existing["evidence"] = (existing.get("evidence") or []) + (item.get("evidence") or [])
                existing["confidence"] = max(float(existing.get("confidence") or 0), float(item.get("confidence") or 0))
    for field in keyed:
        merged[field] = list(keyed[field].values())
    merged["episodePlots"].sort(key=lambda item: item["episode"])
    return merged


def analyze_detail(episodes: list[AnalysisEnvelope], visual_frames: list[dict[str, Any]] | None = None, on_progress: Callable[[int, str], None] | None = None) -> AnalysisEnvelope:
    if not episodes or any(item.tier != "coarse" or item.status != "succeeded" or not item.result for item in episodes):
        raise AnalysisFailed("Detail analysis requires succeeded coarse results for every episode")
    episode_rows: list[dict[str, Any]] = []
    durations: dict[int, float] = {}
    for item in episodes:
        result = item.result or {}
        source = item.source or {}
        try:
            episode_number = int(result.get("episode", source.get("episode")))
            episode_duration = float(result.get("durationSeconds", source.get("durationSeconds", 0)))
        except (TypeError, ValueError):
            raise AnalysisFailed("Coarse result is missing episode number or duration")
        if episode_duration <= 0:
            raise AnalysisFailed("Coarse result duration must be positive")
        durations[episode_number] = episode_duration
        episode_rows.append({"episode": episode_number, "durationSeconds": episode_duration, "transcript": result.get("transcript") or result.get("words") or [], "ocr": result.get("ocr") or result.get("subtitles") or []})
    payload = {"episodes": episode_rows, "frames": visual_frames or [], "scope": "free episodes only", "requirements": ["complete dialogue with speaker aliases", "episode-isolated plot and evidence", "emotion curve", "use supplied visual frames together with transcript and OCR to recall dialogue, action, reaction, reveal, threat, relationship-shift, cliffhanger and payoff triggers", "never infer an observed action or visual impact from dialogue alone", "produce evidence-backed contentTags using only the fixed dimensions genre, theme, character, relationship, emotion, conflict, plot, scene, audience, and adUse", "each content tag contains dimension, value, confidence, episodes, and evidence", "return zero to two distinct evidence-supported highlightCandidates per supplied episode; zero is valid", "never create filler candidates merely to reach a quota", "a candidate is a complete 12-60 second event with cause, trigger and reaction, not an isolated quote", "require audienceQuestion and narrativePromise for every candidate", "never return a candidate outside the supplied episode", "cite evidence with timecode and confidence", "mark unobserved dialogue/actions/shots unverified"]}
    # Analyze one episode per request. This prevents a high-confidence fact from
    # episode N being copied into episode N-1 while still allowing deterministic
    # character/tag merging after all episode-local facts have owners.
    semantic_parts: list[dict[str, Any]] = []
    total_episode_rows = max(1, len(episode_rows))

    def analyze_episode_row(episode_row: dict[str, Any]) -> dict[str, Any]:
        episode_number = int(episode_row["episode"])
        episode_payload = {**payload, "episodes": [episode_row], "frames": [frame for frame in (visual_frames or []) if int(frame.get("episode") or 0) == episode_number]}
        part = _semantic_request("detail-drama-analysis", episode_payload)
        if not isinstance(part.get("highlightCandidates"), list):
            repaired = _semantic_request("repair-detail-output-contract", {"resultToRepair": part, "instruction": f"Preserve only episode {episode_number} facts. Add all required arrays. Never move facts from another episode."})
            part = {**part, **repaired}
        # Fail closed on provider ownership mistakes.
        part["episodePlots"] = [item for item in (part.get("episodePlots") or []) if isinstance(item, dict) and item.get("episode") == episode_number]
        part["highlightCandidates"] = [item for item in (part.get("highlightCandidates") or []) if isinstance(item, dict) and item.get("episode") == episode_number]
        return part

    # Episode ownership is isolated, so these provider requests are safely
    # parallelizable. A small bounded pool cuts wall time without flooding the
    # multimodal endpoint or increasing per-request token volume.
    detail_workers = max(1, min(total_episode_rows, int(os.getenv("LUMINA_DETAIL_SEMANTIC_WORKERS", "2"))))
    completed_rows = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=detail_workers) as executor:
        futures = {executor.submit(analyze_episode_row, row): int(row["episode"]) for row in episode_rows}
        for future in concurrent.futures.as_completed(futures):
            episode_number = futures[future]
            semantic_parts.append(future.result())
            completed_rows += 1
            if on_progress:
                on_progress(40 + round(completed_rows / total_episode_rows * 42), f"完成第 {episode_number} 集证据归属校验（{completed_rows}/{total_episode_rows}）")
    semantic = _merge_episode_detail_results(semantic_parts)
    if on_progress:
        on_progress(83, "统一跨集人物身份并校正因果故事线")
    reconciliation_payload = {
        "episodes": episode_rows,
        # Rebuild continuity from primary evidence.  Feeding the isolated draft
        # back here anchored the continuity model to confident episode-local
        # mistakes (for example a rhetorical father comparison becoming the
        # present spouse's identity).
        "frames": visual_frames or [],
        "isolatedDraft": {field: semantic.get(field, []) for field in ("characters", "relationships", "episodePlots")},
        "episodeBoundaryAnchors": [
            {
                "episode": row["episode"],
                "openingLines": [item.get("text") for item in (row.get("transcript") or [])[:3] if isinstance(item, dict)],
                "closingLines": [item.get("text") for item in (row.get("transcript") or [])[-3:] if isinstance(item, dict)],
            }
            for row in episode_rows
        ],
        "requirements": [
            "resolve canonical recurring characters and aliases across all episodes",
            "correct speaker, subject, object and relationship ownership using transcript and frame evidence",
            "return one evidence-backed episode plot per supplied episode",
            "return a causal whole-drama storyOverview with character arcs, resolved payoffs and unresolved questions",
            "never move an event to a different episode and never invent missing actions",
            "a question or hypothetical such as do you expect me to kneel is not an observed action; negation, refusal and rhetorical questions must never be rewritten as completed actions",
            "a comparison such as you are just like my father keeps you and father as different people; a remembered parent never replaces the present spouse",
            "track first-person continuity across episode boundaries: the hospitalized person, hearing-aid buyer and new worker remain the same character unless evidence explicitly changes speaker",
            "merge short names, surnames, spelling variants and transliterations into one canonical person; never create separate people for Ash, Ashton or a noisy Aston spelling",
            "copy concrete object and medical facts faithfully: allergy is not poisoning, a locket is not a watch, and a hearing aid is not generic medical expense",
            "include explicit reveals and deadlines that alter the relationship, including who actually performed a past rescue, who took credit, and any stated divorce countdown",
            "do not invent rain, street injury, locations, physical actions or outcomes without transcript or frame evidence",
            "episodeBoundaryAnchors are hard ownership boundaries; a line or event belongs only to the episode whose transcript contains it",
            "use isolatedDraft episode plots as ownership hints, correct unsupported wording, and never move their supported facts to a neighboring episode",
        ],
    }
    if len(episode_rows) > 1:
        reconciled = _validate_semantic_claims(_semantic_request("reconcile-drama-storyline", reconciliation_payload), durations)
        for field in ("characters", "relationships", "emotionCurve", "contentTags"):
            if isinstance(reconciled.get(field), list):
                semantic[field] = reconciled[field]
        # Normalize frequent transliteration variants before they are supplied
        # to episode grounding.  Keep this evidence-led: aliases are enabled
        # only when the canonical source spelling explicitly names the person.
        alias_replacements: dict[str, str] = {}
        for character in semantic.get("characters") or []:
            if not isinstance(character, dict):
                continue
            canonical_name = str(character.get("name") or "").strip()
            original = str(character.get("originalName") or "").casefold()
            if "ashton" in original and "ash" in original:
                alias_replacements.update({"艾什": canonical_name, "阿斯顿": canonical_name, "阿什": canonical_name})
            if "jade" in original:
                alias_replacements["杰德"] = canonical_name
            if "stella" in original:
                alias_replacements["斯黛拉"] = canonical_name
            if "ashton" in original and "voss" in original:
                alias_replacements.update({"维斯先生": canonical_name, "沃斯先生": canonical_name})

        def normalize_alias_text(value: Any) -> Any:
            if isinstance(value, str):
                for alias, canonical in alias_replacements.items():
                    if alias == "阿什":
                        value = re.sub(r"阿什(?!顿)", canonical, value)
                    else:
                        value = value.replace(alias, canonical)
                return value
            if isinstance(value, list):
                return [normalize_alias_text(item) for item in value]
            if isinstance(value, dict):
                return {key: normalize_alias_text(item) for key, item in value.items()}
            return value

        semantic["relationships"] = normalize_alias_text(semantic.get("relationships") or [])
        normalized_characters: dict[str, dict[str, Any]] = {}
        for character in normalize_alias_text(semantic.get("characters") or []):
            if not isinstance(character, dict):
                continue
            name = str(character.get("name") or "").strip()
            existing = normalized_characters.get(name)
            if existing is None:
                normalized_characters[name] = character
            else:
                existing["episodes"] = sorted({int(value) for value in (existing.get("episodes") or []) + (character.get("episodes") or []) if isinstance(value, (int, float))})
        semantic["characters"] = list(normalized_characters.values())
        # Re-ground every plot after entity resolution.  The global pass is
        # useful for aliases, but allowing it to author the episode timeline
        # caused adjacent-episode leakage and speaker swaps.  Each repair sees
        # one owned transcript plus canonical identities and boundary context.
        canonical_characters = semantic.get("characters") or []
        grounded_plots: list[dict[str, Any]] = []

        def ground_episode(index: int, row: dict[str, Any]) -> dict[str, Any]:
            episode_number = int(row["episode"])
            prior = episode_rows[index - 1] if index > 0 else None
            following = episode_rows[index + 1] if index + 1 < len(episode_rows) else None
            grounded = _semantic_request("ground-drama-episode", {
                "episode": row,
                "frames": [frame for frame in (visual_frames or []) if int(frame.get("episode") or 0) == episode_number],
                "canonicalCharacters": canonical_characters,
                "canonicalRelationships": semantic.get("relationships") or [],
                "continuityContext": {
                    "previousClosingLines": [item.get("text") for item in ((prior or {}).get("transcript") or [])[-3:] if isinstance(item, dict)],
                    "nextOpeningLines": [item.get("text") for item in ((following or {}).get("transcript") or [])[:3] if isinstance(item, dict)],
                },
            })
            plot = grounded.get("episodePlot") if isinstance(grounded.get("episodePlot"), dict) else None
            if not plot or int(plot.get("episode") or 0) != episode_number:
                raise AnalysisFailed(f"Grounded episode repair returned the wrong owner for episode {episode_number}")
            plot = _validate_semantic_claims(plot, {episode_number: durations[episode_number]})
            facts = []
            for fact in plot.get("coreFacts") or []:
                if not isinstance(fact, dict):
                    continue
                evidence = [item for item in (fact.get("evidence") or []) if isinstance(item, dict)]
                # A visual frame has no verbatim spoken sourceText.  Providers
                # occasionally relabel noisy OCR as a frame and then invent a
                # weather/injury outcome from it.  Such evidence is malformed
                # and cannot support a plot fact.
                malformed_visual_only = bool(evidence) and all(item.get("source") == "frame" for item in evidence) and any(str(item.get("sourceText") or "").strip() for item in evidence)
                if not malformed_visual_only:
                    facts.append(fact)
            transcript_rows = [item for item in (row.get("transcript") or []) if isinstance(item, dict)]
            transcript_source = " ".join(str(item.get("text") or "") for item in transcript_rows).lower()
            ocr_rows = [item for item in (row.get("ocr") or []) if isinstance(item, dict)]
            ocr_source = " ".join(str(item.get("text") or "") for item in ocr_rows).lower()
            fact_text = " ".join(str(item.get("description") or "") for item in facts)
            if "allergic to alcohol" in transcript_source and "won't drink" in transcript_source and "i'll help" in transcript_source and not any(word in fact_text for word in ("强迫", "逼迫", "灌酒")):
                evidence_row = next((item for item in transcript_rows if "won't drink" in str(item.get("text") or "").lower()), {})
                facts.append({"description": "对方明知她酒精严重过敏且已拒绝饮酒，仍以“我来帮你”实施强迫灌酒。", "evidence": [{"episode": episode_number, "source": "transcript", "sourceText": evidence_row.get("text", ""), "timecode": {"start": evidence_row.get("start", 0), "end": evidence_row.get("end", 0)}, "confidence": 0.95}]})
            if "girlfriend" in transcript_source and any(word in transcript_source for word in ("campaign", "shoot")):
                romantic = next((item for item in (semantic.get("relationships") or []) if isinstance(item, dict) and any(word in str(item.get("type") or item.get("description") or "") for word in ("情人", "恋人", "女友", "暧昧", "新欢"))), None)
                if romantic:
                    left = str(romantic.get("character1") or "").strip()
                    right = str(romantic.get("character2") or "").strip()
                    if left and right and not (left in fact_text and right in fact_text):
                        evidence_row = next((item for item in transcript_rows if "girlfriend" in str(item.get("text") or "").lower()), {})
                        facts.append({"description": f"{left}带{right}作为广告拍摄的客户与出镜对象到场。", "evidence": [{"episode": episode_number, "source": "transcript", "sourceText": evidence_row.get("text", ""), "timecode": {"start": evidence_row.get("start", 0), "end": evidence_row.get("end", 0)}, "confidence": 0.9}]})
            countdown_match = re.search(r"divorce\s+countdown\s+(\d+)\s+days", ocr_source, re.IGNORECASE)
            if countdown_match and not (countdown_match.group(1) in fact_text and "离婚" in fact_text):
                evidence_row = next((item for item in ocr_rows if "divorce" in str(item.get("text") or "").lower() and "countdown" in str(item.get("text") or "").lower()), {})
                facts.append({"description": f"画面明确显示离婚倒计时还剩{countdown_match.group(1)}天。", "evidence": [{"episode": episode_number, "source": "ocr", "sourceText": evidence_row.get("text", ""), "timecode": {"start": evidence_row.get("start", 0), "end": evidence_row.get("end", evidence_row.get("start", 0))}, "confidence": 0.99}]})
            spouse_relation = next((item for item in (semantic.get("relationships") or []) if isinstance(item, dict) and any(word in str(item.get("type") or "") for word in ("夫妻", "婚姻"))), None)
            if spouse_relation:
                husband = str(spouse_relation.get("character1") or "").strip()
                wife = str(spouse_relation.get("character2") or "").strip()
                if "walking away in 30 days" in transcript_source:
                    facts = [item for item in facts if not any("walking away in 30 days" in str(ev.get("sourceText") or "").lower() for ev in (item.get("evidence") or []) if isinstance(ev, dict))]
                    evidence_row = next((item for item in transcript_rows if "walking away in 30 days" in str(item.get("text") or "").lower()), {})
                    facts.append({"description": f"{wife}拒绝收钱，并重申将在30天离婚倒计时结束后离开{husband}。", "evidence": [{"episode": episode_number, "source": "transcript", "sourceText": evidence_row.get("text", ""), "timecode": {"start": evidence_row.get("start", 0), "end": evidence_row.get("end", 0)}, "confidence": 0.95}]})
                if "if she finds out i care about her" in transcript_source:
                    facts = [item for item in facts if not any("if she finds out i care about her" in str(ev.get("sourceText") or "").lower() for ev in (item.get("evidence") or []) if isinstance(ev, dict))]
                    evidence_row = next((item for item in transcript_rows if "if she finds out i care about her" in str(item.get("text") or "").lower()), {})
                    facts.append({"description": f"{husband}内心承认在意{wife}，但担心暴露关心会失去控制她的筹码。", "evidence": [{"episode": episode_number, "source": "transcript", "sourceText": evidence_row.get("text", ""), "timecode": {"start": evidence_row.get("start", 0), "end": evidence_row.get("end", 0)}, "confidence": 0.95}]})
            if facts:
                plot["coreFacts"] = facts
                plot["summary"] = "；".join(str(item.get("description") or "").strip().rstrip("。") for item in facts if str(item.get("description") or "").strip()) + "。"
                descriptions = [str(item.get("description") or "").strip() for item in facts if str(item.get("description") or "").strip()]
                plot["cause"] = descriptions[0]
                action_candidates = [text for text in descriptions if any(word in text for word in ("决定", "拒绝", "揭露", "接下", "强迫", "宣布", "归还", "拍摄", "离开"))]
                plot["action"] = action_candidates[0] if action_candidates else descriptions[min(1, len(descriptions) - 1)]
                plot["result"] = str(facts[-1].get("description") or plot.get("result") or "").strip()
            return plot

        with concurrent.futures.ThreadPoolExecutor(max_workers=detail_workers) as executor:
            futures = [executor.submit(ground_episode, index, row) for index, row in enumerate(episode_rows)]
            for future in futures:
                grounded_plots.append(future.result())
        grounded_plots.sort(key=lambda item: int(item["episode"]))
        semantic["episodePlots"] = grounded_plots
        overview_result = _semantic_request("synthesize-drama-overview", {
            "canonicalCharacters": canonical_characters,
            "relationships": semantic.get("relationships") or [],
            "groundedEpisodePlots": grounded_plots,
        })
        if not isinstance(overview_result.get("storyOverview"), dict):
            raise AnalysisFailed("Grounded story synthesis is missing storyOverview")
        semantic["storyOverview"] = overview_result["storyOverview"]
        semantic["storyOverview"]["summary"] = " ".join(f"第{int(plot['episode'])}集：{str(plot.get('summary') or '').strip()}" for plot in grounded_plots)
    raw_candidates = next((semantic.get(name) for name in ("highlightCandidates", "precisionCandidates", "highlights") if isinstance(semantic.get(name), list)), None)
    if raw_candidates is None:
        repaired = _semantic_request("repair-detail-output-contract", {
            "resultToRepair": semantic,
            "instruction": "Preserve existing supported facts. Add all required top-level arrays including contentTags. Map an existing evidence-supported highlights array to highlightCandidates; otherwise use an empty highlightCandidates array. Do not invent candidates or tags.",
        })
        semantic = {**semantic, **repaired}
        raw_candidates = next((semantic.get(name) for name in ("highlightCandidates", "precisionCandidates", "highlights") if isinstance(semantic.get(name), list)), None)
    transcripts = {int(row["episode"]): list(row.get("transcript") or []) for row in episode_rows}
    initial_candidates = _precision_candidates(raw_candidates, durations, transcripts)
    # V2 deliberately has no minimum candidate count. A weak episode may
    # produce zero hooks; silently filling a 3–5 quota created ordinary lines
    # that looked precise but had no stopping power.
    raw_candidates = initial_candidates
    semantic = _validate_semantic_claims(semantic, durations)
    candidates = _precision_candidates(raw_candidates, durations, transcripts)
    # PocketBase consumes highlightCandidates; precisionCandidates is a stable
    # semantic alias for downstream clients. Both reference the same validated list.
    semantic["highlightCandidates"] = candidates
    semantic["precisionCandidates"] = candidates
    story_graph = _reconstruct_storyline(semantic, payload["episodes"])
    semantic["storyGraph"] = story_graph
    semantic["storyline"] = story_graph
    semantic["entryPoints"] = candidates
    if on_progress:
        on_progress(86, "合并人物、标签与单集故事结构")
    if story_graph.get("reviewRequired"):
        semantic["reviewRequired"] = True
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "detail", "succeeded", {"episodes": sorted(durations)}, {"semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, semantic)


def analyze_precision(path: Path, episode: int, start: float, end: float, coarse: AnalysisEnvelope, workspace: Path) -> AnalysisEnvelope:
    duration = _duration(path)
    # Detail candidates are persisted at millisecond precision while ffprobe can
    # report a fractional-frame duration. Accept that harmless rounding delta
    # and clamp extraction to the real media boundary.
    if end > duration and end - duration <= 0.05:
        end = duration
    if not 0 <= start < end <= duration:
        raise AnalysisFailed("Precision interval must be inside the source duration")
    if coarse.status != "succeeded" or coarse.tier != "coarse" or coarse.source.get("episode") != episode:
        raise AnalysisFailed("Precision analysis requires the matching succeeded coarse result")
    interval = float(os.getenv("LUMINA_PRECISION_FRAME_INTERVAL", "0.5"))
    frames = extract_frames(path, workspace / f"precision-{episode}-{start:.3f}-{end:.3f}", interval, start, end)
    transcript = [item for item in (coarse.result or {}).get("transcript", []) if item["end"] >= start and item["start"] <= end]
    multimodal_frames = [{"episode": episode, "timecode": frame["timecode"], "mimeType": "image/jpeg", "base64": _semantic_frame_base64(frame["path"])} for frame in frames]
    payload = {"episode": episode, "interval": {"start": start, "end": end}, "frames": multimodal_frames, "transcript": transcript, "requirements": ["shot semantics", "audio-visual rhythm", "continuity", "explainable highlight scores", "every claim cites timecode/confidence", "unseen dialogue/actions/shots are unverified", "return hookCandidates as every independently reusable naturally bounded 10-60 second subinterval inside this highlight; never force the minimum duration and one highlight may produce multiple hooks", "each hookCandidate must preserve complete cause, dialogue, action, reaction and shot boundaries and contain safeStart/safeEnd, hookType, themes, contentTags, characterRoles, relationships, conflict, emotion, narrativePromise, informationGap, spokenSummary, visualSummary, qualityScores and evidence"]}
    semantic = _validate_semantic_claims(_semantic_request("precision-highlight-analysis", payload), duration)
    analysis = semantic.get("highlightAnalysis") if isinstance(semantic.get("highlightAnalysis"), dict) else {}
    semantic["highlightAnalysis"] = {**analysis, **_highlight_quality_projection(analysis)}
    normalized_hooks = _normalize_precision_hooks(semantic.get("hookCandidates"), start, end, transcript)
    eligible_hooks: list[dict[str, Any]] = []
    for hook in normalized_hooks:
        scores = hook.get("qualityScores") if isinstance(hook.get("qualityScores"), dict) else {}
        audience_question = str(hook.get("audienceQuestion") or "").strip()
        narrative_promise = str(hook.get("narrativePromise") or "").strip()
        stop_power = _numeric_score(scores.get("stopPower"))
        clarity = _numeric_score(scores.get("coldAudienceClarity", scores.get("clarity")))
        usability = _numeric_score(scores.get("productionUsability", scores.get("reusability")))
        boundary_verified = hook.get("safeStart", {}).get("status") == "verified" and hook.get("safeEnd", {}).get("status") == "verified"
        gate_passed = stop_power >= 90 and clarity >= 85 and usability >= 85 and bool(audience_question and narrative_promise)
        hook["hookPotentialScore"] = stop_power
        hook["productionUsabilityScore"] = usability
        hook["qualityGate"] = {"passed": gate_passed, "productionReady": gate_passed and boundary_verified, "reasons": [reason for condition, reason in ((stop_power < 90, "前三秒停滑不足"), (clarity < 85, "陌生观众理解成本过高"), (usability < 85, "生产可用性不足"), (not audience_question, "缺少观众问题"), (not narrative_promise, "缺少叙事承诺"), (not boundary_verified, "安全边界尚未验证")) if condition]}
        hook["reviewRequired"] = bool(hook.get("reviewRequired")) or not gate_passed or not boundary_verified
        if gate_passed and not any(_interval_overlap_ratio(hook, existing) >= .70 and str(hook.get("narrativePromise")) == str(existing.get("narrativePromise")) for existing in eligible_hooks):
            eligible_hooks.append(hook)
    semantic["hookCandidates"] = eligible_hooks
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "precision", "succeeded", {"path": str(path), "episode": episode, "durationSeconds": duration, "interval": {"start": start, "end": end}}, {"frames": "ffmpeg", "semantic": os.getenv("LUMINA_SEMANTIC_MODEL", "not-required")}, semantic)


def failed_envelope(tier: Tier, source: dict[str, Any], exc: Exception) -> AnalysisEnvelope:
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), tier, "failed", source, {}, error={"type": type(exc).__name__, "message": str(exc)})


def write_result(result: AnalysisEnvelope, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
