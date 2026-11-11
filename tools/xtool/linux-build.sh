#!/usr/bin/env bash
# Build apps/ios on Linux with xtool, without an Apple ID (unsigned device build).
# Usage: tools/xtool/linux-build.sh <darwin.xtoolsdk.tar.gz | path/to/Xcode.xip>
# Requires: Swift toolchain on PATH (e.g. the official swift:<ver>-noble image), curl.
# Env: XTOOL_VERSION (default 1.24.0)
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"
SDK_INPUT="${1:?path to darwin.xtoolsdk.tar.gz or Xcode.xip required}"
XTOOL_VERSION="${XTOOL_VERSION:-1.24.0}"
WORK="${WORK:-$ROOT/.build-xtool}"
mkdir -p "$WORK"

step() { echo; echo "=== $* ==="; }

step "Host"
uname -a
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

step "Install Darwin SDK"
case "$SDK_INPUT" in
  *.tar.gz) tar -C "$WORK" -xzf "$SDK_INPUT"; SDK_PATH="$WORK/darwin.xtoolsdk" ;;
  *) SDK_PATH="$SDK_INPUT" ;;
esac
"$XTOOL" sdk install "$SDK_PATH"
"$XTOOL" sdk status || true
swift sdk list

step "xtool dev build (arm64-apple-ios, unsigned)"
cd "$ROOT/apps/ios"
"$XTOOL" dev build

step "Inspect output"
APP="$ROOT/apps/ios/xtool/MonsteraHello.app"
ls -la "$APP"
BIN="$APP/MonsteraHello"
od -An -tx1 -N8 "$BIN"   # Mach-O 64-bit magic: cf fa ed fe; cputype arm64: 0c 00 00 01
grep -a -o 'SpriteKit' "$BIN" | head -1 || true
tar -C "$(dirname "$APP")" -czf "$ROOT/MonsteraHello-unsigned.app.tar.gz" MonsteraHello.app
echo "RESULT: COMPILED (unsigned) -> MonsteraHello-unsigned.app.tar.gz"
