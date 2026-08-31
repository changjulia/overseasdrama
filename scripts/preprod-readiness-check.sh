#!/usr/bin/env bash
set -uo pipefail

# Read-only pre-production gate. It checks presence and policy only; secret
# values are never printed. It does not start services, mutate queues, migrate,
# back up, restore, deploy, publish, push, or create credentials.

PREPROD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREPROD_EVIDENCE_DIR="${LUMINA_PREPROD_EVIDENCE_DIR:-$PREPROD_ROOT/release-evidence/preprod-readiness/attestations}"
PREPROD_MIN_FREE_GB="${LUMINA_PREPROD_MIN_FREE_GB:-20}"
PREPROD_FAILURES=0
PREPROD_WARNINGS=0
PREPROD_RELEASE_SHA="$(git -C "$PREPROD_ROOT" rev-parse HEAD 2>/dev/null || true)"

preprod_pass() { printf '✓ %s\n' "$1"; }
preprod_fail() { printf '✗ %s\n' "$1" >&2; PREPROD_FAILURES=$((PREPROD_FAILURES + 1)); }
preprod_warn() { printf '! %s\n' "$1" >&2; PREPROD_WARNINGS=$((PREPROD_WARNINGS + 1)); }

preprod_secret_present() {
  local variable_name="$1"
  if [[ -n "${!variable_name:-}" ]]; then
    preprod_pass "$variable_name 已注入（值未输出）"
  else
    preprod_fail "$variable_name 未注入"
  fi
}

