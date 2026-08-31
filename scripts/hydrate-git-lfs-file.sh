#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s <lfs-pointer-file> <output-file>\n' "$(basename "$0")" >&2
}

if [[ "$#" -ne 2 ]]; then
  usage
  exit 2
fi

POINTER_FILE="$1"
OUTPUT_FILE="$2"

if [[ -e "$OUTPUT_FILE" || -L "$OUTPUT_FILE" ]]; then
  printf 'Refusing to overwrite existing output: %s\n' "$OUTPUT_FILE" >&2
  exit 1
fi
if [[ ! -f "$POINTER_FILE" ]]; then
  printf 'Git LFS pointer is missing: %s\n' "$POINTER_FILE" >&2
  exit 1
fi

VERSION_COUNT="$(awk '$0 == "version https://git-lfs.github.com/spec/v1" {count++} END {print count+0}' "$POINTER_FILE")"
OID_COUNT="$(awk '/^oid sha256:/ {count++} END {print count+0}' "$POINTER_FILE")"
SIZE_COUNT="$(awk '/^size / {count++} END {print count+0}' "$POINTER_FILE")"
OID="$(awk '/^oid sha256:/ {sub(/^oid sha256:/, ""); print}' "$POINTER_FILE")"
SIZE="$(awk '/^size / {print $2}' "$POINTER_FILE")"
if [[ "$VERSION_COUNT" != 1 || "$OID_COUNT" != 1 || "$SIZE_COUNT" != 1 || ! "$OID" =~ ^[0-9a-f]{64}$ || ! "$SIZE" =~ ^[0-9]+$ ]]; then
  printf 'Git LFS pointer is invalid: %s\n' "$POINTER_FILE" >&2
  exit 1
fi

REPOSITORY_ROOT="$(git -C "$(dirname "$POINTER_FILE")" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPOSITORY_ROOT" ]]; then
  printf 'Git LFS pointer must be inside a Git repository: %s\n' "$POINTER_FILE" >&2
  exit 1
fi
REMOTE="$(git -C "$REPOSITORY_ROOT" remote get-url origin 2>/dev/null || true)"
if [[ "$REMOTE" != https://* ]]; then
  printf 'Git LFS hydration requires an HTTPS origin remote; current origin: %s\n' "$REMOTE" >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
BATCH_FILE="$TEMP_DIR/batch.json"
DOWNLOAD_FILE="$TEMP_DIR/object"
PAYLOAD="$(printf '{"operation":"download","transfers":["basic"],"objects":[{"oid":"%s","size":%s}]}' "$OID" "$SIZE")"

curl --fail --silent --show-error \
  -X POST \
  -H 'Accept: application/vnd.git-lfs+json' \
  -H 'Content-Type: application/vnd.git-lfs+json' \
  -d "$PAYLOAD" \
  "${REMOTE%/}/info/lfs/objects/batch" \
  -o "$BATCH_FILE"

DOWNLOAD_SPEC="$(node - "$BATCH_FILE" <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const object = response.objects?.[0];
const action = object?.actions?.download;
if (!object || object.error || !action || typeof action.href !== "string" || !action.href.startsWith("https://")) {
  process.exit(1);
}
const header = action.header && typeof action.header === "object" ? action.header : {};
process.stdout.write(JSON.stringify({ href: action.href, header }));
NODE
)" || {
  printf 'Git LFS server did not provide a valid HTTPS download action.\n' >&2
  exit 1
}

DOWNLOAD_URL="$(node -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.href)' "$DOWNLOAD_SPEC")"
CURL_DOWNLOAD_ARGS=(--fail --location --silent --show-error)
while IFS= read -r HEADER; do
  CURL_DOWNLOAD_ARGS+=( -H "$HEADER" )
done < <(node -e 'const v=JSON.parse(process.argv[1]); for (const [k,val] of Object.entries(v.header)) console.log(`${k}: ${val}`)' "$DOWNLOAD_SPEC")
CURL_DOWNLOAD_ARGS+=( "$DOWNLOAD_URL" -o "$DOWNLOAD_FILE" )
curl "${CURL_DOWNLOAD_ARGS[@]}"

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_OID="$(shasum -a 256 "$DOWNLOAD_FILE" | awk '{print $1}')"
else
  ACTUAL_OID="$(sha256sum "$DOWNLOAD_FILE" | awk '{print $1}')"
fi
ACTUAL_SIZE="$(wc -c < "$DOWNLOAD_FILE" | tr -d '[:space:]')"
if [[ "$ACTUAL_OID" != "$OID" || "$ACTUAL_SIZE" != "$SIZE" ]]; then
  printf 'Downloaded object failed Git LFS integrity validation (expected sha256:%s size %s; got sha256:%s size %s).\n' \
    "$OID" "$SIZE" "$ACTUAL_OID" "$ACTUAL_SIZE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
mv "$DOWNLOAD_FILE" "$OUTPUT_FILE"
printf 'Git LFS object hydrated and verified: %s\n' "$OUTPUT_FILE"
