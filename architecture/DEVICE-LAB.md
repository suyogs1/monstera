# Device Lab architecture (preliminary, Phase 0)

Device Lab is the part of MONSTERA that takes a built app to a real target and brings back
evidence: screenshots, logs, test results, and a machine-readable report. It is what moves a
capability from COMPILED to SIMULATOR-TESTED or PHYSICAL-DEVICE-TESTED.

Phase 0 sets up the contract and proves the underlying operations. It deliberately has no
scheduler, device pool, daemon, or web UI.

## Targets

| Target | Host | Underlying tools | Phase 0 status |
|---|---|---|---|
| `android-emulator` | Linux, Windows, macOS | Gradle, `emulator`, `adb` | Verified on a Windows host and on Linux CI (`android.yml`); `test` unsupported |
| `android-device` | Any host with USB/adb | Gradle, `adb` | Same adapter (`DL_TARGET_KIND=android-device`, `ANDROID_SERIAL`); never run on hardware |
| `ios-simulator` | macOS only | xtool (build), `xcrun simctl` | Verified in CI (`ios-simulator.yml`); `test` unsupported |
| `ios-device` | Linux/WSL/macOS + USB (usbmuxd) | xtool (`dev build --sign`, `install`, `launch`) | Implemented, never run; needs an Apple ID and an iPhone |

## Operation contract

Defined in `device-lab/contract/README.md`, with results validated by `device-lab/contract/result.schema.json`.

```
adapter <op> [args]   ->  one JSON line on stdout, tool chatter on stderr, exit 0/1/3
```

| Op | android-* | ios-simulator | ios-device |
|---|---|---|---|
| build | `gradlew assembleDebug` | `xtool dev build --triple arm64-apple-ios-simulator` | `xtool dev build --sign` |
| install | `adb install -r` | `simctl install` | `xtool install` |
| launch | `am start -W` | `simctl launch` | `xtool launch` |
| stop | `am force-stop` | `simctl terminate` | unsupported (xtool 1.24.0) |
| screenshot | `adb exec-out screencap -p` | `simctl io screenshot` | unsupported (candidate: libimobiledevice `idevicescreenshot`) |
| logs | `logcat -d` filtered | `log show` filtered by subsystem | unsupported (candidate: `idevicesyslog`) |
| test | unsupported (no automated tests) | **unsupported (no automated iOS tests)** | unsupported |
| report | aggregate `results.jsonl` into `report.json` | same | same |

`unsupported` is a valid result (exit 3), not a failure. It keeps gaps visible in reports
instead of hiding them.

## Implementation and verification matrix (G0)

Key: **V** = implemented and verified by a recorded run. **I** = implemented, never executed.
**U** = returns `unsupported` by design (verified to do so where marked V/U).

| Op | android-emulator | android-device | ios-simulator | ios-device |
|---|---|---|---|---|
| build | V (Linux CI run 42969821785; the local Windows build is evidenced by a direct Gradle log, not by this op) | I (same Gradle command as android-emulator, never run with this target kind) | V (CI, `xtool dev build --triple arm64-apple-ios-simulator`) | I (`xtool dev build --sign`; needs Apple ID) |
| install | V | I | V | I |
| launch | V | I | V | I |
| stop | V | I | V | U |
| screenshot | V | I | V | U |
| logs | V (lifecycle in logcat) | I | V (`scenePhase: active` after the `--info` fix, run 42972339058) | U |
| test | V/U (no automated tests) | U | **V/U: unsupported. No automated iOS tests exist.** | U |
| report | V | I | V | I |

Evidence: `docs/evidence/android-emulator/`, `docs/evidence/android-emulator-linux-ci/`,
`docs/evidence/ios-simulator-ci/`. UI interaction (taps) is verified on Android only, through
`tools/scripts/android-emulator-smoke.sh`, outside the contract. No interaction is verified on iOS.

## Run layout

```
device-lab/reports/runs/<RUN_ID>/<target>/
  results.jsonl      one contract line per op, in order
  report.json        array of results (written by `report`)
  *.png, logs.txt    artifacts referenced by results
```

`runs/` is git-ignored. Evidence that backs a claim in a phase report is copied to
`docs/evidence/<target>/` unchanged.

## Design decisions

1. Thin bash adapters over official tools. They run on Linux, macOS, CI runners and Git Bash,
   and add no dependencies. On Git Bash, `lib.sh` turns off MSYS path conversion
   (`MSYS_NO_PATHCONV=1`) and uses `C:/...` paths, because otherwise device paths like
   `/sdcard/ui.xml` get rewritten before they reach `adb.exe`.
2. One adapter per platform, target kind chosen by environment. Emulator and device share the
   same tools on Android. On iOS they share the build source and differ only in deployment.
3. Machine-readable results first. The future orchestrator, the G0-style reports and the
   `report-auditor` agent all read `results.jsonl`, not terminal output.
4. Interaction scripting is not part of the contract yet. The Android smoke script uses
   `uiautomator dump` to find widgets. A `test` op based on instrumented tests (Android) and
   XCUITest or in-app hooks (iOS) is a Phase 1 decision.

## Deferred (not Phase 0)

- Device pool, parallel runs, scheduling, retries.
- Physical-device screenshot/log capture on iOS.
- Performance capture (frame time, memory) for games.
- Automatic promotion of verification labels from reports.
