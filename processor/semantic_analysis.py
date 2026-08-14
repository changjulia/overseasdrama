"""Evidence-first three-tier video analysis.

No method in this module fabricates content. Optional engines are imported lazily;
missing executables, models or credentials raise ``AnalysisFailed``. Semantic
claims from cloud models are accepted only when they cite measured time ranges.
"""

from __future__ import annotations

import json
import os
import base64
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
    timestamps = [0, 0.5, 1, 2, 3, 5, 8, 12, 15]
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
    priority = [value for value in unique if value <= 15 or value >= duration - 30]
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
    model = WhisperModel(model_name, device=device, compute_type=compute_type, cpu_threads=cpu_threads, num_workers=1)
    segments, info = model.transcribe(str(path), word_timestamps=True, vad_filter=True)
    output = []
    for segment in segments:
        words = [{"text": word.word.strip(), "start": float(word.start), "end": float(word.end), "confidence": float(word.probability)} for word in (segment.words or [])]
        output.append({"text": segment.text.strip(), "start": float(segment.start), "end": float(segment.end), "confidence": sum((word["confidence"] for word in words), 0.0) / max(1, len(words)), "words": words, "speaker": None, "verification": "verified"})
    if not output:
        raise AnalysisFailed("ASR returned no speech segments")
    return output, {"backend": backend, "model": model_name, "language": str(info.language)}


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
    for frame in frames:
        if hasattr(reader, "predict"):
            pages = reader.predict(frame["path"]) or []
            for page in pages:
                texts = page.get("rec_texts", []) if hasattr(page, "get") else []
                scores = page.get("rec_scores", []) if hasattr(page, "get") else []
                for text, confidence in zip(texts, scores):
                    if str(text).strip():
                        output.append({"text": str(text).strip(), "confidence": float(confidence), "timecode": frame["timecode"], "framePath": frame["path"], "verification": "verified"})
        else:
            rows = reader.ocr(frame["path"], cls=True) or []
            for page in rows:
                for row in page or []:
                    text, confidence = row[1]
                    if str(text).strip():
                        output.append({"text": str(text).strip(), "confidence": float(confidence), "timecode": frame["timecode"], "framePath": frame["path"], "verification": "verified"})
    return output, {"backend": backend, "language": language}


def _cache_signature(values: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


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


def _material_semantic_analysis(payload: dict[str, Any], duration: float, report: Callable[[int, str], None]) -> dict[str, Any]:
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
    report(90, "千问全片创意汇总")
    merge_payload = {
        "durationSeconds": duration,
        # Keep explicit source dialogue in the local cache. The provider only
        # needs high-level labels and evidence coordinates for final merging;
        # resending explicit prose can trigger provider inspection and leaks
        # more source text than necessary.
        "segmentAnalyses": [_sanitize_material_provider_input(result) for result in results if result is not None],
        "evidenceIndex": {
            "shots": payload.get("shots", []),
            "audioEvents": payload.get("audioEvents", []),
            "semanticSegments": payload.get("semanticSegments", []),
        },
        "requirements": payload.get("requirements", []) + [
            "merge overlapping claims without removing their original timecoded evidence",
            "produce one coherent full-material structure in Simplified Chinese",
        ],
    }
    result = _validate_semantic_claims(_semantic_request("paid-ad-material-analysis-merge", merge_payload), duration)
    return _ensure_material_output_contract(result, merge_payload, duration, report)


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
            "Each highlight candidate must contain episode, start, end, confidence, and evidence",
        ])
        output_contract = {
            "characters": [],
            "relationships": [],
            "episodePlots": [],
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
                "evidence": [{"episode": "integer", "source": "transcript|ocr|frame", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "optional string"}],
            }],
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
                "timeline": [{**claim, "start": "seconds", "end": "seconds"}], "transitions": [claim],
                "packaging": {"visual": [claim], "subtitle": [claim], "audio": [claim], "rhythm": [claim]},
            },
            "value": {
                "scores": {"observableMetricCode": {**claim, "score": "0..100 number"}},
                "inspirations": [claim], "risks": [claim], "suitableGenres": [claim], "suitableAudiences": [claim],
            },
            "review": {"status": "needs_review|ready", "reasons": ["Simplified Chinese"]},
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
            "max_tokens": int(os.getenv("LUMINA_SEMANTIC_MAX_TOKENS", "8192")),
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
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            result, end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(result, dict) and not text[index + end:].strip().strip("`").strip():
            return result
        if isinstance(result, dict):
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
            valid = valid and isinstance(start, (int, float)) and isinstance(end, (int, float)) and 0 <= start <= end <= evidence_duration and isinstance(evidence_confidence, (int, float)) and 0 <= evidence_confidence <= 1 and isinstance(source, str) and bool(source)
        transformed["verification"] = "verified" if valid else "unverified"
    return transformed


