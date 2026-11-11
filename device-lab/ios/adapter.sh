#!/usr/bin/env bash
# Device Lab adapter: iOS Simulator (macOS, xcrun simctl) and physical iPhone (xtool).
# Usage: device-lab/ios/adapter.sh <build|install|launch|stop|screenshot|logs|test|report> [args]
# Env:
#   DL_TARGET_KIND = ios-simulator (default) | ios-device
#   SIM_DEVICE     = simulator UDID or "booted" (default "booted")
#   XTOOL          = xtool executable (default "xtool")
#   DL_APP_DIR, DL_APP_PRODUCT, DL_APP_BUNDLE_ID = select another SwiftPM app, e.g. a generated
#                    project (defaults: apps/ios, MonsteraHello, app.monstera.hello)
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "$(dirname "$0")/../lib.sh"
dl_init "${DL_TARGET_KIND:-ios-simulator}"

APP_DIR="$DL_ROOT/${DL_APP_DIR:-apps/ios}"
PRODUCT="${DL_APP_PRODUCT:-MonsteraHello}"
APP="$APP_DIR/xtool/$PRODUCT.app"
BUNDLE_ID="${DL_APP_BUNDLE_ID:-app.monstera.hello}"
SIM="${SIM_DEVICE:-booted}"
XTOOL="${XTOOL:-xtool}"

sim() { xcrun simctl "$@"; }

op="${1:?op required}"; shift || true

if [ "$DL_TARGET" = "ios-device" ]; then
  # Physical device: xtool provides build+sign, install and launch. Screenshot/logs/stop are not
  # exposed by xtool 1.24.0; they are unsupported until proven with another tool.
  case "$op" in
    build)
      if (cd "$APP_DIR" && "$XTOOL" dev build --sign) >&2; then dl_result build ok "$APP"
      else dl_result build failed "" "xtool dev build --sign failed"; exit 1; fi ;;
    install)
      if "$XTOOL" install "$APP" >&2; then dl_result install ok
      else dl_result install failed "" "xtool install failed"; exit 1; fi ;;
    launch)
      if "$XTOOL" launch "$BUNDLE_ID" >&2; then dl_result launch ok
      else dl_result launch failed "" "xtool launch failed"; exit 1; fi ;;
    report) dl_report ;;
    stop|screenshot|logs|test) dl_unsupported "$op" "not available via xtool 1.24.0" ;;
    *) echo "unknown op: $op" >&2; exit 2 ;;
  esac
  exit 0
fi

case "$op" in
  build)
    # Same SwiftPM package as the Linux build; only the target triple differs.
    if (cd "$APP_DIR" && "$XTOOL" dev build --triple "arm64-apple-ios-simulator") >&2 && [ -d "$APP" ]; then
      cp -R "$APP" "$DL_OUT/"; dl_result build ok "$DL_OUT/$PRODUCT.app"
    else dl_result build failed "" "xtool dev build (simulator) failed"; exit 1; fi ;;
  install)
    if sim install "$SIM" "$APP" >&2; then dl_result install ok
    else dl_result install failed "" "simctl install failed"; exit 1; fi ;;
  launch)
    if sim launch "$SIM" "$BUNDLE_ID" >&2; then dl_result launch ok
    else dl_result launch failed "" "simctl launch failed"; exit 1; fi ;;
  stop)
    sim terminate "$SIM" "$BUNDLE_ID" >&2 || true; dl_result stop ok ;;
  screenshot)
    f="$DL_OUT/${1:-screenshot}.png"
    if sim io "$SIM" screenshot "$f" >&2 && [ -s "$f" ]; then dl_result screenshot ok "$f"
    else dl_result screenshot failed "" "simctl screenshot failed"; exit 1; fi ;;
  logs)
    f="$DL_OUT/logs.txt"
    # --info: the app logs lifecycle at info level, which `log show` omits by default.
    sim spawn "$SIM" log show --last 10m --style compact --info \
      --predicate "subsystem == \"$BUNDLE_ID\" OR process == \"$PRODUCT\"" > "$f" 2>&1 || true
    dl_result logs ok "$f" ;;
  test)
    dl_unsupported test "unsupported: no automated iOS tests exist (no XCUITest target)" ;;
  report)
    dl_report ;;
  *) echo "unknown op: $op" >&2; exit 2 ;;
esac
