# Deterministic runtime (G2)

Normative contract: `architecture/RUNTIME-CONTRACT.md`. Kiro Spec: `.kiro/specs/g2-deterministic-runtime/`.

- The simulation core exists three times, written independently from the contract: the Python oracle
  (`tools/monstera/monstera/oracle/`), the Kotlin core (`templates/android/runtime/`) and the Swift core
  (`templates/ios/Runtime/`). Never port one implementation into another; port the contract. If they
  disagree, the contract decides, and the contract gets fixed first if it was wrong or silent.
- The core is platform-free and float-free: no Android/UIKit/SwiftUI/SpriteKit/Foundation imports, no
  `Double`/`Float`/float literals, no clock, no system randomness, no locale, no `ushr`, no iteration over
  hash-ordered collections. `monstera check-architecture` enforces what it can read.
- Quantities are Q16.16 raw integers in 64-bit storage, saturated to the int32 range (contract section 2).
  `mul` floors, `div` truncates, shifts are arithmetic. Specs store raw integers (1 unit = 65536).
- Randomness is PCG32 with named streams derived from the seed (contract section 3). Draw counts are part
  of the behaviour: a skipped draw is a divergence, and RNG state is part of the state hash.
- Tick order is fixed: input, spawn, move, collide and resolve, despawn, advance. Entities are always
  iterated in id order. Collision effects are summed per tick so pair order cannot matter.
- Golden scenarios (`spec/scenarios/<project>/*.scenario.json`) are recorded only by
  `monstera scenarios record`, never by a test and never by hand. A spec change makes them stale on purpose:
  re-record, review the diff, commit.
- `monstera conformance <generated-dir>` is the proof. A claim of behavioural equivalence needs its output
  (all three platforms, verdict PASS) or must say which platform was skipped.
- A new behaviour needs, in this order: a contract section, an oracle implementation with hand-computed
  tests, a scenario that exercises it, a mutant in `tests/test_mutations.py` that the scenario kills, then
  the Kotlin and Swift implementations.
