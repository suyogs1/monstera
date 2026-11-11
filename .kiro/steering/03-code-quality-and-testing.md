# Code quality and testing conventions

- Verify by running. After any change run the relevant build; a green build is the minimum evidence.
- Android: `./gradlew assembleDebug` (and `testDebugUnitTest` once tests exist) from the project directory (`reference/g0/android`, `generated/<id>/android`, `apps/<id>/android`).
- iOS: SwiftPM sources must compile for the iOS Simulator in CI (`ios-simulator.yml`).
- Kotlin: idiomatic, no `!!` in production code, state hoisted in Compose, previews optional.
- Swift: Swift 6 language mode where practical, no force unwraps in production code.
- Scripts: POSIX/bash with `set -euo pipefail`; must be runnable on Linux, macOS and Git Bash.
- Add tests with features and bug fixes once a feature has behavior worth testing. Do not add
  placeholder tests for hello-world code.
- No dead code, no speculative abstractions, no TODO without an owner or issue reference.
- Commits are small and logical; messages use the imperative mood and say why.
- Hand-written and generated files must be distinguishable (see provenance steering).
