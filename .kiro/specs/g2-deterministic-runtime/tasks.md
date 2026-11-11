# G2 tasks

Status: **PROPOSED, not approved. Do not execute.** Each task runs through the
`monstera-feature` workflow; IDs in brackets are requirements.

- [ ] 1. Numeric and PRNG contract: write `architecture/RUNTIME-CONTRACT.md` with Q16.16 operations, saturation bounds, PCG32 constants, stream derivation, FNV-1a; add steering `08-runtime-determinism.md` [R2, R3, R5]
- [ ] 2. Schema v2: `game.simulation` + runtime primitives + extended `game.input`; migrate the sample spec; engine tests for the new rules [R7, R4.4, R6]
- [ ] 3. Python oracle (`tools/monstera/monstera/oracle/`): fixed-point, PCG32, core step, serialization, hash; unit tests with hand-computed vectors [R2, R3, R5, R6, D1]
- [ ] 4. Scenario format: `scenario.schema.json`, loader and validator, `monstera validate-scenario`, `monstera scenarios record` (oracle only, explicit) [R8]
- [ ] 5. Kotlin core template + JVM conformance test template; generated `runtime/` package rule in `check-architecture` [R1–R6, R11, D3]
- [ ] 6. Swift `MonsteraRuntime` package template + `swift test` conformance tests; app package depends on it by local path [R1–R6, R11, D2]
- [ ] 7. **Validate D2 early:** xtool builds the app with the local runtime package; `swift test` passes on Linux `swift:6.4.2-noble` and on macOS (spike before tasks 5–6 finish)
- [ ] 8. Shells: Compose and SpriteKit frame loop with accumulator, interpolation, touch → input contract mapping [R1.2, R4.1–R4.2]
- [ ] 9. Conformance runner `monstera conformance` + `conformance.schema.json` report + provenance [R9]
- [ ] 10. Golden scenarios (≥ 6): idle, spawn determinism, collision resolution order, input ordering within a tick, saturation bounds, long run (10,000 ticks) [R8, R2, R3, R6]
- [ ] 11. CI: `conformance` job (Linux: oracle + Kotlin JVM + Swift Linux; macOS: Swift + simulator smoke) [R10.1]
- [ ] 12. Kiro: `run_conformance` MCP tool, workflow step update, `scenario-validate-on-save` hook [R10.2–R10.4]
- [ ] 13. Negative proof: inject a deliberate divergence (e.g. float in Swift core) in a test branch; conformance must fail with the right tick and field; record the evidence [R9.2]
- [ ] 14. Adversarial review (`monstera-adversarial-review`) and release verification (`monstera-release-verification`); `docs/G2-RUNTIME-REPORT.md` with labels and evidence [all]
