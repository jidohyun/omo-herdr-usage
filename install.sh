#!/bin/sh
set -eu

REPO="${OMO_HERDR_USAGE_REPO:-https://github.com/jidohyun/omo-herdr-usage.git}"
REF="${OMO_HERDR_USAGE_REF:-main}"
AGENT_DIR="${OMO_CODING_AGENT_DIR:-${SENPI_CODING_AGENT_DIR:-$HOME/.omo/agent}}"
DEST="$AGENT_DIR/omo-herdr-usage"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "omo-herdr-usage: '$1' 이(가) 필요합니다" >&2; exit 1; }
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -d "$DEST" ] && command -v bun >/dev/null 2>&1; then
    OMO_CODING_AGENT_DIR="$AGENT_DIR" bun "$DEST/scripts/omo-install.ts" uninstall || true
  fi
  rm -rf "$DEST"
  echo "제거함: $DEST"
  exit 0
fi

need git
need bun

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --quiet --depth 1 origin "$REF"
  git -C "$DEST" checkout --quiet --force FETCH_HEAD
  echo "업데이트함: $DEST ($(git -C "$DEST" rev-parse --short HEAD))"
else
  mkdir -p "$AGENT_DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DEST"
  echo "내려받음: $DEST ($(git -C "$DEST" rev-parse --short HEAD))"
fi

OMO_CODING_AGENT_DIR="$AGENT_DIR" bun "$DEST/scripts/omo-install.ts" install
