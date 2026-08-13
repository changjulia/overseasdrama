"""Evidence-first three-tier video analysis.

No method in this module fabricates content. Optional engines are imported lazily;
missing executables, models or credentials raise ``AnalysisFailed``. Semantic
claims from cloud models are accepted only when they cite measured time ranges.
"""

from __future__ import annotations

import json
import os
import base64
import shutil
import subprocess
import urllib.request
import uuid
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


def _require(*names: str) -> None:
    missing = [name for name in names if not shutil.which(name)]
    if missing:
        raise AnalysisFailed(f"Missing required executables: {', '.join(missing)}")


def _duration(path: Path) -> float:
    _require("ffprobe")
    output = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)]).stdout.strip()
    try:
        value = float(output)
    except ValueError as exc:
        raise AnalysisFailed("FFprobe returned no valid duration") from exc
    if value <= 0:
        raise AnalysisFailed("Media duration must be positive")
    return value


def extract_frames(path: Path, destination: Path, interval_seconds: float, start: float = 0, end: float | None = None) -> list[dict[str, Any]]:
    """Extract measured JPEG frames and retain exact requested timecodes."""
    _require("ffmpeg")
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
        _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(timestamp), "-i", str(path), "-frames:v", "1", "-q:v", "3", "-y", str(target)])
        if target.exists() and target.stat().st_size:
            frames.append({"path": str(target), "timecode": {"start": timestamp, "end": timestamp}, "confidence": 1.0, "source": path.name, "verification": "verified"})
    if not frames:
        raise AnalysisFailed("FFmpeg extracted no frames")
    return frames


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
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
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


