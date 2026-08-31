#!/usr/bin/env bash
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PB_URL="${NEXT_PUBLIC_POCKETBASE_URL:-http://127.0.0.1:8090}"
ANALYSIS_ENV_FILE="${LUMINA_ANALYSIS_ENV_FILE:-$PROJECT_ROOT/.env.analysis.local}"
PROFILE="full"
FAILURES=0
WARNINGS=0

usage() {
  cat <<'EOF'
用法: bash scripts/runtime-check.sh [--profile render|analysis|full]

  render    渲染 worker：PocketBase、worker token、Pillow、项目内 ffmpeg/ffprobe
  analysis  分析 worker：render 条件 + 模型凭据、JSON Schema、ASR/OCR 依赖
  full      完整本地运行环境（默认）

设置 LUMINA_HOSTED_GATEWAY_CHECK=1 时，full profile 还会校验托管 Web 网关所需的
POCKETBASE_URL、LUMINA_UI_GATEWAY_TOKEN 与 PocketBase superuser 凭据。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 ]]; then usage >&2; exit 2; fi
      PROFILE="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  render|analysis|full) ;;
  *) printf '无效 profile：%s\n' "$PROFILE" >&2; usage >&2; exit 2 ;;
esac

pass() { printf '✓ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
warn() { printf '! %s\n' "$1" >&2; WARNINGS=$((WARNINGS + 1)); }

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1: $(command -v "$1")"
  else
    fail "缺少必需命令：$1"
  fi
}

require_project_media_tool() {
  local name="$1"
  local fallback=""
  if [[ "$name" == "ffmpeg" ]]; then
    fallback="$PROJECT_ROOT/node_modules/ffmpeg-static/ffmpeg"
  else
    fallback="$(find "$PROJECT_ROOT/node_modules/@ffprobe-installer" -mindepth 2 -maxdepth 2 -type f -name ffprobe -perm -u+x -print -quit 2>/dev/null || true)"
  fi
  if [[ -n "$fallback" && -x "$fallback" ]]; then
    pass "$name: ${fallback}（项目固定版本）"
  else
    fail "缺少项目内 $name（先执行 npm install）"
  fi
}

printf '运行预检 profile：%s\n\n' "$PROFILE"

require_command python3
require_project_media_tool ffmpeg
require_project_media_tool ffprobe

if [[ "$PROFILE" == "full" ]]; then
  require_command node
  require_command npm
  require_command curl
  NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [[ -n "$NODE_VERSION" ]] && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 && (Number(process.versions.node.split(".")[0]) > 22 || Number(process.versions.node.split(".")[1]) >= 13) ? 0 : 1)' 2>/dev/null; then
    pass "Node.js $NODE_VERSION 满足 >=22.13.0"
  else
    fail "Node.js $NODE_VERSION 不满足 >=22.13.0"
  fi
fi

PB_EXE="${POCKETBASE_EXE:-$PROJECT_ROOT/tools/pocketbase/pocketbase}"
if [[ -x "$PB_EXE" ]]; then pass "PocketBase: $PB_EXE"; else fail "PocketBase 不可执行；先运行 npm run pocketbase:setup"; fi

if command -v curl >/dev/null 2>&1 && curl --silent --fail --max-time 2 "$PB_URL/api/health" >/dev/null 2>&1; then
  pass "PocketBase 健康：$PB_URL/api/health"
else
  warn "PocketBase 未就绪：$PB_URL/api/health（可在启动服务前运行本预检）"
fi

if [[ -n "${LUMINA_WORKER_TOKEN:-}" || -s "$PROJECT_ROOT/.analysis-worker-token" ]]; then
  pass "worker 令牌已配置"
elif [[ -w "$PROJECT_ROOT" ]]; then
  pass "worker 令牌将在首次启动 PocketBase 时安全生成"
else
  fail "缺少 LUMINA_WORKER_TOKEN 或 .analysis-worker-token，且项目目录不可写，无法安全生成"
fi

if python3 -c 'import PIL' >/dev/null 2>&1; then pass "Pillow 可导入"; else fail "Pillow 不可导入：python3 -m pip install Pillow"; fi

