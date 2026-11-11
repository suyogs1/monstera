# G2 report: deterministic runtime and conformance

Branch `g2/deterministic-runtime`, PR #4, from `main` at `2c5bb0f` (the verified merge of PR #3). Labels follow
`.kiro/steering/04-generation-and-provenance.md`. "Local" means this Windows machine (Python 3.14, Gradle 9.9.1,
Docker Desktop with `swift:6.1-noble`). "CI" means GitHub Actions on the PR. A claim is made only for evidence that exists.

## Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Same spec, seed and inputs give matching state across Python, Kotlin and Swift | MET | 18 scenarios on 2 specs, 1,513 checkpoints, verdict PASS: `docs/evidence/g2-conformance/*.txt`, `*.report.json` (local); the CI `conformance` job re-ran it on Linux |
| Both native app projects build with the integrated runtime | MET | CI `android-generated` (Gradle `assembleDebug`) and `ios-generated` (iOS app compiled with the local `ios/Runtime` package, installed and launched in the iOS Simulator) |
| Frame loops use the contract's fixed-tick semantics | MET for the core and shells' structure; see limits | `FrameClock`/`GameLoop` live in the core and all three implementations pass the same vectors and 4 recorded frame-driven scenarios. Both shells only measure time, map touches and draw. CI log: `runtime ticks=60 hash=... seed=...` printed by the SpriteKit shell in the simulator |
| Conformance failures identify the first divergent tick and fields | MET | `docs/evidence/g2-negative-proof/` (broken `mul`: scenario `negative-rounding`, tick 1) and `g2-negative-proof-loop/` (no tick cap: scenario `loop-hitch`, frame 8, fields `tick, entityCount, nextId, hash`) |
| CI proves the required builds and tests | see "CI" below | PR #4 checks |
| Limitations and untested device claims explicit | MET | next section |

## Evidence by capability

| Capability | Label | Evidence |
|---|---|---|
| Runtime contract (`architecture/RUNTIME-CONTRACT.md`) | document | reviewed by the adversarial workflow |
| Python oracle, Kotlin core, Swift core | COMPILED and unit-tested | local Gradle and Docker runs, plus CI on Linux and macOS |
| Compose shell (`GameScreen.kt`) | COMPILED (local `assembleDebug`, CI `android-generated`) | no emulator or device run of this build |
| SpriteKit shell (`GameScene.swift`) | COMPILED and SIMULATOR-TESTED for launch and loop ticking (CI iOS Simulator) | touch input is not exercised by any test; no physical device |
| 29 simulation mutants and 7 loop mutants | killed | `tools/monstera/tests/test_mutations.py`; the 5 state-affecting loop mutants die on the recorded scenarios alone |
| Hand-computed edge expectations | tested | `tools/monstera/tests/test_boundary_lab.py` |

Test counts at the time of writing: engine 196, MCP 30, gates 12/12.

## Limitations (explicit)

- Kotlin was run locally on Windows and in CI on Linux; there is no macOS/JVM combination and no Android emulator run of the G2 build.
- iOS touch handling, `touchesEnded` tap detection, swipe mapping and on-screen rendering are written but not exercised by tests or a screenshot review for G2. No physical device was used for anything.
- The three implementations were written by the same agent in one session. They are independent in code, not in authorship; published vectors, hand-computed tests and mutation tests reduce but do not remove common-mode risk.
- Saturation of `add`/`sub` is not observable through the simulation (a clamp or despawn masks it) and operand pre-saturation is not scenario-visible; both are covered by known-answer vectors only.
- `tick` and `nextId` are 32-bit: Kotlin wraps and Swift would trap after about 4.3 billion ticks or spawns, and the oracle would raise. This is outside any supported session length and is not tested.
- The Swift container image is pinned to `swift:6.1-noble` in `toolchain.json` (the version verified here); the experimental xtool workflow still defaults to a different Swift. The tag is not a digest.
- The Kotlin and Swift cores were not independently reviewed by a second model; the adversarial workflow (see "Review") is the independent check.
- The Compose and SpriteKit shells use floating point for display and time; this is outside the deterministic core by design.

## Things found by this work, and fixed

- A contract error (a zero-size box strictly inside another overlaps) found by a hand check before native code existed.
- The macOS compiler rejected a property named `bounds` in `GameScene`; a `ticks > 100` assertion failed on `boundary-lab`, where the game legitimately ends early (an earlier evidence file honestly recorded that FAIL).
- Primitive operands were not saturated: a shell-supplied out-of-range delta would have trapped in Swift and wrapped in Kotlin. Operands are now saturated first, with vectors at the Int64 extremes.
- The frame-duration generator produced only 4 to 12 ms frames, so the "hitch" scenario never hitched; the negative proof exposed it, the generator was fixed and the scenarios were re-recorded.
- Architecture review (workflow `monstera-adversarial-review`): the frame loop had no recorded scenario (added 4), the MCP security document contradicted `run_conformance` (updated; the container now has no network and a read-only source mount), duplicate `junit` pin in `toolchain.json` (removed; the loader now rejects duplicate keys), stale architecture docs, un-hoisted Compose state (hoisted into `GameSession`).

## Review (workflow `monstera-adversarial-review`, target 847e491)

The review reported 20 issues and 7 blockers. All 7 blockers and the rest were fixed, each with a regression test (the
reviewer's tests are `tools/monstera/tests/test_adversarial_g2.py` and `tools/monstera-mcp/tests/test_adversarial_g2.py`):

- oracle-only conformance reported PASS: the verdict is now `pass` only with oracle, Kotlin and Swift all run and matching, otherwise `incomplete`;
- conformance ran unchecked, edited sources and accepted a manifest without scenario resources: it now calls `verify` first, requires the resource, and computes the runtime digests from the files;
- generation embedded a hand-edited golden checkpoint: embedding now requires the checkpoints to equal a fresh oracle run;
- truncated scenarios, `record` on invalid scenarios, non-atomic `record`, unbounded oracle cost, malformed or duplicated platform output, wrong-typed MCP arguments, NaN in specs, and purity-guard gaps (float conversions and literals, nested core directories) are rejected or detected;
- the architecture findings (no frame-loop scenario, MCP security document, stale report and evidence pairs, unpinned Swift image, duplicate `junit` key, unhoisted Compose state, stale docs) are fixed as described above.

Not covered by the review or by any test: concurrent runs on one directory, and behaviour of the u32 `tick`/`nextId`/`age` counters near 2^32.
The differential fuzz the reviewer ran (10,139 trace lines, identical on Kotlin and Swift) is a one-off result, not a committed check.

## CI

Recorded below after the final push.
