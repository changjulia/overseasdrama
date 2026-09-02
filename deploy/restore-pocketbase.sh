#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s /absolute/path/to/pocketbase-backup.tar.gz\n' "$0" >&2
  exit 2
fi

archive="$(realpath "$1")"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$project_root/deploy/runtime/pb_data"
backup_dir="$project_root/deploy/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
previous_dir="$backup_dir/pre-restore-$timestamp"

if [[ ! -f "$archive" ]]; then
  printf 'Backup does not exist: %s\n' "$archive" >&2
  exit 1
fi

cd "$project_root"
docker compose --env-file .env.production -f docker-compose.tencent.yml stop pocketbase worker interactive-worker
trap 'docker compose --env-file .env.production -f docker-compose.tencent.yml up -d pocketbase worker interactive-worker' EXIT
mkdir -p "$runtime_dir" "$previous_dir"
find "$runtime_dir" -mindepth 1 -maxdepth 1 -exec mv -- {} "$previous_dir"/ \;
tar -C "$runtime_dir" -xzf "$archive"
printf 'Previous data retained at: %s\n' "$previous_dir"
