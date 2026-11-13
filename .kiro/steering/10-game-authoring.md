---
inclusion: fileMatch
fileMatchPattern: ["**/monstera.spec.json", "spec/samples/**", "spec/scenarios/**"]
---
# Authoring a game with MONSTERA (for Kiro)

Create a game by writing one canonical spec, never by editing generated code. The engine, the generator and the
templates are fixed: if a request needs something the vocabulary below cannot express, say so and propose a smaller
game. Do not change `tools/monstera/`, `spec/schema/` or any template to fit a game.

## Where things live
- New games: `spec/samples/<id>/monstera.spec.json`. Output: `generated/<id>/` (written only by `generate_project`).
- `apps/` holds exactly the two official applications (Pumpkin Blaster, Trick or Treat Rush). Never add a game there.
- Worked examples to copy structure from: #[[file:apps/trick-or-treat-rush/monstera.spec.json]] (portrait, lanes) and
  `apps/pumpkin-blaster/monstera.spec.json` (landscape, drag and tap).

## The loop (use the MCP server `monstera`; do not re-derive what a tool reports)
1. `engine_info`. If `stale` is true, stop: ask the user to reconnect the server. A stale server is not evidence.
2. Write the spec file. Validate with `validate_spec` using `path` (or an inline `spec` before writing). Fix every
   issue; each has a path, a code and often a "did you mean" hint. Re-validate. Do not guess twice: read the schema description.
3. `generate_project` dry run, then `write=true` (the user approves). Never use shell to write under `generated/`.
4. Scenarios (needed for conformance): write `spec/scenarios/<id>/<name>.scenario.json` per `scenario.schema.json` with
   `spec.sha256` set to 64 zeros and `checkpoints` empty, then run `monstera scenarios record <file>` in the shell. Checkpoints
   come only from that command, never by hand. After any spec change, record again and review that only intended checkpoints moved.
5. `generate_project` again (the scenarios are embedded into the Android and iOS tests), `run_conformance` (oracle first;
   `kotlin` runs Gradle; `swift` needs a swift image or a toolchain). Only PASS on all requested platforms is a pass.
6. `inspect_manifest` with `files=true`, and explain generated files from `path`, `kind` and `source`, tracing them to spec fields.

## Units and time
- Quantities are Q16.16 raw integers: raw = units x 65536 (1 unit = 65536, 4 units = 262144, 0.5 = 32768).
- `world.width` and `world.height` are whole units (at most 32767, aspect at most 3:1) and match `orientation`.
- Velocities are raw per tick. At `tickRate` 60, 4 units per tick is 240 units per second.
- A kind's `width` and `height` are raw and not larger than the world. Positions are the top-left corner.

## Field map (every spec field and what it does)
Sections under `game`: `genre`, `hud`, `screens`, `input`, `simulation`, `runtime`; under `runtime`: `kinds`, `initialEntities`,
`spawners`, `collisions`; under `project`: `platforms`.
- `project`: `id` (slug, names the folder), `displayName`, `identifier` (reverse-DNS, both platforms), `version` with `name` and `code`,
  `targets` (`android`, `ios`), `platforms` with `minSdk` and `deploymentTarget`.
- `game.genre`, `orientation`, `targetFps`; `world` (`width`, `height`); `palette` (`background`, `primary`, `accent`: `#RRGGBB`
  uppercase; `primary` and `accent` need contrast of at least 3:1 against `background`).
- `game.hud`: `lifeGlyph` (symbol per life, `""` shows "lives N"), `scoreLabel`. `game.screens`: `startHint`, `winTitle`, `loseTitle`.
  These and `glyph`, `effect`, `color` are presentation only and can never change a recorded checkpoint.
- `game.input`: `scheme` (`drag`: move by finger delta times `dragGain`; `swipe`: a swipe sets the controlled entity's velocity to
  `swipeSpeed` in that direction; `lanes`: a horizontal swipe moves by `swipeSpeed` once; `tap`), `tapKind` (kind spawned at the
  first controlled entity on a tap, `""` for none) with `tapVx` and `tapVy`.
- `game.simulation`: `tickRate` (30, 60, 120), `maxTicksPerFrame` (1 to 10).
- `game.runtime`: `maxEntities`, `lives` (start), `winScore` (0 disables winning).
  - `kinds[]`: `id`, `width`, `height`, `lifetimeTicks` (0 = unlimited), `exitPolicy` (`despawn` when fully outside, `clamp`, `bounce`),
    and presentation `color`, `glyph` (at most 8 characters), `effect` (`none`, `burst`, `pickup`). Use `effect: none` for kinds that expire or leave the world by their own motion.
  - `initialEntities[]`: `kind`, `x`, `y`, `vx`, `vy`, `controlled` (receives input).
  - `spawners[]`: `stream` (own random stream), `kind`, `startTick`, `intervalTicks`, a spawn box `xMin`..`xMax`, `yMin`..`yMax`, and
    velocity `vx`, `vy`. Difficulty rises by adding spawners with a later `startTick` and a shorter `intervalTicks`.
  - `collisions[]`: `a`, `b`, `despawnA`, `despawnB`, `score`, `lives` (added per overlapping pair; a collectible is a rule with
    `despawnA` true and `score` above 0; a hazard has `lives` of -1).

## Recipes
- Three-lane runner: `scheme: lanes`, `swipeSpeed` = (world width - runner width) / 2 in raw, runner starts in the middle (x = that value), `exitPolicy: clamp`.
  Obstacles spawn at the top with positive `vy` in the three lane x positions (`xMin` = `xMax`). See the Trick or Treat Rush spec.
- Free movement in four directions: `scheme: swipe`, `exitPolicy: clamp` on the controlled kind.
- Shooter: `scheme: drag`, `tapKind` is the bullet kind with a `lifetimeTicks` and a velocity.
- Winning: `winScore` above 0. Losing: `lives` reaching 0.

## Not expressible (stop and say so; never patch the engine)
Jumping or gravity, enemies that aim or chase, power-up timers, levels or scenes, sound, haptics, art assets, networking, saves.

## Honesty
A generated project is GENERATED. COMPILED needs a real Gradle or Xcode build, SIMULATOR-TESTED needs a launch log and screenshot.
Report exactly which conformance platforms ran. Never write a result you did not observe.
