"""Lease PocketBase jobs and run the evidence-first three-tier analyzer."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageFilter, ImageStat

from processor.semantic_analysis import AnalysisEnvelope, analyze_coarse, analyze_detail, analyze_hook_entry_points, analyze_hook_story_match, analyze_material, analyze_precision, extract_frames
from processor.factory_render import render_factory_project


class ApiRequestError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class DownloadIntegrityError(RuntimeError):
    """A remote media transfer did not produce one complete local file."""


def classify_failure(exc: Exception) -> tuple[str, bool, int]:
    """Return error kind, retryability and exponential backoff seconds."""
    message = str(exc).lower()
    if isinstance(exc, DownloadIntegrityError):
        return "transient", True, 30
    # Winsock messages can be localized or mojibake, leaving only the numeric
    # code reliable. Match codes only with an explicit OS/socket prefix so an
    # unrelated media value cannot become retryable. These codes mean network
    # down/unreachable/reset, connection aborted/reset/timeout/refused.
    winsock_interruptions = (10050, 10051, 10052, 10053, 10054, 10060, 10061)
    if any(any(marker in message for marker in (
        f"[errno {code}]", f"[winerror {code}]", f"[wsaerror {code}]",
        f"socket error {code}", f"socket {code}",
    )) for code in winsock_interruptions):
        return "transient", True, 30
    # Some ffprobe process failures return no diagnostic text at all. That is
    # not evidence of permanent media corruption. The queue still caps retry
    # attempts, so this remains a failure unless a later probe succeeds.
    if message.strip() in {"ffprobe failed:", "ffprobe.exe failed:"}:
        return "transient", True, 30
    # Windows error 127 ("the specified procedure could not be found") can be
    # raised while loading native ASR/OCR dependencies.  Under concurrent
    # workers this is not evidence that the media itself is permanently bad;
    # allow the queue's finite retry policy to recover it.
    if "winerror 127" in message:
        return "transient", True, 60
    permanent_markers = ("non full-range yuv", "invalid argument", "missing required executable", "missing material", "validation_invalid_value")
    if any(marker in message for marker in permanent_markers):
        return "media" if "yuv" in message or "ffmpeg" in message else "validation", False, 0
    if any(marker in message for marker in ("timeout", "timed out", "connection", "temporarily", "429", "503", "ssl", "unexpected_eof", "eof occurred", "write operation", "read operation", "mkl_malloc", "failed to allocate memory", "out of memory")):
        return "transient", True, 30
    if any(marker in message for marker in ("provider", "dashscope", "arrearage", "quota")):
        return "provider", True, 120
    if any(marker in message for marker in ("输出契约可修复失败", "返回字段不完整", "缺少可验证的中文摘要", "missing_or_not_object", "basedonfactids")):
        return "validation", True, 120
    return "permanent", False, 0


def _detail_frame_payload(path: Path) -> str:
    """Bound visual tokens while retaining enough detail for scene/action evidence."""
    with Image.open(path) as image:
        image = image.convert("RGB")
        image.thumbnail((640, 640), Image.Resampling.LANCZOS)
        from io import BytesIO
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=82, optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("ascii")


def api_request(base_url: str, token: str, path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | None]:
    def json_safe(value: Any) -> Any:
        if isinstance(value, float) and not math.isfinite(value):
            return None
        if isinstance(value, dict):
            return {str(key): json_safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [json_safe(item) for item in value]
        return value

    # PocketBase/Go rejects non-finite JSON numbers during marshal and can
    # terminate the request path after a large analysis has already finished.
    body = json.dumps(json_safe(payload), allow_nan=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(f"{base_url.rstrip('/')}{path}", data=body, method=method, headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        if exc.code == 204:
            return 204, None
        raise ApiRequestError(exc.code, f"API {method} {path} failed ({exc.code}): {raw.decode('utf-8', errors='replace')[:500]}") from exc


def download(url: str, destination: Path) -> None:
    """Download one complete response before atomically publishing the file."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=f".{destination.name}.", suffix=".part", dir=destination.parent, delete=False) as output:
            temporary = Path(output.name)
            with urllib.request.urlopen(url, timeout=120) as response:
                raw_length = response.headers.get("Content-Length") if response.headers is not None else None
                expected = None
                if raw_length not in (None, ""):
                    try:
                        expected = int(raw_length)
                    except (TypeError, ValueError) as exc:
                        raise DownloadIntegrityError("remote media returned an invalid content length") from exc
                    if expected < 0:
                        raise DownloadIntegrityError("remote media returned an invalid content length")
                written = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    count = output.write(chunk)
                    if count != len(chunk):
                        raise DownloadIntegrityError("local media write was incomplete")
                    written += count
                    if expected is not None and written > expected:
                        raise DownloadIntegrityError("remote media exceeded its declared content length")
                if written == 0:
                    raise DownloadIntegrityError("remote media response was empty")
                if expected is not None and written != expected:
                    raise DownloadIntegrityError("remote media ended before its declared content length")
                output.flush()
                os.fsync(output.fileno())
        os.replace(temporary, destination)
        temporary = None
    except DownloadIntegrityError:
        raise
    except Exception as exc:
        # Provider exceptions may embed the signed URL. Expose only the error
        # type so queue reports and logs cannot persist credentials.
        raise DownloadIntegrityError(f"remote media download failed ({type(exc).__name__})") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def envelope_from_dict(value: dict[str, Any]) -> AnalysisEnvelope:
    return AnalysisEnvelope(
        schema_version=str(value.get("schema_version", value.get("schemaVersion", "1.0.0"))),
        analysis_id=str(value.get("analysis_id", value.get("analysisId", "legacy-envelope"))),
        tier=value.get("tier", "coarse"), status=value.get("status", "succeeded"),
        source=dict(value.get("source") or value.get("input") or {}),
        engine=dict(value.get("engine") or value.get("engines") or {}),
        result=value.get("result", value.get("analysis_result", value.get("analysisResult"))),
        error=value.get("error"), warnings=list(value.get("warnings") or []),
    )


