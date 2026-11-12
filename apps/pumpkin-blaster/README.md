# Pumpkin Blaster

Landscape 2D arcade shooter. Drag to move the ship and tap to fire. Pumpkins (+10), bats (+25) and embers
(cannot be shot) come from the right, and every one that reaches the ship costs a life. Five lives. Reach
1000 points to win. Tap after the game ends to restart.

`monstera.spec.json` is the single source of truth. `android/`, `ios/`, `MONSTERA-MANIFEST.json` and
`.kiro/steering/monstera-generated.md` are generated, so change the spec and run
`monstera generate apps/pumpkin-blaster/monstera.spec.json`.

## Verification

- Oracle, Kotlin and Swift agree on the 5 golden scenarios in `spec/scenarios/pumpkin-blaster/`, 101 checkpoints
  each. These include `win-1000`, which reaches the win score with lives left (`docs/evidence/g3-conformance/`).
- Android `assembleDebug` succeeds. On the Android emulator, launch, firing, scoring, game over and restart were
  observed (`docs/evidence/g3-android-emulator/pumpkin-blaster/`).
- iOS, via GitHub Actions run #31 ([43198048336](https://github.com/suyogs1/monstera/actions/runs/43198048336),
  commit `15f412f`, macOS runner), evidence in `docs/evidence/g3-ios-simulator-ci/pumpkin-blaster/`:
  - The app was built for the iOS Simulator with its local `ios/Runtime` package.
  - `swift test` passed on that package (7 tests).
  - The app was installed and launched on the Simulator. The fixed-tick game loop ran (a logged
    `runtime ticks=60 hash=... seed=...` line), the bundled spec matched (`bundledMatches=true`), and a screenshot was taken.

## Not tested

- iOS firing, ship dragging and restart are compiled but not interaction-tested: the Simulator tooling
  used in CI cannot inject touches. They were exercised on the Android emulator only.
- Physical iOS or Android devices.

The shells draw plain rectangles (no artwork yet) and do not clip entities to the world rectangle.
