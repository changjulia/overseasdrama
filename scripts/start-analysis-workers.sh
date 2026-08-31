#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_SCRIPT="$PROJECT_ROOT/scripts/start-analysis-worker.sh"
RESTART_DELAY="${LUMINA_WORKER_RESTART_DELAY:-5}"
specs=()

usage() {
  cat <<'EOF'
Usage: scripts/start-analysis-workers.sh [--worker QUEUE[:INSTANCE]]... [--restart-delay SECONDS]

Defaults to drama, material and material:interactive. The supervisor runs in the
foreground, restarts failed workers, and stops all children on SIGINT/SIGTERM.
EOF
}

while (($#)); do
  case "$1" in
    --worker) specs+=("${2:?missing --worker value}"); shift 2 ;;
    --restart-delay) RESTART_DELAY="${2:?missing --restart-delay value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
((${#specs[@]})) || specs=(drama material material:interactive)
[[ "$RESTART_DELAY" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'Invalid restart delay: %s\n' "$RESTART_DELAY" >&2; exit 2; }

declare -a queues instances pids
for spec in "${specs[@]}"; do
  queue="${spec%%:*}"
  instance=""
  [[ "$spec" == *:* ]] && instance="${spec#*:}"
  [[ "$queue" =~ ^(drama|material|both)$ ]] || { printf 'Invalid worker queue: %s\n' "$queue" >&2; exit 2; }
  [[ -z "$instance" || "$instance" =~ ^[A-Za-z0-9_-]+$ ]] || { printf 'Invalid worker instance: %s\n' "$instance" >&2; exit 2; }
  queues+=("$queue")
  instances+=("$instance")
  pids+=("")
done

SUPERVISOR_PID_FILE="$PROJECT_ROOT/.analysis-workers-supervisor.pid"
if [[ -s "$SUPERVISOR_PID_FILE" ]]; then
  old_pid="$(<"$SUPERVISOR_PID_FILE")"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    printf 'Analysis worker supervisor is already running (PID %s).\n' "$old_pid"
    exit 0
  fi
  rm -f "$SUPERVISOR_PID_FILE"
fi
printf '%s\n' "$$" > "$SUPERVISOR_PID_FILE"

stopping=0
cleanup() {
  stopping=1
  trap - INT TERM
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  [[ -f "$SUPERVISOR_PID_FILE" && "$(<"$SUPERVISOR_PID_FILE")" == "$$" ]] && rm -f "$SUPERVISOR_PID_FILE"
}
trap cleanup EXIT INT TERM

start_worker() {
  local index="$1" queue="${queues[$1]}" instance="${instances[$1]}" label args log_base
  label="$queue${instance:+-$instance}"
  log_base="$PROJECT_ROOT/.analysis-worker-$label"
  args=(--queue "$queue")
  [[ -n "$instance" ]] && args+=(--instance "$instance")
  "$WORKER_SCRIPT" "${args[@]}" >>"$log_base.stdout.log" 2>>"$log_base.stderr.log" &
  pids[$index]=$!
  printf 'Started %s worker (PID %s); logs: %s.{stdout,stderr}.log\n' "$label" "${pids[$index]}" "$log_base"
}

for ((i=0; i<${#queues[@]}; i++)); do start_worker "$i"; done
printf '%s\n' 'Supervisor is running in the foreground. Press Ctrl-C to stop all workers.'
while (( ! stopping )); do
  for ((i=0; i<${#pids[@]}; i++)); do
    pid="${pids[$i]}"
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || status=$?
      printf '%s worker exited (status %s); restarting in %ss.\n' "${queues[$i]}${instances[$i]:+-${instances[$i]}}" "${status:-0}" "$RESTART_DELAY" >&2
      sleep "$RESTART_DELAY"
      (( stopping )) || start_worker "$i"
      unset status
    fi
  done
  sleep 1
done