def execute_semantic_job(job: dict[str, Any], base_url: str, workspace: Path, on_progress=None) -> dict[str, Any]:
    stage = str(job["stage"])
    if stage == "detail":
        raw_coarse = job.get("coarse_results") or job.get("coarseResults") or []
        if isinstance(raw_coarse, dict):
            raw_coarse = [raw_coarse]
        # Older queue payloads embedded episode rows directly and used
        # analysis_result instead of the three-tier envelope.
        if not raw_coarse and isinstance(job.get("episodes"), list):
            raw_coarse = []
            for item in job["episodes"]:
                if not isinstance(item, dict):
                    continue
                if any(key in item for key in ("schema_version", "schemaVersion", "result")):
                    raw_coarse.append(item)
                    continue
                result = item.get("analysis_result") or item.get("analysisResult") or item.get("result") or item
                episode = int(item.get("episode_number", item.get("episode", 0)) or 0)
                raw_coarse.append({"schema_version": "legacy-1.0", "analysis_id": f"legacy-{episode}", "tier": "coarse", "status": "succeeded", "source": {"episode": episode, "durationSeconds": item.get("duration_seconds", item.get("durationSeconds", (result or {}).get("durationSeconds", 0)))}, "engine": {"legacy": "true"}, "result": result})
        coarse = [envelope_from_dict(item) for item in raw_coarse if isinstance(item, dict)]
        visual_frames: list[dict[str, Any]] = []
        frame_interval = float(os.getenv("LUMINA_DETAIL_FRAME_INTERVAL", "3"))
        # 12 resized frames per short episode keep a four-episode request below
        # Qwen VL's multimodal input ceiling.  Precision analysis later samples
        # the shortlisted event interval densely, so detail recall need not send
        # every extracted source frame at full resolution.
        max_frames_per_episode = max(1, int(os.getenv("LUMINA_DETAIL_MAX_FRAMES_PER_EPISODE", "12")))
        episode_assets = job.get("episode_assets") or job.get("episodeAssets") or []
        asset_total = max(1, len(episode_assets))
        for asset_index, asset in enumerate(episode_assets):
            if not isinstance(asset, dict) or not asset.get("video") or not asset.get("id"):
                continue
            episode_number = int(asset.get("episode_number") or asset.get("episode") or 0)
            if episode_number <= 0:
                continue
            suffix = Path(str(asset["video"])).suffix or ".video"
            source = workspace / f"detail-episode-{episode_number}{suffix}"
            if on_progress:
                on_progress(8 + round(asset_index / asset_total * 24), f"下载并抽取第 {episode_number} 集画面证据")
            asset_url = f"{base_url.rstrip('/')}/api/files/{asset.get('collection_id')}/{asset['id']}/{urllib.parse.quote(str(asset['video']))}"
            download(asset_url, source)
            extracted = extract_frames(source, workspace / f"detail-frames-{episode_number}", frame_interval)
            if len(extracted) > max_frames_per_episode:
                step = len(extracted) / max_frames_per_episode
                extracted = [extracted[min(len(extracted) - 1, int(index * step))] for index in range(max_frames_per_episode)]
            visual_frames.extend({"episode": episode_number, "timecode": frame["timecode"], "mimeType": "image/jpeg", "base64": _detail_frame_payload(Path(frame["path"]))} for frame in extracted)
        if on_progress:
            on_progress(38, "融合对白、OCR 与画面证据")
        return analyze_detail(coarse, visual_frames, on_progress).to_dict()
    video_name = str(job.get("video") or "")
    if not video_name or not job.get("episode"):
        raise RuntimeError(f"{stage} job is missing its PocketBase episode video")
    suffix = Path(video_name).suffix or ".video"
    source = workspace / f"source{suffix}"
    asset_url = f"{base_url.rstrip('/')}/api/files/{job['collection_id']}/{job['episode']}/{urllib.parse.quote(video_name)}"
    if on_progress:
        on_progress(8, "下载剧集片源")
    download(asset_url, source)
    episode_number = int(job["episode_number"])
    if stage == "coarse":
        return analyze_coarse(source, episode_number, workspace).to_dict()
    if stage == "precision":
        parameters = dict(job.get("parameters") or {})
        interval = dict(parameters.get("interval") or {})
        if not interval:
            interval = {"start": parameters.get("start", parameters.get("start_seconds")), "end": parameters.get("end", parameters.get("end_seconds"))}
        if interval.get("start") is None or interval.get("end") is None:
            raise RuntimeError("精解析任务缺少片段起止时间，请重置该任务后重试")
        coarse_payload = dict(job.get("coarse_result") or job.get("coarseResult") or {})
        coarse = envelope_from_dict(coarse_payload)
        if on_progress:
            on_progress(28, "密集抽帧并验证事件区间")
        return analyze_precision(source, episode_number, float(interval["start"]), float(interval["end"]), coarse, workspace).to_dict()
    raise RuntimeError(f"Unsupported analysis stage: {stage}")


