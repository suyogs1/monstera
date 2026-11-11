# MONSTERA

An AI-native, specification-driven foundry for native 2D mobile games. Kiro is the development
environment and coding agent.

Planned games (not started):

1. Pumpkin Blaster: landscape arcade shooter.
2. Trick or Treat Rush: portrait endless runner.

Both are genuine native apps: Kotlin + Jetpack Compose on Android, Swift + SwiftUI + SpriteKit on
iOS. No React Native, Expo, Flutter or other cross-platform rendering framework.

## Status: Phase 0 (toolchain proof)

See [docs/G0-TOOLCHAIN-REPORT.md](docs/G0-TOOLCHAIN-REPORT.md) for what is actually verified, and
[docs/PHASE-0.md](docs/PHASE-0.md) for the completion criteria.

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
| `.github/workflows/` | CI: Android build/emulator on Linux, iOS Simulator on macOS |

## Quick start

```bash
# Android
cd apps/android && ./gradlew assembleDebug

# Android emulator smoke test (emulator already booted)
tools/scripts/android-emulator-smoke.sh
```

iOS: see [apps/ios/README.md](apps/ios/README.md).
