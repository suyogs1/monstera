# Gate E1: native sprite evidence (spec v5)

Source commit for every file here: **`d51a7ea174194ea0ccf38062207b5542956a3d8a`** (PR #58, branch `studio/e1-native-sprites`). Device Lab and
conformance output is copied unchanged. The only change is that the CI conformance file `conformance-<game>.json` is stored as
`conformance/<game>.report.json`, so Studio indexes it like other conformance reports. Historical v4 evidence stays in `docs/evidence/m3-native-apps/`.

## Identity

| | Pumpkin Blaster | Trick or Treat Rush |
|---|---|---|
| Canonical spec SHA-256 (`apps/<id>/monstera.spec.json`) | `02f626f0f398bf98b5e0ed7106c7a3402fb55cbe6c680a9d401d5812ae76c2e5` | `75f62a987a9726a79c236e5e7f1004cc3b57b7801f077a23ccc2f8eaf8499eac` |
| Atlas (`game.atlas`) | 8 x 1 frames of 16 x 16, PNG 128 x 16 | 8 x 1 frames of 16 x 16, PNG 128 x 16 |
| Animated kind (`sprite`) | `bat`: frames `[2, 3]`, 8 ticks each | `runner`: frames `[0, 1]`, 8 ticks each |

## Runs

| Platform | Where | Run id | Commands |
|---|---|---|---|
| Android | Local Windows host, fresh LF clone of the source commit; emulator 36.3.10.0, AVD `Pixel_9_Pro_XL` (`sdk_gphone64_x86_64`, Android 16, API 36) | `e1-d51a7ea-android-<game>` | `DL_APP_DIR=apps/<game>/android DL_APP_PACKAGE=<id> DL_APP_LOG_TAG="MonsteraSpec MonsteraRuntime MonsteraSprites" bash device-lab/android/adapter.sh <op>` for `build install launch screenshot 01-launched screenshot 02-later logs stop report` (Git Bash with `OS=` so the adapter runs `./gradlew`) |
| iOS | GitHub Actions `monstera` run **45144774537** on the source commit, job `ios-generated`, artifact `g1-ios-simulator-45144774537` | `ci-45144774537-<game>` | the job's loop: `device-lab/ios/adapter.sh build`, `swift test` (Runtime, Presentation), `install launch screenshot 01-launched screenshot 02-later logs stop report` |
| Conformance | same run, job `conformance`, artifact `g2-conformance-45144774537` | n/a | `monstera conformance` (oracle, Kotlin JVM, Swift in container) |

The same `monstera` run's other jobs passed on the source commit: `spec` (with the no-project-branching check), `mcp`, `android-generated`
(clean-room regeneration, compile, JVM unit tests including the sprite frame tests) and `ios-generated`.

## Results

| | Android emulator | iOS simulator |
|---|---|---|
| Device Lab operations (both games) | build, install, launch, two screenshots, logs, stop, report: all `ok` | build, install, launch, two screenshots, logs, stop, report: all `ok` |
| Spec check (both games) | logged hash = canonical, `bundledMatches=true` | logged hash = canonical, `bundledMatches=true decodedMatches=true` |
| Atlas | `sprites atlas=loaded size=128x16 frames=8` (decoded size = spec grid) | same |
| Frame changes, Pumpkin Blaster `bat` (tick: frame) | 5:2, 10:3, 19:2, 24:3, 32:2, 41:3 | 5:2, 9:3, 16:2, 24:3, 32:2, 40:3 |
| Frame changes, Trick or Treat Rush `runner` | 0:0, 10:1, 17:0, 24:1, 32:0, 41:1 | 0:0, 9:1, 16:0, 24:1, 32:0, 40:1 |
| Runtime | `runtime ticks=` 62 (PB), 61 (ToTR) | `runtime ticks=60` (both) |
| Conformance | `pass` for oracle, Kotlin and Swift on both specs | |

Every logged frame equals `frames[(tick div 8) mod 2]` (contract section 10). The frame logs are written by the draw path itself
and record the first six changes of each animated kind. A logged tick can be later than the change point (10 rather than 8, for example)
because a display frame can run several ticks; the rule holds at the tick that was drawn. `studio/src/badge/nativeApps.test.ts`
checks every line again.

## What this does not show

- The screenshots show attract mode behind the start card. Gameplay, touch input, restart, performance, haptics and physical devices were not tested.
- **iOS landscape capture.** `xcrun simctl io screenshot` saves the device framebuffer. The job turned the simulator with Device > Rotate Left (the
  log says "simulator rotated to landscape"), but the Pumpkin Blaster capture still shows the landscape game turned 90 degrees in the
  portrait framebuffer. The image is stored as captured, not rotated afterwards.
- The two screenshots of a run are about 1 to 2 seconds apart. They are not tied to a tick; the frame log above is the animation proof.
- Lantern Run has no E1 evidence. Its v4 evidence in `m3-native-apps` is stale for its v5 spec, and Studio shows none for it.
