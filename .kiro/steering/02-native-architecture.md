# Native architecture and technology constraints

## Required

- Android: Kotlin, Jetpack Compose, native Android APIs, Gradle (Kotlin DSL, wrapper committed).
- iOS: Swift, SwiftUI, SpriteKit, Swift Package Manager. `xtool.yml` describes the app bundle.
- Android Emulator must work on Linux. Xcode / iOS Simulator run only on hosted macOS.
- Linux-based iOS builds go through xtool where it is proven to work (see the G0 report).

## Forbidden

- React Native, Expo, Flutter, Unity, Godot, Cocos, libGDX, or any cross-platform rendering framework.
- Kotlin Multiplatform for rendering or UI. Shared logic is shared through specifications and
  generated/ported code, not a shared runtime.
- Web views as a game surface.

## Layout rules

- `apps/android` and `apps/ios` are independent native projects. Neither imports the other.
- Shared contracts (game specs, schemas, asset manifests) live outside both app trees.
- Pin tool and dependency versions exactly. Record why when upgrading.
- Platform build output (`build/`, `.build/`, `xtool/`) is never committed.
