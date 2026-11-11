# G2 Deterministic native runtime and cross-platform behavioural conformance: requirements

Status: **PROPOSED, not approved. Do not execute.**

This is a **Kiro Spec** (how MONSTERA is developed in G2). It is not a MONSTERA canonical
specification (`monstera.spec.json`), which describes a generated app.

## Introduction

G2 gives every generated MONSTERA app the same deterministic game runtime. It's emitted as
native Kotlin and native Swift and proven to behave identically on both: the same canonical spec,
seed and input trace give the same simulation state on every tick. G3 builds the two games on it.
G2 implements neither game.

Non-goals: either demonstration game, audio, haptics, motion, networking, Studio, physical devices.

## Glossary

- **Core**: platform-free simulation code (no Android/UIKit/SpriteKit/Compose imports).
- **Shell**: the platform layer: rendering (Compose `Canvas` / SpriteKit), touch to input contract, frame loop.
- **Tick**: one fixed simulation step.
- **Scenario**: a golden test case: spec, seed, input trace and expected checkpoints.
- **Oracle**: the reference implementation used to produce expected checkpoints.

## Requirements

### R1 Fixed-timestep simulation
**User story:** As a game developer, I want simulation independent of frame rate, so the game behaves the same on every device.
1. THE core SHALL advance only in whole ticks at `game.simulation.tickRate` ticks per second.
2. WHEN the display frame rate differs from the tick rate, THE shell SHALL run zero or more ticks per frame using an accumulator, capped at `maxTicksPerFrame`, and SHALL render an interpolated view without feeding anything back into the core.
3. THE core SHALL NOT read wall-clock time, system randomness, locale, or platform state.

### R2 Numeric determinism
1. THE core SHALL represent all simulation quantities as fixed-point integers (Q16.16 in 64-bit signed storage).
2. THE core SHALL define overflow behaviour explicitly (saturating at documented bounds) and SHALL be identical on Kotlin and Swift.
3. Division SHALL truncate toward zero; shifts SHALL be arithmetic; trigonometry, if used, SHALL come from a generator-emitted integer lookup table.
4. Floating point MAY be used only in the shell for rendering.

### R3 Seeded randomness
1. THE core SHALL use one specified PRNG (PCG32, constants in the design) seeded from the scenario or session seed.
2. THE core SHALL provide named independent streams (e.g. `spawn`, `fx`) derived deterministically from the seed.
3. GIVEN the same seed, THE Kotlin, Swift and oracle implementations SHALL produce identical output sequences (bit-exact).

### R4 Input contract
1. THE shells SHALL translate platform touches into platform-neutral input events: `press`, `release`, `tap`, `drag(dx, dy)`, `swipe(direction)`, in world units (fixed-point).
2. Input events SHALL be applied at the start of the next tick; their order within a tick SHALL be deterministic.
3. Inputs SHALL be recordable as an input trace and replayable by the core without a shell.
4. Which events a spec enables SHALL come from `game.input` (extended schema).

### R5 State observation and hashing
1. THE core SHALL expose a canonical state serialization (entities ordered by id, fields in fixed order, little-endian).
2. THE core SHALL compute a 64-bit FNV-1a hash of that serialization at each checkpoint.
3. Hash and serialization SHALL be identical on Kotlin, Swift and the oracle.

### R6 Runtime primitives (enough for G2 scenarios; G3 extends)
1. Entities with id, kind, position, velocity, axis-aligned box collider, optional lifetime.
2. Deterministic update order: input → spawn → move → collide → resolve → despawn → score.
3. Spawners (interval, PRNG-driven position), world bounds, score and lives counters, end condition.
4. Collision detection SHALL be AABB with a documented, order-independent resolution rule.

### R7 Canonical spec extensions
1. THE schemas SHALL gain `game.simulation` (tickRate, maxTicksPerFrame) and the R6 primitives, following the G1 schema rules (closed objects, all properties required, titles as type names).
2. Existing specs SHALL be migrated by explicit edits; `specVersion` SHALL become 2 with a documented migration.

### R8 Golden scenarios
1. Scenarios SHALL be files `spec/scenarios/**/<name>.scenario.json` validated by a new `scenario.schema.json`: spec reference (path + SHA-256), seed, tick count, input trace, checkpoints (tick, state hash, selected observable values).
2. THE engine SHALL validate scenarios (`monstera validate-scenario`) with the same error quality as specs.
3. Expected checkpoints SHALL be produced by the oracle and committed; regenerating them SHALL be an explicit command, never an implicit side effect of a test.

### R9 Conformance
1. `monstera conformance <generated-dir>` SHALL run every scenario that applies to the spec on Kotlin (JVM unit tests, no emulator) and Swift (`swift test` on the runtime package; Linux or macOS) and compare each checkpoint with the expected values.
2. ON divergence, THE report SHALL name the scenario, the first divergent tick, the platform, and the differing observable fields.
3. THE result SHALL be machine-readable (`conformance.schema.json`) and SHALL record the spec SHA-256, scenario SHA-256s and runtime template digests (provenance).

### R10 CI and Kiro integration
1. CI SHALL run conformance on every change to schemas, scenarios, runtime templates or the engine.
2. THE MCP server SHALL gain `run_conformance` once R9 is merged and tested.
3. THE `monstera-conformance` workflow SHALL use R9 for its behavioural step.
4. A `scenario-validate-on-save` hook SHALL validate scenario files on save.

### R11 Independence of generated apps
1. Generated projects SHALL compile and run without Kiro, Python or the engine installed.
2. Conformance tests SHALL live in the generated projects as ordinary native tests (`testDebugUnitTest`, `swift test`).
