# G1 tasks

Order: the contract (1) was completed and committed before platform generation (4-6) started.

- [x] 1. Contract: `project.schema.json`, `game.schema.json`, `monstera.spec.schema.json`, canonical sample (R1)
- [x] 2. Strict loader, canonical form, SHA-256 (R1.4, R2.3)
- [x] 3. Subset validator + semantic rules + error format with fixes (R2)
- [x] 4. Type IR, Kotlin and Swift emitters from the same schemas (R3)
- [x] 5. Android templates (Gradle/Kotlin/Compose) - scope of `android-native` (R4.2)
- [x] 6. iOS templates (SwiftPM/xtool/SwiftUI/SpriteKit) - scope of `ios-native` (R4.3)
- [x] 7. `monstera generate` / `--check`, manifest, drift detection, ownership guard (R4.1, R4.5-R4.7)
- [x] 8. Unit tests: validation cases, canonicalization, determinism, codegen parity (R5.1)
- [x] 9. CI `monstera.yml`: tests, validation, `generate --check`, both builds via Device Lab (R5.2, R5.3)
- [x] 10. Hooks, steering 06, `spec-engine` agent, architecture check (R6)
- [x] 11. `docs/G1-SPECIFICATION-REPORT.md`
