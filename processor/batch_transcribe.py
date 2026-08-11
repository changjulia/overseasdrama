"""Scan a drama directory and transcribe episodes concurrently with Scribe v2."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from processor.pack import pack_transcripts
from processor.scribe import is_cache_valid, transcript_path, transcribe

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}


def discover(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS and "edit" not in p.parts)


def natural_key(path: Path) -> list[object]:
    """Sort EP2 before EP10 while keeping non-numbered names stable."""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def drama_group(path: Path, root: Path) -> str:
    relative = path.relative_to(root)
    return relative.parts[0] if len(relative.parts) > 1 else "_root"


def select_free_episodes(videos: list[Path], root: Path, limit: int) -> tuple[list[Path], list[Path], dict[str, list[str]]]:
    if limit < 1:
        raise ValueError("免费章节数必须大于 0")
    groups: dict[str, list[Path]] = {}
    for video in videos:
        groups.setdefault(drama_group(video, root), []).append(video)
    selected: list[Path] = []
    excluded: list[Path] = []
    manifest: dict[str, list[str]] = {}
    for name, episodes in sorted(groups.items()):
        ordered = sorted(episodes, key=natural_key)
        free = ordered[:limit]
        selected.extend(free)
        excluded.extend(ordered[limit:])
        manifest[name] = [str(item.relative_to(root)) for item in free]
    return selected, excluded, manifest


def media_duration_seconds(path: Path) -> float | None:
    if shutil.which("ffprobe"):
        result = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
        if result.returncode == 0:
            try:
                return float(result.stdout.strip())
            except ValueError:
                pass
    if shutil.which("mdls"):
        result = subprocess.run(["mdls", "-raw", "-name", "kMDItemDurationSeconds", str(path)], capture_output=True, text=True)
        if result.returncode == 0:
            try:
                return float(result.stdout.strip().replace("\x00", ""))
            except ValueError:
                pass
    return None


def estimate(videos: list[Path], assumed_hours_per_gb: float = 0.55) -> dict:
    total_bytes = sum(p.stat().st_size for p in videos)
    durations = [media_duration_seconds(path) for path in videos]
    exact = all(value is not None for value in durations)
    estimated_hours = sum(value or 0 for value in durations) / 3600 if exact else total_bytes / (1024**3) * assumed_hours_per_gb
    return {
        "files": len(videos),
        "total_gb": round(total_bytes / (1024**3), 2),
        "estimated_hours": round(estimated_hours, 2),
        "estimated_scribe_usd": round(estimated_hours * 0.22, 2),
        "note": "使用媒体时长计算" if exact else "无法读取媒体时长，暂按文件体积估算",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Lumina Scribe v2 批量剧集转写")
    parser.add_argument("source_dir", type=Path)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--language", default=None)
    parser.add_argument("--num-speakers", type=int, default=None)
    parser.add_argument("--keyterms", type=Path, default=None, help="每行一个角色名或专有词")
    parser.add_argument("--free-episodes", type=int, default=10, help="每部剧仅处理前 N 个免费章节（默认：10）")
    parser.add_argument("--estimate-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    root = args.source_dir.expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"目录不存在：{root}")
    all_videos = discover(root)
    if not all_videos:
        sys.exit(f"目录中没有视频：{root}")
    videos, excluded, selection = select_free_episodes(all_videos, root, args.free_episodes)
    print(f"分析范围：每部剧前 {args.free_episodes} 个免费章节；已选 {len(videos)}，排除付费章节 {len(excluded)}")
    print(json.dumps(estimate(videos), ensure_ascii=False, indent=2))
    if args.estimate_only:
        return

    edit_dir = root / "edit"
    edit_dir.mkdir(exist_ok=True)
    (edit_dir / "free_episode_selection.json").write_text(json.dumps({"free_episode_limit": args.free_episodes, "selected": selection, "excluded_count": len(excluded)}, ensure_ascii=False, indent=2), encoding="utf-8")
    keyterms = None
    if args.keyterms:
        keyterms = [line.strip() for line in args.keyterms.read_text(encoding="utf-8").splitlines() if line.strip()]

    pending = [v for v in videos if args.force or not is_cache_valid(v, transcript_path(v, edit_dir))]
    print(f"发现 {len(videos)} 个视频，缓存命中 {len(videos)-len(pending)}，待转写 {len(pending)}")
    failures = []
    started = time.time()
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 4))) as pool:
        jobs = {pool.submit(transcribe, video, edit_dir, args.language, args.num_speakers, keyterms, args.force): video for video in pending}
        for job in as_completed(jobs):
            video = jobs[job]
            try:
                output, cached = job.result()
                print(f"✓ {video.name} → {output.name}{'（缓存）' if cached else ''}")
            except Exception as exc:
                failures.append({"source": str(video), "error": str(exc)})
                print(f"✗ {video.name}: {exc}")

    if (edit_dir / "transcripts").exists() and any((edit_dir / "transcripts").glob("*.json")):
        print(f"文本包：{pack_transcripts(edit_dir)}")
    report = {"finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "elapsed_seconds": round(time.time()-started, 1), "scope": {"free_episode_limit": args.free_episodes, "selected": len(videos), "paid_episodes_excluded": len(excluded)}, "total": len(videos), "failed": failures}
    (edit_dir / "transcription_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
