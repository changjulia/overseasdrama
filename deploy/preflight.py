#!/usr/bin/env python3
"""Fail closed when the production bundle is not safe to deploy."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env.production"
COMPOSE_PATH = ROOT / "docker-compose.tencent.yml"
PB_DATA = ROOT / "deploy" / "runtime" / "pb_data" / "data.db"

REQUIRED = {
    "DOMAIN",
    "ACME_EMAIL",
    "BASIC_AUTH_USER",
    "BASIC_AUTH_HASH",
    "LUMINA_WORKER_TOKEN",
    "EXTERNAL_OPEN_API_BASE_URL",
    "EXTERNAL_OPEN_API_KEY",
    "LUMINA_SEMANTIC_ENDPOINT",
    "LUMINA_SEMANTIC_API_KEY",
    "LUMINA_SEMANTIC_MODEL",
}

PLACEHOLDER_MARKERS = (
    "replace_me",
    "replace-me",
    "replace_with_",
    "provider.example",
    "example.com",
    "your_",
    "changeme",
)


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--allow-no-docker",
        action="store_true",
        help="Run static checks only; production deployment must not use this flag.",
    )
    parser.add_argument(
        "--allow-missing-data",
        action="store_true",
        help="Skip the PocketBase seed check while preparing a release bundle.",
    )
    args = parser.parse_args()
    errors: list[str] = []
    warnings: list[str] = []

    if not ENV_PATH.is_file():
        errors.append("missing .env.production (copy .env.production.example and fill real values)")
        env: dict[str, str] = {}
    else:
        env = read_env(ENV_PATH)
        missing = sorted(key for key in REQUIRED if not env.get(key))
        if missing:
            errors.append("empty required environment values: " + ", ".join(missing))
        placeholders = sorted(
            key
            for key in REQUIRED
            if env.get(key)
            and any(marker in env[key].lower() for marker in PLACEHOLDER_MARKERS)
        )
        if placeholders:
            errors.append("placeholder production values: " + ", ".join(placeholders))
        token = env.get("LUMINA_WORKER_TOKEN", "")
        if token and len(token) < 32:
            errors.append("LUMINA_WORKER_TOKEN must contain at least 32 characters")
        auth_hash = env.get("BASIC_AUTH_HASH", "")
        if auth_hash and not re.match(r"^\$2[aby]\$\d{2}\$", auth_hash):
            errors.append("BASIC_AUTH_HASH is not a bcrypt hash")
        domain = env.get("DOMAIN", "")
        if domain and ("://" in domain or "/" in domain):
            errors.append("DOMAIN must be a hostname without scheme or path")

    if not COMPOSE_PATH.is_file():
        errors.append("missing docker-compose.tencent.yml")
    if not PB_DATA.is_file():
        message = f"PocketBase production data is missing: {PB_DATA}"
        (warnings if args.allow_missing_data else errors).append(message)

    docker = shutil.which("docker")
    if docker:
        compose = [
            docker,
            "compose",
            "--env-file",
            str(ENV_PATH),
            "-f",
            str(COMPOSE_PATH),
        ]
        result = subprocess.run(
            [*compose, "config", "--quiet"],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            errors.append("docker compose config failed: " + (result.stderr.strip() or result.stdout.strip()))
        elif not errors:
            caddy = subprocess.run(
                [*compose, "run", "--rm", "--no-deps", "caddy", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
                cwd=ROOT,
                text=True,
                capture_output=True,
            )
            if caddy.returncode:
                errors.append("Caddy configuration validation failed: " + (caddy.stderr.strip() or caddy.stdout.strip()))
    elif args.allow_no_docker:
        warnings.append("Docker unavailable; container build/start validation was skipped")
    else:
        errors.append("Docker with the Compose plugin is required")

    for warning in warnings:
        print(f"WARN: {warning}")
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    if errors:
        print(f"PREFLIGHT FAILED ({len(errors)} error(s))", file=sys.stderr)
        return 1
    print("PREFLIGHT PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
