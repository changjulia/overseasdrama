#!/usr/bin/env python3
import secrets
import subprocess
from pathlib import Path

import requests


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
    return values


env = read_env(Path("/opt/lumina/.env.production"))
email = f"lumina-deploy-{secrets.token_hex(6)}@localhost.invalid"
password = secrets.token_urlsafe(36)

subprocess.run(
    [
        "sudo", "docker", "exec", "lumina-production-pocketbase-1",
        "pocketbase", "superuser", "upsert", email, password, "--dir=/pb/pb_data",
    ],
    check=True,
    stdout=subprocess.DEVNULL,
)

base = "http://127.0.0.1:8190"
auth_response = requests.post(
    f"{base}/api/collections/_superusers/auth-with-password",
    json={"identity": email, "password": password},
    timeout=30,
)
auth_response.raise_for_status()
headers = {"Authorization": auth_response.json()["token"]}

settings_response = requests.patch(
    f"{base}/api/settings",
    headers=headers,
    json={
        "s3": {
            "enabled": True,
            "bucket": env["COS_BUCKET"],
            "region": env["COS_REGION"],
            "endpoint": env["COS_ENDPOINT"],
            "accessKey": env["COS_ACCESS_KEY_ID"],
            "secret": env["COS_SECRET_ACCESS_KEY"],
            "forcePathStyle": False,
        }
    },
    timeout=30,
)
settings_response.raise_for_status()

test_response = requests.post(
    f"{base}/api/settings/test/s3",
    headers=headers,
    json={"filesystem": "storage"},
    timeout=30,
)
test_response.raise_for_status()

subprocess.run(
    [
        "sudo", "docker", "exec", "lumina-production-pocketbase-1",
        "pocketbase", "superuser", "delete", email, "--dir=/pb/pb_data",
    ],
    check=True,
    stdout=subprocess.DEVNULL,
)
print("pocketbase-cos-ready")
