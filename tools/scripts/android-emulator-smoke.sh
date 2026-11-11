#!/usr/bin/env bash
# Phase 0 Android smoke run on a booted emulator, via the Device Lab adapter (G0 reference app).
# Proves: install, launch, Compose interaction, lifecycle (pause/stop/resume), screenshot, logs.
# Usage: RUN_ID=<id> tools/scripts/android-emulator-smoke.sh   (emulator must already be booted)
set -euo pipefail
cd "$(dirname "$0")/../.."
A=device-lab/android/adapter.sh
ADB="${ADB:-adb}"; export ADB
# This script drives the G0 reference app specifically (it taps its "Tap me" button).
export DL_APP_DIR="${DL_APP_DIR:-reference/g0/android}"
export DL_APP_PACKAGE="${DL_APP_PACKAGE:-app.monstera.hello}"
export DL_APP_LOG_TAG="${DL_APP_LOG_TAG:-MonsteraHello}"
export MSYS_NO_PATHCONV=1 # see device-lab/lib.sh

"$ADB" wait-for-device
for _ in $(seq 1 180); do
  [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 2
done
[ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || { echo "emulator did not boot in 6 min" >&2; exit 1; }
echo "device: $("$ADB" shell getprop ro.product.model | tr -d '\r'), Android $("$ADB" shell getprop ro.build.version.release | tr -d '\r')" >&2

bash "$A" install
bash "$A" launch
sleep 4
bash "$A" screenshot 01-launched

# Tap the "Tap me" button twice. Coordinates come from the UI hierarchy, not hard-coded pixels.
"$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null
bounds="$("$ADB" exec-out cat /sdcard/ui.xml | grep -o 'text="Tap me"[^>]*' | grep -o 'bounds="[^"]*"' | head -1)"
[ -n "$bounds" ] || { echo "Tap me button not found in UI hierarchy" >&2; exit 1; }
[[ "$bounds" =~ \[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\] ]]
x=$(( (BASH_REMATCH[1] + BASH_REMATCH[3]) / 2 )); y=$(( (BASH_REMATCH[2] + BASH_REMATCH[4]) / 2 ))
echo "tap at $x,$y" >&2
"$ADB" shell input tap "$x" "$y"; sleep 1
"$ADB" shell input tap "$x" "$y"; sleep 1
bash "$A" screenshot 02-after-two-taps

# Background then foreground: exercises onPause/onStop/onStart/onResume.
"$ADB" shell input keyevent KEYCODE_HOME; sleep 2
"$ADB" shell am start -n "$DL_APP_PACKAGE/.MainActivity" >/dev/null; sleep 2
bash "$A" screenshot 03-resumed

bash "$A" logs
bash "$A" stop
bash "$A" test || true
bash "$A" report