preprod_https_url() {
  local variable_name="$1" variable_value="${!1:-}"
  if [[ "$variable_value" == https://* ]]; then
    preprod_pass "$variable_name 使用 HTTPS（地址未输出）"
  else
    preprod_fail "$variable_name 必须配置为 HTTPS"
  fi
}

preprod_https_or_loopback() {
  local variable_name="$1" variable_value="${!1:-}"
  if [[ "$variable_value" == https://* || "$variable_value" == http://127.0.0.1:* || "$variable_value" == http://localhost:* ]]; then
    preprod_pass "$variable_name 为 HTTPS 或同机 loopback（地址未输出）"
  else
    preprod_fail "$variable_name 必须为 HTTPS，或仅限同机 loopback"
  fi
}

preprod_attestation() {
  local name="$1" path="$PREPROD_EVIDENCE_DIR/$2"
  if [[ ! -s "$path" ]]; then
    preprod_fail "$name 证据缺失：$2"
    return
  fi
  if python3 - "$path" "$PREPROD_RELEASE_SHA" >/dev/null 2>&1 <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
release = sys.argv[2]
valid = (
    payload.get("schemaVersion") == "preprod-attestation-v1"
    and payload.get("result") == "passed"
    and isinstance(release, str) and len(release) == 40
    and payload.get("releaseCommit") == release
    and isinstance(payload.get("environment"), str) and len(payload["environment"].strip()) >= 3
    and isinstance(payload.get("executedAt"), str) and "T" in payload["executedAt"]
    and isinstance(payload.get("operator"), str) and payload["operator"].strip()
    and isinstance(payload.get("reviewer"), str) and payload["reviewer"].strip()
    and payload["operator"].strip() != payload["reviewer"].strip()
    and payload.get("secretRedactionVerified") is True
    and payload.get("signedUrlRedactionVerified") is True
    and isinstance(payload.get("evidence"), list) and len(payload["evidence"]) > 0
)
raise SystemExit(0 if valid else 1)
PY
  then
    preprod_pass "$name 证据已存在"
  else
    preprod_fail "$name 证据无效：必须为当前 release SHA 的 passed 结果，且包含独立 operator/reviewer、证据和脱敏确认（$2）"
  fi
}

if [[ ! "$PREPROD_MIN_FREE_GB" =~ ^[0-9]+$ ]] || ((PREPROD_MIN_FREE_GB < 1)); then
  printf 'LUMINA_PREPROD_MIN_FREE_GB 必须是正整数\n' >&2
  exit 2
fi

printf '预生产只读就绪检查\n\n'

preprod_https_url EXTERNAL_OPEN_API_BASE_URL
preprod_secret_present EXTERNAL_OPEN_API_KEY
preprod_https_or_loopback POCKETBASE_URL
preprod_https_or_loopback LUMINA_POCKETBASE_WORKER_BASE_URL
preprod_secret_present LUMINA_WORKER_TOKEN
preprod_secret_present LUMINA_UI_GATEWAY_TOKEN
preprod_secret_present LUMINA_POCKETBASE_SUPERUSER_IDENTITY
preprod_secret_present LUMINA_POCKETBASE_SUPERUSER_PASSWORD
preprod_https_url LUMINA_SEMANTIC_ENDPOINT
if [[ -n "${DASHSCOPE_API_KEY:-}${LUMINA_SEMANTIC_API_KEY:-}${OPENAI_API_KEY:-}" ]]; then
  preprod_pass "语义模型凭据已注入（值未输出）"
else
  preprod_fail "语义模型凭据未注入"
fi
if [[ -n "${LUMINA_SEMANTIC_MODEL:-}" ]]; then preprod_pass "LUMINA_SEMANTIC_MODEL 已配置"; else preprod_fail "LUMINA_SEMANTIC_MODEL 未配置"; fi
if [[ "${LUMINA_UI_MODE:-}" == "local-loopback" ]]; then preprod_fail "预生产禁止 LUMINA_UI_MODE=local-loopback"; else preprod_pass "未启用本地 UI 信任模式"; fi

if [[ -n "${LUMINA_FACTORY_RENDER_DIR:-}" && "$LUMINA_FACTORY_RENDER_DIR" == /* ]]; then
  if [[ -d "$LUMINA_FACTORY_RENDER_DIR" && -w "$LUMINA_FACTORY_RENDER_DIR" ]]; then
    preprod_pass "渲染产物持久目录已显式配置且可写（路径未输出）"
  else
    preprod_fail "LUMINA_FACTORY_RENDER_DIR 已配置，但目录不存在或不可写"
  fi
else
  preprod_fail "预生产必须显式配置绝对路径 LUMINA_FACTORY_RENDER_DIR，不得使用 public/renders 默认值"
fi

for ignored_path in .env.analysis.local .analysis-worker-token pb_data/data.db .runtime/analysis-cache/probe.json public/renders/probe.mp4; do
  if git -C "$PREPROD_ROOT" check-ignore -q "$ignored_path"; then
    preprod_pass "$ignored_path 受 Git ignore 保护"
  else
    preprod_fail "$ignored_path 未受 Git ignore 保护"
  fi
done

tracked_sensitive_count="$(git -C "$PREPROD_ROOT" ls-files | awk '/(^|\/)(\.env($|\.)|\.analysis-worker-token$|pb_data\/data\.db($|\.)|\.runtime\/|public\/renders\/)/ && $0 != ".env.analysis.example" {count++} END {print count+0}')"
if [[ "$tracked_sensitive_count" == "0" ]]; then preprod_pass "未跟踪运行凭据、运行数据库、缓存或渲染产物"; else preprod_fail "Git 中发现 $tracked_sensitive_count 个运行敏感路径"; fi

if [[ -n "$(git -C "$PREPROD_ROOT" status --porcelain)" ]]; then
  preprod_fail "工作区未冻结；不得以未说明变更作为发布候选"
else
  preprod_pass "工作区已冻结"
fi

available_kb="$(df -Pk "$PREPROD_ROOT" | awk 'NR==2 {print $4}')"
required_kb=$((PREPROD_MIN_FREE_GB * 1024 * 1024))
if [[ "$available_kb" =~ ^[0-9]+$ ]] && ((available_kb >= required_kb)); then
  preprod_pass "剩余磁盘空间达到 ${PREPROD_MIN_FREE_GB} GiB 门槛"
else
  preprod_fail "剩余磁盘空间低于 ${PREPROD_MIN_FREE_GB} GiB 门槛"
fi

if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$PREPROD_ROOT/pb_data/data.db" ]]; then
  preprod_db_uri="file:$PREPROD_ROOT/pb_data/data.db?mode=ro"
  if [[ "$(sqlite3 -readonly "$preprod_db_uri" 'PRAGMA quick_check;' 2>/dev/null)" == "ok" ]]; then preprod_pass "PocketBase SQLite quick_check 通过"; else preprod_fail "PocketBase SQLite quick_check 未通过"; fi
  preprod_db_mode="$(stat -f '%Lp' "$PREPROD_ROOT/pb_data/data.db" 2>/dev/null || stat -c '%a' "$PREPROD_ROOT/pb_data/data.db" 2>/dev/null || true)"
  if [[ "$preprod_db_mode" =~ ^[0-7]{3,4}$ && "${preprod_db_mode: -1}" == "0" ]]; then preprod_pass "PocketBase 运行数据库不对 other 用户开放"; else preprod_fail "PocketBase 运行数据库权限过宽，必须收紧为 0600/0640 等策略"; fi
else
  preprod_fail "无法以只读方式检查 PocketBase 数据库"
fi

if [[ -f "$PREPROD_ROOT/.openai/hosting.json" ]]; then
  preprod_warn "仓库关联了 Sites 托管项目；本地无法证明主分支自动发布已关闭"
fi
if [[ -d "$PREPROD_ROOT/.github/workflows" ]] && find "$PREPROD_ROOT/.github/workflows" -type f -print -quit | grep -q .; then
  preprod_warn "发现仓库内 CI/CD workflow，需逐一审核触发分支和环境"
else
  preprod_pass "未发现仓库内 GitHub Actions workflow"
fi

preprod_attestation "同一时点数据库+媒体+成片备份恢复演练" backup-restore.json
preprod_attestation "监控告警投递演练" monitoring-alerts.json
preprod_attestation "worker 容量与峰值队列演练" worker-capacity.json
preprod_attestation "迁移、向前修复与整快照回滚演练" migration-rollback.json
preprod_attestation "自动部署、分支保护与人工批准策略" deployment-policy.json

printf '\n预生产检查完成：%d 个失败，%d 个警告。\n' "$PREPROD_FAILURES" "$PREPROD_WARNINGS"
exit "$PREPROD_FAILURES"
