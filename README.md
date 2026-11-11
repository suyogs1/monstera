# MONSTERA

An AI-native, specification-driven foundry for native 2D mobile games. Kiro is the development
environment and coding agent.

Planned games (not started):

1. Pumpkin Blaster: landscape arcade shooter.
2. Trick or Treat Rush: portrait endless runner.

Both are genuine native apps: Kotlin + Jetpack Compose on Android, Swift + SwiftUI + SpriteKit on
iOS. No React Native, Expo, Flutter or other cross-platform rendering framework.

## Status: Phase 1 (G1 specification engine, in review)

| Path | Verification |
|---|---|
| Phase 0 apps: Android on emulator (Windows and Linux CI) | SIMULATOR-TESTED |
| Phase 0 apps: iOS on Simulator (hosted macOS CI) | SIMULATOR-TESTED |
| Phase 0 app: iOS built on Linux with xtool (unsigned) | COMPILED |
| G1 generated Android project (`generated/monstera-sample/android`) | SIMULATOR-TESTED (local emulator); COMPILED in Linux CI |
| G1 generated iOS project (`generated/monstera-sample/ios`) | SIMULATOR-TESTED (hosted macOS CI) |
| Any physical Android or iOS device | **Not tested** |

Reports: [G0](docs/G0-TOOLCHAIN-REPORT.md), [G1](docs/G1-SPECIFICATION-REPORT.md). Criteria:
[docs/PHASE-0.md](docs/PHASE-0.md). No game is implemented yet.

## Layout

| Path | Purpose |
|---|---|
| `.kiro/steering/` | Project rules for Kiro and humans (mission, architecture, quality, provenance, Device Lab) |
| `.kiro/agents/` | Project agent and bounded specialist agents |
| `.kiro/specs/`, `.kiro/hooks/`, `.kiro/prompts/` | Kiro development specs, hooks, reusable prompts |
| `spec/` | Canonical spec schemas, sample `monstera.spec.json`, invalid fixtures |
| `tools/monstera/` | Specification engine and `monstera` CLI (Python 3.10+, stdlib only) |
| `generated/` | Generator-owned native projects. Do not edit; run `monstera generate` |
| `apps/android/` | Phase 0 reference Android app (Gradle, Kotlin, Compose) |
| `apps/ios/` | Phase 0 reference iOS app (SwiftPM package + `xtool.yml`, SwiftUI + SpriteKit) |
| `tools/xtool/` | xtool setup notes and Linux build scripts |
| `tools/scripts/` | Developer and CI scripts |
| `device-lab/` | Device Lab contract (`contract/`), per-platform adapters, run reports |
| `architecture/` | Architecture documents |
| `docs/` | Reports, decisions, curated evidence (`docs/evidence/`) |
| `assets/` | Game assets with provenance records (empty in Phase 0) |
| `.github/workflows/` | CI: `monstera` (spec engine + generated builds), `android` (Linux emulator), `ios-simulator` (hosted macOS), `xtool-linux` (experimental, manual trigger only) |

## Quick start

```bash
# Specification engine (Windows without python3: py -3 tools/monstera/monstera.py ...)
tools/monstera/bin/monstera validate --all
tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json

# Android
cd apps/android && ./gradlew assembleDebug

# Android emulator smoke test (emulator already booted)
tools/scripts/android-emulator-smoke.sh
```

iOS: see [apps/ios/README.md](apps/ios/README.md).
