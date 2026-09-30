#!/usr/bin/env bash
# Builds the DAR without assuming dpm/damlc is on PATH. Neither is a hard
# dependency of this repo — if one is already installed, use it as-is; if
# not, download dpm's own prebuilt binary (no install, no Docker image:
# none exists for the Daml SDK, same situation as Canton 3.x - see
# infra/README.md's "Why these choices") straight from its GitHub releases,
# into a local, gitignored cache, and run it from there. Reproduces exactly
# what got this repo's own DAR built the first time a machine had neither
# tool on PATH (2026-09-30).
set -euo pipefail

cd "$(dirname "$0")"

DAML_VERSION="${DAML_VERSION:-3.5.2}"

if command -v dpm >/dev/null 2>&1; then
  echo "build-dar.sh: using dpm already on PATH"
  DAML_VERSION="$DAML_VERSION" dpm build
  exit 0
fi

if command -v damlc >/dev/null 2>&1; then
  echo "build-dar.sh: using damlc already on PATH"
  damlc build --package-root .
  exit 0
fi

echo "build-dar.sh: neither dpm nor damlc found on PATH — downloading dpm to .dpm-cache/ (gitignored, not installed system-wide)"

case "$(uname -s)" in
  Darwin) OS_NAME=darwin ;;
  Linux) OS_NAME=linux ;;
  *)
    echo "build-dar.sh: unsupported OS '$(uname -s)' for the automatic download — install dpm or damlc yourself, see https://github.com/digital-asset/dpm/releases" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH_NAME=arm64 ;;
  x86_64|amd64) ARCH_NAME=amd64 ;;
  *)
    echo "build-dar.sh: unsupported architecture '$(uname -m)' for the automatic download — install dpm or damlc yourself, see https://github.com/digital-asset/dpm/releases" >&2
    exit 1
    ;;
esac

CACHE_DIR=".dpm-cache"
DPM_BIN="$CACHE_DIR/dpm"

if [ ! -x "$DPM_BIN" ]; then
  mkdir -p "$CACHE_DIR"
  ASSET_URL=$(curl -sL "https://api.github.com/repos/digital-asset/dpm/releases/latest" \
    | grep -oE "\"browser_download_url\": *\"[^\"]*dpm-[0-9.]+-${OS_NAME}-${ARCH_NAME}\.tar\.gz\"" \
    | sed -E 's/.*"(https[^"]+)".*/\1/')
  if [ -z "$ASSET_URL" ]; then
    echo "build-dar.sh: could not find a dpm release asset for ${OS_NAME}-${ARCH_NAME} — install dpm or damlc yourself, see https://github.com/digital-asset/dpm/releases" >&2
    exit 1
  fi
  echo "build-dar.sh: downloading $ASSET_URL"
  curl -sL -o "$CACHE_DIR/dpm.tar.gz" "$ASSET_URL"
  tar -xzf "$CACHE_DIR/dpm.tar.gz" -C "$CACHE_DIR"
  chmod +x "$DPM_BIN"
fi

DAML_VERSION="$DAML_VERSION" "$DPM_BIN" build
