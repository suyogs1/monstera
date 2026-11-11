# MONSTERA

An AI-native, specification-driven foundry for native 2D mobile games. Kiro is the development
environment and coding agent.

Planned games (not started):

1. Pumpkin Blaster: landscape arcade shooter.
2. Trick or Treat Rush: portrait endless runner.

Both are genuine native apps: Kotlin + Jetpack Compose on Android, Swift + SwiftUI + SpriteKit on
iOS. No React Native, Expo, Flutter or other cross-platform rendering framework.

## Status: Phase 0 (toolchain proof)

| Path | Verification |
|---|---|
| Android on emulator (Windows and Linux CI) | SIMULATOR-TESTED |
| iOS on Simulator (hosted macOS CI) | SIMULATOR-TESTED |
| iOS built on Linux with xtool (unsigned) | COMPILED |
| Any physical Android or iOS device | **Not tested** |

Details and evidence: [docs/G0-TOOLCHAIN-REPORT.md](docs/G0-TOOLCHAIN-REPORT.md). Completion
criteria: [docs/PHASE-0.md](docs/PHASE-0.md).

## Layout

| Path | Purpose |
|---|---|
| `.kiro/steering/` | Project rules for Kiro and humans (mission, architecture, quality, provenance, Device Lab) |
| `.kiro/agents/` | Project agent and bounded specialist agents |
| `.kiro/specs/`, `.kiro/hooks/`, `.kiro/prompts/` | Specs, hooks, reusable prompts (empty in Phase 0) |
| `apps/android/` | Native Android app (Gradle, Kotlin, Compose) |
| `apps/ios/` | Native iOS app (SwiftPM package + `xtool.yml`, SwiftUI + SpriteKit) |
| `tools/xtool/` | xtool setup notes and Linux build scripts |
| `tools/scripts/` | Developer and CI scripts |
| `device-lab/` | Device Lab contract (`contract/`), per-platform adapters, run reports |
| `architecture/` | Architecture documents |
| `docs/` | Reports, decisions, curated evidence (`docs/evidence/`) |
| `assets/` | Game assets with provenance records (empty in Phase 0) |
| `.github/workflows/` | CI: `android` (Linux emulator), `ios-simulator` (hosted macOS), `xtool-linux` (experimental, manual trigger only) |

## Quick start

```bash
# Android
cd apps/android && ./gradlew assembleDebug

# Android emulator smoke test (emulator already booted)
tools/scripts/android-emulator-smoke.sh
```

iOS: see [apps/ios/README.md](apps/ios/README.md).
