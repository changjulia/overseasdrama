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
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Literal

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
        _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-q:v", "3", "-y", str(target)])
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
        _run([_executable("ffmpeg"), "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-q:v", "3", "-y", str(target)])
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
    priority = [value for value in unique if value <= 60 or value >= duration - 30]
    if len(priority) >= max_frames:
        stride = max(1, (len(priority) + max_frames - 1) // max_frames)
        selected = priority[::stride][:max_frames]
        # Always retain the first and last measured frame.
        selected = sorted(set(selected + [priority[0], priority[-1]]))
        return selected[:max_frames - 1] + [selected[-1]] if len(selected) > max_frames else selected
    remainder = [value for value in unique if value not in set(priority)]
    capacity = max(0, max_frames - len(priority))
    stride = max(1, (len(remainder) + max(1, capacity) - 1) // max(1, capacity))
    return sorted(set(priority + remainder[::stride][:capacity]))


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
    segments, info = model.transcribe(str(path), word_timestamps=True, vad_filter=True)
    output = []
    for segment in segments:
        words = [{"text": word.word.strip(), "start": float(word.start), "end": float(word.end), "confidence": float(word.probability)} for word in (segment.words or [])]
        output.append({"text": segment.text.strip(), "start": float(segment.start), "end": float(segment.end), "confidence": sum((word["confidence"] for word in words), 0.0) / max(1, len(words)), "words": words, "speaker": None, "verification": "verified"})
    if not output:
        raise AnalysisFailed("ASR returned no speech segments")
    engine = {
        "backend": backend,
        "model": model_name,
        "language": str(info.language),
        "device": runtime.device,
        "computeType": runtime.compute_type,
    }
    if runtime.fallback_reason:
        engine["fallbackReason"] = runtime.fallback_reason
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


def _enrich_material_hooks(creative: dict[str, Any], transcript: list[dict[str, Any]], shots: list[dict[str, Any]], duration: float) -> dict[str, Any]:
    hooks = creative.get("hooks") if isinstance(creative.get("hooks"), list) else []
    # Providers sometimes return a verified opening hook on the creative
    # timeline but omit the duplicate hooks array. Promote that exact,
    # evidence-backed interval instead of losing it during asset projection.
    if not hooks:
        for item in creative.get("timeline", []) if isinstance(creative.get("timeline"), list) else []:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").lower()
            label = str(item.get("label") or "")
            start, end = item.get("start"), item.get("end")
            if ("opening" in code or "开场钩子" in label) and isinstance(start, (int, float)) and isinstance(end, (int, float)) and float(start) <= 5 and 5 <= float(end) - float(start) <= 60:
                hooks.append({
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
        # A dissolve/time-card/body reset often forms one unusually long shot
        # after the opening scene. Use the preceding verified shot boundary as
        # a conservative candidate, then require dense human/action review.
        for index in range(1, len(shot_ranges)):
            previous_end, next_start, next_end = shot_ranges[index - 1][1], shot_ranges[index][0], shot_ranges[index][1]
            if 10 <= previous_end <= min(60, duration) and abs(previous_end - next_start) <= .5 and next_end - next_start >= 8:
                opening_limit = previous_end
                break
        if opening_limit is None:
            boundaries = [end for _start, end in shot_ranges if 5 <= end <= min(60, duration * .5)]
            opening_limit = boundaries[0] if boundaries else None
    enriched: list[dict[str, Any]] = []
    for index, raw in enumerate(hooks[:12]):
        if not isinstance(raw, dict):
            continue
        if not isinstance(raw.get("start"), (int, float)) or not isinstance(raw.get("end"), (int, float)):
            continue
        start = max(0.0, min(duration, float(raw["start"])))
        end = max(start, min(duration, float(raw["end"])))
        candidate_duration = end - start
        if duration > 8 and start <= .5 and end >= duration - .5:
            continue
        if material_format == "外搭钩子＋本剧正片":
            if opening_limit is None or start > 5 or start >= opening_limit:
                continue
            external_maximum = max(5.0, float(os.getenv("LUMINA_EXTERNAL_HOOK_MAX_SECONDS", "20")))
            if candidate_duration < 5 or candidate_duration > external_maximum or end > opening_limit + .5:
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
        if any(min(candidate["end"], existing["end"]) - max(candidate["start"], existing["start"]) >= .8 * min(candidate["duration"], existing["duration"]) for existing in enriched):
            continue
        enriched.append(candidate)
    return {**creative, "hooks": enriched[:5], "entryPoints": enriched[:5], "hookLocalization": {
        "status": "localized" if enriched else "needs_review",
        "candidateCount": len(enriched[:5]),
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
    if duration < minimum_duration or max_workers == 1:
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
    semantic_cache = cache_dir / "semantic-segments-v4.json" if cache_dir else None
    semantic_signature = _cache_signature({"version": 4, "duration": duration, "segmentSeconds": segment_seconds, "segmentCount": len(segments), "hookPolicy": "localized-no-whole-video-v1"})
    cached_segments = _read_analysis_cache(semantic_cache, semantic_signature) if semantic_cache else None
    if cached_segments and isinstance(cached_segments[0], list) and len(cached_segments[0]) == len(segments):
        results = cached_segments[0]
        report(88, f"千问分段分析缓存复用 {len(segments)}/{len(segments)}")
    else:
        report(78, f"千问分段分析 0/{len(segments)}")
        failures: dict[int, Exception] = {}
        with ThreadPoolExecutor(max_workers=min(max_workers, len(segments)), thread_name_prefix="material-qwen") as executor:
            futures = {executor.submit(_semantic_request, "paid-ad-material-segment-analysis", segment): index for index, segment in enumerate(segments)}
            completed = 0
            for future in as_completed(futures):
                index = futures[future]
                try:
                    results[index] = _validate_semantic_claims(future.result(), duration)
                except Exception as exc:
                    failures[index] = exc
                completed += 1
                report(78 + round(10 * completed / len(segments)), f"千问分段分析 {completed}/{len(segments)}")
        if failures:
            for retry_number, index in enumerate(sorted(failures), start=1):
                report(88, f"千问并发受限，串行重试 {retry_number}/{len(failures)}")
                time.sleep(float(os.getenv("LUMINA_QWEN_RETRY_DELAY", "2")))
                results[index] = _validate_semantic_claims(_semantic_request("paid-ad-material-segment-analysis", segments[index]), duration)
        if semantic_cache:
            _write_analysis_cache(semantic_cache, semantic_signature, results, {"backend": "qwen-segments-v4"})
    report(90, "千问全片创意汇总")
    merge_payload = {
        "durationSeconds": duration,
        # Keep explicit source dialogue in the local cache. The provider only
        # needs high-level labels and evidence coordinates for final merging;
        # resending explicit prose can trigger provider inspection and leaks
        # more source text than necessary.
        "segmentAnalyses": [_compact_material_merge_segment(result) for result in results if result is not None],
        "evidenceIndex": {
            "shots": payload.get("shots", [])[:80],
            "audioEvents": payload.get("audioEvents", [])[:80],
            "semanticSegments": payload.get("semanticSegments", []),
        },
        "requirements": payload.get("requirements", []) + [
            "merge overlapping claims without removing their original timecoded evidence",
            "produce one coherent full-material structure in Simplified Chinese",
        ],
    }
    try:
        result = _validate_semantic_claims(_semantic_request("paid-ad-material-classification-merge", merge_payload), duration)
    except AnalysisFailed as exc:
        if "finish_reason=length" not in str(exc) and "no complete JSON object" not in str(exc):
            raise
        report(91, "云端汇总截断，使用分段证据聚合")
        result = _aggregate_material_classification([item for item in results if isinstance(item, dict)], duration)
    result = _ensure_material_output_contract(result, merge_payload, duration, report)
    return _reconcile_material_segment_results(result, [item for item in results if isinstance(item, dict)], duration)


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
    review_required = hook_source["label"] in {"疑似外搭", "来源未知"} or body["label"] == "未确定"
    empty_claim = {"code": "UNDETERMINED", "label": "未确定", "value": "未确定", "confidence": 0, "evidence": [], "verification": "unverified"}
    return {
        "content": {"summary": {"value": " ".join(summaries)[:500], "confidence": body["confidence"], "evidence": evidence}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": {**empty_claim, "label": "分段证据完整", "value": "分段证据完整", "confidence": 1, "verification": "verified"}},
        "creative": {"format": empty_claim, "tier": {**empty_claim, "code": "TX", "label": "TX", "value": "TX"}, "hooks": [], "bodyFormat": body, "hookSourceStatus": hook_source, "narrationCoverage": {"value": round(narration, 4), "confidence": body["confidence"], "evidence": evidence, "verification": "verified"}, "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
        "value": {"scores": {}, "inspirations": [], "risks": [], "suitableGenres": [], "suitableAudiences": []},
        "review": {"status": "needs_review" if review_required else "ready", "reviewRequired": review_required, "reasons": ["云端全片汇总截断，已按验证分段进行确定性聚合"]},
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


def _compact_material_merge_segment(result: dict[str, Any]) -> dict[str, Any]:
    """Keep merge evidence useful while staying below provider context limits."""
    def compact(value: Any, key: str = "", depth: int = 0) -> Any:
        if depth > 7:
            return None
        if isinstance(value, str):
            return _sanitize_material_provider_input(value, key)[:240]
        if isinstance(value, list):
            limit = 2 if key == "evidence" else 4
            return [compact(item, key, depth + 1) for item in value[:limit]]
        if isinstance(value, dict):
            omitted = {"sourceText", "base64", "path", "characters", "relationships", "packaging", "inspirations", "suitableGenres", "suitableAudiences"}
            return {name: compact(item, name, depth + 1) for name, item in value.items() if name not in omitted}
        return value

    content = result.get("content") if isinstance(result.get("content"), dict) else {}
    creative = result.get("creative") if isinstance(result.get("creative"), dict) else {}
    value = result.get("value") if isinstance(result.get("value"), dict) else {}
    review = result.get("review") if isinstance(result.get("review"), dict) else {}
    selected = {
        "content": {name: content.get(name) for name in ("summary", "tags", "segments", "completeness") if name in content},
        "creative": {name: creative.get(name) for name in ("format", "tier", "hooks", "bodyFormat", "hookSourceStatus", "narrationCoverage", "timeline", "transitions") if name in creative},
        "value": {name: value.get(name) for name in ("scores", "risks") if name in value},
        "review": review,
    }
    return compact(selected)


def _material_output_contract_valid(result: Any) -> bool:
    """Return whether a provider result satisfies the independent material-v2 schema."""
    if not isinstance(result, dict):
        return False
    return (
        isinstance(result.get("content"), dict)
        and isinstance(result.get("creative"), dict)
        and isinstance(result.get("value"), dict)
        and isinstance(result.get("review"), dict)
        and isinstance(result["content"].get("tags"), list)
        and isinstance(result["content"].get("segments"), list)
        and isinstance(result["creative"].get("hooks"), list)
        and isinstance(result["creative"].get("timeline"), list)
        and isinstance(result["value"].get("scores"), (dict, list))
    )


def _ensure_material_output_contract(
    result: dict[str, Any],
    source_payload: dict[str, Any],
    duration: float,
    report: Callable[[int, str], None],
) -> dict[str, Any]:
    """Repair provider shape once, then fail truthfully instead of persisting empty success."""
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
    repaired = _validate_semantic_claims(_semantic_request("repair-paid-ad-material-output-contract", repair_payload), duration)
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
        "Every semantic claim must cite source, valid timecode and confidence; episode is required only for owned-drama analysis and must not be invented for external material",
        "Never invent unseen dialogue, actions, characters, or shots",
        "All user-visible narrative fields must be written in natural Simplified Chinese, including summaries, descriptions, roles, relationships, plot events, emotions, shot semantics, rhythm, continuity, scoring reasons and recommendations",
        "Transliterate character names into commonly used Simplified Chinese and preserve the source spelling in originalName",
        "For every evidence item, put a faithful Simplified Chinese translation in text and preserve the verbatim source quote in sourceText; never translate timestamps, IDs or enum keys",
        "Do not output English prose in user-visible fields; English is allowed only in originalName, sourceText, filenames, model identifiers and machine enum keys",
    ]
    output_contract: dict[str, Any] | None = None
    if task in ("detail-drama-analysis", "repair-detail-output-contract"):
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
            "entryPoints": [],
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
    if task in ("paid-ad-material-analysis", "paid-ad-material-segment-analysis", "paid-ad-material-analysis-merge", "repair-paid-ad-material-output-contract"):
        rules.extend([
            "This is an independent external paid-ad material; never require or invent dramaId, episode number, source drama, or complete-series context",
            "The top-level JSON object must contain content, creative, value, and review",
            "content contains summary, tags, characters, relationships, segments, and completeness",
            "creative contains format, tier, hooks, timeline, transitions, and packaging with visual/subtitle/audio/rhythm arrays",
            "value contains scores, inspirations, risks, suitableGenres, and suitableAudiences",
            "review contains status and reasons; use needs_review when evidence is insufficient or conflicting",
            "Every tag, hook, timeline item and score must contain code, label, confidence, evidence, and verification",
            "Use material-local timecodes and segment/shot identifiers; do not use episode as a required fact",
            "Analyze the observable story inside this material only and explicitly label missing context, suspected reordering, cross-segment montage, external hook, or mixed-source content",
            "Classify bodyFormat as 正片主导, 解说主导, 混合, or 未确定; narrationCoverage is the fraction 0..1 of valid content duration occupied by narration that is independent from original character dialogue",
            "Classify hookSourceStatus as 无独立钩子, 已确认同剧, 疑似外搭, 已确认外搭, or 来源未知; an opening hook must be a distinct semantic unit near the opening with an observable boundary from the body",
            "同剧高光钩子＋正片 always maps to final format 正片剧集拼接; both external-hook-plus-original-footage and external-hook-plus-narration map to 外搭钩子＋本剧正片",
            "When owned-drama source coverage is incomplete, external origin can never be confirmed: use 疑似外搭, set reviewRequired true, and explain the missing source coverage",
            "Only use 已确认外搭 when source metadata, a match to another source, or a complete owned-drama search provides direct evidence; visual style changes alone support only 疑似外搭",
            "For long material identify the opening hook, later re-hooks, information refreshes, emotional peaks, low-retention intervals, cliffhanger and CTA when evidence supports them",
            "Scores describe observable creative properties only; never invent exposure, CTR, CVR, spend, ROAS, audience response, or other performance data",
            "Never wrap the whole response in a single value/confidence/evidence claim",
        ])
        evidence = [{"source": "transcript|ocr|frame|shot|audio", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "Simplified Chinese", "sourceText": "optional verbatim source"}]
        claim = {"code": "stable enum code", "label": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}
        output_contract = {
            "content": {
                "summary": {"value": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence},
                "tags": [claim], "characters": [claim], "relationships": [claim],
                "segments": [{**claim, "start": "seconds", "end": "seconds", "description": "Simplified Chinese"}],
                "completeness": claim,
            },
            "creative": {
                "format": claim, "tier": claim, "hooks": [{**claim, "start": "seconds", "end": "seconds"}],
                "bodyFormat": claim, "hookSourceStatus": claim,
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
            output_contract = {
                "content": {
                    "summary": {"value": "Simplified Chinese", "confidence": "0..1 number", "evidence": evidence},
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
                    "summary": {"value": "concise Simplified Chinese", "confidence": "0..1 number", "evidence": evidence},
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
    if task == "paid-ad-material-classification-merge":
        rules.extend([
            "Classify this independent paid-ad material from the supplied segment analyses",
            "Return only the compact classification contract below; do not generate a detailed content, packaging, inspiration or risk report",
            "bodyFormat must be 正片主导, 解说主导, 混合, or 未确定",
            "hookSourceStatus must be 无独立钩子, 已确认同剧, 疑似外搭, 已确认外搭, or 来源未知",
            "When complete owned-drama source coverage is absent, visual differences can only support 疑似外搭 and reviewRequired=true, never 已确认外搭",
            "Use at most 2 hooks and 2 evidence items per claim; every array shown as [] must remain exactly empty",
        ])
        evidence = [{"source": "transcript|ocr|frame|shot|audio", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "concise Simplified Chinese"}]
        claim = {"code": "stable enum code", "label": "Simplified Chinese", "value": "enum value", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}
        output_contract = {
            "content": {"summary": {"value": "concise Simplified Chinese", "confidence": "0..1 number", "evidence": evidence}, "tags": [], "characters": [], "relationships": [], "segments": [], "completeness": claim},
            "creative": {"format": claim, "tier": claim, "hooks": [{**claim, "start": "seconds", "end": "seconds", "hookType": "stable hook type", "themes": ["tag"], "contentTags": ["tag"], "characterRoles": ["role"], "relationships": ["relationship"], "conflict": "Simplified Chinese", "emotion": "Simplified Chinese", "narrativePromise": "Simplified Chinese", "informationGap": "Simplified Chinese", "spokenSummary": "Simplified Chinese", "visualSummary": "Simplified Chinese", "qualityScores": {"stopPower": "0..100", "conflict": "0..100", "clarity": "0..100", "reusability": "0..100"}, "reviewRequired": "boolean"}], "bodyFormat": claim, "hookSourceStatus": claim, "narrationCoverage": {"value": "0..1 number", "confidence": "0..1 number", "evidence": evidence, "verification": "verified|unverified"}, "timeline": [], "transitions": [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}},
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
            "max_tokens": int(os.getenv("LUMINA_SEMANTIC_MAX_TOKENS", "16384")),
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


def _semantic_request(task: str, payload: dict[str, Any]) -> dict[str, Any]:
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
    request = urllib.request.Request(endpoint, data=json.dumps(body).encode(), headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=int(os.getenv("LUMINA_SEMANTIC_TIMEOUT", "180"))) as response:
            if provider == "openai-chat-completions" and body.get("stream"):
                result = _extract_chat_stream(response)
            else:
                result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")[:1600]
        raise AnalysisFailed(f"Semantic provider HTTP {exc.code}: {response_body or exc.reason}") from exc
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


def analyze_coarse(path: Path, episode: int, workspace: Path) -> AnalysisEnvelope:
    duration = _duration(path)
    frames = extract_frames(path, workspace / "coarse-frames", float(os.getenv("LUMINA_COARSE_FRAME_INTERVAL", "10")))
    transcript, asr_engine = transcribe(path)
    try:
        ocr, ocr_engine = read_ocr(frames)
    except Exception as exc:
        # OCR is supporting evidence, not a prerequisite for transcript- and
        # frame-backed episode analysis. Keep the failure explicit so later
        # production gates can require review instead of killing the whole job.
        ocr, ocr_engine = [], {"backend": "paddleocr", "status": "unavailable", "error": str(exc)[:500]}
    semantic_input = {"episode": episode, "durationSeconds": duration, "transcript": transcript, "ocr": ocr, "requirements": ["episode summary", "cast candidates", "every claim cites transcript/OCR evidence with timecode and confidence", "do not infer unseen dialogue/actions/shots"]}
    semantic = _validate_semantic_claims(_semantic_request("coarse-episode-analysis", semantic_input), duration)
    result = {"episode": episode, "durationSeconds": duration, "keyframes": frames, "transcript": transcript, "ocr": ocr, "episodeSummary": semantic.get("episodeSummary"), "castCandidates": semantic.get("castCandidates", [])}
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "coarse", "succeeded", {"path": str(path), "episode": episode, "durationSeconds": duration}, {"asr": asr_engine, "ocr": ocr_engine, "frames": "ffmpeg", "semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, result)


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
            "base64": base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii"),
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
        {"asr": asr_engine, "ocr": ocr_engine, "frames": "ffmpeg", "semantic": os.environ["LUMINA_SEMANTIC_MODEL"]},
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
    if hook_source in {"疑似外搭", "已确认外搭"}:
        final_format = "外搭钩子＋本剧正片"
        basis = hook_claim
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
        "scanner": "material-v2",
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
    frame_signature = _cache_signature({"timestamps": timestamps, "backend": "ffmpeg", "scanner": "material-v2"})
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
    ocr_frames = frames[:max(1, int(os.getenv("LUMINA_MATERIAL_MAX_OCR_FRAMES", "48")))]
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
        "base64": base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii"),
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
            "Return every independently reusable hook interval, not the whole material; one material may contain multiple distinct hooks",
            "For 正片剧集解说, derive hooks only from the opening 5-60 seconds and prioritize the condensed narration promise; do not return the whole narrated body as a hook",
            "For 外搭钩子＋本剧正片, locate only the external-source opening fragment before the body transition; use dense boundary comparison around the suspected transition and do not treat the following drama body as part of the hook",
            "The external-source opening fragment is only a search area, not automatically the hook: select one or more strongest independently understandable 5-20 second subintervals inside it; never return the complete opening fragment merely because it precedes the body transition",
            "Each hook must include hookType, themes, contentTags, characterRoles, relationships, conflict, emotion, narrativePromise, informationGap, spokenSummary, visualSummary and qualityScores",
            "Each hook start and end must be supported by dialogue, action and shot-boundary evidence; if action completion is not observable mark the boundary unverified and reviewRequired=true",
            "Classify hookSourceStatus as 无独立钩子, 已确认同剧, 疑似外搭, 已确认外搭, or 来源未知",
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
    semantic = {**semantic, "creative": creative, "review": review}
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
        {"asr": asr_engine, "ocr": ocr_engine, "frames": "ffmpeg-adaptive", "shots": "ffmpeg-scene-detection", "audio": "ffmpeg-silencedetect", "semantic": os.environ["LUMINA_SEMANTIC_MODEL"]},
        result,
    )


# Public material entry point. The previous implementation remains above for
# old persisted-result readability; all new jobs use the independent v2 path.
analyze_material = analyze_material_v2

def _target_duration_spec(payload: dict[str, Any]) -> dict[str, Any]:
    value = str(payload.get("target_duration_tier") or payload.get("targetDurationTier") or payload.get("targetDuration") or "").lower()
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


def analyze_hook_story_match(payload: dict[str, Any]) -> AnalysisEnvelope:
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
    approved_count = sum(1 for item in episodes for highlight in (item.get("highlights") or []) if isinstance(highlight, dict) and highlight.get("boundary_status") == "verified" and highlight.get("review_status") == "approved")
    if approved_count == 0:
        supplemental = [{"episode": int(item.get("episode_number") or 0), "reason": "no approved verified highlights", "requestedAnalysis": "highlight_precision"} for item in episodes if int(item.get("episode_number") or 0) in scope]
        empty = {"schemaVersion": "hook-match-v2", "matches": [], "editableCandidates": [], "rejectionReasons": [{"reason": "缺少已审核且边界已验证的高光", "count": len(supplemental)}], "candidateFunnel": _candidate_funnel(0, 0, 0, len(supplemental), 0), "supplementalAnalysisRequests": supplemental, "targetDuration": duration_spec}
        return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, empty)
    semantic_payload = {
        "hook": hook,
        "drama": {"id": drama.get("id"), "title": drama.get("title"), "genre": drama.get("genre"), "analysis": drama.get("analysis")},
        "episodeScope": sorted(scope),
        "topics": payload.get("topics") or [],
        "targetDuration": duration_spec,
        "episodes": [{
            "episode": int(item.get("episode_number") or 0),
            "durationSeconds": item.get("duration_seconds"),
            "analysis": item.get("analysis_result"),
            "highlights": item.get("highlights") if isinstance(item.get("highlights"), list) else [],
        } for item in episodes if int(item.get("episode_number") or 0) in scope],
        "requirements": [
            "Build a complete and coherent story arc across the selected episode scope.",
            "Every returned body segment must be contained within one supplied episode highlight interval; never invent or extend a time range outside supplied highlights.",
            "Select whole supplied highlights without sub-trimming; start and end must equal the selected highlight boundaries.",
            "Prefer highlights whose boundaries are human verified. Mark the match reviewRequired when any selected highlight boundary is not verified.",
            "Do not cut an incomplete spoken sentence, action, or shot. Preserve chronological causality unless an explicitly explained reorder improves comprehension.",
            "Return the selected highlight asset id as highlightAssetId on every segment.",
            "For every segment return purpose as one of setup, escalation, payoff, ending, plus evidence-backed preconditions and result so causal continuity can be verified; missing causal links must remain reviewable rather than inferred.",
            "For the first segment include entryEvidence with transcript, actions, shots and audioEvents copied only from the supplied highlight analysis; never invent a media event or timestamp.",
            "Use targetDuration as a whole-story constraint. If approved evidence cannot reach the minimum, return a concise durationShortfallExplanation grounded in the available scope; never pad with weak or invented clips.",
        ],
    }
    result = _semantic_request("hook-story-match", semantic_payload)
    matches = result.get("matches") if isinstance(result.get("matches"), list) else []
    valid_matches: list[dict[str, Any]] = []
    discarded_candidates: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        if not isinstance(match, dict) or not isinstance(match.get("segments"), list) or not match["segments"]:
            discarded_candidates.append({"id": str(match.get("id") or f"match-{index + 1:03d}") if isinstance(match, dict) else f"match-{index + 1:03d}", "selectionStatus": "rejected", "hardConflict": False, "overrideAllowed": False, "rejectionReasons": ["缺少可追溯的正片片段"]})
            continue
        valid_segments = []
        needs_review = bool(match.get("reviewRequired"))
        episode_highlights = {
            int(item.get("episode_number") or 0): item.get("highlights")
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
            business_score = deterministic_story_score(match)
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
            gate["requiredChecks"]["targetDuration"] = duration_validation["passed"]
            if not duration_validation["passed"]:
                gate["passed"] = False; gate["reasons"].append("targetDuration failed")
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
                **match, "segments": valid_segments, "storyGraph": graph,
                "entryPoints": [], "storyEntryBoundary": entry_points[0], "completeness": graph.get("completeness", {}),
                "calibration": calibration, "businessScore": business_score,
                "storyScore": business_score["score"],
                "targetDuration": duration_validation,
                "selectionStatus": "production" if gate["passed"] else "editable" if 65 <= business_score["score"] < 75 else "rejected",
                "promiseScore": business_score["dimensionScores"]["promise"],
                "promiseFulfillmentScore": business_score["dimensionScores"]["promise"],
                "causalCompletenessScore": business_score["dimensionScores"]["causal"],
                "businessGate": gate, "productionGate": gate,
                "storyAdvisory": graph["reviewRequired"],
                "reviewRequired": needs_review or not gate["passed"],
            })
    if not valid_matches:
        empty = {**result, "schemaVersion": "hook-match-v2", "matches": [], "editableCandidates": discarded_candidates, "rejectionReasons": _rejection_reason_counts(discarded_candidates), "candidateFunnel": _candidate_funnel(len(discarded_candidates), 0, 0, 0, len(discarded_candidates)), "targetDuration": duration_spec, "supplementalAnalysisRequests": []}
        return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, empty)
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
    validated = {**result, "schemaVersion": "hook-match-v2", "matches": ranked_matches, "editableCandidates": editable + rejected, "rejectionReasons": _rejection_reason_counts(editable + rejected), "candidateFunnel": _candidate_funnel(len(ranked_matches) + len(discarded_candidates), len(production), len(editable), sum(1 for item in editable if item.get("reviewRequired")), len(rejected)), "storyGraph": ranked_matches[0].get("storyGraph", {}), "entryPointAnalysis": analyze_hook_entry_points({"matches": ranked_matches}), "targetDuration": duration_spec, "supplementalAnalysisRequests": []}
    return AnalysisEnvelope("hook-match-v2", str(uuid.uuid4()), "detail", "succeeded", {"hook": hook.get("id"), "drama": drama.get("id"), "episodeScope": sorted(scope)}, {"semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, validated)


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
    payload = {"episodes": episode_rows, "frames": visual_frames or [], "scope": "free episodes only", "requirements": ["complete dialogue with speaker aliases", "episode-isolated plot and evidence", "emotion curve", "use supplied visual frames together with transcript and OCR to recall dialogue, action, reaction, reveal, threat, spectacle, relationship-shift, cliffhanger and payoff triggers", "never infer an observed action or visual impact from dialogue alone", "produce evidence-backed contentTags using only the fixed dimensions genre, theme, character, relationship, emotion, conflict, plot, scene, audience, and adUse", "each content tag contains dimension, value, confidence, episodes, and evidence", "return zero to five distinct evidence-supported highlightCandidates per supplied episode; quality is mandatory and no minimum count exists", "never create filler candidates merely to reach a quota", "separate plot importance from paid-ad hook potential and production usability", "a reusable highlight is a complete event interval containing enough cause, trigger and reaction for a cold viewer, not an isolated quote", "score every candidate with highlightScores, hookPotentialScores and productionScores using the required contract", "require an explicit audienceQuestion and narrativePromise for hook-potential candidates", "never return a highlight candidate for an episode outside the supplied free-episode input", "for each highlight candidate choose a naturally bounded playable 12-60 second interval inside one episode and cite transcript/OCR/frame evidence within that interval; never default all intervals to 12 seconds", "rank candidates by hook potential and complete-event quality, never by model confidence alone", "cite evidence with timecode and confidence", "mark unobserved dialogue/actions/shots unverified"]}
    payload["requirements"].extend([
        "Reconstruct an evidence-backed storyGraph with event nodes containing actors, preconditions, action, result, relationshipBefore, relationshipAfter, emotionBefore, emotionAfter, reveals and unresolvedQuestions plus timecode evidence",
        "StoryGraph must contain setup, escalation, payoff and ending, causalChecks, completeness and reviewRequired; do not fill missing phases with invented events",
        "Every highlight must distinguish trigger, narrativeInterval and productionInterval; reject zero-length or spoken/action-truncated intervals",
        "Return entryPoints only at sentence starts/ends, shot boundaries or observed action-safe points, with dialogue/action/shot/semantic status and frame/timecode evidence",
    ])
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
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "detail", "succeeded", {"episodes": sorted(durations)}, {"semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, semantic)


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
    multimodal_frames = [{"episode": episode, "timecode": frame["timecode"], "mimeType": "image/jpeg", "base64": base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii")} for frame in frames]
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
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "precision", "succeeded", {"path": str(path), "episode": episode, "durationSeconds": duration, "interval": {"start": start, "end": end}}, {"frames": "ffmpeg", "semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, semantic)


def failed_envelope(tier: Tier, source: dict[str, Any], exc: Exception) -> AnalysisEnvelope:
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), tier, "failed", source, {}, error={"type": type(exc).__name__, "message": str(exc)})


def write_result(result: AnalysisEnvelope, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