def _precision_candidates(value: Any, durations: dict[int, float]) -> list[dict[str, Any]]:
    """Validate the detail->precision handoff; invalid candidates are excluded."""
    if not isinstance(value, list):
        raise AnalysisFailed("Detail provider result must contain precisionCandidates[]")
    candidates: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        episode, start, end, confidence = item.get("episode"), item.get("start"), item.get("end"), item.get("confidence")
        if not isinstance(episode, int) or episode not in durations or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or not 0 <= start < end <= durations[episode] or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            continue
        checked = _validate_semantic_claims(item, durations)
        if checked.get("verification") == "verified":
            candidates.append(checked)
    return candidates


def analyze_coarse(path: Path, episode: int, workspace: Path) -> AnalysisEnvelope:
    duration = _duration(path)
    frames = extract_frames(path, workspace / "coarse-frames", float(os.getenv("LUMINA_COARSE_FRAME_INTERVAL", "10")))
    transcript, asr_engine = transcribe(path)
    ocr, ocr_engine = read_ocr(frames)
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
    semantic = _material_semantic_analysis(payload, duration, report)
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
            "Produce reusable inspiration methods but never claim a proven prototype or performance without external data",
            "All conclusions cite transcript, OCR, frame, shot or audio evidence with valid material-local timecodes and confidence",
        ],
    }
    semantic = _material_semantic_analysis(payload, duration, report)
    report(94, "校验 material-v2 结构化结果")

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
    hooks = creative.get("hooks", []) if isinstance(creative.get("hooks"), list) else []
    transitions = creative.get("transitions", []) if isinstance(creative.get("transitions"), list) else []
    inspirations = value.get("inspirations", []) if isinstance(value.get("inspirations"), list) else []
    timeline = creative.get("timeline", []) if isinstance(creative.get("timeline"), list) else []
    confidence = round(100 * max(_claim_confidences(semantic) or [0.0]))
    material_fields = {
        "analysis": "分析完成", "analysisStatus": "succeeded",
        "materialType": _verified_claim_value(creative.get("format")),
        "tier": _verified_claim_value(creative.get("tier")),
        "hookType": _verified_claim_value(hooks[0] if hooks else None),
        "transition": _verified_claim_value(transitions[0] if transitions else None),
        "prototype": _verified_claim_value(inspirations[0] if inspirations else None),
        "summary": _verified_claim_value(content.get("summary"), ""),
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


def analyze_detail(episodes: list[AnalysisEnvelope]) -> AnalysisEnvelope:
    if not episodes or any(item.tier != "coarse" or item.status != "succeeded" or not item.result for item in episodes):
        raise AnalysisFailed("Detail analysis requires succeeded coarse results for every episode")
    durations = {int(item.source["episode"]): float(item.source["durationSeconds"]) for item in episodes}
    payload = {"episodes": [{"episode": item.result["episode"], "durationSeconds": item.result["durationSeconds"], "transcript": item.result["transcript"], "ocr": item.result["ocr"]} for item in episodes], "requirements": ["complete dialogue with speaker aliases", "cross-episode character relationships", "episode plot", "emotion curve", "produce evidence-backed contentTags using only the fixed dimensions genre, theme, character, relationship, emotion, conflict, plot, scene, audience, and adUse", "each content tag contains dimension, value, confidence, episodes, and evidence", "extract every evidence-supported conflict, reversal, revelation, threat, emotional peak, cliffhanger or payoff as highlightCandidates", "for each highlight candidate choose a playable 3-30 second interval inside one episode and cite transcript/OCR evidence within that interval", "prefer 3-12 distinct candidates when the supplied episodes contain qualifying moments; return [] only when no qualifying evidence exists", "cite evidence with timecode and confidence", "mark unobserved dialogue/actions/shots unverified"]}
    semantic = _semantic_request("detail-drama-analysis", payload)
    raw_candidates = next((semantic.get(name) for name in ("highlightCandidates", "precisionCandidates", "highlights") if isinstance(semantic.get(name), list)), None)
    if raw_candidates is None:
        repaired = _semantic_request("repair-detail-output-contract", {
            "resultToRepair": semantic,
            "instruction": "Preserve existing supported facts. Add all required top-level arrays including contentTags. Map an existing evidence-supported highlights array to highlightCandidates; otherwise use an empty highlightCandidates array. Do not invent candidates or tags.",
        })
        semantic = {**semantic, **repaired}
        raw_candidates = next((semantic.get(name) for name in ("highlightCandidates", "precisionCandidates", "highlights") if isinstance(semantic.get(name), list)), None)
    semantic = _validate_semantic_claims(semantic, durations)
    candidates = _precision_candidates(raw_candidates, durations)
    # PocketBase consumes highlightCandidates; precisionCandidates is a stable
    # semantic alias for downstream clients. Both reference the same validated list.
    semantic["highlightCandidates"] = candidates
    semantic["precisionCandidates"] = candidates
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "detail", "succeeded", {"episodes": [item.source["episode"] for item in episodes]}, {"semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, semantic)


def analyze_precision(path: Path, episode: int, start: float, end: float, coarse: AnalysisEnvelope, workspace: Path) -> AnalysisEnvelope:
    duration = _duration(path)
    if not 0 <= start < end <= duration:
        raise AnalysisFailed("Precision interval must be inside the source duration")
    if coarse.status != "succeeded" or coarse.tier != "coarse" or coarse.source.get("episode") != episode:
        raise AnalysisFailed("Precision analysis requires the matching succeeded coarse result")
    interval = float(os.getenv("LUMINA_PRECISION_FRAME_INTERVAL", "0.5"))
    frames = extract_frames(path, workspace / f"precision-{episode}-{start:.3f}-{end:.3f}", interval, start, end)
    transcript = [item for item in (coarse.result or {}).get("transcript", []) if item["end"] >= start and item["start"] <= end]
    multimodal_frames = [{"episode": episode, "timecode": frame["timecode"], "mimeType": "image/jpeg", "base64": base64.b64encode(Path(frame["path"]).read_bytes()).decode("ascii")} for frame in frames]
    payload = {"episode": episode, "interval": {"start": start, "end": end}, "frames": multimodal_frames, "transcript": transcript, "requirements": ["shot semantics", "audio-visual rhythm", "continuity", "explainable highlight scores", "every claim cites timecode/confidence", "unseen dialogue/actions/shots are unverified"]}
    semantic = _validate_semantic_claims(_semantic_request("precision-highlight-analysis", payload), duration)
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), "precision", "succeeded", {"path": str(path), "episode": episode, "durationSeconds": duration, "interval": {"start": start, "end": end}}, {"frames": "ffmpeg", "semantic": os.environ["LUMINA_SEMANTIC_MODEL"]}, semantic)


def failed_envelope(tier: Tier, source: dict[str, Any], exc: Exception) -> AnalysisEnvelope:
    return AnalysisEnvelope("1.0.0", str(uuid.uuid4()), tier, "failed", source, {}, error={"type": type(exc).__name__, "message": str(exc)})


def write_result(result: AnalysisEnvelope, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
