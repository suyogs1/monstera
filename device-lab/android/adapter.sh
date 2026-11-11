#!/usr/bin/env bash
# Device Lab adapter: Android emulator / physical device via adb.
# Usage: device-lab/android/adapter.sh <build|install|launch|stop|screenshot|logs|test|report> [args]
# Env: ANDROID_SERIAL (adb target), DL_TARGET_KIND=android-emulator|android-device (default emulator)
#      DL_APP_DIR      repo-relative Gradle project dir      (required by build, install)
#      DL_APP_PACKAGE  applicationId                         (required by launch, stop)
#      DL_APP_LOG_TAG  logcat tag the app logs under         (required by logs)
#      There is no default app (since G1.5): the G0 reference app is reference/g0/android.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "$(dirname "$0")/../lib.sh"
dl_init "${DL_TARGET_KIND:-android-emulator}"

APP_DIR="$DL_ROOT/${DL_APP_DIR:-}"
APK="$APP_DIR/app/build/outputs/apk/debug/app-debug.apk"
PKG="${DL_APP_PACKAGE:-}"
LOG_TAG="${DL_APP_LOG_TAG:-}"
ACTIVITY="$PKG/.MainActivity"
ADB="${ADB:-adb}"
GRADLEW="./gradlew"; [ "${OS:-}" = "Windows_NT" ] && GRADLEW="./gradlew.bat"

op="${1:?op required}"; shift || true
case "$op" in
  build)
    dl_require build DL_APP_DIR
    if (cd "$APP_DIR" && "$GRADLEW" assembleDebug --no-daemon) >&2; then
      cp "$APK" "$DL_OUT/"; dl_result build ok "$DL_OUT/app-debug.apk"
    else dl_result build failed "" "gradle assembleDebug failed"; exit 1; fi ;;
  install)
    dl_require install DL_APP_DIR
    "$ADB" wait-for-device >&2
    if "$ADB" install -r "$APK" >&2; then dl_result install ok
    else dl_result install failed "" "adb install failed"; exit 1; fi ;;
  launch)
    dl_require launch DL_APP_PACKAGE
    "$ADB" logcat -c >&2 || true
    if "$ADB" shell am start -W -n "$ACTIVITY" >&2; then dl_result launch ok
    else dl_result launch failed "" "am start failed"; exit 1; fi ;;
  stop)
    dl_require stop DL_APP_PACKAGE
    "$ADB" shell am force-stop "$PKG" >&2; dl_result stop ok ;;
  screenshot)
    f="$DL_OUT/${1:-screenshot}.png"
    # exec-out avoids CRLF corruption of the binary stream.
    "$ADB" exec-out screencap -p > "$f"
    if [ -s "$f" ]; then dl_result screenshot ok "$f"
    else dl_result screenshot failed "" "empty screenshot"; exit 1; fi ;;
  logs)
    dl_require logs DL_APP_LOG_TAG
    f="$DL_OUT/logs.txt"
    "$ADB" logcat -d -v time "$LOG_TAG:I" AndroidRuntime:E ActivityTaskManager:I '*:S' > "$f"
    dl_result logs ok "$f" ;;
  test)
    dl_unsupported test "no automated tests in Phase 0 hello world" ;;
  report)
    dl_report ;;
  *) echo "unknown op: $op" >&2; exit 2 ;;
esac
