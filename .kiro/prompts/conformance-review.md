Cross-platform conformance review of: $ARGUMENTS (a generated app directory such as
`generated/<id>` or `apps/<id>`).

Goal: the Kotlin (Android) and Swift (iOS) projects generated from one canonical spec must carry
the same configuration and, from G2 on, behave identically.

1. `monstera verify <dir>`: both projects match the manifest.
2. Bundled spec parity: `android/app/src/main/assets/monstera.spec.json` and
   `ios/Sources/<Product>/Resources/monstera.spec.json` are byte-identical, and both hash to the
   manifest's `spec.sha256` and to the generated `GeneratedSpec` constants.
3. Model parity: every schema type exists on both platforms with the same fields and enum values.
4. Behaviour (G2+): run `monstera conformance <dir>`. For each golden scenario, compare the
   checkpoints (tick, state hash, observed values) across the oracle, Kotlin and Swift.
5. Read both runtimes for platform-dependent behaviour the scenarios might miss: floating point
   in the core, hash-ordered iteration, overflow handling, division/shift semantics, wall-clock or
   locale reads.

Output exactly one table:
`| Scenario/check | Tick | Field | Oracle | Kotlin | Swift | Verdict |`
followed by `CONFORMANT` or `DIVERGENT: <n>`. Each divergence needs evidence (command output or file:line).
