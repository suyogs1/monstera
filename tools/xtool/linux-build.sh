#!/usr/bin/env bash
# Build the G0 reference app reference/g0/ios on Linux with xtool, without an Apple ID (unsigned device build).
# Usage: tools/xtool/linux-build.sh [Xcode.xip | Xcode.app | darwin.xtoolsdk(.tar.gz)]
#   With an argument: install the Darwin SDK from YOUR OWN Xcode download, then build.
#   Without:          use the Darwin SDK already installed for this user (`swift sdk list`).
# The Darwin SDK is derived from Xcode. Never commit it, publish it, or upload it as a CI artifact.
# Requires: Swift toolchain on PATH (e.g. the official swift:<ver>-noble image), curl.
# Env: XTOOL_VERSION (default 1.24.0)
#      XTOOL_ALLOW_NO_SDK=1  exit 0 after the toolchain check if no SDK is available
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
SDK_INPUT="${1:-}"
XTOOL_VERSION="${XTOOL_VERSION:-1.24.0}"
WORK="${WORK:-$ROOT/.build-xtool}"
mkdir -p "$WORK"

step() { echo; echo "=== $* ==="; }

step "Host"
uname -a
# shellcheck source=/dev/null
. /etc/os-release && echo "$PRETTY_NAME"
swift --version

step "Install xtool $XTOOL_VERSION (AppImage, extracted so FUSE is not needed)"
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }
curl -fsSL "https://github.com/xtool-org/xtool/releases/download/${XTOOL_VERSION}/xtool-$(uname -m).AppImage" \
  -o "$WORK/xtool.AppImage"
chmod +x "$WORK/xtool.AppImage"
(cd "$WORK" && ./xtool.AppImage --appimage-extract >/dev/null)
XTOOL="$WORK/squashfs-root/AppRun"
"$XTOOL" --help | head -3

step "Validate package manifest on Linux"
(cd "$ROOT/reference/g0/ios" && swift package describe | head -20)

step "Darwin SDK"
if [ -n "$SDK_INPUT" ]; then
  case "$SDK_INPUT" in
    *.tar.gz) tar -C "$WORK" -xzf "$SDK_INPUT"; SDK_PATH="$WORK/darwin.xtoolsdk" ;;
    *) SDK_PATH="$SDK_INPUT" ;;
  esac
  "$XTOOL" sdk install "$SDK_PATH"
fi
if ! swift sdk list 2>/dev/null | grep -qx darwin; then
  echo "No Darwin SDK installed. Provide your own Xcode.xip (see docs/XTOOL-EXPERIMENT.md)."
  if [ "${XTOOL_ALLOW_NO_SDK:-0}" = "1" ]; then
    echo "RESULT: SKIPPED build (toolchain check only)"; exit 0
  fi
  exit 1
fi
"$XTOOL" sdk status || true

step "xtool dev build (arm64-apple-ios, unsigned)"
cd "$ROOT/reference/g0/ios"
"$XTOOL" dev build

step "Inspect output"
APP="$ROOT/reference/g0/ios/xtool/MonsteraHello.app"
ls -la "$APP"
BIN="$APP/MonsteraHello"
od -An -tx1 -N8 "$BIN"   # Mach-O 64-bit magic: cf fa ed fe; cputype arm64: 0c 00 00 01
grep -a -o 'SpriteKit' "$BIN" | head -1 || true
tar -C "$(dirname "$APP")" -czf "$ROOT/MonsteraHello-unsigned.app.tar.gz" MonsteraHello.app
echo "RESULT: COMPILED (unsigned) -> MonsteraHello-unsigned.app.tar.gz"
