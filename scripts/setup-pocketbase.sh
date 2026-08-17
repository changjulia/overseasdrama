#!/usr/bin/env bash
set -euo pipefail

POCKETBASE_VERSION="${POCKETBASE_VERSION:-0.39.9}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="$PROJECT_ROOT/tools/pocketbase"
EXECUTABLE="$INSTALL_DIR/pocketbase"

if [[ -x "$EXECUTABLE" ]]; then
  printf 'PocketBase is ready: %s\n' "$EXECUTABLE"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM="darwin_arm64" ;;
  Darwin-x86_64) PLATFORM="darwin_amd64" ;;
  Linux-aarch64|Linux-arm64) PLATFORM="linux_arm64" ;;
  Linux-x86_64) PLATFORM="linux_amd64" ;;
  *) printf 'Unsupported platform: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
ARCHIVE="$(mktemp -t lumina-pocketbase.XXXXXX.zip)"
trap 'rm -f "$ARCHIVE"' EXIT
URL="https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_${PLATFORM}.zip"
printf 'Downloading PocketBase %s for %s...\n' "$POCKETBASE_VERSION" "$PLATFORM"
curl --fail --location --silent --show-error "$URL" --output "$ARCHIVE"
unzip -q -o "$ARCHIVE" pocketbase -d "$INSTALL_DIR"
chmod +x "$EXECUTABLE"
printf 'PocketBase installed: %s\n' "$EXECUTABLE"
