# MONSTERA

An AI-native, specification-driven foundry for native 2D mobile games. Kiro is the development
environment and coding agent.

Two game prototypes are generated from canonical specifications (`apps/`). They are implemented, working native
prototypes, not finished commercial games:

1. Pumpkin Blaster (`apps/pumpkin-blaster/`): landscape arcade shooter.
2. Trick or Treat Rush (`apps/trick-or-treat-rush/`): portrait endless runner.

A third game, Lantern Run (`generated/lantern-run/`), was authored by Kiro through the MONSTERA tools without changing the engine.

**MONSTERA Studio** is a static web app that runs the unmodified Python engine in the browser (Pyodide) to edit, validate,
preview and export a game specification and its generated native source: https://monstera-phi.vercel.app/ (source in `studio/`).

All games are genuine native apps: Kotlin + Jetpack Compose on Android, Swift + SwiftUI + SpriteKit on
iOS. No React Native, Expo, Flutter or other cross-platform rendering framework.

## Status: G6 clean-room verification is the remaining milestone

| Path | Verification |
|---|---|
| Phase 0 apps: Android on emulator (Windows and Linux CI) | SIMULATOR-TESTED |
| Phase 0 apps: iOS on Simulator (hosted macOS CI) | SIMULATOR-TESTED |
| Phase 0 app: iOS built on Linux with xtool (unsigned) | COMPILED |
| G1 generated Android project (`generated/monstera-sample/android`) | SIMULATOR-TESTED (local emulator); COMPILED in Linux CI |
| G1 generated iOS project (`generated/monstera-sample/ios`) | SIMULATOR-TESTED (hosted macOS CI) |
| Pumpkin Blaster and Trick or Treat Rush, Android | COMPILED (local and CI); SIMULATOR-TESTED on an Android emulator, launch only |
| Pumpkin Blaster and Trick or Treat Rush, iOS | COMPILED with xtool; SIMULATOR-TESTED in hosted macOS CI, launch only |
| Simulation conformance of both games (oracle, Kotlin, Swift) | PASS on the current spec hashes (Kotlin as JVM unit tests, Swift as `swift test` on Linux) |
| Studio (`studio/`) | Deployed at https://monstera-phi.vercel.app/; 17/17 smoke checks pass locally and against production; bundle secret scan clean |
| Any physical Android or iOS device | **Not tested** |

Completed: G0 toolchain, G1 specification engine, G2 deterministic runtime and conformance, G3 two games, G4 Studio (M0 to M3).
Remaining: **G6**, clean-room regeneration of both games from their committed specs into empty directories, with build
verification and a recorded demonstration (`.kiro/specs/g4-studio/tasks.md`, item 5). The framework and specification
freeze is its first step.

Not shown: gameplay or touch input on an emulator or simulator for the current spec version (the native launch evidence
covers install, launch and the first 60 runtime ticks), performance, haptics, and any physical device.

Evidence: [native build and launch](docs/evidence/m3-native-apps/SUMMARY.md),
[conformance](docs/evidence/m3-native-conformance/SUMMARY.md), [Studio M3-B](docs/evidence/studio-m3b/README.md).
Reports: [G0](docs/G0-TOOLCHAIN-REPORT.md), [G1](docs/G1-SPECIFICATION-REPORT.md), [G2](docs/G2-RUNTIME-REPORT.md),
[G3](docs/G3-GAMES-REPORT.md). Criteria: [docs/PHASE-0.md](docs/PHASE-0.md).

## Layout

| Path | Purpose |
|---|---|
| `.kiro/steering/` | Project rules for Kiro and humans (mission, architecture, quality, provenance, Device Lab) |
| `.kiro/agents/` | Project agent and bounded specialist agents |
| `.kiro/specs/`, `.kiro/hooks/`, `.kiro/prompts/` | Kiro development specs, hooks, reusable prompts |
| `spec/` | Canonical spec schemas, sample `monstera.spec.json`, invalid fixtures |
| `tools/monstera/` | Specification engine and `monstera` CLI (Python 3.10+, stdlib only) |
| `generated/` | Generator-owned native projects. Do not edit; run `monstera generate` |
| `studio/` | MONSTERA Studio: static Vite + React + TypeScript app; the engine runs in the browser with Pyodide |
| `apps/` | The two Skeleton Crew apps (G3): `pumpkin-blaster/`, `trick-or-treat-rush/` |
| `reference/g0/android/` | Phase 0 reference Android app (Gradle, Kotlin, Compose) |
| `reference/g0/ios/` | Phase 0 reference iOS app (SwiftPM package + `xtool.yml`, SwiftUI + SpriteKit) |
| `tools/xtool/` | xtool setup notes and Linux build scripts |
| `tools/scripts/` | Developer and CI scripts |
| `device-lab/` | Device Lab contract (`contract/`), per-platform adapters, run reports |
| `architecture/` | Architecture documents |
| `docs/` | Reports, decisions, curated evidence (`docs/evidence/`) |
| `assets/` | Game assets with provenance records |
| `.github/workflows/` | CI: `monstera` (spec engine + generated builds), `android` (Linux emulator), `ios-simulator` (hosted macOS), `studio-ci` (Studio tests, build, secret scan, Playwright smoke), `xtool-linux` (experimental, manual trigger only) |

## Quick start

```bash
# Specification engine (Windows without python3: py -3 tools/monstera/monstera.py ...)
tools/monstera/bin/monstera validate --all
tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json

# Android
cd reference/g0/android && ./gradlew assembleDebug

# Android emulator smoke test (emulator already booted)
tools/scripts/android-emulator-smoke.sh
```

iOS: see [reference/g0/ios/README.md](reference/g0/ios/README.md).
