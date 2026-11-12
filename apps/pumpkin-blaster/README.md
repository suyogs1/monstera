# Pumpkin Blaster

Landscape 2D arcade shooter. Drag to move the ship, tap to fire. Pumpkins (+10), bats (+25) and embers
(cannot be shot) come from the right; every one that reaches the ship costs a life. Five lives; reach
1000 points to win.

`monstera.spec.json` is the single source of truth. `android/`, `ios/`, `MONSTERA-MANIFEST.json` and
`.kiro/steering/monstera-generated.md` are generated: change the spec and run
`monstera generate apps/pumpkin-blaster/monstera.spec.json`.

Verification (see `docs/evidence/g3-conformance/`): oracle, Kotlin and Swift agree on the four golden
scenarios in `spec/scenarios/pumpkin-blaster/`; the Android project assembles (`assembleDebug`).
Not yet run: Android emulator, iOS Simulator, any physical device. The shells draw plain rectangles
(no artwork yet).