def execute_material_job(response: dict[str, Any], base_url: str, workspace: Path, on_progress=None) -> dict[str, Any]:
    job = dict(response.get("job") or {})
    material = dict(response.get("material") or {})
    if str(job.get("stage")) != "material":
        raise RuntimeError(f"Unsupported material analysis stage: {job.get('stage')}")
    material_id = str(material.get("id") or "")
    collection_id = str(material.get("collection_id") or "")
    video_name = str(material.get("video") or "")
    source_url = str(material.get("source_url") or "").strip()
    if not material_id or not collection_id or (not video_name and not source_url):
        raise RuntimeError("material job is missing material identity or a playable media source")
    parsed_source = urllib.parse.urlparse(source_url)
    if source_url and parsed_source.scheme not in {"http", "https"}:
        raise RuntimeError("material source_url must use http or https")
    source_name = video_name or Path(urllib.parse.unquote(parsed_source.path)).name
    suffix = Path(source_name).suffix or ".video"
    source = workspace / f"material-source{suffix}"
    asset_url = (f"{base_url.rstrip('/')}/api/files/{collection_id}/{material_id}/{urllib.parse.quote(video_name)}"
                 if video_name else source_url)
    if on_progress:
        on_progress(8, "下载素材")
    download(asset_url, source)
    # Generate a small, cacheable card poster once.  The feed must never open
    # hundreds of source-video range requests merely to paint first frames.
    poster = Path.cwd() / "public" / "material-covers" / f"{material_id}.webp"
    if not poster.exists():
        try:
            extracted = extract_frames(source, workspace / "poster-frame", max(1.0, _safe_video_duration(source)))
            if extracted:
                poster.parent.mkdir(parents=True, exist_ok=True)
                with Image.open(extracted[0]["path"]) as image:
                    image = image.convert("RGB")
                    image.thumbnail((480, 480), Image.Resampling.LANCZOS)
                    image.save(poster, format="WEBP", quality=78, method=4)
        except Exception as poster_exc:
            print(f"[material:{material_id}] poster generation skipped: {poster_exc}", file=sys.stderr, flush=True)
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    cache_root = Path(os.getenv("LUMINA_ANALYSIS_CACHE_DIR", str(Path.cwd() / "analysis_cache")))
    # Technical evidence is a pure function of the video bytes and engine
    # configuration. Key it by content hash so re-ingesting the same file does
    # not repeat ASR/OCR/frame extraction under a new PocketBase record id.
    cache_dir = cache_root / "materials" / "by-content-hash" / digest.hexdigest()
    parameters = dict(job.get("parameters") or {})
    if parameters.get("force_semantic_refresh") is True:
        # A manual story retry keeps deterministic media evidence but must not
        # reuse an earlier model interpretation after the story contract changes.
        semantic_cache = cache_dir / "semantic-segments-v6.json"
        if semantic_cache.exists():
            semantic_cache.unlink()
        if on_progress:
            on_progress(74, "保留抽帧/ASR/OCR，刷新剧情语义")
    try:
        result = analyze_material(source, workspace, on_progress=on_progress, cache_dir=cache_dir).to_dict()
    except Exception as exc:
        # A paid provider can become unavailable after useful, verified legacy
        # analysis has already been persisted. Preserve that evidence instead
        # of replacing it with a failed/empty card. The conservative v2
        # projection keeps unsupported dimensions empty and requires review.
        if "Arrearage" not in str(exc):
            raise
        record_url = f"{base_url.rstrip('/')}/api/collections/ad_materials/records/{urllib.parse.quote(material_id)}"
        with urllib.request.urlopen(record_url, timeout=30) as record_response:
            previous = json.loads(record_response.read())
        legacy = dict(previous.get("analysis_result") or {})
        if not isinstance(legacy.get("semantic"), dict):
            raise
        if on_progress:
            on_progress(96, "千问额度不可用，保留并升级已验证结果")
        result = _upgrade_legacy_material_result(legacy, material_id)
        upgraded_root = result.get("result") if isinstance(result.get("result"), dict) else {}
        upgraded_content = upgraded_root.get("content") if isinstance(upgraded_root.get("content"), dict) else {}
        upgraded_summary = upgraded_content.get("summary") if isinstance(upgraded_content.get("summary"), dict) else {}
        if not str(upgraded_summary.get("value") or "").strip() or not upgraded_summary.get("evidence"):
            raise exc
    result["material_id"] = material_id
    return result


