#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXECUTABLE="${POCKETBASE_EXE:-$PROJECT_ROOT/tools/pocketbase/pocketbase}"
DATA_DIR="$PROJECT_ROOT/pb_data"

if [[ ! -x "$EXECUTABLE" ]]; then
  "$PROJECT_ROOT/scripts/setup-pocketbase.sh"
fi

is_sqlite() {
  [[ -f "$1" ]] && [[ "$(LC_ALL=C head -c 15 "$1" 2>/dev/null || true)" == "SQLite format 3" ]]
}

if [[ -f "$DATA_DIR/data.db" ]] && ! is_sqlite "$DATA_DIR/data.db"; then
  rm "$DATA_DIR/data.db"
fi

if [[ ! -f "$DATA_DIR/data.db" ]] && is_sqlite "$DATA_DIR/data.seed.db"; then
  cp "$DATA_DIR/data.seed.db" "$DATA_DIR/data.db"
fi

exec "$EXECUTABLE" serve \
  --dir="$DATA_DIR" \
  --hooksDir="$PROJECT_ROOT/pb_hooks" \
  --hooksWatch=false \
  --migrationsDir="$PROJECT_ROOT/pb_migrations" \
  --http="127.0.0.1:8090"
