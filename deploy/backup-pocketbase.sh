#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$project_root/deploy/runtime/pb_data"
backup_dir="$project_root/deploy/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_dir/pocketbase-$timestamp.tar.gz"

if [[ ! -f "$runtime_dir/data.db" ]]; then
  printf 'PocketBase data was not found at %s\n' "$runtime_dir" >&2
  exit 1
fi

mkdir -p "$backup_dir"
cd "$project_root"
docker compose --env-file .env.production -f docker-compose.tencent.yml stop pocketbase worker interactive-worker
trap 'docker compose --env-file .env.production -f docker-compose.tencent.yml up -d pocketbase worker interactive-worker' EXIT
tar -C "$runtime_dir" -czf "$archive" .
sha256sum "$archive" > "$archive.sha256"
printf 'Backup created: %s\n' "$archive"