def _openai_request_body(provider: str, model: str, task: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Build either Responses API or Chat Completions compatible JSON."""
    clean_payload = dict(payload)
    frames = clean_payload.pop("frames", [])
    rules = [
        "Return one JSON object only",
        "Every semantic claim must cite evidence with episode, source, valid timecode and confidence",
        "Never invent unseen dialogue, actions, characters, or shots",
        "All user-visible narrative fields must be written in natural Simplified Chinese, including summaries, descriptions, roles, relationships, plot events, emotions, shot semantics, rhythm, continuity, scoring reasons and recommendations",
        "Transliterate character names into commonly used Simplified Chinese and preserve the source spelling in originalName",
        "For every evidence item, put a faithful Simplified Chinese translation in text and preserve the verbatim source quote in sourceText; never translate timestamps, IDs or enum keys",
        "Do not output English prose in user-visible fields; English is allowed only in originalName, sourceText, filenames, model identifiers and machine enum keys",
    ]
    output_contract: dict[str, Any] | None = None
    if task in ("detail-drama-analysis", "repair-detail-output-contract"):
        rules.extend([
            "The top-level JSON object must always contain characters, relationships, episodePlots, emotionCurve, and highlightCandidates arrays",
            "highlightCandidates must be [] when no evidence-supported candidate exists; never omit the field",
            "Each highlight candidate must contain episode, start, end, confidence, and evidence",
        ])
        output_contract = {
            "characters": [],
            "relationships": [],
            "episodePlots": [],
            "emotionCurve": [],
            "highlightCandidates": [{
                "episode": "integer",
                "start": "seconds number",
                "end": "seconds number",
                "confidence": "0..1 number",
                "evidence": [{"episode": "integer", "source": "transcript|ocr|frame", "timecode": {"start": "seconds", "end": "seconds"}, "confidence": "0..1 number", "text": "optional string"}],
            }],
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
                content.append({"type": "input_text", "text": f"Evidence frame: {json.dumps({'episode': frame.get('episode'), 'timecode': frame.get('timecode', {})})}"})
                content.append({"type": "input_image", "image_url": f"data:{frame.get('mimeType', 'image/jpeg')};base64,{encoded}", "detail": "low"})
        return {"model": model, "input": [{"role": "user", "content": content}], "text": {"format": {"type": "json_object"}}}
    if provider == "openai-chat-completions":
        content = [{"type": "text", "text": prompt}]
        for frame in frames:
            encoded = frame.get("base64") if isinstance(frame, dict) else None
            if encoded:
                content.append({"type": "text", "text": f"Evidence frame: {json.dumps({'episode': frame.get('episode'), 'timecode': frame.get('timecode', {})})}"})
                content.append({"type": "image_url", "image_url": {"url": f"data:{frame.get('mimeType', 'image/jpeg')};base64,{encoded}", "detail": "low"}})
        return {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "stream": True,
            "stream_options": {"include_usage": True},
        }
    raise AnalysisFailed(f"Unsupported OpenAI-compatible provider: {provider}")


def _extract_provider_result(provider: str, response: dict[str, Any]) -> dict[str, Any]:
    if provider == "openai-responses":
        texts = [part.get("text", "") for item in response.get("output", []) if isinstance(item, dict) for part in item.get("content", []) if isinstance(part, dict) and part.get("type") == "output_text"]
        raw = "".join(texts)
    elif provider == "openai-chat-completions":
        choices = response.get("choices", [])
        raw = choices[0].get("message", {}).get("content", "") if choices and isinstance(choices[0], dict) else ""
    else:
        return response
    try:
        result = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise AnalysisFailed("OpenAI-compatible API returned no valid JSON object") from exc
    if not isinstance(result, dict):
        raise AnalysisFailed("OpenAI-compatible API returned a non-object JSON value")
    return result


def _extract_chat_stream(response: Any) -> dict[str, Any]:
    """Consume OpenAI-compatible Chat Completions SSE and parse its JSON text."""
    text_parts: list[str] = []
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
    raw = "".join(text_parts)
    try:
        result = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise AnalysisFailed("OpenAI-compatible streaming API returned no valid JSON object") from exc
    if not isinstance(result, dict):
        raise AnalysisFailed("OpenAI-compatible streaming API returned a non-object JSON value")
    return result


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
    if "confidence" in transformed:
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


def analyze_material(path: Path, workspace: Path, on_progress: Callable[[int, str], None] | None = None) -> AnalysisEnvelope:
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
    report(22, "抽取关键帧")
    frames = extract_frames(path, workspace / "material-frames", float(os.getenv("LUMINA_MATERIAL_FRAME_INTERVAL", "5")))
    max_frames = max(1, int(os.getenv("LUMINA_MATERIAL_MAX_SEMANTIC_FRAMES", "24")))
    stride = max(1, (len(frames) + max_frames - 1) // max_frames)
    selected = frames[::stride][:max_frames]
    report(35, "语音转写")
    transcript, asr_engine = transcribe(path)
    report(62, "字幕识别")
    ocr, ocr_engine = read_ocr(selected)
    report(78, "千问多模态分析")
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
    semantic = _validate_semantic_claims(_semantic_request("paid-ad-material-analysis", payload), duration)
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


def analyze_detail(episodes: list[AnalysisEnvelope]) -> AnalysisEnvelope:
    if not episodes or any(item.tier != "coarse" or item.status != "succeeded" or not item.result for item in episodes):
        raise AnalysisFailed("Detail analysis requires succeeded coarse results for every episode")
    durations = {int(item.source["episode"]): float(item.source["durationSeconds"]) for item in episodes}
    payload = {"episodes": [{"episode": item.result["episode"], "durationSeconds": item.result["durationSeconds"], "transcript": item.result["transcript"], "ocr": item.result["ocr"]} for item in episodes], "requirements": ["complete dialogue with speaker aliases", "cross-episode character relationships", "episode plot", "emotion curve", "cite evidence with timecode and confidence", "mark unobserved dialogue/actions/shots unverified"]}
    semantic = _semantic_request("detail-drama-analysis", payload)
    raw_candidates = next((semantic.get(name) for name in ("highlightCandidates", "precisionCandidates", "highlights") if isinstance(semantic.get(name), list)), None)
    if raw_candidates is None:
        repaired = _semantic_request("repair-detail-output-contract", {
            "resultToRepair": semantic,
            "instruction": "Preserve existing supported facts. Add all required top-level arrays. Map an existing evidence-supported highlights array to highlightCandidates; otherwise use an empty highlightCandidates array. Do not invent candidates.",
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
