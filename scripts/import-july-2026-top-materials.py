"""Import and queue the July 2026 Top-15 dramas × Top-10 ADX materials.

The checkpoint is updated after every item and is safe to rerun. PocketBase's
source identity and file SHA-256 indexes remain the authoritative dedupe gates.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def request_json(url: str, payload: dict[str, Any] | None = None, timeout: int = 240, attempts: int = 4) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if body else {}
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=timeout) as response:
                return json.loads(response.read())
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(min(20, 2**attempt))
    raise RuntimeError("unreachable")


def text(value: Any, fallback: str = "") -> str:
    return str(value).strip() if value is not None and str(value).strip() else fallback


def number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://localhost:3001")
    parser.add_argument("--checkpoint", default="analysis_artifacts/july-2026-top15x10-import.json")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--minimum-free-gb", type=float, default=8)
    args = parser.parse_args()
    free_gb = shutil.disk_usage(Path.cwd()).free / 1024**3
    if free_gb < args.minimum_free_gb:
        raise SystemExit(f"Only {free_gb:.1f} GB free; refusing import below {args.minimum_free_gb:.1f} GB")
    root = args.base_url.rstrip("/")
    checkpoint_path = Path(args.checkpoint)
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    if checkpoint_path.exists():
        state = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    else:
        rankings = request_json(f"{root}/api/external-data/rankings?month=2026-07").get("data", {}).get("items", [])[:15]
        targets: list[dict[str, Any]] = []
        for drama in rankings:
            response = request_json(f"{root}/api/external-data/materials", {
                "drama_name": drama["playletName"], "start_date": "2026-07-01", "end_date": "2026-07-31", "page": 1, "page_size": 100,
            })
            materials = response.get("data", {}).get("upstream", {}).get("content", {}).get("searchList", [])
            ranked = sorted((item for item in materials if item.get("videoList")), key=lambda item: (-number(item.get("exposureNum")), text(item.get("materialId"), text(item.get("id")))))[:10]
            if len(ranked) != 10:
                raise RuntimeError(f"{drama['playletName']} returned only {len(ranked)} playable materials")
            for rank, item in enumerate(ranked, 1):
                external_id = text(item.get("materialId"), text(item.get("id")))
                countries = [text(country.get("countryName")) for country in item.get("countries", []) if isinstance(country, dict) and text(country.get("countryName"))]
                targets.append({
                    "key": f"{drama['playletId']}:{external_id}", "dramaRanking": drama["ranking"], "dramaId": drama["playletId"],
                    "dramaName": drama["playletName"], "materialRank": rank, "externalId": external_id,
                    "sourceUrl": item["videoList"][0], "exposure": number(item.get("exposureNum")), "days": number(item.get("releaseDay")),
                    "durationSeconds": number(item.get("durationMillis")) / 1000, "market": " / ".join(countries[:3]) + (f" +{len(countries)-3}" if len(countries) > 3 else "") if countries else "ADX 市场",
                    "status": "pending", "attempts": 0,
                })
        state = {"schemaVersion": 1, "batchId": "july-2026-top15x10", "month": "2026-07", "targets": targets}
        checkpoint_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    targets = state["targets"]
    if len(targets) != 150:
        raise RuntimeError(f"checkpoint target count is {len(targets)}, expected 150")
    lock = threading.Lock()

    def persist() -> None:
        checkpoint_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def upload(item: dict[str, Any]) -> None:
        if item.get("status") in {"created", "deduplicated"}:
            return
        source_hash = hashlib.sha256(f"adx:{item['externalId']}".encode()).hexdigest()
        title = f"{item['dramaName']}-202607-{int(item['materialRank']):02d}"
        payload = {key: item[key] for key in ("externalId", "sourceUrl", "market", "exposure", "days", "durationSeconds")}
        payload.update({"title": title, "sourceIdentityHash": source_hash, "autoAnalyze": True, "batchId": state["batchId"]})
        item["attempts"] = int(item.get("attempts", 0)) + 1
        try:
            result = request_json(f"{root}/api/material-intake", payload, timeout=300, attempts=3)
            record = result.get("record") or {}
            if not record.get("id"):
                raise RuntimeError(result.get("message") or "intake returned no record")
            item.update({"status": "created" if result.get("created") else "deduplicated", "recordId": record["id"], "analysisQueued": bool(result.get("analysisQueued")), "error": ""})
        except Exception as exc:
            item.update({"status": "failed", "error": str(exc)[:1000]})
        with lock:
            persist()
            done = sum(target.get("status") in {"created", "deduplicated"} for target in targets)
            failed = sum(target.get("status") == "failed" for target in targets)
            print(f"[{done:03d}/150] #{item['dramaRanking']} {item['dramaName']} - {item['materialRank']:02d}: {item['status']} (failed={failed})", flush=True)

    pending = [item for item in targets if item.get("status") not in {"created", "deduplicated"}]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(6, args.workers))) as executor:
        list(executor.map(upload, pending))
    created = sum(item.get("status") == "created" for item in targets)
    deduplicated = sum(item.get("status") == "deduplicated" for item in targets)
    failed = sum(item.get("status") == "failed" for item in targets)
    print(f"Finished: targets=150 created={created} deduplicated={deduplicated} failed={failed}")
    if failed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
