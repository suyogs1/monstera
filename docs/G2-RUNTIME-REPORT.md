# G2 report: deterministic runtime and conformance

Branch `g2/deterministic-runtime` (from `main` at `2c5bb0f`, the verified merge of PR #3). Labels follow `.kiro/steering/04-generation-and-provenance.md`.

## Evidence kinds

Local evidence (this machine, Windows plus Docker) is in `docs/evidence/g2-*`. CI evidence is recorded in the PR; until a check is green there it is not claimed.

## Result

| Capability | Label | Evidence |
|---|---|---|
| Runtime contract (Q16.16, PCG32, tick order, collisions, serialization, hash) | GENERATED (document) | `architecture/RUNTIME-CONTRACT.md` |
| Python oracle matches published PCG32, SplitMix64 and FNV-1a vectors | tested | `tests/test_oracle.py` |
| Kotlin core: 3 JVM unit tests pass on 2 specs | COMPILED + unit-tested on Windows (Gradle 9.9.1, local JDK) | `docs/evidence/g2-conformance/*.txt` |
| Swift core: `swift test` on Linux (swift:6.1-noble, Docker) passes on 2 specs | COMPILED + unit-tested on Linux | same |
| Oracle, Kotlin and Swift agree on every checkpoint | 14 scenarios, 1,109 checkpoints, verdict PASS for both specs | `docs/evidence/g2-conformance/*.report.json` |
| Conformance catches a deliberate fault and localizes it | negative proof | `docs/evidence/g2-negative-proof/` |
| 29 oracle mutants all killed by the committed scenarios | tested | `tests/test_mutations.py` |
| Hand-computed edge expectations (touching edges, exact world exits, bounce, rounding, lives) | tested | `tests/test_boundary_lab.py` |

Test counts: engine 169, MCP 26 (with the new tests), gates 12/12.

## What a skeptical judge should know

- Kotlin was tested on Windows only; Linux Kotlin is expected to match but has not run (the CI job exists, unrun).
- No simulator, device or UI shell was involved. G2 task 8 (Compose and SpriteKit frame loops, accumulator, input mapping) is open.
- The SwiftUI app package now depends on `ios/Runtime` by local path. That is NOT yet built on macOS or with xtool:
  only `swift test` on the Runtime package ran. CI (`ios-generated`) will be the first check, so task 7 is partial.
- The new CI jobs have not run on GitHub. No claim about them is made.
- Saturation of `add`/`sub` is not observable through the simulation (a later clamp or despawn masks it); it is
  covered by the known-answer vectors that the Kotlin and Swift suites run, not by scenarios.
- A hand check found a contract error (a zero-size box inside another box does overlap). Contract, oracle and
  comments were corrected before native code was recorded against it.
- The oracle, Kotlin and Swift were written by the same agent in one session. They are independent in code, not in
  authorship. Hand-computed tests and published vectors reduce, but do not remove, that common-mode risk.

## Open before G3

1. Push the branch; get CI green (Linux conformance, macOS `swift test`, iOS simulator build with the local package).
2. Task 8 shells; task 14 adversarial review and release verification.
