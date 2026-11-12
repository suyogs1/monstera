# Specification engine architecture (G1)

The specification engine turns one canonical `monstera.spec.json` into native Android and iOS
projects. It is build tooling: nothing from it ships inside an app except the files it generates.

```
spec/schema/*.schema.json ─────────────┐ (contract)
                                       ▼
monstera.spec.json ─► strict load ─► schema validation ─► semantic rules ─► canonical bytes + SHA-256
                                       │                                         │
                                       └──► type IR (same schema files) ◄────────┤
                                               │                                 │
                     ┌─────────────────────────┴───────────────┐                 │
                     ▼                                         ▼                 │
              Kotlin emitter                              Swift emitter          │
     MonsteraSpec.kt + GeneratedSpec.kt          MonsteraSpec.swift + GeneratedSpec.swift
                     │                                         │                 │
                     ▼                                         ▼                 ▼
         Android templates (Gradle/Compose)       iOS templates (SwiftPM/xtool)  canonical JSON copy
                     └──────────────► generated/<id>/{android,ios} + MONSTERA-MANIFEST.json
```

## Components (`tools/monstera/monstera/`)

| Module | Responsibility |
|---|---|
| `jsonio.py` | Strict JSON load (duplicate keys, NaN/Infinity, BOM, UTF-8, line/column), canonical serialization, SHA-256 |
| `schema.py` | Loads `spec/schema/*.schema.json`, rejects unsupported keywords, validates instances deterministically |
| `semantic.py` | Cross-field rules: orientation vs. world aspect, aspect limit, palette contrast (WCAG 3:1), Kotlin-keyword package segments, product name vs. system modules |
| `typemodel.py` | Platform-neutral type IR from the schemas (records, enums, scalars, lists) |
| `emit_kotlin.py` / `emit_swift.py` | Model types and the typed spec constant, by string emission (no AST) |
| `generate.py` | Builds the full output plan in memory; `write()` and `check()` both consume it |
| `archcheck.py` | Rejects forbidden frameworks in build/package manifests |
| `cli.py` | `validate`, `format`, `generate [--check] [--force]`, `verify`, `check-architecture`, `guard-generated` |
| `templates/` | Deterministic structural templates (`@@{name}` placeholders) and the static Gradle wrapper |
| `toolchain.json` | Pinned versions used by generated projects (same as the Phase 0 apps) |

## The contract

- `monstera.spec.schema.json` = `{specVersion: 3, project, game}`.
- `project.schema.json`: `id`, `displayName`, `identifier` (one reverse-DNS value valid on both
  platforms; it is the Android `applicationId`/namespace and the iOS bundle ID), `version`
  (`name` semver + `code`), `targets`, and `platforms.{android.minSdk, ios.deploymentTarget}`.
  The latter are the only platform-specific values; neither has a cross-platform equivalent.
- `game.schema.json`: presentation only: `genre`, `orientation`, `targetFps`, `world`
  (logical size), `palette`, `input.scheme`. No gameplay.
- Every property is required and `additionalProperties` is `false`.

### Supported JSON Schema subset

`$schema $defs $ref title description type properties required additionalProperties enum const
pattern minLength maxLength minimum maximum exclusiveMinimum items minItems uniqueItems`.
Anything else fails schema loading. Loading also runs a structural meta-check, because each of
these would make validation lie or the generated code wrong: every node has a known `type`;
objects are closed (`additionalProperties: false`) and `required` lists every property exactly
once; property names are lowerCamelCase and not Kotlin/Swift keywords; titles are PascalCase and
not built-in or generator helper names; patterns compile; enums are non-empty, unique and
type-consistent, and map to unique case names on both platforms; every `$ref` resolves.
Differences from full JSON Schema (all stricter): integers
must be JSON integer tokens, booleans are never numbers, `pattern` uses Python `re` with a
trailing `$` meaning end of string, and `$ref` resolves to sibling schema files only.

### Error format

`<json-path> [<rule>]: <message>`, sorted by path, then rule. Messages include the offending
value, the constraint, and a fix where one exists (closest enum value or property name,
"remove the quotes", "swap width and height"). Parse errors carry `file:line N, column M`.
Semantic rules run only when the schema passes, so they can rely on types.

## Canonical form and identity

UTF-8, keys sorted, 2-space indent, LF, trailing newline (`monstera format`); integral floats
are written as integers (`1080.0` → `1080`). The spec SHA-256 is computed over these bytes, so key
order, whitespace or number spelling in the source file doesn't change it. The loader rejects
duplicate keys, NaN/Infinity, numbers that overflow a double (`1e400`), a BOM, invalid UTF-8 and
pathological nesting. Messages are ASCII-escaped, so output is identical on every console.

## Output layout and ownership

