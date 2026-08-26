"""Import all episodes for the July Top-15 dramas with a resumable checkpoint."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def request_json(url: str, payload: dict[str, Any] | None = None, method: str | None = None, attempts: int = 4) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if body else {}
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read())
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(min(20, 2**attempt))
    raise RuntimeError("unreachable")


def external_id(platform: str, source_id: str) -> str:
    value = f"{platform}:{source_id}"
    hash_value = 2166136261
    for character in value:
        hash_value = ((hash_value ^ ord(character)) * 16777619) & 0xFFFFFFFF
    return str(1_000_000_000 + hash_value % 1_000_000_000)


def download(url: str, destination: Path, attempts: int = 4) -> None:
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=180) as response, destination.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if destination.stat().st_size:
                return
            raise RuntimeError("empty episode")
        except Exception:
            destination.unlink(missing_ok=True)
            if attempt == attempts:
                raise
            time.sleep(min(20, 2**attempt))


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-url", default="http://localhost:3001")
    parser.add_argument("--pb-url", default="http://127.0.0.1:8090")
    parser.add_argument("--checkpoint", default="analysis_artifacts/july-2026-top15-drama-import.json")
    parser.add_argument("--minimum-free-gb", type=float, default=8)
    args = parser.parse_args()
    app_url, pb_url = args.app_url.rstrip("/"), args.pb_url.rstrip("/")
    checkpoint = Path(args.checkpoint)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    state = json.loads(checkpoint.read_text(encoding="utf-8")) if checkpoint.exists() else {"schemaVersion": 1, "month": "2026-07", "dramas": []}
    by_ranking = {int(item["ranking"]): item for item in state["dramas"]}
    rankings = request_json(f"{app_url}/api/external-data/rankings?month=2026-07").get("data", {}).get("items", [])[:15]

    def persist() -> None:
        state["dramas"] = [by_ranking[key] for key in sorted(by_ranking)]
        checkpoint.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    for ranked in rankings:
        ranking = int(ranked["ranking"])
        row = by_ranking.setdefault(ranking, {"ranking": ranking, "name": ranked["playletName"], "episodesCompleted": 0, "status": "pending", "errors": []})
        playback = request_json(f"{app_url}/api/external-data/playback?{urllib.parse.urlencode({'name': ranked['playletName']})}").get("data", {}).get("items", [])
        if not playback:
            row.update({"status": "failed", "errors": ["playback lookup returned no series"]}); persist(); continue
        series = playback[0]
        platform, source_id = str(series["platform"]), str(series["source_id"])
        filter_value = f'source_type="外部" && source_platform="{platform}" && source_record_id="{source_id}"'
        existing = request_json(f"{pb_url}/api/collections/dramas/records?perPage=1&filter={urllib.parse.quote(filter_value)}").get("items", [])
        body = {
            "external_id": external_id(platform, source_id), "title": series["name"], "cn": series["name"], "genre": "待分析", "language": "待识别",
            "total_episodes": int(series["total_episodes"]), "free_episodes": int(series["total_episodes"]), "copyright_status": "外部数据 · 仅限内部分析",
            "parse_state": "queued", "parse_config": {"coarse": "全剧逐集", "detail": "全剧融合", "precision": "高潜片段"},
            "source_type": "外部", "source_platform": platform, "source_record_id": source_id, "acquisition_method": "开放 API",
            "external_cover_url": ranked.get("coverOss") or "", "source_metadata": {"dataeye_playlet_id": ranked["playletId"], "ranking": ranking, "ranking_month": "2026-07", "material_count": ranked.get("materialCnt", 0), "playlet_tags": ranked.get("playletTags", [])},
        }
        if existing:
            drama = existing[0]
            try:
                drama = request_json(f"{pb_url}/api/collections/dramas/records/{drama['id']}", body, "PATCH")
            except Exception:
                pass
        else:
            drama = request_json(f"{pb_url}/api/collections/dramas/records", body, "POST")
        row.update({"recordId": drama["id"], "platform": platform, "sourceId": source_id, "totalEpisodes": int(series["total_episodes"]), "status": "importing"})
        episode_filter = urllib.parse.quote(f'drama="{drama["id"]}"')
        stored = request_json(f"{pb_url}/api/collections/drama_episodes/records?perPage=500&filter={episode_filter}&fields=id,episode_number").get("items", [])
        existing_numbers = {int(item["episode_number"]) for item in stored}
        row["episodesCompleted"] = len(existing_numbers)
        persist()
        episode_lock = threading.Lock()
        stop_for_capacity = threading.Event()

        def upload_episode(episode: dict[str, Any]) -> None:
            episode_number = int(episode["episode"])
            if episode_number in existing_numbers or stop_for_capacity.is_set():
                return
            with tempfile.TemporaryDirectory(prefix="lumina-drama-import-") as temporary:
                path = Path(temporary) / f"EP{episode_number:03d}.mp4"
                free_gb = shutil.disk_usage(Path.cwd()).free / 1024**3
                if free_gb < args.minimum_free_gb:
                    with episode_lock:
                        row.update({"status": "paused_capacity", "freeGB": round(free_gb, 2)}); persist()
                    stop_for_capacity.set()
                    return
                try:
                    download(str(episode["url"]), path)
                    command = ["curl.exe", "--fail", "--silent", "--show-error", "--max-time", "300", "-X", "POST",
                        "-F", f"drama={drama['id']}", "-F", f"episode_number={episode_number}", "-F", f"original_name={path.name}",
                        "-F", "mime_type=video/mp4", "-F", f"byte_size={path.stat().st_size}", "-F", "duration_seconds=0",
                        "-F", "analysis_status=queued", "-F", "analysis_progress=0", "-F", f"video=@{path};type=video/mp4;filename={path.name}",
                        f"{pb_url}/api/collections/drama_episodes/records"]
                    completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
                    if completed.returncode:
                        raise RuntimeError(completed.stderr.strip() or f"curl exit {completed.returncode}")
                    with episode_lock:
                        existing_numbers.add(episode_number)
                        row.update({"episodesCompleted": len(existing_numbers), "lastEpisode": episode_number, "error": ""})
                        persist()
                        print(f"[#{ranking:02d}] {series['name']} EP{episode_number:03d}/{series['total_episodes']} uploaded+queued", flush=True)
                except Exception as exc:
                    with episode_lock:
                        row["errors"] = (row.get("errors") or []) + [{"episode": episode_number, "message": str(exc)[:500]}]
                        persist()
                finally:
                    path.unlink(missing_ok=True)
        missing = [episode for episode in series["episodes"] if int(episode["episode"]) not in existing_numbers]
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(upload_episode, missing))
        if stop_for_capacity.is_set():
            raise SystemExit(f"Paused safely below {args.minimum_free_gb:.1f} GB free")
        row["status"] = "completed" if len(existing_numbers) >= int(series["total_episodes"]) else "partial"
        persist()
    completed = sum(item.get("status") == "completed" for item in by_ranking.values())
    print(f"Finished drama import: {completed}/15 complete")


if __name__ == "__main__":
    main()
