# G1 Canonical Specification Engine: requirements

Phase 1 (gate G1). Source: the G1 brief. No game implementation and no deferred integrations
(auth, cloud sync, ads, notifications).

## R1 Canonical specification

- R1.1 One file, `monstera.spec.json`, is the only source of truth for a generated project.
- R1.2 Its format is defined by `spec/schema/monstera.spec.schema.json`, which composes
  `project.schema.json` and `game.schema.json`.
- R1.3 Every property is required and unknown properties are rejected, so the canonical form
  has no implicit defaults.
- R1.4 Canonical serialization (sorted keys, 2-space indent, UTF-8, LF, trailing newline) is
  defined, and its SHA-256 identifies the spec.

## R2 Validation

- R2.1 Validation is deterministic: same input, same errors, in the same order.
- R2.2 Errors name the JSON path, the rule, the offending value and, where possible, a fix
  (closest allowed value or property name).
- R2.3 Malformed JSON, duplicate keys and non-finite numbers are rejected with line/column.
- R2.4 Semantic rules that a schema can't express (e.g. orientation vs. world aspect) are
  validated after the schema passes.

## R3 Typed models

- R3.1 Kotlin and Swift model types are generated from the same schema files.
- R3.2 The canonical spec is emitted as a typed constant on both platforms, with its SHA-256.

## R4 Scaffolding and generation

- R4.1 `monstera generate <spec>` writes `generated/<project.id>/{android,ios}`.
- R4.2 Android output: Gradle (Kotlin DSL) + Kotlin + Jetpack Compose, pinned versions.
- R4.3 iOS output: a SwiftPM package with `xtool.yml` (SwiftUI + SpriteKit), the same layout
  that was proven at G0.
- R4.4 Both outputs contain the byte-identical canonical spec and check its hash at runtime.
- R4.5 Every output file is listed in `MONSTERA-MANIFEST.json` with its SHA-256 and provenance.
  The manifest has no timestamps.
- R4.6 Regenerating from unchanged inputs produces byte-identical output.
- R4.7 Generated output is marked generated, and generator-owned directories never contain
  hand-maintained files.

## R5 Verification

- R5.1 Unit tests cover validation (valid and invalid fixtures), canonicalization, determinism
  and code generation.
- R5.2 CI regenerates and fails if committed output differs.
- R5.3 CI compiles both generated projects with the existing Device Lab `build` op.

## R6 Governance

- R6.1 Kiro hooks validate specs on save and block hand edits to generated output.
- R6.2 An architecture check rejects forbidden cross-platform frameworks.
