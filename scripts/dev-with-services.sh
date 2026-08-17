#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_LOG="$PROJECT_ROOT/.pocketbase.dev.log"

cleanup() {
  if [[ -n "${PB_PID:-}" ]] && kill -0 "$PB_PID" 2>/dev/null; then
    kill "$PB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! curl --silent --fail --max-time 1 http://127.0.0.1:8090/api/health >/dev/null 2>&1; then
  "$PROJECT_ROOT/scripts/start-pocketbase.sh" >"$PB_LOG" 2>&1 &
  PB_PID=$!
  for _ in {1..40}; do
    curl --silent --fail --max-time 1 http://127.0.0.1:8090/api/health >/dev/null 2>&1 && break
    if ! kill -0 "$PB_PID" 2>/dev/null; then
      printf 'PocketBase failed to start. See %s\n' "$PB_LOG" >&2
      exit 1
    fi
    sleep 0.25
  done
fi

cd "$PROJECT_ROOT"
exec npm run dev
