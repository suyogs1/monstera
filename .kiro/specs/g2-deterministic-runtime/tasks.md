# G2 tasks

Status: **APPROVED 2026-11-11, in progress** (core, scenarios and conformance done; shells and CI evidence open, see tasks). Each task runs through the
`monstera-feature` workflow; IDs in brackets are requirements.

- [x] 1. Numeric and PRNG contract: write `architecture/RUNTIME-CONTRACT.md` with Q16.16 operations, saturation bounds, PCG32 constants, stream derivation, FNV-1a; add steering `08-runtime-determinism.md` [R2, R3, R5]
- [x] 2. Schema v2: `game.simulation` + runtime primitives + extended `game.input`; migrate the sample spec; engine tests for the new rules [R7, R4.4, R6]
- [x] 3. Python oracle (`tools/monstera/monstera/oracle/`): fixed-point, PCG32, core step, serialization, hash; unit tests with hand-computed vectors [R2, R3, R5, R6, D1]
- [x] 4. Scenario format: `scenario.schema.json`, loader and validator, `monstera validate-scenario`, `monstera scenarios record` (oracle only, explicit) [R8]
- [x] 5. Kotlin core template + JVM conformance test template; generated `runtime/` package rule in `check-architecture` [R1–R6, R11, D3]
- [x] 6. Swift `MonsteraRuntime` package template + `swift test` conformance tests; app package depends on it by local path [R1–R6, R11, D2]
- [x] 7. (verified: Linux `swift test`, macOS `swift test`, and the iOS app build with the local Runtime dependency in CI) **Validate D2 early:** xtool builds the app with the local runtime package; `swift test` passes on Linux `swift:6.4.2-noble` and on macOS (spike before tasks 5–6 finish)
- [x] 8. Shells: Compose and SpriteKit frame loop with accumulator, interpolation, touch → input contract mapping [R1.2, R4.1–R4.2]
- [x] 9. Conformance runner `monstera conformance` + `conformance.schema.json` report + provenance [R9]
- [x] 10. Golden scenarios (≥ 6): idle, spawn determinism, collision resolution order, input ordering within a tick, saturation bounds, long run (10,000 ticks) [R8, R2, R3, R6]
- [x] 11. CI (green on PR #4; see docs/G2-RUNTIME-REPORT.md): `conformance` job (Linux: oracle + Kotlin JVM + Swift Linux; macOS: Swift + simulator smoke) [R10.1]
- [x] 12. Kiro: `run_conformance` MCP tool, workflow step update, `scenario-validate-on-save` hook [R10.2–R10.4]
- [x] 13. Negative proof: inject a deliberate divergence (e.g. float in Swift core) in a test branch; conformance must fail with the right tick and field; record the evidence [R9.2]
- [ ] 14. (open) Adversarial review (`monstera-adversarial-review`) and release verification (`monstera-release-verification`); `docs/G2-RUNTIME-REPORT.md` with labels and evidence [all]

Notes (2026-11-11): the oracle also covers D4 as designed. Deviations from the design: scenarios are embedded as a text resource instead of Kotlin/Swift source (JVM method-size limit); runtime config sits in game.input and game.runtime; a second sample spec, boundary-lab, holds hand-verifiable edge cases (task 10 exceeded: 14 scenarios over two specs). Task 12 hook and MCP tool are done; the workflow step already called conformance.
