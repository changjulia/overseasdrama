#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXECUTABLE="${POCKETBASE_EXE:-$PROJECT_ROOT/tools/pocketbase/pocketbase}"
DATA_DIR="$PROJECT_ROOT/pb_data"
TOKEN_FILE="$PROJECT_ROOT/.analysis-worker-token"

if [[ ! -s "$TOKEN_FILE" ]]; then
  umask 077
  if [[ -n "${LUMINA_WORKER_TOKEN:-}" ]]; then
    printf '%s' "$LUMINA_WORKER_TOKEN" > "$TOKEN_FILE"
  else
    command -v python3 >/dev/null 2>&1 || { printf '%s\n' 'python3 is required to generate the local worker token.' >&2; exit 1; }
    python3 -c 'import secrets; print(secrets.token_hex(32), end="")' > "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
  printf 'Created local worker token: %s\n' "$TOKEN_FILE"
fi
if [[ -s "$TOKEN_FILE" ]]; then
  file_token="$(tr -d '\r\n' < "$TOKEN_FILE")"
  if [[ -n "${LUMINA_WORKER_TOKEN:-}" && "$LUMINA_WORKER_TOKEN" != "$file_token" ]]; then
    printf '%s\n' 'LUMINA_WORKER_TOKEN differs from .analysis-worker-token; refusing to start PocketBase.' >&2
    exit 1
  fi
  export LUMINA_WORKER_TOKEN="${LUMINA_WORKER_TOKEN:-$file_token}"
fi
export LUMINA_UI_MODE="local-loopback"
FFPROBE="${LUMINA_FFPROBE_PATH:-$(find "$PROJECT_ROOT/node_modules/@ffprobe-installer" -mindepth 2 -maxdepth 2 -type f -name ffprobe -perm -u+x -print -quit 2>/dev/null || true)}"
[[ -x "$FFPROBE" ]] || { printf '%s\n' 'Project FFprobe is missing; run npm install.' >&2; exit 1; }
export LUMINA_FFPROBE_PATH="$FFPROBE"
if [[ -z "${LUMINA_SHA256_PATH:-}" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    LUMINA_SHA256_PATH="$(command -v sha256sum)"
  elif command -v shasum >/dev/null 2>&1; then
    LUMINA_SHA256_PATH="$(command -v shasum)"
  else
    printf '%s\n' 'sha256sum or shasum is required for narration upload verification.' >&2
    exit 1
  fi
fi
export LUMINA_SHA256_PATH
export LUMINA_POCKETBASE_WORKER_BASE_URL="${LUMINA_POCKETBASE_WORKER_BASE_URL:-http://127.0.0.1:8090}"

if [[ ! -x "$EXECUTABLE" ]]; then
  "$PROJECT_ROOT/scripts/setup-pocketbase.sh"
fi

is_sqlite() {
  [[ -f "$1" ]] && [[ "$(LC_ALL=C head -c 15 "$1" 2>/dev/null || true)" == "SQLite format 3" ]]
}

if [[ -f "$DATA_DIR/data.db" ]] && ! is_sqlite "$DATA_DIR/data.db"; then
  RECOVERY_DIR="$PROJECT_ROOT/.runtime/pocketbase-recovery"
  mkdir -p "$RECOVERY_DIR"
  RECOVERY_FILE="$RECOVERY_DIR/data.db.$(date -u +%Y%m%dT%H%M%SZ).$$"
  mv "$DATA_DIR/data.db" "$RECOVERY_FILE"
  printf 'Moved invalid PocketBase data to recoverable quarantine: %s\n' "$RECOVERY_FILE" >&2
fi

if [[ ! -f "$DATA_DIR/data.db" ]] && is_sqlite "$DATA_DIR/data.seed.db"; then
  cp "$DATA_DIR/data.seed.db" "$DATA_DIR/data.db"
fi

if [[ ! -f "$DATA_DIR/data.db" ]] && grep -q '^version https://git-lfs.github.com/spec/v1$' "$DATA_DIR/data.seed.db" 2>/dev/null; then
  "$PROJECT_ROOT/scripts/hydrate-pocketbase-seed.sh" "$DATA_DIR/data.seed.db" "$DATA_DIR/data.db"
fi

exec "$EXECUTABLE" serve \
  --dir="$DATA_DIR" \
  --hooksDir="$PROJECT_ROOT/pb_hooks" \
  --hooksWatch=false \
  --migrationsDir="$PROJECT_ROOT/pb_migrations" \
  --http="127.0.0.1:8090"
