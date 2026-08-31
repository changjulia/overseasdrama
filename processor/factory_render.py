from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from processor.semantic_analysis import AnalysisFailed, _executable
from processor.safe_media_download import download_same_origin_media


@dataclass(frozen=True)
class RenderConstraints:
    """Trusted renderer constraints; API payloads cannot override these values.

    Production callers use the defaults.  Integration tests may inject smaller
    dimensions and a shorter episode-splice duration while exercising the same
    FFmpeg, QC, hashing, and atomic-publish path.
    """

    dimensions: dict[str, tuple[int, int]] | None = None
    episode_splice_duration: tuple[float, float] = (300.0, 900.0)
    external_hook_duration: tuple[float, float] = (300.0, 900.0)

    def dimensions_for(self, ratio: str) -> tuple[int, int]:
        values = self.dimensions or {
            "9:16": (1080, 1920),
            "16:9": (1920, 1080),
            "1:1": (1080, 1080),
        }
        return values.get(ratio, values["9:16"])


def _download(url: str, target: Path) -> None:
    with urllib.request.urlopen(url, timeout=180) as response, target.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)


def _duration(path: Path) -> float:
    result = subprocess.run([_executable("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AnalysisFailed(f"ffprobe failed: {result.stderr[-800:]}")
    return float(result.stdout.strip())


def _has_audio_stream(path: Path) -> bool:
    result = subprocess.run([_executable("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AnalysisFailed(f"audio-stream probe failed: {result.stderr[-800:]}")
    return bool(result.stdout.strip())


def _audio_volume_metrics(path: Path) -> dict[str, float]:
    result = subprocess.run([_executable("ffmpeg"), "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"audio QC failed: {result.stderr[-800:]}")
    values = {}
    for name in ("mean_volume", "max_volume"):
        match = re.search(rf"{name}:\s*(-?(?:inf|[0-9.]+))\s*dB", result.stderr, re.IGNORECASE)
        if not match or match.group(1).lower() == "-inf":
            raise AnalysisFailed("audio QC detected a missing or silent narration mix")
        values[name] = float(match.group(1))
    return values


def _loudnorm_measurement(path: Path, target_i: float) -> dict[str, float]:
    """Run loudnorm's measurement pass and return the renderer-owned values."""
    result = subprocess.run(
        [_executable("ffmpeg"), "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", f"loudnorm=I={target_i}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise AnalysisFailed(f"loudness measurement failed: {result.stderr[-1000:]}")
    matches = re.findall(r"\{\s*\"input_i\".*?\}", result.stderr, re.DOTALL)
    if not matches:
        raise AnalysisFailed("loudness measurement did not return loudnorm statistics")
    try:
        raw = json.loads(matches[-1])
        values = {name: float(raw[name]) for name in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise AnalysisFailed("loudness measurement returned invalid statistics") from exc
    if any(not math.isfinite(value) for value in values.values()):
        raise AnalysisFailed("loudness measurement returned non-finite statistics")
    return values


def _normalize_audio_loudness(source: Path, target: Path, *, target_i: float) -> None:
    """Apply reproducible two-pass EBU R128 normalization without re-encoding video."""
    measured = _loudnorm_measurement(source, target_i)
    audio_filter = (
        f"loudnorm=I={target_i}:TP=-1.5:LRA=11:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true:print_format=summary"
    )
    result = subprocess.run(
        [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-map", "0:v?", "-map", "0:a:0", "-c:v", "copy", "-af", audio_filter, "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise AnalysisFailed(f"two-pass loudness normalization failed: {result.stderr[-1200:]}")


def _concat_with_audio_crossfades(paths: list[Path], target: Path, *, fade_seconds: float = .025) -> None:
    """Concatenate pictures while de-clicking every real audio boundary."""
    if not paths:
        raise AnalysisFailed("final concat has no media")
    inputs = [part for path in paths for part in ("-i", str(path))]
    if len(paths) == 1:
        chain = "[0:v]null[v];[0:a]aresample=48000[a]"
    else:
        video_inputs = "".join(f"[{index}:v]" for index in range(len(paths)))
        filters = [f"{video_inputs}concat=n={len(paths)}:v=1:a=0[v]"]
        previous = "0:a"
        for index in range(1, len(paths)):
            output = "a" if index == len(paths) - 1 else f"af{index}"
            filters.append(f"[{previous}][{index}:a]acrossfade=d={fade_seconds:.3f}:c1=tri:c2=tri[{output}]")
            previous = output
        chain = ";".join(filters)
    result = subprocess.run(
        [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise AnalysisFailed(f"final concat with audio crossfades failed: {result.stderr[-1200:]}")


def build_render_quality_report(
    *,
    output: Path,
    technical: dict[str, Any],
    expected_duration: float,
    width: int,
    height: int,
    ledger: list[dict[str, Any]],
) -> dict[str, Any]:
    streams = technical.get("streams") or []
    format_data = technical.get("format") or {}
    actual_duration = float(format_data.get("duration") or 0)
    duration_error = abs(actual_duration - expected_duration)
    try:
        loudness = _loudnorm_measurement(output, -14.0)
    except AnalysisFailed:
        # QC must return an actionable failure envelope for corrupt or
        # audio-less output rather than replacing it with a worker exception.
        loudness = None
    audio_durations = [float(item.get("duration") or 0) for item in streams if item.get("codec_type") == "audio" and item.get("duration")]
    audio_video_drift = abs(actual_duration - audio_durations[0]) if audio_durations else math.inf
    checks = [
        {"code": "OUTPUT_PRESENT", "label": "成片文件存在", "passed": output.is_file() and output.stat().st_size > 0},
        {"code": "VIDEO_SPEC", "label": "H.264 画面规格", "passed": any(item.get("codec_type") == "video" and item.get("codec_name") == "h264" and item.get("width") == width and item.get("height") == height for item in streams)},
        {"code": "AUDIO_SPEC", "label": "AAC 音轨", "passed": any(item.get("codec_type") == "audio" and item.get("codec_name") == "aac" for item in streams)},
        {"code": "DURATION_CONSISTENCY", "label": "时间线与成片时长一致", "passed": duration_error <= max(0.5, expected_duration * 0.005), "metrics": {"expectedSeconds": round(expected_duration, 3), "actualSeconds": round(actual_duration, 3), "errorSeconds": round(duration_error, 3)}},
        {"code": "STANDARD_LOUDNESS", "label": "成片标准响度", "passed": loudness is not None and abs(loudness["input_i"] - -14.0) <= 1.0 and loudness["input_tp"] <= -1.0, "metrics": {"integratedLufs": round(loudness["input_i"], 2) if loudness else None, "truePeakDbtp": round(loudness["input_tp"], 2) if loudness else None, "targetLufs": -14.0}},
        {"code": "AUDIO_VIDEO_SYNC", "label": "音画时长一致", "passed": audio_video_drift <= max(.2, expected_duration * .001), "metrics": {"driftSeconds": round(audio_video_drift, 3) if math.isfinite(audio_video_drift) else None}},
        {"code": "BOUNDARY_LEDGER", "label": "全部剪辑边界可追溯", "passed": bool(ledger) and all(item.get("status") == "verified" and item.get("safeStart") and item.get("safeEnd") for item in ledger)},
        {"code": "FLASH_TAIL_REMOVED", "label": "剧集闪光结尾已避让", "passed": all(item.get("kind") != "episode" or item.get("flashTailStart") is None or float(item.get("end") or 0) < float(item.get("flashTailStart") or 0) for item in ledger)},
    ]
    failures = [item for item in checks if not item["passed"]]
    return {
        "schemaVersion": "factory-render-qc-v1",
        "passed": not failures,
        "checks": checks,
        "failureCodes": [item["code"] for item in failures],
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
    video = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30"
    audio = "aresample=48000"
    fade = min(max(0.0, fade_seconds), clip_duration / 4)
    if fade_in and fade > 0:
        video += f",fade=t=in:st=0:d={fade:.3f}"
        audio += f",afade=t=in:st=0:d={fade:.3f}"
    if fade_out and fade > 0:
        video += f",fade=t=out:st={max(0, clip_duration-fade):.3f}:d={fade:.3f}"
        audio += f",afade=t=out:st={max(0, clip_duration-fade):.3f}:d={fade:.3f}"
    # Accurate output seeking: decode up to the requested boundary instead of
    # fast-seeking to the preceding keyframe. This is slower, but prevents the
    # first/last reaction or subtitle from drifting by several frames.
    command = [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-ss", f"{start:.3f}", "-t", f"{clip_duration:.3f}", "-vf", video, "-af", audio, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(target)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"clip render failed: {result.stderr[-1200:]}")


def _validated_transition(project: dict[str, Any], *, review_preview: bool = False) -> dict[str, Any]:
    transition = project.get("transition") if isinstance(project.get("transition"), dict) else {}
    kind = str(transition.get("type") or "")
    if kind not in {"direct_cut", "transition_copy", "continuous_narration"}:
        raise AnalysisFailed("a formal transition production object is required")
    if not review_preview and transition.get("reviewStatus") != "approved":
        raise AnalysisFailed("transition review must be approved before rendering, including direct_cut")
    if review_preview and transition.get("reviewStatus") not in {"draft", "pending", "rejected"}:
        raise AnalysisFailed("transition review preview requires an unapproved production version")
    gaps = transition.get("gapDiagnosis")
    gaps = gaps if isinstance(gaps, list) else [gaps]
    if not gaps or any(item not in {"time", "space", "character", "causal", "emotion"} for item in gaps):
        raise AnalysisFailed("transition gapDiagnosis is invalid")
    if not str(transition.get("language") or "").strip() or int(transition.get("version") or 0) < 1:
        raise AnalysisFailed("transition language/version is invalid")
    if kind == "continuous_narration":
        voice = transition.get("voice") if isinstance(transition.get("voice"), dict) else {}
        if voice.get("mode") != "manual_audio" or not str(voice.get("audioUrl") or "").strip():
            raise AnalysisFailed("continuous_narration requires a real uploaded manual narration audio URL")
        duration = float(transition.get("end") or 0) - float(transition.get("start") or 0)
        if float(transition.get("start") or 0) != 0 or not 60 <= duration <= 100:
            raise AnalysisFailed("continuous_narration must start at 0 and last 60-100 seconds")
    return transition


def _render_transition_card(
    target: Path,
    transition: dict[str, Any],
    width: int,
    height: int,
    *,
    outgoing: Path | None = None,
    incoming: Path | None = None,
) -> float:
    copy = str(transition.get("copy") or "").strip()
    if not copy:
        raise AnalysisFailed("transition_copy requires non-empty copy")
    config = transition.get("renderConfig") if isinstance(transition.get("renderConfig"), dict) else {}
    effect = str(config.get("transitionStyle") or config.get("effect") or "")
    if effect not in {"hard_cut", "fade", "black", "flash_avoidance", "match_cut"}:
        raise AnalysisFailed("unsupported transition effect")
    evidence = transition.get("evidence") if isinstance(transition.get("evidence"), list) else []
    if re.search(r"(年后|年前|天后|小时前|与此同时|重生|穿越)", copy) and not evidence:
        raise AnalysisFailed("time/causal transition copy has no supporting evidence")
    duration = min(5.0, max(0.8, float(config.get("durationSeconds") or 1.5)))
    if effect != "black" and (outgoing is None or incoming is None):
        raise AnalysisFailed(f"{effect} transition requires real outgoing and incoming media")
    if effect == "match_cut":
        match_evidence = config.get("matchCutEvidence") if isinstance(config.get("matchCutEvidence"), dict) else {}
        required = ("feature", "outgoing", "incoming")
        if any(not str(match_evidence.get(field) or "").strip() for field in required):
            raise AnalysisFailed("match_cut requires visual feature evidence for both outgoing and incoming shots")
    text_file = target.with_suffix(".txt")
    text_file.write_text(copy, encoding="utf-8")
    font_size = max(24, round(width * 0.055))
    # Keep copy inside the central title-safe area and readable over live video.
    draw = (
        f"drawtext=textfile='{text_file.as_posix()}':fontcolor=white:fontsize={font_size}:"
        "x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.62:boxborderw=12"
    )
    common = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30"
    audio_input = ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    if effect == "black":
        command = [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:r=30:d={duration:.3f}", *audio_input, "-vf", draw, "-map", "0:v", "-map", "1:a"]
    else:
        assert outgoing is not None and incoming is not None
        half = duration / 2
        outgoing_start = max(0.0, _duration(outgoing) - (duration if effect == "fade" else half))
        inputs = ["-i", str(outgoing), "-i", str(incoming), *audio_input]
        if effect == "fade":
            fade_duration = min(duration * .6, max(.15, float(config.get("fadeSeconds") or duration * .6)))
            chain = (
                f"[0:v]trim=start={outgoing_start:.3f}:duration={duration:.3f},setpts=PTS-STARTPTS,{common}[out];"
                f"[1:v]trim=start=0:duration={duration:.3f},setpts=PTS-STARTPTS,{common}[in];"
                f"[out][in]xfade=transition=fade:duration={fade_duration:.3f}:offset=0,{draw}[v]"
            )
        else:
            # hard_cut and evidence-backed match_cut preserve an instantaneous cut.
            # flash_avoidance adds a dip-to-black on both sides, never a white flash.
            outgoing_filter = f"trim=start={outgoing_start:.3f}:duration={half:.3f},setpts=PTS-STARTPTS,{common}"
            incoming_filter = f"trim=start=0:duration={half:.3f},setpts=PTS-STARTPTS,{common}"
            if effect == "flash_avoidance":
                dip = min(.3, half)
                outgoing_filter += f",fade=t=out:st={max(0, half-dip):.3f}:d={dip:.3f}:color=black"
                incoming_filter += f",fade=t=in:st=0:d={dip:.3f}:color=black"
            chain = f"[0:v]{outgoing_filter}[out];[1:v]{incoming_filter}[in];[out][in]concat=n=2:v=1:a=0,{draw}[v]"
        command = [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", *inputs, "-filter_complex", chain, "-map", "[v]", "-map", "2:a"]
    command += ["-t", f"{duration:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", str(target)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"transition render failed: {result.stderr[-1200:]}")
    return duration


def _srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _narration_cues(script: str, duration: float) -> list[tuple[float, float, str]]:
    """Split narration into readable, duration-weighted subtitle cues."""
    normalized = re.sub(r"\s+", " ", script).strip()
    # SRT/libass accepts inline HTML/ASS styling. Keep reviewed copy as plain
    # text so it cannot escape the renderer-owned safe-area style.
    normalized = normalized.translate(str.maketrans({"<": "＜", ">": "＞", "{": "｛", "}": "｝"}))
    if not normalized:
        return []
    phrases = [item.strip() for item in re.split(r"(?<=[。！？!?;；])\s*|(?<=[,.，])\s+", normalized) if item.strip()]
    chunks: list[str] = []
    for phrase in phrases or [normalized]:
        # About two short CJK lines or one compact Latin subtitle per cue.
        limit = 24 if re.search(r"[\u3400-\u9fff]", phrase) else 48
        while len(phrase) > limit:
            split = phrase.rfind(" ", 0, limit + 1)
            split = split if split >= max(8, limit // 2) else limit
            chunks.append(phrase[:split].strip())
            phrase = phrase[split:].strip()
        if phrase:
            chunks.append(phrase)
    weights = [max(1, len(re.sub(r"\s", "", item))) for item in chunks]
    total = sum(weights)
    cursor = 0.0
    cues = []
    for index, (chunk, weight) in enumerate(zip(chunks, weights)):
        end = duration if index == len(chunks) - 1 else cursor + duration * weight / total
        cues.append((cursor, end, chunk))
        cursor = end
    return cues


def _ass_color(value: Any, fallback: str) -> str:
    text = str(value or fallback).strip()
    match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", text)
    if not match:
        text = fallback
        match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", text)
    assert match
    red, green, blue = match.group(1)[0:2], match.group(1)[2:4], match.group(1)[4:6]
    return f"&H00{blue}{green}{red}&".upper()


def _write_narration_ass(path: Path, cues: list[tuple[float, float, str]], config: dict[str, Any], width: int, height: int) -> None:
    raw = config.get("subtitleStyle") if isinstance(config.get("subtitleStyle"), dict) else {}
    font = re.sub(r"[,\r\n]", " ", str(raw.get("fontFamily") or "Noto Sans CJK SC")).strip()[:80] or "Arial"
    font_size = min(96, max(18, int(raw.get("fontSize") or max(18, round(width * .045)))))
    outline = min(8.0, max(0.0, float(raw.get("outlineWidth") or 3)))
    shadow = min(8.0, max(0.0, float(raw.get("shadowDepth") or 1)))
    max_lines = 3 if int(raw.get("maxLines") or 2) == 3 else 2
    horizontal_percent = min(25.0, max(3.0, float(raw.get("marginHorizontalPercent") or 8)))
    vertical_percent = min(30.0, max(5.0, float(raw.get("marginVerticalPercent") or 12)))
    alignment = {"bottom-center": 2, "center": 5, "top-center": 8}.get(str(raw.get("alignment") or "bottom-center"), 2)
    margin_l = margin_r = round(width * horizontal_percent / 100)
    margin_v = round(height * vertical_percent / 100)
    available_width = max(40, width - margin_l - margin_r)
    chars_per_line = max(6, int(available_width / max(8.0, font_size * .55)))
    max_chars = chars_per_line * max_lines

    expanded: list[tuple[float, float, str]] = []
    for start, end, text in cues:
        words = text.split() if " " in text else list(text)
        separator = " " if " " in text else ""
        pieces: list[str] = []
        current = ""
        for word in words:
            candidate = f"{current}{separator if current else ''}{word}"
            if current and len(candidate) > max_chars:
                pieces.append(current)
                current = word
            else:
                current = candidate
        if current:
            pieces.append(current)
        span = max(.01, end - start) / max(1, len(pieces))
        for index, piece in enumerate(pieces or [text]):
            piece_start = start + index * span
            piece_end = end if index == len(pieces) - 1 else piece_start + span
            lines: list[str] = []
            remaining = piece
            while remaining and len(lines) < max_lines:
                if len(remaining) <= chars_per_line:
                    lines.append(remaining.strip())
                    remaining = ""
                    break
                split = remaining.rfind(" ", 0, chars_per_line + 1)
                split = split if split >= max(3, chars_per_line // 2) else chars_per_line
                lines.append(remaining[:split].strip())
                remaining = remaining[split:].strip()
            if remaining:
                lines[-1] = f"{lines[-1]} {remaining}".strip()
            safe_text = "\\N".join(lines).replace("{", "｛").replace("}", "｝")
            expanded.append((piece_start, piece_end, safe_text))

    primary = _ass_color(raw.get("primaryColor"), "#FFFFFF")
    outline_color = _ass_color(raw.get("outlineColor"), "#111111")
    bold = -1 if raw.get("bold", True) is not False else 0
    header = (
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\nScaledBorderAndShadow: yes\n"
        f"PlayResX: {width}\nPlayResY: {height}\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Narration,{font},{font_size},{primary},{primary},{outline_color},&H80000000&,{bold},0,0,0,100,100,0,0,1,{outline:.2f},{shadow:.2f},{alignment},{margin_l},{margin_r},{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = "".join(
        f"Dialogue: 0,{_srt_timestamp(start).replace(',', '.')[:-1]},{_srt_timestamp(end).replace(',', '.')[:-1]},Narration,,0,0,0,,{text}\n"
        for start, end, text in expanded
    )
    path.write_text(header + events, encoding="utf-8")


def _validated_original_audio_windows(config: dict[str, Any], duration: float) -> list[tuple[float, float]]:
    raw = config.get("keyOriginalAudioWindows") if isinstance(config.get("keyOriginalAudioWindows"), list) else []
    if len(raw) > 20:
        raise AnalysisFailed("key original-audio windows exceed the supported limit")
    windows: list[tuple[float, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise AnalysisFailed("key original-audio window is invalid")
        try:
            start, end = float(item.get("start")), float(item.get("end"))
        except (TypeError, ValueError) as exc:
            raise AnalysisFailed("key original-audio window is invalid") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start or end > duration:
            raise AnalysisFailed("key original-audio window must stay inside the narration interval")
        if windows and start < windows[-1][1]:
            raise AnalysisFailed("key original-audio windows must be sorted and non-overlapping")
        windows.append((start, end))
    return windows


def _render_narration_mix(source: Path, target: Path, transition: dict[str, Any], workspace: Path, *, trusted_base_url: str, subtitle_width: int, subtitle_height: int, review_preview: bool = False) -> None:
    if not _has_audio_stream(source):
        raise AnalysisFailed("source media has no audio track; narration mixing requires an explicit audio policy")
    voice = transition.get("voice") if isinstance(transition.get("voice"), dict) else {}
    audio_url = str(voice.get("audioUrl") or "").strip()
    narration = workspace / f"narration{Path(urllib.parse.urlparse(audio_url).path).suffix or '.audio'}"
    download_same_origin_media(audio_url, narration, trusted_base_url=trusted_base_url)
    requested = float(transition.get("end") or 0) - float(transition.get("start") or 0)
    audio_duration = _duration(narration)
    if abs(audio_duration - requested) > max(2.0, requested * .05):
        raise AnalysisFailed(f"narration audio duration does not match production object ({audio_duration:.2f}s vs {requested:.2f}s)")
    source_duration = _duration(source)
    if not review_preview and source_duration + .05 < requested:
        raise AnalysisFailed("assembled video is shorter than the 60-100 second narration interval")
    narration_volume = _audio_volume_metrics(narration)
    if narration_volume["mean_volume"] < -45:
        raise AnalysisFailed("narration audio is too quiet for intelligible mixing")
    normalized_narration = workspace / "narration-loudnorm.m4a"
    _normalize_audio_loudness(narration, normalized_narration, target_i=-16.0)
    mix_duration = min(requested, source_duration) if review_preview else requested
    config = transition.get("renderConfig") if isinstance(transition.get("renderConfig"), dict) else {}
    try:
        requested_duck_db = float(config.get("originalAudioDuckDb") or -12)
    except (TypeError, ValueError) as exc:
        raise AnalysisFailed("original-audio duck level is invalid") from exc
    if not math.isfinite(requested_duck_db):
        raise AnalysisFailed("original-audio duck level is invalid")
    duck_db = min(0.0, max(-40.0, requested_duck_db))
    windows = _validated_original_audio_windows(config, mix_duration)
    terms = [f"between(t,{start:.3f},{end:.3f})" for start, end in windows]
    sidechain_expression = f"if({'+'.join(terms)},0,1)" if terms else "1"
    narration_expression = f"if({'+'.join(terms)},0.251189,1)" if terms else "1"
    script = str(transition.get("script") or "").strip()
    if not script:
        raise AnalysisFailed("continuous_narration requires subtitle script")
    subtitle = workspace / "continuous-narration.ass"
    cues = _narration_cues(script, mix_duration)
    _write_narration_ass(subtitle, cues, config, subtitle_width, subtitle_height)
    subtitle_filter = f"ass='{subtitle.as_posix()}'" if config.get("subtitleEnabled", True) else "null"
    ratio = min(20.0, max(2.0, abs(duck_db) / 1.5))
    filters = (
        f"[0:v]{subtitle_filter}[v];"
        f"[0:a]aresample=48000[base];"
        f"[1:a]atrim=0:{mix_duration:.3f},aresample=48000,asplit=2[narrraw][side];"
        # The sidechain input is only as long as the narration interval. Pad it
        # with silence so sidechaincompress keeps emitting the full programme
        # audio after narration ends; otherwise long final renders are silently
        # truncated to 60-100 seconds and fail A/V sync QC.
        f"[side]volume='{sidechain_expression}':eval=frame,apad=whole_dur={source_duration:.3f}[control];"
        f"[base][control]sidechaincompress=threshold=0.02:ratio={ratio:.3f}:attack=15:release=250[ducked];"
        f"[narrraw]volume='{narration_expression}':eval=frame[narr];"
        f"[ducked][narr]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]"
    )
    mixed_raw = workspace / "continuous-narration-mix-raw.mp4"
    command = [_executable("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-i", str(normalized_narration), "-filter_complex", filters, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(mixed_raw)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise AnalysisFailed(f"continuous narration mix failed: {result.stderr[-1200:]}")
    _normalize_audio_loudness(mixed_raw, target, target_i=-14.0)
    mixed_volume = _audio_volume_metrics(target)
    if mixed_volume["max_volume"] > 0.1:
        raise AnalysisFailed("continuous narration mix clips above digital full scale")


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


def _validated_splice_boundaries(item: dict[str, Any], *, first: bool, episode: int, start: float) -> tuple[dict[str, Any], dict[str, Any]]:
    """Accept only the canonical boundary contract persisted by PocketBase."""
    safe_start = item.get("safeStart") if isinstance(item.get("safeStart"), dict) else {}
    safe_end = item.get("safeEnd") if isinstance(item.get("safeEnd"), dict) else {}
    if first:
        if safe_start.get("status") != "verified" or safe_start.get("source") != "approved_highlight" or not safe_start.get("highlightAssetId"):
            raise AnalysisFailed("first splice segment is missing its approved highlight boundary contract")
    elif safe_start.get("status") != "verified" or safe_start.get("source") != "episode_start" or abs(start) > 0.05:
        raise AnalysisFailed(f"episode {episode} is missing its verified source-start boundary contract")
    if safe_end.get("status") != "verified" or safe_end.get("source") != "episode_end":
        raise AnalysisFailed(f"episode {episode} is missing its verified source-end boundary contract")
    return safe_start, safe_end


def render_factory_project(response: dict[str, Any], base_url: str, workspace: Path, output_root: Path, on_progress: Callable[[int, str], None] | None = None, *, constraints: RenderConstraints | None = None) -> dict[str, Any]:
    constraints = constraints or RenderConstraints()
    project, hook, match, material = (dict(response.get(name) or {}) for name in ("project", "hook", "match", "material"))
    render_config = (response.get("render") or {}).get("render_config") if isinstance((response.get("render") or {}).get("render_config"), dict) else {}
    review_preview = render_config.get("purpose") == "transition_review"
    transition = _validated_transition(project, review_preview=review_preview)
    episodes = [dict(item) for item in response.get("episodes") or []]
    is_episode_splice = project.get("mode") == "episode-splice"
    if not is_episode_splice and hook.get("boundary_status") != "verified":
        raise AnalysisFailed("render requires a verified-boundary hook asset")
    segments = match.get("segments") if isinstance(match.get("segments"), list) else []
    if not is_episode_splice and not segments:
        raise AnalysisFailed("story match contains no segments")
    if on_progress:
        on_progress(8, "下载钩子与剧集片源")
    material_path: Path | None = None
    if not is_episode_splice:
        material_name = str(material.get("video") or "")
        material_path = workspace / f"hook-source{Path(material_name).suffix or '.mp4'}"
        _download(f"{base_url.rstrip('/')}/api/files/{material.get('collectionId')}/{material.get('id')}/{urllib.parse.quote(material_name)}", material_path)
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
        hook_end = float(hook.get("end_seconds") or 0)
        hook_start = max(float(hook.get("start_seconds") or 0), hook_end - 10) if review_preview else float(hook.get("start_seconds") or 0)
        clip_specs.append((material_path, hook_start, hook_end, "hook"))
        ledger.append({"kind": "hook", "start": clip_specs[0][1], "end": clip_specs[0][2], "safeStart": hook.get("safe_start"), "safeEnd": hook.get("safe_end"), "status": "verified"})
    timeline = project.get("timeline") if isinstance(project.get("timeline"), list) else []
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
            safe_start, safe_end = _validated_splice_boundaries(
                item, first=not ordered_segments, episode=episode, start=float(start_value or 0)
            )
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
                safe_start = anchor.get("safeStart") or {"status": "verified", "source": "approved_highlight_start"}
            else:
                previous_episode = int(ordered_segments[-1].get("episode") or 0)
                if episode != previous_episode + 1 or abs(start) > 0.05:
                    raise AnalysisFailed("sequential body episodes are not consecutive")
                safe_start = {"status": "verified", "source": "episode_start"}
            source_duration = _duration(episode_paths[episode])
            if abs(end - source_duration) > 0.1:
                raise AnalysisFailed(f"episode {episode} must continue to its source ending")
            ordered_segments.append({
                "episode": episode, "start": start, "end": end,
                "purpose": "sequential_from_highlight",
                "safeStart": safe_start,
                "safeEnd": {"status": "verified", "source": "episode_end"},
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
    if review_preview and segments:
        first = dict(segments[0])
        first["end"] = min(float(first.get("end") or 0), float(first.get("start") or 0) + 20)
        segments = [first]
    ratio = str(project.get("ratio") or "9:16")
    width, height = constraints.dimensions_for(ratio)
    transition_id = str(transition.get("type"))
    effect = str((transition.get("renderConfig") or {}).get("transitionStyle") or (transition.get("renderConfig") or {}).get("effect") or "hard_cut")
    fade_seconds = min(.5, max(.05, float((transition.get("renderConfig") or {}).get("fadeSeconds") or .25))) if effect == "fade" else 0.0
    for segment in segments:
        number, start, end = int(segment.get("episode") or 0), float(segment.get("start") or 0), float(segment.get("end") or 0)
        if number not in episode_paths:
            raise AnalysisFailed(f"episode {number} source is unavailable")
        safe_start, safe_end = segment.get("safeStart") or {}, segment.get("safeEnd") or {}
        if not is_episode_splice and not sequential_external_body and (safe_start.get("status") != "verified" or safe_end.get("status") != "verified"):
            raise AnalysisFailed(f"episode {number} has an unverified dialogue/action boundary")
        flash_start = tail_starts.get(number)
        adjusted_end = min(end, max(start, flash_start - 0.05)) if flash_start is not None else end
        if adjusted_end <= start:
            raise AnalysisFailed(f"episode {number} segment falls inside the flash tail")
        clip_specs.append((episode_paths[number], start, adjusted_end, f"episode-{number}"))
        ledger.append({"kind": "episode", "episode": number, "start": start, "requestedEnd": end, "end": adjusted_end, "flashTailStart": flash_start, "safeStart": safe_start, "safeEnd": safe_end, "status": "verified"})
    rendered: list[Path] = []
    for index, (source, start, end, kind) in enumerate(clip_specs):
        if on_progress:
            on_progress(30 + round(45 * index / max(1, len(clip_specs))), f"渲染片段 {index + 1}/{len(clip_specs)}")
        target = workspace / f"clip-{index:03d}.mp4"
        _render_clip(source, target, start, end, fade_in=(index == 1 and not is_episode_splice), fade_out=(index == 0 and not is_episode_splice), width=width, height=height, fade_seconds=fade_seconds)
        rendered.append(target)
    if transition_id == "transition_copy":
        if len(rendered) < 2:
            raise AnalysisFailed("transition_copy requires media on both sides of the transition")
        transition_target = workspace / "transition-production.mp4"
        transition_duration = _render_transition_card(
            transition_target, transition, width, height,
            outgoing=rendered[0], incoming=rendered[1],
        )
        rendered.insert(1, transition_target)
        ledger.append({"kind": "transition", "start": float(transition.get("start") or 0), "end": float(transition.get("end") or 0), "safeStart": {"status": "verified", "source": "approved_transition_review"}, "safeEnd": {"status": "verified", "source": "approved_transition_review"}, "status": "verified", "reviewStatus": "approved", "effect": effect, "renderedDuration": transition_duration})
    safe_title = re.sub(r"[\\/:*?\"<>|]+", "-", str(project.get("title") or "external-hook-production")).strip() or "external-hook-production"
    version = int((response.get("render") or {}).get("version") or 1)
    render_id = re.sub(r"[^A-Za-z0-9_-]+", "-", str((response.get("render") or {}).get("id") or "")).strip("-")
    output_name = f"{safe_title}-v{version:02d}{f'-{render_id}' if render_id else ''}.mp4"
    # Render and validate outside the public directory. A failed duration/spec
    # check must never leave a downloadable file that looks like a successful
    # render, and different render records must not overwrite one another.
    staged_output = workspace / "factory-render-output.mp4"
    concat_output = workspace / "factory-render-concat.mp4"
    if on_progress:
        on_progress(78, "合并成片并封装")
    _concat_with_audio_crossfades(rendered, concat_output)
    if transition_id == "continuous_narration":
        _render_narration_mix(concat_output, staged_output, transition, workspace, trusted_base_url=base_url, subtitle_width=width, subtitle_height=height, review_preview=review_preview)
    else:
        _normalize_audio_loudness(concat_output, staged_output, target_i=-14.0)
    probe = subprocess.run([_executable("ffprobe"), "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height,duration", "-show_entries", "format=duration,size", "-of", "json", str(staged_output)], capture_output=True, text=True)
    technical = json.loads(probe.stdout or "{}") if probe.returncode == 0 else {}
    expected_duration = sum(end - start for _, start, end, _ in clip_specs) + sum(float(item.get("renderedDuration") or 0) for item in ledger if item.get("kind") == "transition")
    minimum_splice_duration, maximum_splice_duration = constraints.episode_splice_duration
    if not review_preview and is_episode_splice and not minimum_splice_duration <= expected_duration <= maximum_splice_duration:
        raise AnalysisFailed(
            "sequential splice output must be "
            f"{minimum_splice_duration:g}-{maximum_splice_duration:g} seconds after tail removal "
            f"(actual {expected_duration:.2f}s)"
        )
    minimum_external_duration, maximum_external_duration = constraints.external_hook_duration
    if not review_preview and not is_episode_splice and not minimum_external_duration <= expected_duration <= maximum_external_duration:
        raise AnalysisFailed(
            "external hook output must be "
            f"{minimum_external_duration:g}-{maximum_external_duration:g} seconds after tail removal "
            f"(actual {expected_duration:.2f}s)"
        )
    render_quality = build_render_quality_report(output=staged_output, technical=technical, expected_duration=expected_duration, width=width, height=height, ledger=ledger)
    if not render_quality["passed"]:
        raise AnalysisFailed(f"rendered output quality check failed: {', '.join(render_quality['failureCodes'])}")
    digest = hashlib.sha256(staged_output.read_bytes()).hexdigest()
    output_root.mkdir(parents=True, exist_ok=True)
    output = output_root / output_name
    publish_staging = output_root / f".{output_name}.partial"
    try:
        shutil.copyfile(staged_output, publish_staging)
        publish_staging.replace(output)
    finally:
        publish_staging.unlink(missing_ok=True)
    if on_progress:
        on_progress(96, "验证成片编码、音轨与边界台账")
    voice = transition.get("voice") if isinstance(transition.get("voice"), dict) else {}
    transition_lineage = {
        "transitionVersion": int(transition.get("version") or 0),
        "audioAssetId": str(voice.get("assetId") or "") or None,
        "audioSha256": str(voice.get("sha256") or "") or None,
    }
    return {"preview_url": f"/renders/{urllib.parse.quote(output.name)}", "output_url": f"/renders/{urllib.parse.quote(output.name)}", "output_sha256": digest, "boundary_ledger": ledger, "validation": {**render_quality, "technical": technical, "file": str(output), "ratio": ratio, "language": str(project.get("language") or "英语"), "transition": transition_id, **transition_lineage}, "logs": {"clips": len(rendered), "flashTailDetection": tail_starts, "timelineOrder": [int(item.get("episode") or 0) for item in segments]}}
