# Trick or Treat Rush

Portrait 2D endless runner. The runner moves up the road on its own (the world scrolls toward it). Swipe left
or right to change lane, one lane per swipe. Every road stripe you pass scores 1 (distance), and candy scores 10.
Tombstones and ghosts cost a life. Three lives, and the run ends at zero. Tap after game over to restart.

Difficulty rises on a fixed schedule:

- From 2 s: one tombstone every 1.5 s, rotating lanes.
- From 30 s: fast ghosts as well.
- From 60 s: tombstones twice as often.

Spawners in one group share an interval and differ in `startTick` (their phase), so at most one tombstone and
one ghost are ever in the runner's row together. A free lane always exists, and
`tools/monstera/tests/test_trick_or_treat.py` checks this for the first 200 s.

`monstera.spec.json` is the single source of truth. `android/`, `ios/`, `MONSTERA-MANIFEST.json` and
`.kiro/steering/monstera-generated.md` are generated, so change the spec and run
`monstera generate apps/trick-or-treat-rush/monstera.spec.json`. There is no game-specific code in the
generator. This game uses the v3 primitives `spawners[].startTick` and `input.scheme: "lanes"`
(`docs/SPEC-V2-MIGRATION.md`).

## Verification

- Oracle, Kotlin and Swift agree on the 6 golden scenarios in `spec/scenarios/trick-or-treat-rush/`, 101 checkpoints
  each (`docs/evidence/g3-conformance/`). `hand-lane-zero` is checked against hand-computed values.
- Android `assembleDebug` succeeds. On the Android emulator, the app launched, lane swipes, scoring, game over and
  restart were observed (`docs/evidence/g3-android-emulator/trick-or-treat-rush/`).

## Not yet run

- The iOS app build and the iOS Simulator (needs macOS CI).
- Any physical device.

The shells draw plain rectangles (no artwork yet) and do not clip entities to the world rectangle.
