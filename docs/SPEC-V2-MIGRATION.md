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
## v4 to v5 (Gate E1, sprites)
`specVersion` is now exactly `5`. Both new properties are presentation only (`architecture/RUNTIME-CONTRACT.md` section 10), required, and have a
neutral value that keeps the v4 look (glyphs or color rectangles). There are no hidden defaults: write the neutral value explicitly.
| Where | New property | Constraint | Neutral value |
|---|---|---|---|
| `game` | `atlas` | `png`: standard base64 of one 8-bit RGB or RGBA PNG, at most 1 MiB of text (1,048,576 characters), or `""`; `frameWidth`, `frameHeight` 1 to 128; `columns`, `rows` 1 to 16; the PNG must be `columns*frameWidth` x `rows*frameHeight` pixels | `{"png": "", "frameWidth": 1, "frameHeight": 1, "columns": 1, "rows": 1}` |
| `game.runtime.kinds[]` | `sprite` | `frames`: 0 to 4 atlas frame indices (they need an atlas); `ticksPerFrame` 1 to 600; at most two kinds of a project have more than one frame | `{"frames": [], "ticksPerFrame": 1}` |
Migrate by adding the neutral values and setting `"specVersion": 5`, then `monstera format`, `monstera scenarios record --all` (only the spec hash
changes; review that), `monstera generate`. A v4 spec is refused with `must be 5`; nothing is defaulted silently.
Simulation compatibility of v4 to v5: neither property is read by the simulation. Verified for the 33 scenarios of the five shipped specs when v5 was
introduced: `scenarios record --all` changed one line per scenario, `spec.sha256`, and no checkpoint. The two Skeleton Crew games then received their
atlases from `assets/sprites/make_atlases.py`, which again changed only the spec hash of their scenarios.
In Studio, content written for v4 is upgraded on opening with exactly these neutral values (`studio/src/project/specV5.ts`). This covers
stored IndexedDB projects, direct spec imports, project bundles and the legacy localStorage draft. The upgrade is used only when the v5 engine
accepts it; versions other than 4 are never guessed. Project keys, names, manifests, assets and origins are kept; only the project manifest's spec
hashes that named the v4 text are rebound. A stored project is re-saved as one atomic record, so a failed write leaves the v4 record untouched.
Bundles pass their integrity checks as written before the upgrade, and the legacy draft is never written. No sprite is assigned, and
Studio says so in a notice.
