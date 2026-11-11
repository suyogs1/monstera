# MONSTERA iOS Hello World

Swift + SwiftUI + SpriteKit, packaged as a SwiftPM library in the layout `xtool new` generates.
`xtool.yml` turns the package into an `.app`. There is no Xcode project.

- `MonsteraHelloApp.swift`: `@main` App; logs `scenePhase` changes (subsystem `app.monstera.hello`).
- `ContentView.swift`: title, a `SpriteView`, a tap counter button.
- `PulseScene.swift`: `SKScene` with a pulsing circle that bursts on each tap.

## Build

| Host | Command | Output |
|---|---|---|
| macOS (Xcode installed) | `xtool dev build --triple arm64-apple-ios-simulator` | `xtool/MonsteraHello.app` (simulator) |
| macOS / Linux, unsigned device build | `xtool dev build` | `xtool/MonsteraHello.app` (arm64 iOS, unsigned) |
| Linux, signed + install on iPhone | `xtool dev` (needs `xtool setup`: Apple ID, USB device) | installed app |

Linux setup and the reproducible experiment: [tools/xtool/README.md](../../tools/xtool/README.md)
and [docs/XTOOL-EXPERIMENT.md](../../docs/XTOOL-EXPERIMENT.md).

## Simulator (macOS)

```bash
UDID=$(xcrun simctl list devices available | grep -m1 -E '^[[:space:]]+iPhone' | grep -oE '[0-9A-F-]{36}')
xcrun simctl boot "$UDID" && xcrun simctl bootstatus "$UDID" -b
SIM_DEVICE=$UDID device-lab/ios/adapter.sh build      # then install, launch, screenshot, logs
```

CI does this in `.github/workflows/ios-simulator.yml`.

## Versions

- Package: swift-tools-version 6.0, iOS 17 minimum (same as the `xtool new` template).
- xtool 1.24.0. CI: Xcode 26.6 (Swift 6.3.3, iOS Simulator SDK 26.5) on `macos-26`.
