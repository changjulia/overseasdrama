"""Lease PocketBase jobs and run the evidence-first three-tier analyzer."""

from __future__ import annotations

import argparse
import hashlib
import json
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
        if interval.get("start") is None or interval.get("end") is None:
            raise RuntimeError("精解析任务缺少片段起止时间，请重置该任务后重试")
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
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    cache_root = Path(os.getenv("LUMINA_ANALYSIS_CACHE_DIR", str(Path.cwd() / "analysis_cache")))
    cache_dir = cache_root / "materials" / material_id / digest.hexdigest()
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
    result["material_id"] = material_id
    return result


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
    hook = claim("hookType", "LEGACY_HOOK")
    if hook:
        times = [e.get("timecode") for e in hook["evidence"] if isinstance(e.get("timecode"), dict)]
        hook = {**hook, "start": min((float(t.get("start") or 0) for t in times), default=0), "end": max((float(t.get("end") or 0) for t in times), default=0)}
    material_format = claim("materialType", "LEGACY_FORMAT")
    tier = claim("tier", str((semantic.get("tier") or {}).get("value") or "TX"))
    transition = claim("transition", "LEGACY_TRANSITION")
    inspiration = claim("prototype", "LEGACY_INSPIRATION")
    duration = float(legacy.get("durationSeconds") or 0)
    content = {"summary": summary, "tags": [], "characters": [], "relationships": [], "segments": timeline, "completeness": {"code": "PARTIAL_LEGACY", "label": "历史分析证据可用，新增维度待复核", "confidence": 1, "evidence": [], "verification": "verified"}}
    creative = {"format": material_format or {}, "tier": tier or {}, "hooks": [hook] if hook else [], "timeline": timeline, "transitions": [transition] if transition else [], "packaging": {"visual": [], "subtitle": [], "audio": [], "rhythm": []}}
    value = {"scores": {}, "inspirations": [inspiration] if inspiration else [], "risks": [], "suitableGenres": [], "suitableAudiences": []}
    review = {"status": "needs_review", "reasons": ["千问账户额度不可用；已保留此前模型生成且带时间码证据的结论，未覆盖的 material-v2 维度保持为空。"], "items": [{"id": "provider-arrearage", "field": "semantic.full_merge", "label": "全片汇总待补跑", "reason": "DashScope 返回 Arrearage", "confidence": 1}]}
    result = {"schemaVersion": "material-v2", "evidence": {"transcript": legacy.get("transcript") or [], "ocr": legacy.get("ocr") or [], "keyframes": [{key: value for key, value in frame.items() if key != "path"} for frame in (legacy.get("keyframes") or []) if isinstance(frame, dict)], "shots": [], "audioEvents": []}, "content": content, "creative": creative, "value": value, "review": review, "sourceAttribution": {"status": "not_required", "matches": []}, "semanticSegments": [], "semantic": {"content": content, "creative": creative, "value": value, "review": review}, "materialFields": {"analysis": "分析完成（待复核）", "analysisStatus": "succeeded", "materialType": material_format.get("label", "未确定") if material_format else "未确定", "tier": tier.get("label", "TX") if tier else "TX", "hookType": hook.get("label", "未确定") if hook else "未确定", "transition": transition.get("label", "未确定") if transition else "未确定", "prototype": inspiration.get("label", "未确定") if inspiration else "未确定", "summary": summary["value"], "highlights": timeline, "structure": timeline, "review": "待人工复核", "confidence": round(100 * max([summary["confidence"], *(item["confidence"] for item in timeline)], default=0))}, "durationSeconds": duration}
    return {"schema_version": "material-v2", "analysis_id": f"legacy-upgrade-{material_id}", "tier": "coarse", "status": "succeeded", "source": {"kind": "external_paid_ad_material", "durationSeconds": duration}, "engines": {"semantic": "verified-legacy-result", "upgrade": "local-material-v2"}, "result": result}


def process_one_endpoint(base_url: str, token: str, worker_id: str, api_prefix: str, kind: str, optional: bool = False, job_id: str | None = None) -> bool:
    try:
        claim_body = {"worker_id": worker_id, "lease_seconds": 600}
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
            "worker_id": worker_id, "lease_token": job["lease_token"], "status": "running",
            "progress": progress_state["value"], "lease_seconds": 600,
            "logs": {"stage": stage, "kind": kind},
        }
        if kind == "material":
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
            result = execute_material_job(response, base_url, Path(tmp), report_progress) if kind == "material" else execute_semantic_job(job, base_url, Path(tmp))
        api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "succeeded", "result": result, "logs": {"processor": "processor.semantic_analysis", "analysisVersion": result["schema_version"], "stage": job["stage"], "kind": kind}})
    except Exception as exc:
        try:
            api_request(base_url, token, f"{api_prefix}/jobs/{job_id}", "PATCH", {"worker_id": worker_id, "lease_token": job["lease_token"], "status": "failed", "error": str(exc)[:2000]})
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
    if queue == "material":
        return process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True, job_id=job_id)
    if job_id:
        raise ValueError("--job-id requires --queue drama or --queue material")
    drama = process_one_endpoint(base_url, token, worker_id, "/api/lumina/analysis", "drama")
    material = process_one_endpoint(base_url, token, worker_id, "/api/lumina/material-analysis", "material", optional=True)
    return drama or material


def main() -> None:
    parser = argparse.ArgumentParser(description="Lumina PocketBase three-tier semantic-analysis worker")
    parser.add_argument("--base-url", default=os.environ.get("NEXT_PUBLIC_POCKETBASE_URL", "http://127.0.0.1:8090"))
    parser.add_argument("--token", default=os.environ.get("LUMINA_WORKER_TOKEN"))
    parser.add_argument("--worker-id", default=f"media-worker-{os.getpid()}")
    parser.add_argument("--queue", choices=("drama", "material", "both"), default=os.environ.get("LUMINA_WORKER_QUEUE", "both"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--job-id", help="Claim one exact job; requires --queue drama or material")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("Set LUMINA_WORKER_TOKEN or pass --token")
    while True:
        processed = process_available(args.base_url, args.token, args.worker_id, args.queue, args.job_id)
        if args.once:
            return
        if not processed:
            time.sleep(max(0.5, args.poll_seconds))


if __name__ == "__main__":
    main()
