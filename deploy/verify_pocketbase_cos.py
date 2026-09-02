#!/usr/bin/env python3
from pathlib import Path

import requests


root = Path("/opt/lumina/deploy/runtime/pb_data/storage")
sample = next(path for path in root.rglob("*") if path.is_file() and not path.name.endswith(".attrs"))
url = "http://127.0.0.1:8190/api/files/" + sample.relative_to(root).as_posix()
response = requests.get(url, headers={"Range": "bytes=0-1023"}, timeout=30)
response.raise_for_status()
if not response.content:
    raise RuntimeError("PocketBase returned an empty COS object")
print(f"cos-file-ready {response.status_code} {len(response.content)}")
