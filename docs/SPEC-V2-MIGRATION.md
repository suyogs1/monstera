# Canonical spec v1 to v2 migration (G2)

`specVersion` is now exactly `2`. A v1 spec is rejected with `must be 2`. Migrate by explicit edits, then run
`monstera format` and `monstera generate`.

All new properties are required; there are no defaults.

| Where | New properties | Meaning |
|---|---|---|
| `game.input` | `dragGain`, `swipeSpeed`, `tapKind`, `tapVx`, `tapVy` | Q16.16 raw integers; `tapKind` is a kind id or `""` for none |
| `game.simulation` | `tickRate` (30, 60 or 120), `maxTicksPerFrame` (1..10) | fixed timestep |
| `game.runtime` | `maxEntities`, `lives`, `winScore`, `kinds`, `initialEntities`, `spawners`, `collisions` | see `architecture/RUNTIME-CONTRACT.md` |

Quantities are Q16.16 raw integers: 1.5 units is `98304` (units times 65536). `world.width` and `world.height`
must be whole units no larger than 32767. Kind ids and stream names match `^[a-z][a-z0-9-]{0,31}$`.

`spec/samples/monstera-sample/monstera.spec.json` is a complete worked example; `spec/samples/boundary-lab/`
shows the edge cases. Golden scenarios record the spec hash, so after any spec change run
`monstera scenarios record --all`, review the diff and commit.

## v2 to v3 (G3)
`specVersion` is now exactly `3`. Two changes, both needed by Trick or Treat Rush and neither expressible with v2 primitives:
| Where | Change | Meaning |
|---|---|---|
| `game.runtime.spawners[]` | new required `startTick` (integer >= 0) | first spawn tick and phase: spawns at `startTick + k * intervalTicks`; nothing is drawn before it; `0` reproduces v2 exactly. Lets difficulty rise over time and lets spawners with one interval be staggered so they never align. |
| `game.input.scheme` | new value `lanes` | shell input mapping only: a horizontal swipe submits `drag(+-swipeSpeed, 0)`, so `swipeSpeed` is the lane step. The simulation core is unchanged. |
Migrate by adding `"startTick": 0` to every spawner and setting `"specVersion": 3`, then `monstera format`,
`monstera scenarios record --all` (the spec hash changed; the recorded states must be identical, review that),
`monstera generate`.
## v3 to v4 (G4 visual batch)
`specVersion` is now exactly `4`. All new properties are presentation only (`architecture/RUNTIME-CONTRACT.md` section 9), required, and have a
neutral value that reproduces the old plain look. There are no hidden defaults: write the neutral value explicitly.
| Where | New property | Constraint | Neutral value |
|---|---|---|---|
| `game.runtime.kinds[]` | `glyph` | at most 8 characters (one symbol or emoji), no control characters, `"`, `\` or `$` | `""` (draws the `color` rectangle) |
| `game.runtime.kinds[]` | `effect` | `none`, `burst` or `pickup` | `"none"` |
| `game.hud` | `lifeGlyph` | same as `glyph` | `""` (lives shown as the text `lives N`) |
| `game.hud` | `scoreLabel` | 1 to 40 characters, same character rule | `"score"` |
| `game.screens` | `startHint`, `winTitle`, `loseTitle` | 1 to 40 characters, same character rule | `"Tap to start"`, `"You win"`, `"Game over"` |
Migrate by adding the neutral values and setting `"specVersion": 4`, then `monstera format`, `monstera scenarios record --all` (only the spec hash
changes; review that), `monstera generate`. A `glyph` replaces the rectangle; set `effect` to `none` for kinds that expire or leave the world by their own motion.
Simulation compatibility of v3 to v4: none of the new properties is read by the simulation (`architecture/RUNTIME-CONTRACT.md` section 9). A migrated
spec has a new SHA-256, so the golden scenarios must be re-recorded, but every recorded checkpoint (hash and observables) stays identical. Verified for
the 29 scenarios of the four shipped specs when v4 was introduced: only `spec.sha256` changed. A migration that changes any checkpoint is not a v4 migration.
