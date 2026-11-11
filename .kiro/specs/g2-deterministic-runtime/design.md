# G2 design: deterministic native runtime

Status: **APPROVED 2026-11-11, in progress** (core, scenarios and conformance done; shells and CI evidence open, see tasks). (Kiro Spec; not a `monstera.spec.json`.)

## Architecture

```
monstera.spec.json (v2: + game.simulation, + primitives)
        │
        ▼  tools/monstera (unchanged pipeline + runtime templates)
┌───────────────────────────── generated app ─────────────────────────────┐
│ Android                                │ iOS                            │
│  shell: Compose Canvas + frame loop    │  shell: SpriteKit + SKView loop│
│  core:  <pkg>.runtime (pure Kotlin)    │  core:  MonsteraRuntime (pure  │
│         Fx, Pcg32, World, step(),      │         Swift package)         │
│         serialize(), fnv1a64()         │         same API               │
│  test:  ConformanceTest (JVM)          │  test:  ConformanceTests       │
└────────────────────────────────────────┴────────────────────────────────┘
        ▲ scenarios (spec/scenarios, copied into test resources by the generator)
        │
tools/monstera/oracle (Python): records expected checkpoints, never shipped
```

## Decisions

| ID | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| D1 | **Python oracle** in the engine produces expected checkpoints; Kotlin and Swift must both match it | An independent third implementation catches errors common to two hand-written ports that a pure Kotlin-vs-Swift comparison would miss. It runs on Linux CI in seconds. It's a *test oracle*, not generation logic, so it doesn't duplicate the generator | Recording Kotlin output as golden (bugs become "truth"); generating the core from an IR (that's an AST compiler, excluded by G1) |
| D2 | Swift core is a **separate local SwiftPM package** `ios/Runtime` that the app package depends on by path | It lets `swift test` run on Linux without SwiftUI/SpriteKit. Must be validated with xtool first (task 7) | Single package (SwiftUI target blocks Linux tests) |
| D3 | Kotlin core stays **inside the app module** in package `<id>.runtime`, tested with `testDebugUnitTest` on the JVM; `check-architecture` forbids `android.*`/`androidx.*` imports there | No new Gradle plugin; JVM tests need no emulator | Separate `kotlin("jvm")` module (adds a plugin) |
| D4 | Fixed point **Q16.16 in Int64/Long**, saturating to ±2^31 range before multiply; products computed in 64 bits | Fits 64-bit intermediates without 128-bit math. Kotlin `Long` wraps silently and Swift traps on overflow, so explicit saturation removes that platform difference | Floats (cross-platform libm/FMA differences); Q32.32 (needs 128-bit products) |
| D5 | PCG32 (XSH-RR, multiplier `6364136223846793005`, stream increments derived via SplitMix64 from the seed and stream name hash) | Small, well specified, bit-exact in 64-bit unsigned arithmetic (Kotlin `ULong`/`Long` wrapping, Swift `&*`/`&+`) | System RNGs; xorshift variants with weaker specs |
| D6 | State hash = FNV-1a 64 over the canonical little-endian serialization | Trivial to implement identically in three languages; a checkpoint mismatch localizes to a tick | SHA-256 per tick (slower, no benefit for divergence detection) |
| D7 | Simulation tick rate is independent of `targetFps`; the shell accumulates time and caps ticks per frame | Determinism and graceful slowdown | Variable timestep |

## Determinism pitfalls handled explicitly

| Pitfall | Kotlin | Swift | Contract |
|---|---|---|---|
| Overflow | `Long` wraps silently | `Int64` traps; `&+`/`&*` wrap | Saturate before arithmetic; tested at bounds |
| Division | truncates toward zero | truncates toward zero | Same, plus a test with negative operands |
| Right shift | `shr` arithmetic | `>>` arithmetic on signed | Arithmetic only; `ushr` is forbidden in the core |
| Iteration order | `HashMap` order unspecified | `Dictionary` order randomized per process | Entities in arrays sorted by id; no hash-ordered iteration in the core |
| Float leakage | `Double` | `Double`, `CGFloat` | The core contains no floating-point types; enforced by an architecture check on the core sources |

## Data contracts

- `scenario.schema.json`: `{specVersion, spec: {path, sha256}, seed, ticks, inputs: [{tick, events: [...]}], checkpoints: [{tick, hash, observe: {score, lives, entityCount, ...}}]}`.
- `conformance.schema.json`: `{spec_sha256, runtimeDigests, scenarios: [{name, sha256, platforms: {kotlin, swift, oracle: {status, firstDivergence?}}}], verdict}`.

## Testing strategy

1. **Oracle unit tests**: known PCG32 vectors, fixed-point edge cases, hash vectors.
2. **Native unit tests** (generated): the same vectors on Kotlin and Swift.
3. **Scenario conformance**: all scenarios × {Kotlin JVM, Swift Linux, Swift macOS}.
4. **Negative proof** (task 13): a deliberate divergence must be caught and localized.
5. **Adversarial review** of the contract and runner before release verification.

## Risks

| Risk | Mitigation |
|---|---|
| D2 fails under xtool (local package dependency) | Spike first (task 7). Fallback: the Swift core is copied as a second target and tests run on macOS only |
| Fixed-point feel too coarse for gameplay | Q16.16 gives sub-pixel precision at world sizes ≤ 32k units; validate in G3 prototypes |
| Schema v2 migration breaks G1 fixtures | Explicit migration + updated fixtures; `generate --check` in CI catches drift |
