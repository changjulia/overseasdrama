"""Inventory a full DataEye monthly ranking without downloading expiring media.

The generated checkpoint is intentionally compact: one row per ranked drama
with exact material/page counts.  Ingestion workers can later resume by
``nextPage`` without repeating already completed pages.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def request_json(url: str, payload: dict[str, Any] | None = None, attempts: int = 5) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"content-type": "application/json"} if body else {}
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=120) as response:
                return json.loads(response.read())
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(min(12, 2**attempt))
    raise RuntimeError("unreachable")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--month", default="2026-07")
    parser.add_argument("--base-url", default="http://localhost:3001")
    parser.add_argument("--output", default="analysis_artifacts/monthly-running-materials-2026-07.json")
    args = parser.parse_args()
    start_date = f"{args.month}-01"
    year, month = map(int, args.month.split("-"))
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    from datetime import date, timedelta
    end_date = (date(next_year, next_month, 1) - timedelta(days=1)).isoformat()
    rankings_url = f"{args.base_url.rstrip('/')}/api/external-data/rankings?{urllib.parse.urlencode({'month': args.month})}"
    rankings = request_json(rankings_url).get("data", {}).get("items", [])
    rows: list[dict[str, Any]] = []
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    def persist() -> None:
        output.write_text(json.dumps({
            "schemaVersion": 1, "month": args.month, "startDate": start_date, "endDate": end_date,
            "generatedAt": datetime.now(timezone.utc).isoformat(), "dramaCount": len(rows),
            "materialCount": sum(row["julyMaterialCount"] for row in rows), "rows": rows,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in rankings:
        payload = {"drama_name": item["playletName"], "start_date": start_date, "end_date": end_date, "page": 1, "page_size": 1}
        response = request_json(f"{args.base_url.rstrip('/')}/api/external-data/materials", payload)
        total = int(response.get("data", {}).get("upstream", {}).get("content", {}).get("totalRecord", 0))
        rows.append({
            "ranking": int(item["ranking"]), "playletId": int(item["playletId"]), "playletName": item["playletName"],
            "reportedMaterialCount": int(item.get("materialCnt", 0)), "julyMaterialCount": total,
            "pageSize": 100, "totalPages": (total + 99) // 100, "nextPage": 1,
            "dramaImported": False, "materialsCompleted": 0, "materialsCreated": 0,
            "materialsDeduplicated": 0, "materialsFailed": 0,
        })
        persist()
        print(f"[{len(rows):02d}/{len(rankings):02d}] #{item['ranking']} {item['playletName']}: {total}", flush=True)
    persist()
    print(f"Wrote {output}: {len(rows)} dramas, {sum(row['julyMaterialCount'] for row in rows)} materials")


if __name__ == "__main__":
    main()
