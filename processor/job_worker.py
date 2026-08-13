"""Lease PocketBase jobs and run the evidence-first three-tier analyzer."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from processor.semantic_analysis import AnalysisEnvelope, analyze_coarse, analyze_detail, analyze_material, analyze_precision


class ApiRequestError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def api_request(base_url: str, token: str, path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any] | None]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
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
    with urllib.request.urlopen(url, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)


def envelope_from_dict(value: dict[str, Any]) -> AnalysisEnvelope:
    return AnalysisEnvelope(
        schema_version=str(value["schema_version"]), analysis_id=str(value["analysis_id"]), tier=value["tier"],
        status=value["status"], source=dict(value.get("source") or {}), engine=dict(value.get("engine") or {}),
        result=value.get("result"), error=value.get("error"), warnings=list(value.get("warnings") or []),
    )


def execute_semantic_job(job: dict[str, Any], base_url: str, workspace: Path) -> dict[str, Any]:
    stage = str(job["stage"])
    if stage == "detail":
        coarse = [envelope_from_dict(item) for item in job.get("coarse_results", [])]
        return analyze_detail(coarse).to_dict()
    video_name = str(job.get("video") or "")
    if not video_name or not job.get("episode"):
        raise RuntimeError(f"{stage} job is missing its PocketBase episode video")
    suffix = Path(video_name).suffix or ".video"
    source = workspace / f"source{suffix}"
    asset_url = f"{base_url.rstrip('/')}/api/files/{job['collection_id']}/{job['episode']}/{urllib.parse.quote(video_name)}"
    download(asset_url, source)
    episode_number = int(job["episode_number"])
    if stage == "coarse":
        return analyze_coarse(source, episode_number, workspace).to_dict()
    if stage == "precision":
        interval = dict((job.get("parameters") or {}).get("interval") or {})
        coarse = envelope_from_dict(dict(job.get("coarse_result") or {}))
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
    if not material_id or not collection_id or not video_name:
        raise RuntimeError("material job is missing material.id, material.collection_id, or material.video")
    suffix = Path(video_name).suffix or ".video"
    source = workspace / f"material-source{suffix}"
    asset_url = f"{base_url.rstrip('/')}/api/files/{collection_id}/{material_id}/{urllib.parse.quote(video_name)}"
    if on_progress:
        on_progress(8, "下载素材")
    download(asset_url, source)
    result = analyze_material(source, workspace, on_progress=on_progress).to_dict()
    result["material_id"] = material_id
    return result


def process_one_endpoint(base_url: str, token: str, worker_id: str, api_prefix: str, kind: str, optional: bool = False) -> bool:
    try:
        status, response = api_request(base_url, token, f"{api_prefix}/claim", "POST", {"worker_id": worker_id, "lease_seconds": 600})
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
    heartbeat_stop = threading.Event()
    progress_state: dict[str, Any] = {"value": 5, "stage": "领取任务"}

    def report_progress(progress: int, stage: str) -> None:
        progress_state["value"] = max(progress_state["value"], min(99, int(progress)))
        progress_state["stage"] = stage
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {
            "worker_id": worker_id, "lease_token": job["lease_token"], "status": "running",
            "progress": progress_state["value"], "lease_seconds": 600,
            "logs": {"stage": stage, "kind": kind},
        })

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
            result = execute_material_job(response, base_url, Path(tmp), report_progress) if kind == "material" else execute_semantic_job(job, base_url, Path(tmp))
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "succeeded", "result": result, "logs": {"processor": "processor.semantic_analysis", "analysisVersion": result["schema_version"], "stage": job["stage"], "kind": kind}})
    except Exception as exc:
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "failed", "error": str(exc)[:2000]})
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2)
    return True


def process_available(base_url: str, token: str, worker_id: str) -> bool:
    """Attempt both queues each cycle so neither queue can starve the other."""
    drama = process_one_endpoint(base_url, token, worker_id, "/api/lumina/analysis", "drama")
    material = process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True)
    return drama or material


def main() -> None:
    parser = argparse.ArgumentParser(description="Lumina PocketBase three-tier semantic-analysis worker")
    parser.add_argument("--base-url", default=os.environ.get("NEXT_PUBLIC_POCKETBASE_URL", "http://127.0.0.1:8090"))
    parser.add_argument("--token", default=os.environ.get("LUMINA_WORKER_TOKEN"))
    parser.add_argument("--worker-id", default=f"media-worker-{os.getpid()}")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("Set LUMINA_WORKER_TOKEN or pass --token")
    while True:
        processed = process_available(args.base_url, args.token, args.worker_id)
        if args.once:
            return
        if not processed:
            time.sleep(max(0.5, args.poll_seconds))


if __name__ == "__main__":
    main()
