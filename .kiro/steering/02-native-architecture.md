# Native architecture and technology constraints

These rules apply to **generated applications** (`apps/*`, `generated/*`) and to the G0 reference
apps (`reference/g0/*`). MONSTERA Studio (`studio/`) follows `07-studio.md` instead (G1.5 split).

## Required (generated applications)

- Android: Kotlin, Jetpack Compose, native Android APIs, Gradle (Kotlin DSL, wrapper committed).
- iOS: Swift, SwiftUI, SpriteKit, Swift Package Manager. `xtool.yml` describes the app bundle.
- Android Emulator must work on Linux. Xcode / iOS Simulator run only on hosted macOS.
- Linux-based iOS builds go through xtool where it is proven to work (see the G0 report).
- A generated app compiles, installs and runs with its platform toolchain only. It never
  requires Kiro, Python, the MONSTERA engine or Studio. Optional Kiro guidance shipped inside a
  generated app is documentation only (see `06-specification-engine.md`).

## Forbidden (generated applications)

- React Native, Expo, Flutter, Unity, Godot, Cocos, libGDX, or any cross-platform rendering framework.
- Kotlin Multiplatform for rendering or UI. Shared logic is shared through specifications and
  generated/ported code, not a shared runtime.
- Web views as a game surface.
- Any Studio/web dependency inside `apps/*` or `generated/*` (`monstera check-architecture`).

## Layout rules

- `reference/g0/android` and `reference/g0/ios` are the Phase 0 toolchain proofs, kept as
  references (moved from `apps/` in G1.5). Neither imports the other.
- `apps/` contains exactly the two Skeleton Crew applications, `apps/pumpkin-blaster/` and
  `apps/trick-or-treat-rush/` (G3). In each, the generator owns exactly `android/`, `ios/`, the
  documentation-only `.kiro/steering/monstera-generated.md` (decision 1) and
  `MONSTERA-MANIFEST.json`, which records that ownership (decision 2). The spec, assets, README and
  every other file, including the app's other `.kiro/` files, are hand-maintained.
- Shared contracts (game specs, schemas, asset manifests) live outside the app trees: `spec/`.
- Engine fixture output lives in `generated/<project.id>/`. The generator (`tools/monstera/`) is
  build tooling, never shipped in an app.
- Pin tool and dependency versions exactly. Record why when upgrading.
- Platform build output (`build/`, `.build/`, `xtool/`) is never committed.
