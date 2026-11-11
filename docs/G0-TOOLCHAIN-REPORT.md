# G0 Toolchain Report (Phase 0)

Date: 2026-11-11. Branch: `phase0/toolchain-proof`.

Labels follow `.kiro/steering/04-generation-and-provenance.md`: GENERATED < COMPILED <
SIMULATOR-TESTED < PHYSICAL-DEVICE-TESTED. Each row gets the highest label with evidence.

## Summary

| Platform / path | Label | Evidence |
|---|---|---|
| Android, Windows workstation, emulator | **SIMULATOR-TESTED** | `docs/evidence/android-emulator/` |
| Android, Linux (GitHub Actions), emulator | **SIMULATOR-TESTED** | `docs/evidence/android-emulator-linux-ci/` (run 42969821785; passed again in run 42972339283) |
| Android, physical device | COMPILED (same APK) | no device run |
| iOS, hosted macOS, xtool build for simulator | **SIMULATOR-TESTED** | `docs/evidence/ios-simulator-ci/`, run 42972339058 |
| iOS, Linux, xtool unsigned device build | **COMPILED** (historical; CI SDK transfer since disabled) | `docs/evidence/xtool-linux/`, run 42972339280 |
| iOS, physical iPhone via xtool | COMPILED (unsigned build only) | not attempted: needs Apple ID + iPhone |
| Device Lab contract and adapters | GENERATED (contract); ops proven per row above | `architecture/DEVICE-LAB.md`, `device-lab/` |

## Android

### Windows workstation (local)

- Build attempted: yes. `apps/android`: `gradlew assembleDebug` (Gradle 9.9.1, AGP 9.5.1, Kotlin
  Compose plugin 2.4.21, JBR 21.0.8, compileSdk 36).
- Build: **successful**. `app-debug.apk` 11,434,714 bytes. `:app:compileDebugKotlin` ran.
  Log: `docs/evidence/android-emulator/gradle-assembleDebug.log`, captured with a downloaded
  Gradle 9.9.1 distribution while the wrapper download was timing out. The committed wrapper
  (`gradlew.bat`) was then verified through the Device Lab `build` op (`BUILD SUCCESSFUL`).
- Obstacle: the first wrapper runs failed downloading the distribution (`timeout (10000ms)`,
  then `SSLHandshakeException`). It succeeded on retry; `networkTimeout` raised to 120000.
- Launched: **yes**. `am start -W`: `LaunchState: COLD`, `Status: ok`.
- Emulator: AVD `Pixel_9_Pro_XL`, `sdk_gphone64_x86_64`, Android 16, 1344x2992,
  `-gpu swiftshader_indirect`.
- Screenshots: yes. `01-launched.png` (Taps: 0), `02-after-two-taps.png`, `03-resumed.png`
  (Taps: 2 after HOME and relaunch).
- Lifecycle: logcat shows `onCreate, onStart, onResume, onPause, onStop, onStart, onResume`.
- Device Lab ops: build, install, launch, stop, screenshot, logs, report = ok; test = unsupported.

### Linux (GitHub Actions `android.yml`, ubuntu-24.04)

- Build: **successful** via the Device Lab `build` op (JDK 21).
- Launched: **yes**, API 36 `google_apis` x86_64 emulator with KVM, Android 16, 1080x2400.
- Screenshots: yes, same three steps. Taps: 2 confirmed. Same lifecycle sequence in logcat.

### Known limitations

- Compose BOM pinned to 2026.06.01 (Compose 1.11.4). BOM 2026.08.00+ requires compileSdk 37,
  which isn't installed locally. activity-compose pinned to 1.12.4 for the same reason.
- Headless emulator with host GPU failed locally (`eglMakeCurrent failed`, `null ctx`).
  `swiftshader_indirect` works.
- No automated tests (`test` op = unsupported). Interaction is scripted with `uiautomator dump` + `input tap`.
- Not run on a physical Android device.

### Next action

Decide on compileSdk 37 for Phase 1, add instrumented tests behind the `test` op, run once on a
physical device (`DL_TARGET_KIND=android-device ANDROID_SERIAL=...`).

## iOS: hosted macOS Simulator (`ios-simulator.yml`)

- Build attempted: yes. `xtool dev build --triple arm64-apple-ios-simulator` (xtool 1.24.0) on
  `macos-26` (macOS 26.7.2 as reported in run 42969821752), Xcode 26.6 (17F113), Swift 6.3.3,
  iPhoneSimulator26.5.sdk.
