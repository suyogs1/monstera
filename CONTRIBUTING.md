# Contributing

- Read `.kiro/steering/` first. It defines the rules for humans and for Kiro.
- Native only: Kotlin/Compose on Android, Swift/SwiftUI/SpriteKit on iOS.
- Keep commits small, imperative, and explain why.
- Verify with a real build before claiming anything. Use the labels GENERATED, COMPILED,
  SIMULATOR-TESTED, PHYSICAL-DEVICE-TESTED and only the level you have evidence for.
- Do not commit build output, keys, certificates, Apple credentials or `local.properties`.
- Branch from `main`; open a pull request. CI must pass.
