#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-worker-queues.sh [--db PATH] [--json]

Read PocketBase worker queue health directly from SQLite without modifying it.
Exit 0 when no actionable jobs are found, 1 for expired leases/due retries/
exhausted attempts, and 2 for usage or database errors.
EOF
}

db_path="pb_data/data.db"
format="table"
while (($#)); do
  case "$1" in
    --db) db_path="${2:?missing --db path}"; shift 2 ;;
    --json) format="json"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v sqlite3 >/dev/null 2>&1 || { printf '%s\n' 'sqlite3 is required' >&2; exit 2; }
[[ -f "$db_path" ]] || { printf 'PocketBase database not found: %s\n' "$db_path" >&2; exit 2; }

# URI mode=ro is enforced by SQLite itself. Do not add immutable=1 here: on a
# live PocketBase WAL database it ignores the WAL and can report a stale schema
# or stale queue counts. mode=ro reads the existing WAL/SHM without mutating
# queue data.
abs_db="$(cd "$(dirname "$db_path")" && pwd -P)/$(basename "$db_path")"
db_uri="file:${abs_db}?mode=ro"

queues=(analysis_jobs material_analysis_jobs hook_match_jobs entry_precision_jobs supplemental_highlight_jobs factory_renders)
rows=()
attention=0

for queue in "${queues[@]}"; do
  exists="$(sqlite3 -readonly "$db_uri" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$queue';" 2>/dev/null)" || {
    printf 'Unable to read PocketBase database: %s\n' "$db_path" >&2; exit 2;
  }
  [[ "$exists" == "1" ]] || continue

  active_status="running"
  [[ "$queue" == "factory_renders" ]] && active_status="rendering"
  sql="SELECT
    sum(status='queued'),
    sum(status='$active_status'),
    sum(status='failed'),
    sum(status='$active_status' AND (lease_until IS NULL OR lease_until='' OR datetime(lease_until) <= datetime('now'))),
    sum(status='failed' AND attempt < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at='' OR datetime(next_attempt_at) <= datetime('now'))),
    sum(status='failed' AND attempt >= max_attempts)
    FROM \"$queue\";"
  values="$(sqlite3 -readonly -separator '|' "$db_uri" "$sql")" || {
    printf 'Queue schema is not observable for %s\n' "$queue" >&2; exit 2;
  }
  IFS='|' read -r queued active failed expired due exhausted <<<"$values"
  queued="${queued:-0}"; active="${active:-0}"; failed="${failed:-0}"
  expired="${expired:-0}"; due="${due:-0}"; exhausted="${exhausted:-0}"
  (( expired + due + exhausted > 0 )) && attention=1
  rows+=("$queue|$queued|$active|$failed|$expired|$due|$exhausted")
done

((${#rows[@]})) || { printf '%s\n' 'No known worker queue tables found' >&2; exit 2; }

if [[ "$format" == "json" ]]; then
  printf '{"source":"sqlite-readonly","queues":['
  first=1
  for row in "${rows[@]}"; do
    IFS='|' read -r queue queued active failed expired due exhausted <<<"$row"
    ((first)) || printf ','; first=0
    printf '{"queue":"%s","queued":%d,"active":%d,"failed":%d,"lease_expired":%d,"backoff_due":%d,"attempt_exhausted":%d}' \
      "$queue" "$queued" "$active" "$failed" "$expired" "$due" "$exhausted"
  done
  printf '],"attention_required":%s}\n' "$([[ "$attention" == 1 ]] && printf true || printf false)"
else
  printf '%-30s %7s %7s %7s %13s %11s %17s\n' QUEUE QUEUED ACTIVE FAILED LEASE_EXPIRED BACKOFF_DUE ATTEMPT_EXHAUSTED
  for row in "${rows[@]}"; do
    IFS='|' read -r queue queued active failed expired due exhausted <<<"$row"
    printf '%-30s %7d %7d %7d %13d %11d %17d\n' "$queue" "$queued" "$active" "$failed" "$expired" "$due" "$exhausted"
  done
fi

exit "$attention"
