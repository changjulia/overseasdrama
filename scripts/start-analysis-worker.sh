#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUEUE="${LUMINA_WORKER_QUEUE:-both}"
INSTANCE=""
DEVICE=""
COMPUTE_TYPE=""
JOB_ID=""
ONCE=0

usage() {
  cat <<'EOF'
Usage: scripts/start-analysis-worker.sh [options]
  --queue drama|material|both  Queue to claim (default: both)
  --instance NAME              Safe instance suffix for PID/worker ID
  --device cpu|cuda            Override Whisper device
  --compute-type TYPE          Override Whisper compute type
  --job-id ID                  Claim one exact drama/material job
  --once                       Exit after one claim attempt
EOF
}

while (($#)); do
  case "$1" in
    --queue) QUEUE="${2:?missing --queue value}"; shift 2 ;;
    --instance) INSTANCE="${2:?missing --instance value}"; shift 2 ;;
    --device) DEVICE="${2:?missing --device value}"; shift 2 ;;
    --compute-type) COMPUTE_TYPE="${2:?missing --compute-type value}"; shift 2 ;;
    --job-id) JOB_ID="${2:?missing --job-id value}"; shift 2 ;;
    --once) ONCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$QUEUE" =~ ^(drama|material|both)$ ]] || { printf 'Invalid queue: %s\n' "$QUEUE" >&2; exit 2; }
[[ -z "$INSTANCE" || "$INSTANCE" =~ ^[A-Za-z0-9_-]+$ ]] || { printf 'Invalid instance: %s\n' "$INSTANCE" >&2; exit 2; }
[[ -z "$DEVICE" || "$DEVICE" =~ ^(cpu|cuda)$ ]] || { printf 'Invalid device: %s\n' "$DEVICE" >&2; exit 2; }
if [[ -n "$JOB_ID" && "$QUEUE" == "both" ]]; then
  printf '%s\n' '--job-id requires --queue drama or --queue material' >&2
  exit 2
fi

# Parse the local dotenv as data. Never source it: values must not execute shell code.
ENV_FILE="$PROJECT_ROOT/.env.analysis.local"
if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ ( "$value" == \"*\" && "$value" == *\" ) || ( "$value" == \'*\' && "$value" == *\' ) ]]; then
        value="${value:1:${#value}-2}"
      fi
      [[ -n "${!name+x}" ]] || export "$name=$value"
    else
      printf 'Invalid environment line in %s (refusing to source it): %s\n' "$ENV_FILE" "$line" >&2
      exit 2
    fi
  done < "$ENV_FILE"
fi

TOKEN_FILE="$PROJECT_ROOT/.analysis-worker-token"
file_token=""
if [[ -s "$TOKEN_FILE" ]]; then
  file_token="$(tr -d '\r\n' < "$TOKEN_FILE")"
fi
if [[ -n "${LUMINA_WORKER_TOKEN:-}" && -n "$file_token" && "$LUMINA_WORKER_TOKEN" != "$file_token" ]]; then
  printf '%s\n' 'LUMINA_WORKER_TOKEN differs from .analysis-worker-token; refusing to start.' >&2
  exit 1
fi
export LUMINA_WORKER_TOKEN="${LUMINA_WORKER_TOKEN:-$file_token}"
[[ -n "$LUMINA_WORKER_TOKEN" ]] || { printf '%s\n' 'Set LUMINA_WORKER_TOKEN or create .analysis-worker-token.' >&2; exit 1; }
if [[ -z "${LUMINA_SEMANTIC_API_KEY:-}" && -z "${DASHSCOPE_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" ]]; then
  printf '%s\n' 'Configure DASHSCOPE_API_KEY, LUMINA_SEMANTIC_API_KEY, or OPENAI_API_KEY in .env.analysis.local.' >&2
  exit 1
fi

FFMPEG="$PROJECT_ROOT/node_modules/ffmpeg-static/ffmpeg"
FFPROBE="$(find "$PROJECT_ROOT/node_modules/@ffprobe-installer" -mindepth 2 -maxdepth 2 -type f -name ffprobe -perm -u+x -print -quit 2>/dev/null || true)"
[[ -x "$FFMPEG" ]] || { printf 'Project FFmpeg is missing; run npm install: %s\n' "$FFMPEG" >&2; exit 1; }
[[ -x "$FFPROBE" ]] || { printf '%s\n' 'Project FFprobe is missing; run npm install.' >&2; exit 1; }
export PATH="$(dirname "$FFMPEG"):$(dirname "$FFPROBE"):$PATH"

export LUMINA_SEMANTIC_PROVIDER="${LUMINA_SEMANTIC_PROVIDER:-openai-chat-completions}"
export LUMINA_SEMANTIC_ENDPOINT="${LUMINA_SEMANTIC_ENDPOINT:-https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions}"
export LUMINA_SEMANTIC_MODEL="${LUMINA_SEMANTIC_MODEL:-qwen-vl-max}"
export LUMINA_WHISPER_MODEL="${LUMINA_WHISPER_MODEL:-small}"
export LUMINA_WHISPER_DEVICE="${DEVICE:-${LUMINA_WHISPER_DEVICE:-cpu}}"
export LUMINA_WHISPER_COMPUTE_TYPE="${COMPUTE_TYPE:-${LUMINA_WHISPER_COMPUTE_TYPE:-int8}}"
export LUMINA_OCR_LANGUAGE="${LUMINA_OCR_LANGUAGE:-en}"
export NEXT_PUBLIC_POCKETBASE_URL="${NEXT_PUBLIC_POCKETBASE_URL:-http://127.0.0.1:8090}"

PYTHON="${LUMINA_PYTHON_EXE:-}"
if [[ -z "$PYTHON" && -x "$PROJECT_ROOT/.runtime/analysis-venv/bin/python" ]]; then
  PYTHON="$PROJECT_ROOT/.runtime/analysis-venv/bin/python"
fi
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || { printf 'Python is unavailable: %s\n' "$PYTHON" >&2; exit 1; }

instance_suffix="${INSTANCE:+-$INSTANCE}"
PID_FILE="$PROJECT_ROOT/.analysis-worker-$QUEUE$instance_suffix.pid"
if [[ -s "$PID_FILE" ]]; then
  old_pid="$(<"$PID_FILE")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    printf '%s worker is already running (PID %s).\n' "$QUEUE$instance_suffix" "$old_pid"
    exit 0
  fi
  rm -f "$PID_FILE"
fi
printf '%s\n' "$$" > "$PID_FILE"
child_pid=""
cleanup() {
  [[ -n "$child_pid" ]] && kill "$child_pid" 2>/dev/null || true
  [[ -f "$PID_FILE" && "$(<"$PID_FILE")" == "$$" ]] && rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

args=(-m processor.job_worker --base-url "$NEXT_PUBLIC_POCKETBASE_URL" --queue "$QUEUE" --worker-id "$QUEUE-worker$instance_suffix-$$")
((ONCE)) && args+=(--once)
[[ -n "$JOB_ID" ]] && args+=(--job-id "$JOB_ID")
cd "$PROJECT_ROOT"
"$PYTHON" "${args[@]}" &
child_pid=$!
wait "$child_pid"
status=$?
child_pid=""
exit "$status"
