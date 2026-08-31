#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POINTER_FILE="${1:-$PROJECT_ROOT/pb_data/data.seed.db}"
OUTPUT_FILE="${2:-$PROJECT_ROOT/pb_data/data.db}"

if [[ -e "$OUTPUT_FILE" ]]; then
  printf 'Refusing to overwrite existing PocketBase data: %s\n' "$OUTPUT_FILE" >&2
  exit 1
fi
if [[ ! -f "$POINTER_FILE" ]]; then
  printf 'PocketBase seed is missing: %s\n' "$POINTER_FILE" >&2
  exit 1
fi
if [[ "$(LC_ALL=C head -c 15 "$POINTER_FILE" 2>/dev/null || true)" == "SQLite format 3" ]]; then
  cp "$POINTER_FILE" "$OUTPUT_FILE"
  printf 'PocketBase seed copied: %s\n' "$OUTPUT_FILE"
  exit 0
fi
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
DOWNLOAD_FILE="$TEMP_DIR/data.seed.db"
"$PROJECT_ROOT/scripts/hydrate-git-lfs-file.sh" "$POINTER_FILE" "$DOWNLOAD_FILE"
if [[ "$(LC_ALL=C head -c 15 "$DOWNLOAD_FILE")" != "SQLite format 3" ]]; then
  printf 'Downloaded seed is not a SQLite database.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
mv "$DOWNLOAD_FILE" "$OUTPUT_FILE"
printf 'PocketBase seed hydrated and verified: %s\n' "$OUTPUT_FILE"
