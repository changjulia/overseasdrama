from __future__ import annotations

import hashlib
import json
import re
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from processor.semantic_analysis import AnalysisFailed, _executable


def _download(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=180) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def _duration(path: Path) -> float:
    result = subprocess.run([_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AnalysisFailed(f"ffprobe failed: {result.stderr[-800:]}")
    return float(result.stdout.strip())


def _boundary_state(
    safe_start: Any,
    safe_end: Any,
    declared_status: Any = None,
) -> str:
    """Return the boundary state actually supported by the persisted evidence.

    A source-file edge or a caller supplied ``boundary_status=verified`` is not
    enough on its own: both effective cut points must carry verified evidence.
    This keeps the ledger useful for review without turning it into a render
    gate.
    """

    def status(value: Any) -> str:
        if not isinstance(value, dict):
            return "unverified"
        return str(value.get("status") or value.get("verification") or "unverified").strip().lower()

    start_status, end_status = status(safe_start), status(safe_end)
    declared = str(declared_status or "").strip().lower()
    if start_status == "verified" and end_status == "verified" and declared not in {
        "unsafe",
        "rejected",
        "invalid",
        "unverified",
    }:
        return "verified"
    if "unsafe" in {start_status, end_status, declared} or "rejected" in {
        start_status,
        end_status,
        declared,
    } or "invalid" in {start_status, end_status, declared}:
        return "unsafe"
    if "needs_review" in {start_status, end_status, declared} or "pending" in {
        start_status,
        end_status,
        declared,
    }:
        return "needs_review"
    return "unverified"


def _transition_settings(
    transition: dict[str, Any],
    render: dict[str, Any],
) -> dict[str, Any]:
    nested_config = transition.get("renderConfig") if isinstance(transition.get("renderConfig"), dict) else {}
    render_config = render.get("render_config") if isinstance(render.get("render_config"), dict) else {}
    if not render_config and isinstance(render.get("renderConfig"), dict):
        render_config = render.get("renderConfig") or {}
    transition_id = str(transition.get("id") or "fade-cut").strip() or "fade-cut"
    effect = str(nested_config.get("effect") or render_config.get("effect") or "").strip()

    def normalized(value: str) -> str:
        return re.sub(r"[-_\s]+", "-", value.lower()).strip("-")

    normalized_id, normalized_effect = normalized(transition_id), normalized(effect)
    hard_cut = any(
        value == "hardcut" or value == "hard-cut" or value.startswith("hard-cut-")
        for value in (normalized_id, normalized_effect)
        if value
    )
    fade_seconds = 0.0 if hard_cut else min(
        0.5,
        max(0.05, float(transition.get("durationSeconds") or nested_config.get("durationSeconds") or 0.25)),
    )
    return {
        "id": transition_id,
        "effect": effect or ("hard_cut" if hard_cut else "fade"),
        "hardCut": hard_cut,
        "fadeSeconds": fade_seconds,
    }


def _unsupported_features(
    project: dict[str, Any],
    transition: dict[str, Any],
    render: dict[str, Any],
) -> list[str]:
    """List requested presentation features the ffmpeg path does not render."""

    nested_config = transition.get("renderConfig") if isinstance(transition.get("renderConfig"), dict) else {}
    render_config = render.get("render_config") if isinstance(render.get("render_config"), dict) else {}
    if not render_config and isinstance(render.get("renderConfig"), dict):
        render_config = render.get("renderConfig") or {}
    configs = (project, transition, nested_config, render_config)
    unsupported: list[str] = []
    if any(str(transition.get(key) or "").strip() for key in ("copy", "script")):
        unsupported.append("transition.copy")
    if any(
        config.get(key) is True
        for config in configs
        for key in ("subtitleEnabled", "subtitlesEnabled", "burnSubtitles")
    ):
        unsupported.append("subtitles")
    if any(
        config.get(key) is True
        for config in configs
        for key in ("voiceoverEnabled", "voiceOverEnabled", "narrationEnabled")
    ) or any(
        str(config.get(key) or "").strip()
        for config in configs
        for key in ("voiceover", "voiceOver")
    ):
        unsupported.append("voiceover")
    return list(dict.fromkeys(unsupported))


def _output_filename(title: Any, version: int, render_id: Any) -> str:
    render_id_text = str(render_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,80}", render_id_text):
        raise AnalysisFailed("factory render id is required for a unique output filename")
    safe_title = re.sub(r"[\\/:*?\"<>|]+", "-", str(title or "external-hook-production")).strip(" .") or "external-hook-production"
    # Keep both the filename component and full Windows path comfortably below
    # their practical limits; render_id still provides collision resistance.
    safe_title = safe_title[:96].rstrip(" .-") or "external-hook-production"
    return f"{safe_title}-v{version:02d}-{render_id_text}.mp4"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _leading_blank_metrics(path: Path, window: float = 15.0) -> dict[str, float]:
    """Measure a leading interval that is both black and silent."""
    command = [
        _executable("ffmpeg"), "-hide_banner", "-loglevel", "info", "-t", f"{window:.3f}",
        "-i", str(path), "-vf", "blackdetect=d=0.2:pix_th=0.10",
        "-af", "silencedetect=n=-45dB:d=0.2", "-f", "null", "-",
    ]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    diagnostics = f"{result.stdout}\n{result.stderr}"

    def leading_duration(kind: str) -> float:
        match = re.search(
            rf"{kind}_start:\s*(-?[0-9.]+).*?{kind}_end:\s*([0-9.]+)",
            diagnostics,
            re.DOTALL,
        )
        if not match or abs(float(match.group(1))) > 0.1:
            return 0.0
        return max(0.0, float(match.group(2)))

    black = leading_duration("black")
    silence = leading_duration("silence")
    return {
        "leadingBlackSeconds": round(black, 3),
        "leadingSilenceSeconds": round(silence, 3),
        "leadingBlankSeconds": round(min(black, silence), 3),
    }


def _validate_sequential_duration(duration: float, sequential: bool) -> None:
    if sequential and not 300 <= duration <= 900:
        raise AnalysisFailed(
            f"sequential output must be 5-15 minutes after tail removal (actual {duration:.2f}s)"
        )


def build_render_quality_report(
    *,
    output: Path,
    technical: dict[str, Any],
    expected_duration: float,
    width: int,
    height: int,
    ledger: list[dict[str, Any]],
    render_id: str = "",
    unsupported_features: list[str] | None = None,
    leading_blank: dict[str, float] | None = None,
) -> dict[str, Any]:
    streams = technical.get("streams") or []
    format_data = technical.get("format") or {}
    actual_duration = float(format_data.get("duration") or 0)
    duration_error = abs(actual_duration - expected_duration)
    hard_checks = [
        {"code": "UNIQUE_OUTPUT_PATH", "label": "成片文件绑定唯一渲染任务", "passed": bool(render_id) and output.name.endswith(f"-{render_id}.mp4")},
        {"code": "OUTPUT_PRESENT", "label": "成片文件存在", "passed": output.is_file() and output.stat().st_size > 0},
        {"code": "PLAYABLE", "label": "成片可解析播放", "passed": actual_duration > 0 and any(item.get("codec_type") == "video" for item in streams)},
        {"code": "VIDEO_CODEC", "label": "H.264 视频编码", "passed": any(item.get("codec_type") == "video" and item.get("codec_name") == "h264" for item in streams)},
        {"code": "AUDIO_CODEC", "label": "AAC 音轨", "passed": any(item.get("codec_type") == "audio" and item.get("codec_name") == "aac" for item in streams)},
        {"code": "RESOLUTION", "label": "输出分辨率正确", "passed": any(item.get("codec_type") == "video" and item.get("width") == width and item.get("height") == height for item in streams), "metrics": {"expectedWidth": width, "expectedHeight": height}},
        {"code": "DURATION_CONSISTENCY", "label": "时间线与成片时长一致", "passed": duration_error <= max(0.5, expected_duration * 0.005), "metrics": {"expectedSeconds": round(expected_duration, 3), "actualSeconds": round(actual_duration, 3), "errorSeconds": round(duration_error, 3)}},
        {"code": "FLASH_TAIL_REMOVED", "label": "剧集闪光结尾已避让", "passed": all(item.get("kind") != "episode" or item.get("flashTailStart") is None or float(item.get("end") or 0) < float(item.get("flashTailStart") or 0) for item in ledger)},
        {"code": "LEADING_CONTENT", "label": "成片开头不是黑场静音占位", "passed": not leading_blank or float(leading_blank.get("leadingBlankSeconds") or 0) < 1.0, "metrics": leading_blank or {}},
    ]
    boundary_counts: dict[str, int] = {}
    for item in ledger:
        state = str(item.get("status") or "unverified")
        boundary_counts[state] = boundary_counts.get(state, 0) + 1
    advisories = [
        {
            "code": "BOUNDARY_STATUS",
            "label": "剪辑边界证据状态",
            "passed": bool(ledger) and boundary_counts.get("verified", 0) == len(ledger),
            "severity": "advisory",
            "metrics": {"total": len(ledger), "states": boundary_counts},
        },
    ]
    unsupported = list(dict.fromkeys(unsupported_features or []))
    if unsupported:
        advisories.append(
            {
                "code": "UNSUPPORTED_FEATURES",
                "label": "请求的包装功能尚未写入成片",
                "passed": False,
                "severity": "advisory",
                "unsupportedFeatures": unsupported,
            },
        )
    failures = [item for item in hard_checks if not item["passed"]]
    return {
        "schemaVersion": "factory-render-qc-v2",
        "technicalPassed": not failures,
        "passed": not failures,
        "technicalChecks": hard_checks,
        "advisories": advisories,
        "checks": hard_checks + advisories,
        "failureCodes": [item["code"] for item in failures],
        "advisoryCodes": [item["code"] for item in advisories if not item["passed"]],
        "unsupportedFeatures": unsupported,
        "boundaryStatus": {"allVerified": bool(ledger) and boundary_counts.get("verified", 0) == len(ledger), "states": boundary_counts},
        "metrics": {"expectedDurationSeconds": round(expected_duration, 3), "actualDurationSeconds": round(actual_duration, 3), "durationErrorSeconds": round(duration_error, 3)},
    }


def detect_flash_tail(path: Path, duration: float, window: float = 3.0) -> float | None:
    start = max(0.0, duration - window)
    command = [_executable("ffmpeg"), "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(path), "-vf", "fps=10,signalstats,metadata=print:file=-", "-an", "-f", "null", "-"]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        return None
    current_time: float | None = None
    samples: list[tuple[float, float]] = []
    for line in result.stdout.splitlines():
        time_match = re.search(r"pts_time:([0-9.]+)", line)
        if time_match:
            current_time = start + float(time_match.group(1))
        y_match = re.search(r"lavfi\.signalstats\.YAVG=([0-9.]+)", line)
        if y_match and current_time is not None:
            samples.append((current_time, float(y_match.group(1))))
    # Require two consecutive near-white frames so a single bright shot is not
    # mistaken for the known episode-ending flash effect.
    for index in range(max(0, len(samples) - 1)):
        if samples[index][1] >= 235 and samples[index + 1][1] >= 235:
            return round(samples[index][0], 3)
    return None


def _render_clip(source: Path, target: Path, start: float, end: float, fade_in: bool, fade_out: bool, width: int, height: int, fade_seconds: float) -> None:
    clip_duration = end - start
    if clip_duration <= 0.15:
        raise AnalysisFailed("render clip is too short")
    # Output-side seeking keeps the source timestamps seen by filters.  Reset
    # both streams before applying fades so a body clip that starts midway
    # through an episode still fades in from t=0 of the rendered clip.
    video = f"setpts=PTS-STARTPTS,scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30"
    audio = "asetpts=PTS-STARTPTS,aresample=48000"
    fade = min(max(0.0, fade_seconds), clip_duration / 4)
    if fade_in and fade > 0:
        video += f",fade=t=in:st=0:d={fade:.3f}"
        audio += f",afade=t=in:st=0:d={fade:.3f}"
    if fade_out and fade > 0:
        video += f",fade=t=out:st={max(0, clip_duration-fade):.3f}:d={fade:.3f}"
        audio += f",afade=t=out:st={max(0, clip_duration-fade):.3f}:d={fade:.3f}"
    # Seek the input before it reaches setpts/asetpts. Placing -ss after -i
    # makes it an output seek; combined with timestamp-resetting filters that
    # can preserve the source offset as black video and silence at the start of
    # the rendered clip. Re-encoding still gives frame-accurate input seeking.
    command = [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{clip_duration:.3f}", "-vf", video, "-af", audio, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"clip render failed: {result.stderr[-1200:]}")


def _resolve_timeline_segment(
    available: list[dict[str, Any]],
    *,
    episode: int,
    start: float | None,
    end: float | None,
    tolerance: float = 0.05,
) -> tuple[dict[str, Any] | None, list[int]]:
    """Resolve a timeline clip against one or more contiguous evidence segments.

    The editor intentionally merges adjacent story beats from the same episode
    into one continuous clip.  The renderer used to accept only a 1:1 match,
    which rejected an otherwise fully evidenced merged clip.  This resolver
    accepts the merge only when its outer boundaries match and every interval
    between them is covered (overlaps are allowed; uncovered gaps are not).
    """
    indexed = [
        (index, item)
        for index, item in enumerate(available)
        if int(item.get("episode") or 0) == episode
    ]
    for index, item in indexed:
        item_start, item_end = float(item.get("start") or 0), float(item.get("end") or 0)
        if (start is None or abs(item_start - start) <= tolerance) and (end is None or abs(item_end - end) <= tolerance):
            return dict(item), [index]
    if start is None or end is None:
        return None, []
    candidates = sorted(
        ((index, item) for index, item in indexed if float(item.get("end") or 0) >= start - tolerance and float(item.get("start") or 0) <= end + tolerance),
        key=lambda pair: (float(pair[1].get("start") or 0), float(pair[1].get("end") or 0)),
    )
    if not candidates or abs(float(candidates[0][1].get("start") or 0) - start) > tolerance:
        return None, []
    covered_end = start
    consumed: list[tuple[int, dict[str, Any]]] = []
    for index, item in candidates:
        item_start, item_end = float(item.get("start") or 0), float(item.get("end") or 0)
        if item_start > covered_end + tolerance:
            return None, []
        if item_end > covered_end:
            consumed.append((index, item))
            covered_end = item_end
        if covered_end >= end - tolerance:
            break
    if abs(covered_end - end) > tolerance or not consumed:
        return None, []
    first, last = consumed[0][1], consumed[-1][1]
    merged = {
        "episode": episode,
        "start": start,
        "end": end,
        "purpose": "+".join(dict.fromkeys(str(item.get("purpose") or "story") for _, item in consumed)),
        "safeStart": first.get("safeStart") or {},
        "safeEnd": last.get("safeEnd") or {},
        "evidence": [evidence for _, item in consumed for evidence in (item.get("evidence") or [])],
        "sourceSegments": [str(item.get("highlightAssetId") or "") for _, item in consumed],
    }
    return merged, [index for index, _ in consumed]


def render_factory_project(response: dict[str, Any], base_url: str, workspace: Path, output_root: Path, on_progress: Callable[[int, str], None] | None = None) -> dict[str, Any]:
    project, hook, match, material = (dict(response.get(name) or {}) for name in ("project", "hook", "match", "material"))
    render = dict(response.get("render") or {})
    episodes = [dict(item) for item in response.get("episodes") or []]
    is_episode_splice = project.get("mode") == "episode-splice"
    if not is_episode_splice and hook.get("source_class") != "external_material":
        raise AnalysisFailed("render requires an external hook asset")
    segments = match.get("segments") if isinstance(match.get("segments"), list) else []
    if not is_episode_splice and not segments:
        raise AnalysisFailed("story match contains no segments")
    if on_progress:
        on_progress(8, "下载钩子与剧集片源")
    material_path: Path | None = None
    if not is_episode_splice:
        material_name = str(material.get("video") or "")
        remote_source = str(material.get("source_url") or "").strip()
        source_url = (
            f"{base_url.rstrip('/')}/api/files/{material.get('collectionId')}/{material.get('id')}/{urllib.parse.quote(material_name)}"
            if material_name
            else remote_source
        )
        if not source_url or urllib.parse.urlparse(source_url).scheme not in {"http", "https"}:
            raise AnalysisFailed("hook material has no playable local file or remote source URL")
        source_suffix = Path(urllib.parse.urlparse(source_url).path).suffix or ".mp4"
        material_path = workspace / f"hook-source{source_suffix}"
        _download(source_url, material_path)
    episode_paths: dict[int, Path] = {}
    for episode in episodes:
        number = int(episode.get("episode_number") or 0)
        video = str(episode.get("video") or "")
        target = workspace / f"episode-{number:03d}{Path(video).suffix or '.mp4'}"
        _download(f"{base_url.rstrip('/')}/api/files/{episode.get('collectionId')}/{episode.get('id')}/{urllib.parse.quote(video)}", target)
        episode_paths[number] = target
    if on_progress:
        on_progress(24, "检测剧集闪光结尾与安全边界")
    tail_starts = {number: detect_flash_tail(path, _duration(path)) for number, path in episode_paths.items()}
    ledger: list[dict[str, Any]] = []
    clip_specs: list[tuple[Path, float, float, str]] = []
    if material_path is not None:
        clip_specs.append((material_path, float(hook.get("start_seconds") or 0), float(hook.get("end_seconds") or 0), "hook"))
        hook_safe_start, hook_safe_end = hook.get("safe_start"), hook.get("safe_end")
        ledger.append({
            "kind": "hook",
            "start": clip_specs[0][1],
            "end": clip_specs[0][2],
            "safeStart": hook_safe_start,
            "safeEnd": hook_safe_end,
            "declaredStatus": hook.get("boundary_status"),
            "status": _boundary_state(hook_safe_start, hook_safe_end, hook.get("boundary_status")),
        })
    timeline = project.get("timeline") if isinstance(project.get("timeline"), list) else []
    transition = project.get("transition") if isinstance(project.get("transition"), dict) else {}
    sequential_external_body = transition.get("bodyAssemblyMode") == "sequential_from_highlight"
    ordered_segments: list[dict[str, Any]] = []
    unused = list(segments)
    for item in timeline:
        if not isinstance(item, dict) or not int(item.get("episode") or 0):
            continue
        episode = int(item.get("episode") or 0)
        start_value = item.get("startSeconds", item.get("start"))
        end_value = item.get("endSeconds", item.get("end"))
        if is_episode_splice:
            safe_start = item.get("safeStart") or {
                "status": "source_boundary",
                "source": "timeline_source_start",
            }
            safe_end = item.get("safeEnd") or {
                "status": "source_boundary",
                "source": "timeline_source_end",
            }
            ordered_segments.append({
                "episode": episode, "start": float(start_value or 0), "end": float(end_value or 0),
                "purpose": "sequential-episode-body",
                "safeStart": safe_start,
                "safeEnd": safe_end,
                "evidence": item.get("evidence") or [],
            })
            continue
        if sequential_external_body:
            start = float(start_value) if start_value is not None else 0.0
            end = float(end_value) if end_value is not None else _duration(episode_paths[episode])
            if not ordered_segments:
                anchor = next(
                    (
                        segment for segment in segments
                        if int(segment.get("episode") or 0) == episode
                        and abs(float(segment.get("start") or 0) - start) <= 0.05
                    ),
                    None,
                )
                if anchor is None:
                    raise AnalysisFailed("sequential body does not start at an approved highlight")
                safe_start = anchor.get("safeStart") or {
                    "status": "unverified",
                    "source": "approved_highlight_start_missing_boundary_evidence",
                }
            else:
                previous_episode = int(ordered_segments[-1].get("episode") or 0)
                if episode != previous_episode + 1 or abs(start) > 0.05:
                    raise AnalysisFailed("sequential body episodes are not consecutive")
                safe_start = {"status": "source_boundary", "source": "episode_start"}
            source_duration = _duration(episode_paths[episode])
            if abs(end - source_duration) > 0.1:
                raise AnalysisFailed(f"episode {episode} must continue to its source ending")
            ordered_segments.append({
                "episode": episode, "start": start, "end": end,
                "purpose": "sequential_from_highlight",
                "safeStart": safe_start,
                "safeEnd": {"status": "source_boundary", "source": "episode_end"},
                "evidence": [],
            })
            continue
        resolved, consumed_indices = _resolve_timeline_segment(
            unused,
            episode=episode,
            start=float(start_value) if start_value is not None else None,
            end=float(end_value) if end_value is not None else None,
        )
        if resolved is None:
            raise AnalysisFailed(f"timeline episode {episode} is not fully covered by timestamped story evidence")
        ordered_segments.append(resolved)
        for consumed_index in sorted(consumed_indices, reverse=True):
            unused.pop(consumed_index)
    if ordered_segments:
        segments = ordered_segments
    ratio = str(project.get("ratio") or "9:16")
    width, height = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}.get(ratio, (1080, 1920))
    transition_settings = _transition_settings(transition, render)
    transition_id = str(transition_settings["id"])
    fade_seconds = float(transition_settings["fadeSeconds"])
    unsupported_features = _unsupported_features(project, transition, render)
    for segment in segments:
        number, start, end = int(segment.get("episode") or 0), float(segment.get("start") or 0), float(segment.get("end") or 0)
        if number not in episode_paths:
            raise AnalysisFailed(f"episode {number} source is unavailable")
        safe_start, safe_end = segment.get("safeStart") or {}, segment.get("safeEnd") or {}
        # Content Factory treats boundary analysis as an advisory. The chosen
        # timeline remains renderable and is surfaced for human preview.
        flash_start = tail_starts.get(number)
        adjusted_end = min(end, max(start, flash_start - 0.05)) if flash_start is not None else end
        if adjusted_end <= start:
            raise AnalysisFailed(f"episode {number} segment falls inside the flash tail")
        effective_safe_end = safe_end
        if adjusted_end < end - 0.001:
            effective_safe_end = {
                "status": "mechanical_trim",
                "source": "flash_tail_detection",
                "original": safe_end,
            }
        clip_specs.append((episode_paths[number], start, adjusted_end, f"episode-{number}"))
        ledger.append({
            "kind": "episode",
            "episode": number,
            "start": start,
            "requestedEnd": end,
            "end": adjusted_end,
            "flashTailStart": flash_start,
            "safeStart": safe_start,
            "safeEnd": effective_safe_end,
            "status": _boundary_state(safe_start, effective_safe_end),
        })
    expected_duration = sum(end - start for _, start, end, _ in clip_specs)
    _validate_sequential_duration(
        expected_duration,
        is_episode_splice or sequential_external_body,
    )
    rendered: list[Path] = []
    for index, (source, start, end, kind) in enumerate(clip_specs):
        if on_progress:
            on_progress(30 + round(45 * index / max(1, len(clip_specs))), f"渲染片段 {index + 1}/{len(clip_specs)}")
        target = workspace / f"clip-{index:03d}.mp4"
        _render_clip(source, target, start, end, fade_in=(index == 1 and not is_episode_splice), fade_out=(index == 0 and not is_episode_splice), width=width, height=height, fade_seconds=fade_seconds)
        rendered.append(target)
    concat_file = workspace / "concat.txt"
    concat_file.write_text("\n".join(f"file '{path.as_posix()}'" for path in rendered), encoding="utf-8")
    output_root.mkdir(parents=True, exist_ok=True)
    version = int(render.get("version") or 1)
    render_id = str(render.get("id") or "").strip()
    output = output_root / _output_filename(project.get("title"), version, render_id)
    if on_progress:
        on_progress(78, "合并成片并封装")
    result = subprocess.run([_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", "-movflags", "+faststart", str(output)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"final concat failed: {result.stderr[-1200:]}")
    probe = subprocess.run([_executable("ffprobe"), "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-show_entries", "format=duration,size", "-of", "json", str(output)], capture_output=True, text=True)
    technical = json.loads(probe.stdout or "{}") if probe.returncode == 0 else {}
    render_quality = build_render_quality_report(
        output=output,
        technical=technical,
        expected_duration=expected_duration,
        width=width,
        height=height,
        ledger=ledger,
        render_id=render_id,
        unsupported_features=unsupported_features,
        leading_blank=_leading_blank_metrics(output),
    )
    if not render_quality["passed"]:
        raise AnalysisFailed(f"rendered output quality check failed: {', '.join(render_quality['failureCodes'])}")
    digest = _sha256_file(output)
    if on_progress:
        on_progress(96, "验证成片编码、音轨与边界台账")
    return {"preview_url": f"/renders/{urllib.parse.quote(output.name)}", "output_url": f"/renders/{urllib.parse.quote(output.name)}", "output_sha256": digest, "boundary_ledger": ledger, "validation": {**render_quality, "technical": technical, "file": str(output), "ratio": ratio, "language": str(project.get("language") or "英语"), "transition": transition_id, "transitionConfig": transition_settings}, "unsupportedFeatures": unsupported_features, "logs": {"clips": len(rendered), "flashTailDetection": tail_starts, "timelineOrder": [int(item.get("episode") or 0) for item in segments], "unsupportedFeatures": unsupported_features}}
