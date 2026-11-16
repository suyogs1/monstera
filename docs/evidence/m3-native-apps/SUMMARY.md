# M3 Phase 1: native build and simulator evidence
Base: `origin/main` at `ecca397` (PR #10 merge). Android evidence was produced locally on 2026-11-16 (Windows host). iOS evidence comes from
GitHub Actions run **43804610330** on head `9b52dfa` (all jobs passed), artifact **g1-ios-simulator-43804610330** (Device Lab reports, screenshots, logs; no `.app`).
Android CI build results: artifact **g1-android-43804610330**. Each game was run once per target.

## Preflight (before any build)
`validate` on the three specs, `verify` on the three generated directories and `generate <spec> --check` all exit 0. Spec hashes equal the Phase 0 report
(`docs/evidence/m3-native-conformance/SUMMARY.md`). `monstera gates --skip-tests`: 32/32 passed. No drift, nothing regenerated.

## Matrix
| | Pumpkin Blaster | Trick or Treat Rush | Lantern Run |
|---|---|---|---|
| Path | `apps/pumpkin-blaster` | `apps/trick-or-treat-rush` | `generated/lantern-run` |
| Canonical spec SHA-256 | `08c7a90d9fcfd599c0b5f83743ba339e61f57f1fb10938cf6806d70cda7e0be3` | `edcc2000685684cfc17fcbe3634bb01d2967b7d590cfceabb02a2286eaa79b4c` | `cc08da835eab0e59b23ddb58e766cd9420e41514124e09b7903438a5fd0d60b1` |
| Android applicationId / activity | `app.monstera.pumpkinblaster` / `.MainActivity` | `app.monstera.trickortreatrush` / `.MainActivity` | `app.monstera.lanternrun` / `.MainActivity` |
| Android log tags | MonsteraSpec, MonsteraRuntime | same | same |
| iOS product / bundle ID | `PumpkinBlaster` / `app.monstera.pumpkinblaster` | `TrickOrTreatRush` / `app.monstera.trickortreatrush` | `LanternRun` / `app.monstera.lanternrun` |
| Android `assembleDebug` (Device Lab `build`) | COMPILED (local, CI) | COMPILED (local, CI) | COMPILED (local, CI) |
| Android JVM tests (`cleanTestDebugUnitTest testDebugUnitTest`) | pass | pass | pass |
| APK `assets/monstera.spec.json` SHA-256 equals canonical | yes | yes | yes |
| Android emulator install, launch, screenshot, logs, stop, report | all `ok` | all `ok` | all `ok` |
| Android logs | `bundledMatches=true`, `runtime ticks=60` | same | same |
| iOS simulator build (xtool, `arm64-apple-ios-simulator`) | COMPILED | COMPILED | COMPILED |
| iOS `swift test` Runtime / Presentation | 7 / 15 pass | 7 / 15 pass | 7 / 15 pass |
| iOS install, launch, screenshot, logs, stop, report | all `ok` | all `ok` | all `ok` |
| iOS logs | `bundledMatches=true decodedMatches=true`, logged sha = canonical, `runtime ticks=60` | same | same |
| Label | SIMULATOR-TESTED (Android emulator, iOS simulator), launch only | same | same |

## Toolchain and targets
- Android: Gradle 9.9.1 wrapper, host JDK 25.0.2, emulator 36.3.10.0, AVD `Pixel_9_Pro_XL` (`sdk_gphone64_x86_64`, Android 16, API 36, 1344x2992, `-no-snapshot`). Fingerprint `google/sdk_gphone64_x86_64/emu64xa:16/BE4B.251210.005/14574095:user/release-keys`.
- iOS (CI `macos-26`): Xcode 26.6 (17F113), Apple Swift 6.3.3, xtool 1.24.0, simulator `iPhone 17 Pro` (first available iPhone).
- The Android adapter now accepts several space-separated tags in `DL_APP_LOG_TAG` (run used `"MonsteraSpec MonsteraRuntime"`). No other adapter, template or generated change.

## CI
- `android-generated` and `ios-generated` in `.github/workflows/monstera.yml` now include `generated/lantern-run`; both passed in run 43804610330.
- The iOS loop now also requires the logged `spec sha256=` to equal `shasum -a 256` of the canonical spec file, and the artifact excludes `*.app/**`.

## Evidence files
- Android: `docs/evidence/m3-native-apps/android/<game>/` (`01-launched.png`, `logs.txt`, `report.json`, `results.jsonl`). The `build` entry names an APK that is not committed.
- iOS: `docs/evidence/m3-native-apps/ios/<game>/` (same file set), copied unchanged from artifact `g1-ios-simulator-43804610330` (per-game run IDs `ci-43804610330-<game>`).
- Android run IDs: `m3p1-android-<game>`.

## Not tested
- Gameplay: no touch, swipe, fire, game-over or restart on either platform. Android logs show only the launch and the first 60 ticks (`adb` input was not used); iOS `simctl` cannot inject touches. Earlier G3 evidence of interaction predates spec v4.
- Android emulator is local only; CI does not run an emulator for these apps. Android `stop` leaves no further checks.
- Frame pacing, performance, haptics, physical devices (no PHYSICAL-DEVICE-TESTED label anywhere).
- iOS simulator OS version was not recorded by the adapter. The Android JVM test output is not archived; only its pass result is stated here.
- Docs-only commits do not trigger the workflow (`docs/**` is outside its path filter), so the final PR head's CI result is that of the last commit that touched filtered paths.