def _safe_video_duration(path: Path) -> float:
    """Read duration for poster sampling without coupling to analyzer internals."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 3600.0
    import subprocess
    completed = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    try:
        return max(1.0, float(completed.stdout.strip()))
    except (TypeError, ValueError):
        return 3600.0


def execute_hook_match_job(response: dict[str, Any], on_progress=None) -> dict[str, Any]:
    job = dict(response.get("job") or {})
    if str(job.get("stage")) != "hook_match":
        raise RuntimeError(f"Unsupported hook matching stage: {job.get('stage')}")
    if on_progress:
        on_progress(25, "正在理解选中的正片故事线")
    result = analyze_hook_story_match({
        "hook": dict(response.get("hook") or {}), "drama": dict(response.get("drama") or {}),
        "episodes": list(response.get("episodes") or []), "topics": list(response.get("topics") or []),
        "episode_scope": list(response.get("episode_scope") or []),
        "match_context": dict(response.get("match_context") or {}),
        "target_duration_tier": response.get("target_duration_band") or response.get("target_duration_tier") or response.get("targetDurationTier") or job.get("target_duration_band") or job.get("target_duration_tier") or job.get("targetDurationTier"),
    }, on_progress=on_progress).to_dict()
    if on_progress:
        on_progress(92, "校验完整故事脉络与安全边界")
    return result


def _entry_frame_quality(path: Path) -> dict[str, Any]:
    with Image.open(path) as image:
        gray = image.convert("L").resize((320, 180))
        brightness = float(ImageStat.Stat(gray).mean[0])
        edge_variance = float(ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).var[0])
    flash = brightness >= 248.0
    black = brightness <= 3.0
    blurred = edge_variance < 8.0
    return {"brightness": round(brightness, 2), "edgeVariance": round(edge_variance, 2), "flash": flash, "black": black, "blurred": blurred, "passed": not flash and not black and not blurred}


def execute_entry_precision_job(response: dict[str, Any], base_url: str, workspace: Path, on_progress=None) -> dict[str, Any]:
    job = dict(response.get("job") or {})
    if str(job.get("stage")) != "entry_precision":
        raise RuntimeError(f"Unsupported entry precision stage: {job.get('stage')}")
    if on_progress:
        on_progress(35, "校验对白、动作、镜头与声音接点证据")
    match = dict(response.get("match") or {})
    match.setdefault("storyScore", match.get("story_score"))
    match.setdefault("productionGate", match.get("production_gate") or {})
    match.setdefault("businessScore", match.get("business_score") or {"dimensionScores": match.get("dimension_scores") or {}})
    analyzed = analyze_hook_entry_points({"matches": [match]})
    rows = analyzed.get("matches") if isinstance(analyzed.get("matches"), list) else []
    candidates = rows[0].get("candidates", []) if rows and isinstance(rows[0], dict) else []
    episodes = {int(item.get("episode_number") or 0): dict(item) for item in (response.get("episodes") or []) if isinstance(item, dict)}
    sources: dict[int, Path] = {}
    verified: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates[:3]):
        episode_number, point = int(candidate.get("episode") or 0), float(candidate.get("start") or 0)
        episode = episodes.get(episode_number, {})
        video_name, episode_id = str(episode.get("video") or ""), str(episode.get("id") or "")
        collection_id = str(episode.get("collectionId") or episode.get("collection_id") or "pbc_lumepisodes")
        if not video_name or not episode_id:
            continue
        source = sources.get(episode_number)
        if source is None:
            source = workspace / f"entry-{episode_number}{Path(video_name).suffix or '.video'}"
            download(f"{base_url.rstrip('/')}/api/files/{collection_id}/{episode_id}/{urllib.parse.quote(video_name)}", source)
            sources[episode_number] = source
        if on_progress:
            on_progress(45 + index * 15, f"密集抽取第 {episode_number} 集接点前后画面")
        start, end = max(0.0, point - 0.6), point + 0.6
        frames = extract_frames(source, workspace / f"entry-frames-{episode_number}-{index}", 0.2, start, end)
        if not frames:
            continue
        closest = min(frames, key=lambda frame: abs(float((frame.get("timecode") or {}).get("start") or 0) - point))
        quality = _entry_frame_quality(Path(closest["path"]))
        gate = dict(candidate.get("productionGate") or {})
        checks = dict(gate.get("checks") or {}); checks["visualFrame"] = quality["passed"]
        gate["checks"] = checks; gate["passed"] = bool(gate.get("passed")) and quality["passed"]
        if not gate["passed"]:
            continue
        verified.append({**candidate, "productionGate": gate, "frameEvidence": {"timecode": closest.get("timecode"), "quality": quality, "sampleCount": len(frames)}})
    return {"schemaVersion": "hook-entry-v2", "candidates": verified}


def execute_supplemental_highlight_job(response: dict[str, Any], base_url: str, workspace: Path, on_progress=None) -> dict[str, Any]:
    job, episode = dict(response.get("job") or {}), dict(response.get("episode") or {})
    if str(job.get("stage")) != "supplemental_highlight":
        raise RuntimeError(f"Unsupported supplemental highlight stage: {job.get('stage')}")
    episode_id = str(episode.get("id") or "")
    collection_id = str(episode.get("collectionId") or episode.get("collection_id") or "pbc_lumepisodes")
    video_name = str(episode.get("video") or "")
    episode_number = int(episode.get("episode_number") or 0)
    if not episode_id or not video_name or episode_number <= 0:
        raise RuntimeError("supplemental highlight job is missing episode media")
    source = workspace / f"supplemental-{episode_number}{Path(video_name).suffix or '.video'}"
    download(f"{base_url.rstrip('/')}/api/files/{collection_id}/{episode_id}/{urllib.parse.quote(video_name)}", source)
    if on_progress:
        on_progress(20, "补充分析剧集对白与高光候选")
    # Reuse the persisted episode-local candidates and coarse transcript first.
    # They were produced by
    # the full drama pass and retain cross-scene context; a one-episode retry can
    # legitimately return zero and must not erase those evidence-backed assets.
    persisted = episode.get("analysis_result") if isinstance(episode.get("analysis_result"), dict) else {}
    persisted_root = persisted.get("result") if isinstance(persisted.get("result"), dict) else persisted
    candidates = persisted_root.get("precisionCandidates") if isinstance(persisted_root.get("precisionCandidates"), list) else []
    if isinstance(persisted_root.get("transcript"), list) and persisted_root.get("transcript"):
        coarse = AnalysisEnvelope(
            str(persisted.get("schema_version") or "1.0.0"),
            str(persisted.get("analysis_id") or f"persisted-{episode_id}"),
            "coarse", "succeeded",
            dict(persisted.get("source") or {"episode": episode_number, "durationSeconds": episode.get("duration_seconds")}),
            dict(persisted.get("engine") or {}), persisted_root,
        )
    else:
        coarse = analyze_coarse(source, episode_number, workspace)
    if not candidates and not (isinstance(persisted_root.get("transcript"), list) and persisted_root.get("transcript")):
        detail = analyze_detail([coarse], on_progress=on_progress)
        root = detail.result or {}
        candidates = root.get("precisionCandidates") if isinstance(root.get("precisionCandidates"), list) else []
    highlights: list[dict[str, Any]] = []
    for candidate in candidates[:5]:
        if not isinstance(candidate, dict) or candidate.get("precisionEligible") is False:
            continue
        start, end = float(candidate.get("start") or 0), float(candidate.get("end") or 0)
        if end <= start:
            continue
        try:
            precision = analyze_precision(source, episode_number, start, end, coarse, workspace)
            precision_root = precision.result or {}
            hooks = precision_root.get("hookCandidates") if isinstance(precision_root.get("hookCandidates"), list) else []
            highlights.extend(item for item in hooks if isinstance(item, dict))
        except Exception:
            # A malformed provider candidate must not abort transcript-backed
            # recovery for the whole episode.
            continue
    if not highlights:
        # Fail-safe candidate recovery from measured ASR boundaries. This does
        # not invent a plot: it exposes complete, contiguous dialogue events so
        # the story matcher can reason from quoted source evidence. The later
        # production gate still rejects any unsupported semantic claim.
        transcript = persisted_root.get("transcript") if isinstance(persisted_root.get("transcript"), list) else (coarse.result or {}).get("transcript", [])
        usable = [row for row in transcript if isinstance(row, dict) and float(row.get("end") or 0) > float(row.get("start") or 0) and str(row.get("text") or "").strip()]
        for anchor in range(0, len(usable), 3):
            group = usable[anchor:anchor + 4]
            if not group:
                continue
            start, end = float(group[0]["start"]), float(group[-1]["end"])
            if end - start < 10:
                continue
            if end - start > 60:
                end = min(end, start + 60)
            quoted = " ".join(str(row.get("text") or "").strip() for row in group)
            evidence = [{"source": "transcript", "text": str(row.get("text") or ""), "timecode": {"start": float(row["start"]), "end": float(row["end"])}, "confidence": float(row.get("confidence") or 0), "verification": "verified"} for row in group]
            boundary_evidence = [{"source": "asr_sentence_boundary", "result": "complete measured dialogue interval"}]
            highlights.append({
                "timecode": {"start": round(start, 3), "end": round(end, 3)},
                "safeStart": {"status": "verified", "dialogueStatus": "complete", "actionStatus": "complete", "shotStatus": "reviewable", "evidence": boundary_evidence},
                "safeEnd": {"status": "verified", "dialogueStatus": "complete", "actionStatus": "complete", "shotStatus": "reviewable", "evidence": boundary_evidence},
                "qualityGate": {"productionReady": True, "evidenceOnly": True},
                "hookType": "对白事件高光", "narrativePromise": quoted[:500],
                "informationGap": "该连续对白之后的行动结果是什么？",
                "themes": [], "contentTags": ["对白冲突", "事件推进"],
                "conflict": "以原片对白为准", "emotion": "由对白强度复核",
                "evidence": evidence,
            })
            if len(highlights) >= 2:
                break
    return {"schemaVersion": "supplemental-highlight-v1", "episode": episode_number, "highlights": highlights[:8]}


def execute_factory_render_job(response: dict[str, Any], base_url: str, workspace: Path, on_progress=None) -> dict[str, Any]:
    output_root = Path(os.getenv("LUMINA_FACTORY_RENDER_DIR", str(Path.cwd() / "public" / "renders")))
    return render_factory_project(response, base_url, workspace, output_root, on_progress)


def _upgrade_legacy_material_result(legacy: dict[str, Any], material_id: str) -> dict[str, Any]:
    semantic = dict(legacy.get("semantic") or {})

    def claim(field: str, code: str) -> dict[str, Any] | None:
        source = semantic.get(field)
        if not isinstance(source, dict) or source.get("value") in (None, "", []):
            return None
        evidence = []
        for item in source.get("evidence") or []:
            if isinstance(item, dict):
                evidence.append({key: value for key, value in item.items() if key != "episode"})
        value = source.get("value")
        label = "；".join(str(item) for item in value) if isinstance(value, list) else str(value)
        return {
            "code": code,
            "label": label,
            "confidence": float(source.get("confidence") or 0),
            "evidence": evidence,
            "verification": source.get("verification") if source.get("verification") in ("verified", "unverified") else "unverified",
        }

    summary_source = semantic.get("summary") if isinstance(semantic.get("summary"), dict) else {}
    summary = {
        "value": str(summary_source.get("value") or ""),
        "confidence": float(summary_source.get("confidence") or 0),
        "evidence": [{key: value for key, value in item.items() if key != "episode"} for item in (summary_source.get("evidence") or []) if isinstance(item, dict)],
    }
    timeline = []
    for index, item in enumerate(semantic.get("structure") or []):
        if not isinstance(item, dict):
            continue
        timeline.append({
            "code": f"LEGACY_STRUCTURE_{index + 1}", "label": str(item.get("label") or "结构节点"),
            "start": float(item.get("start") or 0), "end": float(item.get("end") or item.get("start") or 0),
            "confidence": float(item.get("confidence") or 0),
            "evidence": [{key: value for key, value in evidence.items() if key != "episode"} for evidence in (item.get("evidence") or []) if isinstance(evidence, dict)],
            "verification": item.get("verification") if item.get("verification") in ("verified", "unverified") else "unverified",
        })
    # A legacy hookType is a categorical label, not a localized reusable
    # interval. Never promote its scattered evidence span into a hook asset.
    hook = None
    material_format = claim("materialType", "LEGACY_FORMAT")
    tier = claim("tier", str((semantic.get("tier") or {}).get("value") or "TX"))
    transition = claim("transition", "LEGACY_TRANSITION")
    inspiration = claim("prototype", "LEGACY_INSPIRATION")
    duration = float(legacy.get("durationSeconds") or 0)
    content = {"summary": summary, "tags": [], "characters": [], "relationships": [], "segments": timeline, "completeness": {"code": "PARTIAL_LEGACY", "label": "历史分析证据可用，新增维度待复核", "confidence": 1, "evidence": [], "verification": "verified"}}
    creative = {"format": material_format or {}, "tier": tier or {}, "hooks": [hook] if hook else [], "timeline": timeline, "transitions": [transition] if transition else [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}}
    value = {"scores": {}, "inspirations": [inspiration] if inspiration else [], "risks": [], "suitableGenres": [], "suitableAudiences": []}
    review = {"status": "needs_review", "reasons": ["千问账户额度不可用；已保留此前模型生成且带时间码证据的结论，未覆盖的 material-v2 维度保持为空。"], "items": [{"id": "provider-arrearage", "field": "semantic.full_merge", "label": "全片汇总待补跑", "reason": "DashScope 返回 Arrearage", "confidence": 1}, {"id": "legacy-hook-not-localized", "field": "creative.hooks", "label": "历史钩子未定位", "reason": "旧版结果只有类型标签，没有经过对白、动作和镜头边界校验的独立区间。", "confidence": 1}]}
    result = {"schemaVersion": "material-v2", "evidence": {"transcript": legacy.get("transcript") or [], "ocr": legacy.get("ocr") or [], "keyframes": [{key: value for key, value in frame.items() if key != "path"} for frame in (legacy.get("keyframes") or []) if isinstance(frame, dict)], "shots": [], "audioEvents": []}, "content": content, "creative": creative, "value": value, "review": review, "sourceAttribution": {"status": "not_required", "matches": []}, "semanticSegments": [], "semantic": {"content": content, "creative": creative, "value": value, "review": review}, "materialFields": {"analysis": "分析完成（待复核）", "analysisStatus": "succeeded", "materialType": material_format.get("label", "未确定") if material_format else "未确定", "tier": tier.get("label", "TX") if tier else "TX", "hookType": hook.get("label", "未确定") if hook else "未确定", "transition": transition.get("label", "未确定") if transition else "未确定", "prototype": inspiration.get("label", "未确定") if inspiration else "未确定", "summary": summary["value"], "highlights": timeline, "structure": timeline, "review": "待人工复核", "confidence": round(100 * max([summary["confidence"], *(item["confidence"] for item in timeline)], default=0))}, "durationSeconds": duration}
    return {"schema_version": "material-v2", "analysis_id": f"legacy-upgrade-{material_id}", "tier": "coarse", "status": "succeeded", "source": {"kind": "external_paid_ad_material", "durationSeconds": duration}, "engines": {"semantic": "verified-legacy-result", "upgrade": "local-material-v2"}, "result": result}


def process_one_endpoint(base_url: str, token: str, worker_id: str, api_prefix: str, kind: str, optional: bool = False, job_id: str | None = None) -> bool:
    try:
        # Long-form material synthesis/repair calls can legitimately take more
        # than ten minutes. Keep the lease at the server-supported maximum so a
        # completed result is not rejected while the worker is inside one model
        # request and cannot emit an intermediate progress heartbeat.
        # Interactive matching calls are individually capped at 180 seconds.
        # A four-minute lease covers one provider call while allowing a new
        # worker to recover promptly after a local service restart. Long-form
        # material analysis keeps the full 30-minute lease.
        lease_seconds = 240 if kind in {"hook_match", "entry_precision", "supplemental_highlight"} else 1800
        claim_body = {"worker_id": worker_id, "lease_seconds": lease_seconds}
        if job_id:
            claim_body["job_id"] = job_id
        status, response = api_request(base_url, token, f"{api_prefix}/claim", "POST", claim_body)
    except ApiRequestError as exc:
        # Rolling deployments may start the worker before the material hook and
        # migration are present. Keep serving drama jobs instead of exiting.
        if optional and exc.status in (400, 404):
            return False
        raise
    if status == 204 or not response:
        return False
    job = response["job"]
    job_id = job["id"]
    raw_parameters = job.get("parameters")
    claimed_parameters = dict(raw_parameters) if isinstance(raw_parameters, dict) else {}
    print(f"[{kind}:{job_id}] claimed stage={job.get('stage')} attempt={job.get('attempt')}", file=sys.stderr, flush=True)
    heartbeat_stop = threading.Event()
    progress_state: dict[str, Any] = {"value": 5, "stage": "领取任务"}

    def material_stage(progress: int, label: str) -> str:
        """Map worker progress onto the persisted material-v2 stages."""
        lowered = label.lower()
        if any(word in lowered for word in ("download", "下载", "准备")):
            return "download"
        if any(word in lowered for word in ("asr", "ocr", "transcript", "转写", "字幕", "证据")):
            return "evidence"
        if any(word in lowered for word in ("global", "summary", "汇总")):
            return "creative"
        if any(word in lowered for word in ("segment", "semantic", "qwen", "语义", "理解")):
            return "content"
        if any(word in lowered for word in ("validate", "repair", "review", "校验", "修复", "复核")):
            return "review"
        if any(word in lowered for word in ("scan", "frame", "shot", "audio", "ffmpeg", "抽帧", "镜头", "音频")):
            return "scan"
        if progress < 12:
            return "download"
        if progress < 38:
            return "scan"
        if progress < 74:
            return "evidence"
        if progress < 88:
            return "content"
        if progress < 94:
            return "creative"
        if progress < 97:
            return "value"
        return "review"

    def report_progress(progress: int, stage: str) -> None:
        progress_state["value"] = max(progress_state["value"], min(99, int(progress)))
        progress_state["stage"] = stage
        payload = {
            "worker_id": worker_id, "lease_token": job["lease_token"], "status": "rendering" if kind == "factory_render" else "running",
            "progress": progress_state["value"], "lease_seconds": lease_seconds,
            "logs": {**claimed_parameters, "stage": stage, "kind": kind},
        }
        if kind == "hook_match":
            value = progress_state["value"]
            payload["current_stage"] = "准备匹配" if value < 20 else "理解选中故事线" if value < 45 else "评估钩子承接关系" if value < 85 else "校验时间戳与证据"
        elif kind in ("material", "entry_precision", "supplemental_highlight", "factory_render"):
            payload["current_stage"] = material_stage(progress_state["value"], stage)
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", payload)

    def heartbeat() -> None:
        while not heartbeat_stop.wait(120):
            try:
                report_progress(progress_state["value"], progress_state["stage"])
            except Exception:
                # The final PATCH remains authoritative; a transient heartbeat
                # failure must not discard completed local analysis work.
                pass

    heartbeat_thread = threading.Thread(target=heartbeat, name=f"lease-{job_id}", daemon=True)
    heartbeat_thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="lumina-analysis-") as tmp:
            report_progress(5, "准备处理")
            print(f"[{kind}:{job_id}] executing", file=sys.stderr, flush=True)
            if kind == "material":
                result = execute_material_job(response, base_url, Path(tmp), report_progress)
            elif kind == "hook_match":
                result = execute_hook_match_job(response, report_progress)
            elif kind == "entry_precision":
                result = execute_entry_precision_job(response, base_url, Path(tmp), report_progress)
            elif kind == "supplemental_highlight":
                result = execute_supplemental_highlight_job(response, base_url, Path(tmp), report_progress)
            elif kind == "factory_render":
                result = execute_factory_render_job(response, base_url, Path(tmp), report_progress)
            else:
                result = execute_semantic_job(job, base_url, Path(tmp), report_progress)
        if kind == "drama" and job.get("stage") == "precision" and claimed_parameters.get("generation"):
            result["asset_generation"] = claimed_parameters["generation"]
        final_payload = {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "succeeded", "result": result, "logs": {**claimed_parameters, "processor": "processor.semantic_analysis", "analysisVersion": result.get("schema_version", kind), "stage": job["stage"], "kind": kind}}
        if kind == "factory_render":
            final_payload.update(result)
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", final_payload)
    except Exception as exc:
        error_kind, retryable, base_delay = classify_failure(exc)
        attempt = max(1, int(job.get("attempt") or 1))
        retry_after = min(1800, base_delay * (2 ** (attempt - 1))) if retryable else 0
        try:
            api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "failed", "error": str(exc)[:2000], "error_kind": error_kind, "retryable": retryable, "retry_after_seconds": retry_after})
        except Exception as patch_exc:
            print(f"[{kind}:{job_id}] task failed: {exc}; status update failed: {patch_exc}", file=sys.stderr, flush=True)
        else:
            print(f"[{kind}:{job_id}] task failed: {exc}", file=sys.stderr, flush=True)
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)
    return True


def process_available(base_url: str, token: str, worker_id: str, queue: str = "both", job_id: str | None = None) -> bool:
    """Process only the configured queue so long jobs cannot starve each other."""
    if queue == "drama":
        return process_one_endpoint(base_url, token, worker_id, "/api/lumina/analysis", "drama", job_id=job_id)
    if queue == "material-batch":
        return process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True, job_id=job_id)
    if queue == "material":
        # Interactive production jobs must not wait behind an arbitrary backlog
        # of ingestion analysis. Serve only the user's active chain by default;
        # batch ingestion has its own material-batch workers and may be paused
        # independently. An explicit opt-in retains the old idle fallback.
        # An explicit id can belong to any interactive material-side queue.
        # Probe every queue in priority order; each claim endpoint returns 204
        # when the id is not present there. Previously --job-id skipped all
        # interactive queues and only queried ordinary material analysis, so a
        # stuck hook-match or render job could not be recovered deterministically.
        hook_match = process_one_endpoint(base_url, token, worker_id, "/api/lumina/hook-matching", "hook_match", optional=True, job_id=job_id)
        entry_precision = not hook_match and process_one_endpoint(base_url, token, worker_id, "/api/lumina/entry-precision", "entry_precision", optional=True, job_id=job_id)
        factory_render = not hook_match and not entry_precision and process_one_endpoint(base_url, token, worker_id, "/api/lumina/factory-render", "factory_render", optional=True, job_id=job_id)
        supplemental = not hook_match and not entry_precision and not factory_render and process_one_endpoint(base_url, token, worker_id, "/api/lumina/supplemental-highlights", "supplemental_highlight", optional=True, job_id=job_id)
        fallback_enabled = os.environ.get("LUMINA_INTERACTIVE_MATERIAL_FALLBACK", "").strip() == "1"
        material = fallback_enabled and not hook_match and not entry_precision and not factory_render and not supplemental and process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True, job_id=job_id)
        return material or supplemental or hook_match or entry_precision or factory_render
    if job_id:
        raise ValueError("--job-id requires --queue drama or --queue material")
    drama = process_one_endpoint(base_url, token, worker_id, "/api/lumina/analysis", "drama")
    material = process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True)
    supplemental = process_one_endpoint(base_url, token, worker_id, "/api/lumina/supplemental-highlights", "supplemental_highlight", optional=True)
    hook_match = process_one_endpoint(base_url, token, worker_id, "/api/lumina/hook-matching", "hook_match", optional=True)
    entry_precision = process_one_endpoint(base_url, token, worker_id, "/api/lumina/entry-precision", "entry_precision", optional=True)
    factory_render = process_one_endpoint(base_url, token, worker_id, "/api/lumina/factory-render", "factory_render", optional=True)
    return drama or material or supplemental or hook_match or entry_precision or factory_render


def main() -> None:
    parser = argparse.ArgumentParser(description="Lumina PocketBase three-tier semantic-analysis worker")
    parser.add_argument("--base-url", default=os.environ.get("NEXT_PUBLIC_POCKETBASE_URL", "http://127.0.0.1:8090"))
    parser.add_argument("--token", default=os.environ.get("LUMINA_WORKER_TOKEN"))
    parser.add_argument("--worker-id", default=f"media-worker-{os.getpid()}")
    parser.add_argument("--queue", choices=("drama", "material", "material-batch", "both"), default=os.environ.get("LUMINA_WORKER_QUEUE", "both"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--job-id", help="Claim one exact job; requires --queue drama or material")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("Set LUMINA_WORKER_TOKEN or pass --token")
    while True:
        try:
            processed = process_available(args.base_url, args.token, args.worker_id, args.queue, args.job_id)
        except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
            # PocketBase restarts automatically when hooks change. Keep the
            # worker alive so queued analysis resumes without manual relaunch.
            print(f"[worker:{args.worker_id}] backend unavailable; retrying: {exc}", file=sys.stderr, flush=True)
            if args.once or args.job_id:
                raise
            time.sleep(max(1.0, args.poll_seconds))
            continue
        if args.once:
            return
        if not processed:
            time.sleep(max(0.5, args.poll_seconds))


if __name__ == "__main__":
    main()