if [[ "$PROFILE" == "analysis" || "$PROFILE" == "full" ]]; then
  if [[ -n "${DASHSCOPE_API_KEY:-}${LUMINA_SEMANTIC_API_KEY:-}${OPENAI_API_KEY:-}" ]]; then
    pass "语义模型凭据已通过当前环境配置"
  elif [[ -s "$ANALYSIS_ENV_FILE" ]] && grep -Eq '^(DASHSCOPE_API_KEY|LUMINA_SEMANTIC_API_KEY|OPENAI_API_KEY)=.+' "$ANALYSIS_ENV_FILE"; then
    pass "语义模型凭据已在 .env.analysis.local 配置"
  else
    fail "缺少 DASHSCOPE_API_KEY / LUMINA_SEMANTIC_API_KEY / OPENAI_API_KEY"
  fi

  ANALYSIS_PYTHON="${LUMINA_PYTHON_EXE:-}"
  if [[ -z "$ANALYSIS_PYTHON" && -x "$PROJECT_ROOT/.runtime/analysis-venv/bin/python" ]]; then
    ANALYSIS_PYTHON="$PROJECT_ROOT/.runtime/analysis-venv/bin/python"
  fi
  ANALYSIS_PYTHON="${ANALYSIS_PYTHON:-python3}"
  if ! command -v "$ANALYSIS_PYTHON" >/dev/null 2>&1; then
    fail "分析 Python 不可用：${ANALYSIS_PYTHON}（无法检查 jsonschema、faster-whisper、paddleocr）"
  elif ! "$ANALYSIS_PYTHON" -c 'import sys; raise SystemExit(0 if (3, 9) <= sys.version_info[:2] < (3, 13) else 1)' >/dev/null 2>&1; then
    fail "分析 Python 必须为 3.9–3.12：$($ANALYSIS_PYTHON -V 2>&1)（无法使用 jsonschema、faster-whisper、paddleocr 生产环境）"
  else
    pass "分析 Python 版本兼容：$($ANALYSIS_PYTHON -V 2>&1)"
    if "$ANALYSIS_PYTHON" -c 'import jsonschema' >/dev/null 2>&1; then pass "jsonschema 可导入"; else fail "jsonschema 不可导入：bash scripts/setup-analysis-env.sh --install"; fi
    if "$ANALYSIS_PYTHON" -c 'import faster_whisper' >/dev/null 2>&1; then pass "faster-whisper 可导入"; else fail "faster-whisper 不可导入"; fi
    if "$ANALYSIS_PYTHON" -c 'import paddleocr, paddle' >/dev/null 2>&1; then pass "paddleocr/paddle 可导入"; else fail "paddleocr/paddle 不可导入"; fi
  fi
fi

if [[ "$PROFILE" == "full" ]]; then
  EFFECTIVE_FFPROBE="${LUMINA_FFPROBE_PATH:-$(find "$PROJECT_ROOT/node_modules/@ffprobe-installer" -mindepth 2 -maxdepth 2 -type f -name ffprobe -perm -u+x -print -quit 2>/dev/null || true)}"
  EFFECTIVE_SHA256="${LUMINA_SHA256_PATH:-}"
  if [[ -z "$EFFECTIVE_SHA256" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then EFFECTIVE_SHA256="$(command -v sha256sum)";
    elif command -v shasum >/dev/null 2>&1; then EFFECTIVE_SHA256="$(command -v shasum)";
    fi
  fi
  EFFECTIVE_WORKER_BASE_URL="${LUMINA_POCKETBASE_WORKER_BASE_URL:-http://127.0.0.1:8090}"
  if [[ -x "$EFFECTIVE_FFPROBE" ]]; then pass "旁白上传 ffprobe 可用：$EFFECTIVE_FFPROBE"; else fail "缺少可执行的旁白上传 ffprobe"; fi
  if [[ -x "$EFFECTIVE_SHA256" ]]; then pass "旁白上传 SHA-256 工具可用：$EFFECTIVE_SHA256"; else fail "缺少可执行的 SHA-256 工具（sha256sum 或 shasum）"; fi
  if [[ "$EFFECTIVE_WORKER_BASE_URL" == https://* || "$EFFECTIVE_WORKER_BASE_URL" == http://127.0.0.1:* || "$EFFECTIVE_WORKER_BASE_URL" == http://localhost:* ]]; then
    pass "旁白媒体 worker 同源地址可用：$EFFECTIVE_WORKER_BASE_URL"
  else
    fail "LUMINA_POCKETBASE_WORKER_BASE_URL 必须是 HTTPS 或本机 loopback"
  fi
  if [[ -n "${EXTERNAL_OPEN_API_KEY:-}" ]]; then pass "外部短剧 API Key 已配置"; else warn "EXTERNAL_OPEN_API_KEY 未配置；外部数据导入不可用"; fi
  if [[ "${EXTERNAL_OPEN_API_BASE_URL:-}" == https://* ]]; then pass "外部短剧 API 使用 HTTPS"; else warn "EXTERNAL_OPEN_API_BASE_URL 未配置为 HTTPS；不得用于生产"; fi

  if [[ "${LUMINA_HOSTED_GATEWAY_CHECK:-0}" == "1" ]]; then
    if [[ "${POCKETBASE_URL:-}" == https://* || "${POCKETBASE_URL:-}" == http://127.0.0.1:* || "${POCKETBASE_URL:-}" == http://localhost:* ]]; then
      pass "托管网关 PocketBase 地址已配置"
    else
      fail "托管网关要求 POCKETBASE_URL 为 HTTPS，或由同机 Web 服务访问 loopback HTTP"
    fi
    if [[ -n "${LUMINA_UI_GATEWAY_TOKEN:-}" ]]; then pass "托管 UI gateway token 已配置"; else fail "缺少 LUMINA_UI_GATEWAY_TOKEN"; fi
    if [[ -n "${LUMINA_POCKETBASE_SUPERUSER_IDENTITY:-}" && -n "${LUMINA_POCKETBASE_SUPERUSER_PASSWORD:-}" ]]; then
      pass "托管网关 PocketBase superuser 凭据已配置"
    else
      fail "缺少 LUMINA_POCKETBASE_SUPERUSER_IDENTITY / LUMINA_POCKETBASE_SUPERUSER_PASSWORD"
    fi
    if [[ "${LUMINA_UI_MODE:-}" == "local-loopback" ]]; then
      fail "托管环境不得启用 LUMINA_UI_MODE=local-loopback"
    else
      pass "托管环境未启用本地 UI 信任模式"
    fi
  fi
fi

printf '\n预检完成：%d 个失败，%d 个警告。\n' "$FAILURES" "$WARNINGS"
exit "$FAILURES"
