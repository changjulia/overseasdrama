#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${LUMINA_ANALYSIS_VENV:-$PROJECT_ROOT/.runtime/analysis-venv}"
REQUIREMENTS="$PROJECT_ROOT/processor/requirements-analysis.txt"
MODE="check"
REQUESTED_PYTHON="${LUMINA_ANALYSIS_PYTHON:-}"

usage() {
  cat <<'EOF'
用法: bash scripts/setup-analysis-env.sh [--check|--dry-run|--install] [--python PATH]

  --check      检查兼容 Python 和现有分析环境，不创建或安装（默认）
  --dry-run    显示将创建/安装的命令，不执行
  --install    创建项目本地虚拟环境并安装分析依赖（会下载大型包）
  --python     指定 Python 3.9–3.12 可执行文件

环境变量:
  LUMINA_ANALYSIS_PYTHON   等同于 --python
  LUMINA_ANALYSIS_VENV     覆盖虚拟环境路径（默认 .runtime/analysis-venv）
EOF
}

while (($#)); do
  case "$1" in
    --check) MODE="check"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --install) MODE="install"; shift ;;
    --python) [[ $# -ge 2 ]] || { printf '%s\n' '--python 缺少路径' >&2; exit 2; }; REQUESTED_PYTHON="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -f "$REQUIREMENTS" ]] || { printf '缺少依赖清单：%s\n' "$REQUIREMENTS" >&2; exit 1; }

python_is_compatible() {
  "$1" -c 'import sys; raise SystemExit(0 if (3, 9) <= sys.version_info[:2] < (3, 13) else 1)' >/dev/null 2>&1
}

describe_python() {
  "$1" -c 'import platform, sys; print(f"{sys.executable} (Python {platform.python_version()}, {platform.machine()})")'
}

select_python() {
  local candidate
  if [[ -n "$REQUESTED_PYTHON" ]]; then
    command -v "$REQUESTED_PYTHON" >/dev/null 2>&1 || { printf '指定的 Python 不可用：%s\n' "$REQUESTED_PYTHON" >&2; return 1; }
    python_is_compatible "$REQUESTED_PYTHON" || {
      printf '指定的 Python 版本不兼容：%s。分析依赖要求 Python 3.9–3.12；Python 3.13/3.14 暂不用于该环境。\n' "$(describe_python "$REQUESTED_PYTHON")" >&2
      return 1
    }
    printf '%s\n' "$REQUESTED_PYTHON"
    return
  fi
  for candidate in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && python_is_compatible "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  printf '%s\n' '未找到兼容 Python（需要 3.9–3.12）。macOS 可安装 Python 3.12；Linux 请使用发行版包或 pyenv。' >&2
  printf '%s\n' '安装后重新运行：bash scripts/setup-analysis-env.sh --python /path/to/python3.12 --check' >&2
  return 1
}

if [[ "$MODE" == "check" && -x "$VENV_DIR/bin/python" && -z "$REQUESTED_PYTHON" ]]; then
  PYTHON="$VENV_DIR/bin/python"
else
  PYTHON="$(select_python)" || exit 1
fi
printf '兼容 Python：%s\n' "$(describe_python "$PYTHON")"
printf '分析环境：%s\n' "$VENV_DIR"

if [[ "$MODE" == "dry-run" ]]; then
  printf 'DRY-RUN: %q -m venv %q\n' "$PYTHON" "$VENV_DIR"
  printf 'DRY-RUN: %q -m pip install --upgrade pip setuptools wheel\n' "$VENV_DIR/bin/python"
  printf 'DRY-RUN: %q -m pip install -r %q\n' "$VENV_DIR/bin/python" "$REQUIREMENTS"
  exit 0
fi

check_environment() {
  local env_python="$VENV_DIR/bin/python"
  if [[ ! -x "$env_python" ]]; then
    printf '分析环境尚未创建。确认 dry-run 后执行：bash scripts/setup-analysis-env.sh --install\n' >&2
    return 1
  fi
  python_is_compatible "$env_python" || { printf '现有分析环境的 Python 不兼容，请移动该目录后重新创建：%s\n' "$VENV_DIR" >&2; return 1; }
  if ! "$env_python" -c 'import faster_whisper, jsonschema, paddleocr, paddle' >/dev/null 2>&1; then
    printf '分析依赖未完整导入。使用以下命令查看具体缺失项：\n' >&2
    printf '  %q -c %q\n' "$env_python" 'import faster_whisper, jsonschema, paddleocr, paddle' >&2
    return 1
  fi
  printf '✓ 分析依赖可导入（faster-whisper、jsonschema、paddleocr、paddle）\n'
  printf '启动 worker 时将 LUMINA_PYTHON_EXE 设置为：%s\n' "$env_python"
}

if [[ "$MODE" == "check" ]]; then
  check_environment
  exit $?
fi

mkdir -p "$(dirname "$VENV_DIR")"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV_DIR" || {
    printf '%s\n' '创建 venv 失败。Linux 可能需要安装 python3-venv；macOS 请确认所选 Python 带有 venv。' >&2
    exit 1
  }
fi
"$VENV_DIR/bin/python" -m pip install --upgrade pip setuptools wheel
if ! "$VENV_DIR/bin/python" -m pip install -r "$REQUIREMENTS"; then
  printf '%s\n' '分析依赖安装失败。请保留上方 pip 错误并检查 Python 版本、CPU 架构、网络和可用磁盘空间。' >&2
  printf '%s\n' 'Apple Silicon 若 PaddlePaddle 无可用 wheel，请改用受支持的 Linux x86_64 分析 worker。' >&2
  exit 1
fi
check_environment