```
generated/<project.id>/
  MONSTERA-MANIFEST.json      generator, spec path + sha256, schema sha256s, toolchain, files[]
  README.md
  android/  settings.gradle.kts, build.gradle.kts, gradle.properties, gradlew(.bat), gradle/wrapper/*
            app/build.gradle.kts, app/src/main/AndroidManifest.xml
            app/src/main/assets/monstera.spec.json                  canonical copy
            app/src/main/kotlin/<identifier path>/MainActivity.kt
            app/src/main/kotlin/<identifier path>/generated/{MonsteraSpec,GeneratedSpec}.kt
  ios/      Package.swift, xtool.yml, Info.plist
            Sources/<Product>/{<Product>App,ContentView,GameScene,SpecIntegrity}.swift
            Sources/<Product>/Resources/monstera.spec.json           canonical copy
            Sources/<Product>/Generated/{MonsteraSpec,GeneratedSpec}.swift
```

- The whole directory is generator-owned. Text files carry
  `GENERATED by monstera-generator <ver> from monstera.spec.json sha256:<16 hex> - do not edit`.
  JSON and the static wrapper files can't carry comments; the manifest records them instead
  (`kind`: `template`, `static`, `model`, `spec`).
- Hand-maintained code does not live here. Where future game code lives is a Phase 2 decision.
- Build output is recognised only at fixed paths: `android/{.gradle,.kotlin,build,app/build,local.properties}`
  and `ios/{.build,.swiftpm,xtool,.bsp}`. It is ignored by `--check`/`verify` and never deleted. A
  directory named `build` anywhere else (e.g. under `Sources/`, which SwiftPM compiles) is
  reported as unexpected.

### Overwrite rules (`generate`)

| Situation in the output directory | Without `--force` | With `--force` |
|---|---|---|
| Empty or missing | write | write |
| Generator-owned file, unmodified since the last run | replace | replace |
| Generator-owned file, hand-modified | **refuse** | discard the edit |
| File the previous manifest doesn't list | **refuse** | delete |
| Output of another project (`spec.projectId` differs) | **refuse** | overwrite |
| Non-empty, no valid manifest (not generator-owned, e.g. `--out .`) | **refuse** | **refuse** |
| Any symlink inside | **refuse** | **refuse** |

The manifest is written last, so an interrupted run leaves files that match either the old
manifest or the new plan, and the next run completes. `monstera verify <dir>` checks a tree
against its own manifest without regenerating, so hand edits are detected even after the
generator or spec has changed.

## Determinism

- No timestamps or absolute paths in any output (spec path is recorded repo-relative).
- Files and manifest entries are sorted; JSON is canonical; type and field order follow
  schema declaration order.
- Template line endings are normalized to LF (CRLF for `.bat`), so a Windows checkout produces
  the same bytes as Linux. `.gitattributes` keeps `generated/`, `spec/` and `tools/monstera/` LF.
- File modes are fixed (`gradlew` 755, others 644) and recorded in the manifest.
- `generate --check` regenerates in memory and reports `changed`, `missing` and `unexpected` files.

## Runtime parity check

Both apps bundle the byte-identical canonical JSON. At launch:
- Android hashes the asset and compares it with `GeneratedSpec.SHA256`.
- iOS hashes the resource **and** decodes it with the generated `Codable` models, then compares
  the result with `GeneratedSpec.spec`.
Both display "verified" or "MISMATCH" and log the result.

## Kiro integration

| Mechanism | Use |
|---|---|
| Steering `06-specification-engine.md` | Rules for changing the contract, generator and output |
| Agent `spec-engine` | Owns `spec/` and the generator core; `android-native`/`ios-native` own their template dirs |
| Hook `guard-generated-output` (PreToolUse) | Blocks file-tool edits under `generated/` |
| Hook `validate-specs-on-save` (PostFileSave) | `monstera validate --all` |
| Hook `architecture-check-on-build-file-save` (PostFileSave) | `monstera check-architecture` |
| Kiro spec `.kiro/specs/g1-specification-engine/` | Requirements, design, tasks for G1 |
| MCP | Not used: no MCP server adds capability over the local CLI for this phase |

Hooks invoke `git -c alias.monstera=!tools/monstera/bin/monstera monstera …`. Git runs `!` aliases
with its own POSIX shell from the repository root on Windows, macOS and Linux, and the wrapper
picks a working Python (`python3`, `python`, `py -3`). One committed command works on every OS.

## Limits (G1)

- No optional properties, no `oneOf`/`anyOf`, no cross-file `$defs` reuse beyond `$ref` to a file.
- The Kotlin side checks the hash only; it has no JSON decoder (no new dependency was added).
- The emitted app shells are presentation previews, not a game engine.
