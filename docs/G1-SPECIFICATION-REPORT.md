# G1 Specification Report (Phase 1: Canonical Specification Engine)

Date: 2026-11-11. Branch: `phase1/g1-spec-engine` (not merged; awaiting review).
Labels follow `.kiro/steering/04-generation-and-provenance.md`. No game is implemented, and no
deferred integration (auth, cloud sync, ads, notifications) was touched.

## Summary

| Deliverable | Result | Evidence |
|---|---|---|
| 1. `project.schema.json`, `game.schema.json` | Done | `spec/schema/` |
| 2. Canonical `monstera.spec.json` format | Done (`monstera.spec.schema.json` + canonical serialization) | `spec/samples/monstera-sample/monstera.spec.json` |
| 3. Deterministic validation | Done; 17 invalid patch cases + 2 raw-text cases, within 24 unit tests | `tools/monstera/tests/test_engine.py`, CI `spec` job |
| 4. Kotlin and Swift models from the same schema | Done | `generated/.../MonsteraSpec.kt`, `.../MonsteraSpec.swift` |
| 5. Deterministic Android and iOS scaffolding | Done | `tools/monstera/monstera/templates/`, `generated/monstera-sample/` |
| 6. `monstera generate` | Done (`validate`, `format`, `generate [--check]`, `check-architecture`, `guard-generated`) | `tools/monstera/` |
| 7. Minimal native apps from the sample spec | Done | screenshots below |
| 8. Both generated projects compile in CI | **Yes** | run [42987172336](https://github.com/suyogs1/monstera/actions/runs/42987172336) |

| Generated project | Label | Evidence |
|---|---|---|
| `generated/monstera-sample/android` | **SIMULATOR-TESTED** (local emulator); COMPILED (Linux CI) | `docs/evidence/g1-android-emulator/`; CI job `android-generated` |
| `generated/monstera-sample/ios` | **SIMULATOR-TESTED** (hosted macOS CI) | `docs/evidence/g1-ios-simulator-ci/`; CI job `ios-generated` |
| Either, on a physical device | Not tested | - |

## Acceptance criteria

| Criterion | Result | How it was checked |
|---|---|---|
| Valid sample is validated | Pass | `monstera validate --all` → `valid, sha256 88ddd663…a977e1` (local + CI) |
| Android project generated | Pass | 25-file plan; `android/` tree with Gradle wrapper, Kotlin sources, assets |
| iOS project generated | Pass | `ios/` SwiftPM package + `xtool.yml` + `Info.plist` |
| Same canonical configuration in both | Pass | CI `cmp` of both bundled JSON copies; unit test asserts byte equality and the same SHA-256 in both generated constants; **at runtime** Android logs `bundledMatches=true` and iOS logs `bundledMatches=true decodedMatches=true` |
| Both projects compile | Pass | Android: `:app:compileDebugKotlin`, `BUILD SUCCESSFUL` (local Windows and Linux CI). iOS: all 6 Swift files compiled, `Build complete! (20.07s)` (Xcode 26.6, Swift 6.3.3, xtool 1.24.0) |
| Invalid specs give useful errors | Pass | examples below; CI asserts raw fixtures exit 1 |
| Unchanged inputs give reproducible output | Pass | `generate --check` clean against committed output on Windows and Linux; two fresh CI generations `diff -r` identical to each other and to the commit; unit tests compare two written trees byte for byte |

## Architecture

Full design: [architecture/SPECIFICATION-ENGINE.md](../architecture/SPECIFICATION-ENGINE.md).

- **One source of truth.** `monstera.spec.json` = `{specVersion, project, game}`. The only
  platform-specific values (`platforms.android.minSdk`, `platforms.ios.deploymentTarget`) have
  no shared equivalent. `identifier` is one value used as both the Android applicationId and the
  iOS bundle ID, restricted to what both platforms accept.
- **Schema-driven types.** The Kotlin and Swift models are emitted from a type IR built from the
  same schema files (`title` = type name). The spec value is emitted as a typed constant
  (`GeneratedSpec`) on both platforms.
- **Generator.** Python 3.10+ standard library only; no new dependency, no AST compiler, no
  template engine (`string.Template` with an `@@` delimiter).
- **Ownership and provenance.** `generated/<id>/` is generator-owned. Text files carry a
  `GENERATED … sha256:<spec>` header. `MONSTERA-MANIFEST.json` lists every file with its
  SHA-256, source template or schema, kind and mode, plus the spec, schema and toolchain
  identity, and no timestamps.
- **xtool direction kept.** The iOS output is the same SwiftPM + `xtool.yml` layout proven at
  G0; CI builds it with `xtool dev build --triple arm64-apple-ios-simulator`.

### Changes to existing files (all documented)

| File | Change | Why |
|---|---|---|
| `device-lab/{android,ios}/adapter.sh` | Optional `DL_APP_*` overrides; defaults unchanged | Run the existing contract against generated projects |
| `.kiro/steering/02`, `04` | Added `spec/`, `generated/`, `tools/monstera/` layout; clarified that `monstera.spec.json` (not `.kiro/specs/`) is the source of truth for generated code | The old line conflated Kiro development specs with product specs |
| `.kiro/agents/*` | New `spec-engine`; platform agents also own their template dirs | Bounded ownership for parallel work after the contract |
| `.gitattributes`, `.gitignore` | LF for `generated/`, `spec/`, `tools/monstera/`; ignore `__pycache__`, `.bsp` | Byte-exact reproducibility across OSes |

The Phase 0 workflows still pass after the adapter change: `android` run 42987172253,
`ios-simulator` run 42987172122.

## Implementation

| Area | Files |
|---|---|
| Contract | `spec/schema/{monstera.spec,project,game}.schema.json` |
| Engine | `tools/monstera/monstera/{jsonio,schema,semantic,naming,validate,typemodel,emit_kotlin,emit_swift,generate,archcheck,cli}.py` |
| Templates | `tools/monstera/monstera/templates/{README.md.tmpl,android/…,ios/…}`, `toolchain.json` |
| CLI | `tools/monstera/bin/monstera` (bash, picks a working Python), `tools/monstera/monstera.py` |
| Tests | `tools/monstera/tests/test_engine.py` (24 tests), `spec/fixtures/` |
| CI | `.github/workflows/monstera.yml` (`spec` → `android-generated`, `ios-generated`) |
| Kiro | `.kiro/specs/g1-specification-engine/`, `.kiro/steering/06-specification-engine.md`, `.kiro/agents/spec-engine.json`, `.kiro/hooks/*.json` |

Kiro approach: the contract (schemas, sample, fixtures) was committed first (`5992472`), before
any platform template work. Platform templates are separated into directories owned by the
`android-native` and `ios-native` agents. In this session one agent did the work in that order;
no parallel sub-agent runs were needed, because each template set took one short iteration.
**MCP was not used:** no MCP server adds capability over the local CLI for this phase.

## Test results

| Check | Where | Result |
|---|---|---|
| Unit tests (24) | Windows, Python 3.14.1 | OK |
| Unit tests (24) | CI ubuntu-24.04, Python 3.12.3 | OK |
| `validate --all`, `format --check`, `check-architecture` | local + CI | pass |
| `generate --check` vs committed output | local (Windows) + CI (Linux) | up to date, 25 files |
| Two fresh generations + `diff -r` | CI | identical |
| Generated Android `assembleDebug` | local (JBR 21) + CI | BUILD SUCCESSFUL |
| Generated Android on emulator | local, Android 16 | launched, "verified", logcat `bundledMatches=true` |
| Generated iOS simulator build | CI macos-26 | Build complete |
| Generated iOS on simulator | CI, iPhone 17 Pro | launched, "verified", log `bundledMatches=true decodedMatches=true` |
| Hook commands | local PowerShell, via `git -c alias.monstera=!…` | validate exit 0; guard exit 2 for relative and absolute `generated/` paths, exit 0 otherwise |

### Example errors (real output)

```
typos.json: INVALID (4 issues)
  $.game.orientation [enum]: string "portait" is not allowed; expected one of: "landscape", "portrait" (did you mean 'portrait'?)
  $.project [additionalProperties]: unknown property 'displayname' (did you mean 'displayName'?)
  $.project [required]: missing required property 'displayName'
  $.project.version.code [type]: expected integer, got string "1"; remove the quotes: 1
semantic.json: INVALID (3 issues)
  $.game.palette.primary [semantic.palette-contrast]: contrast 1.07:1 against background #1A1230 is below 3.0:1; choose a lighter or darker color
  $.game.world [semantic.orientation-aspect]: world is 1920x1080 (landscape) but orientation is 'portrait'; swap width and height or set orientation to 'landscape'
  $.project.identifier [semantic.identifier-keyword]: segment 'object' is a Java/Kotlin keyword and can't be a package name
spec/fixtures/raw/duplicate-key.json: INVALID (1 issue)
  duplicate-key.json:line 3, column 3 [json.duplicate-key]: duplicate key 'specVersion'
generate: refusing to generate from an invalid specification          (exit 1)
```

## Limitations

- **Schema subset.** No optional properties, `oneOf`/`anyOf`, or `multipleOf`. Unsupported
  keywords fail at load, by design.
- **Pattern dialect.** Patterns use Python `re` semantics, so editor validation (VS Code, ECMA
  regex) could differ for exotic patterns. The current patterns are portable.
- **Parse-error position varies by Python version.** For example, a trailing comma is reported
  at line 3 on Python 3.14 and line 4 on 3.12. Both are correct, but the output isn't identical
  across Python versions. Validation of parsed specs is identical.
- **Android integrity check is hash-only.** The Kotlin side has no JSON decoder (none added).
  iOS also decodes and compares.
- **Hooks not observed live.** Kiro activates new hooks at the next session, so they haven't
  fired in a live session yet. Their commands were tested directly with representative payloads.
  On Windows they rely on Git's shell resolving `!` aliases (verified here).
- **Android in CI is compile-only.** The emulator run of the generated app was local.
- **No physical-device testing.** No automated UI tests; the Device Lab `test` op is still `unsupported`.
- **Python version spread.** `python3` must be ≥ 3.10. Windows users may need `py -3` (the wrapper
  handles this).

## Remaining work (not started)

1. Review and merge this branch.
2. Decide where hand-maintained game code lives relative to `generated/` (Phase 2 design input).
3. Extend the game schema for real game content, keeping the required-property and
   unsupported-keyword rules or deliberately relaxing them.
4. Android JSON decode parity (if a decoder dependency is accepted) and automated `test` ops.
5. Physical-device runs (still blocked on hardware and Apple ID).