- Build: **successful**. All three Swift files compiled; `Build complete!`.
- Launched: **yes**. `simctl install` + `simctl launch` ok. The log shows
  `[app.monstera.hello:lifecycle] scenePhase: active`.
- Simulator: iPhone 17 Pro (first available iPhone on the runner).
- Screenshot: yes. `docs/evidence/ios-simulator-ci/01-launched.png` shows the SwiftUI text, the
  SpriteKit scene (orange circle on a dark background) and the button. A system "Ready for Apple
  Intelligence" banner covers the top of the screen.
- Known limitations: no tap is exercised on iOS (needs XCUITest or `simctl`-level input tooling).
  The first CI attempt hung because `Contents/MacOS/xtool` starts the GUI; fixed by using
  `Contents/Resources/bin/xtool`.
- Next action: add a UI interaction path for the `test` op; pin the simulator model/runtime.

## iOS: Linux build with xtool (`xtool-linux.yml`)

Full record: [XTOOL-EXPERIMENT.md](XTOOL-EXPERIMENT.md).

- Build attempted: yes, twice. Ubuntu 24.04 x86_64, `swift:6.4.2-noble`, xtool 1.24.0 AppImage
  (extracted), Darwin SDK generated on macOS from Xcode 26.6.
- Attempt 1: **failed** at link (`toolset/bin/llvm-lib: Exec format error`). The SDK's Linux
  linker tools were aarch64 because the SDK was built on an arm64 host.
- Attempt 2: **successful**, unsigned, after setting `XTL_TOOLSET_TARBALL=toolset-x86_64.tar.gz`.
  `Build complete! (48.25 secs)`; `MonsteraHello` is Mach-O 64-bit arm64 and references SpriteKit.
- Launched: **no**. There is no simulator on Linux, and device deploy needs signing.
- Device tested: none.
- Screenshot: no.
- Known limitations: Swift 6.4.2 (Linux) vs Xcode 26.6 / Swift 6.3.3 (SDK) skew. Unsigned.
  Locally, Linux needs an Apple ID to download `Xcode.xip`.
- **G0 review action:** the CI SDK hand-off (macOS runner to Linux runner) is **disabled**
  because its licensing is unresolved. All three SDK artifacts (runs 42969821746, 42972339280, 42974703468) were deleted. `xtool-linux.yml` is now
  an opt-in, manual-trigger experiment that never handles Apple SDK material; it builds only
  on a runner with a developer-installed SDK. The COMPILED result is preserved as historical
  evidence and is reproducible only with the documented setup (your own Xcode download).
- Next action: physical iPhone test via `xtool dev` (needs **Apple ID + iPhone + USB** from the
  user); record free-account limits observed.

## Device Lab

- Contract: `device-lab/contract/README.md`, `result.schema.json`. Design: `architecture/DEVICE-LAB.md`.
- `android-emulator`: all ops except `test` proven (local + Linux CI).
- `ios-simulator`: build, install, launch, stop, screenshot, logs, report proven in CI.
  **`test` is unsupported: there are no automated iOS tests.**
- `android-device`, `ios-device`: implemented, never run.
- Per-op matrix: `architecture/DEVICE-LAB.md`, "Implementation and verification matrix".

## G0 completion criteria (`docs/PHASE-0.md`)

| # | Criterion | Status |
|---|---|---|
| 1 | Repository structure exists | Met |
| 2 | Kiro steering and project instructions present | Met (`.kiro/steering/`, `.kiro/agents/`) |
| 3 | Android APK builds | Met (local + Linux CI) |
| 4 | Android app launches in an emulator | Met (local + Linux CI) |
| 5 | xtool experiment documented and reproducible | Met (COMPILED on Linux; reproducible with your own Xcode download; CI transfer disabled; device deploy not attempted) |
| 6 | Hosted macOS iOS Simulator build proven | Met |
| 7 | Device Lab interfaces documented | Met |
| 8 | G0 report accurate | This document; audit with the `report-auditor` agent |

G0 review decision (2026-11-11): substantially successful. Open items, none of which block G0:
physical Android, physical iPhone (needs user credentials and hardware), automated `test` op on
both platforms, licensing decision before any CI use of Apple SDK material on Linux.
