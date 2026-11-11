# G1 Specification Report (Phase 1: Canonical Specification Engine)

Date: 2026-11-11. Branch: `phase1/g1-spec-engine` (not merged; awaiting review). Updated after the G1 adversarial review.
Labels follow `.kiro/steering/04-generation-and-provenance.md`. No game is implemented, and no
deferred integration (auth, cloud sync, ads, notifications) was touched.

## Summary

| Deliverable | Result | Evidence |
|---|---|---|
| 1. `project.schema.json`, `game.schema.json` | Done | `spec/schema/` |
| 2. Canonical `monstera.spec.json` format | Done (`monstera.spec.schema.json` + canonical serialization) | `spec/samples/monstera-sample/monstera.spec.json` |
| 3. Deterministic validation | Done; 17 invalid patch cases + 2 raw-text cases; 56 unit tests in total (24 engine + 32 adversarial regression) | `tools/monstera/tests/`, CI `spec` job |
| 4. Kotlin and Swift models from the same schema | Done | `generated/.../MonsteraSpec.kt`, `.../MonsteraSpec.swift` |
| 5. Deterministic Android and iOS scaffolding | Done | `tools/monstera/monstera/templates/`, `generated/monstera-sample/` |
| 6. `monstera generate` | Done (`validate`, `format`, `generate [--check] [--force]`, `verify`, `check-architecture`, `guard-generated`) | `tools/monstera/` |
| 7. Minimal native apps from the sample spec | Done | `docs/evidence/g1-android-emulator/01-launched.png`, `docs/evidence/g1-ios-simulator-ci/01-launched.png` |
| 8. Both generated projects compile in CI | **Yes** | run [42987172336](https://github.com/suyogs1/monstera/actions/runs/42987172336) |

| Generated project | Label | Evidence |
|---|---|---|
| `generated/monstera-sample/android` | **SIMULATOR-TESTED** (local emulator); COMPILED (Linux CI) | `docs/evidence/g1-android-emulator/`; CI job `android-generated` |
| `generated/monstera-sample/ios` | **SIMULATOR-TESTED** (hosted macOS CI) | `docs/evidence/g1-ios-simulator-ci/`; CI job `ios-generated` |
| Either, on a physical device | **Not tested** (no hardware or Apple ID used) | - |

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
| Tests | `tools/monstera/tests/test_engine.py` (24), `test_adversarial.py` (32), `spec/fixtures/` |
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
| Unit tests (56) | Windows, Python 3.14.1 (working tree and a fresh `core.autocrlf=true` clone) | OK, 1 skipped (symlink test needs elevation on Windows) |
| Unit tests (56) | CI ubuntu-24.04, Python 3.12.3 | OK, 1 skipped (Windows-only case-insensitive path test); symlink test ran |
| `validate --all`, `format --check`, `check-architecture` | local + CI | pass |
| `generate --check` vs committed output | local (Windows), fresh Windows clone, CI (Linux) | up to date, 25 files |
| `verify` (tree vs its own manifest) | local, fresh Windows clone, CI | matches its manifest |
| Fresh-generation manifest SHA-256 | Windows clone vs CI Linux (run 42993403656, commit `0bf89ea`) | both `c012aa98db899661153f52ee342c80326b0de2f4c43101235a952a48367a8bb2` |
| Fresh-generation manifest SHA-256, final templates | Windows (local) vs CI Linux on the final PR commit | Windows `a75d60cf3a781f7113a1d3fa99453f363a16dd96c2c9b51afde2f1c1e20642bd`; CI value is printed by the `spec` job and quoted in the PR |
| Two fresh generations + `diff -r` | CI | identical |
| Generated Android `assembleDebug` | local (JBR 21) + CI | BUILD SUCCESSFUL |
| Generated Android on emulator | local, Android 16 | launched, "verified", logcat `bundledMatches=true` |
| Generated iOS simulator build | CI macos-26 | Build complete |
| Generated iOS on simulator | CI, iPhone 17 Pro | launched, "verified", log `bundledMatches=true decodedMatches=true` |
| Hook commands | local PowerShell, via `git -c alias.monstera=!…` | validate exit 0; guard exit 2 for relative and absolute `generated/` paths, exit 0 otherwise |
| `guard-generated-output` hook, live | fresh Kiro session | a real `fs_write` to `generated/monstera-sample/HOOK-PROBE.txt` was blocked by the hook; file not created |
| PostFileSave hooks, live | fresh Kiro session | **not observed**: they fire on editor saves by a user, not on agent writes (an agent rewrite of the spec produced no hook output) |

### Example errors (real output)

```
typos.json: INVALID (4 issues)
  $.game.orientation [enum]: string "portait" is not allowed; expected one of: "landscape", "portrait" (did you mean 'portrait'?)
  $.project [additionalProperties]: unknown property "displayname" (did you mean 'displayName'?)
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

## Adversarial review (G1 review)

Each item was attacked, not just re-run. "Before" is what the attack did on commit `105756b`.

| # | Requirement | Before | Fix (commit `dabfe66`) | Now |
|---|---|---|---|---|
| 1 | Ownership and modification detection | **Hole:** build-output names were ignored at any depth, so `ios/Sources/MonsteraSample/build/Injected.swift` (compiled by SwiftPM) passed `generate --check` | Build output is ignored only at fixed paths (`android/.gradle`, `android/build`, `android/app/build`, `android/.kotlin`, `android/local.properties`, `ios/.build`, `ios/.swiftpm`, `ios/xtool`, `ios/.bsp`); new `monstera verify` checks a tree against its own manifest | Injected file reported by both `--check` and `verify` |
| 2 | SHA-256 over exact canonical bytes | Correct for the sample. Gaps: `1080` and `1080.0` had different canonical bytes; `1e400` parsed as infinity | Integral floats get one spelling; overflowing numbers rejected (`json.non-finite`) | Bundled bytes, constants, manifest and `validate` all report the same SHA; the sample file's raw SHA-256 equals the spec SHA (on disk it is canonical) |
| 3 | Schema evolution / unsupported keywords | Unsupported keywords were rejected, but `additionalProperties: true` (data hashed but dropped by models), a property named `class`, a title `String`, enum values colliding as case names, and ghost `required` entries all loaded | Structural meta-check at load: closed objects only, `required` = all properties, keyword-free lowerCamel property names, PascalCase non-reserved titles, known types, compiling patterns, resolvable refs, unique enum cases on both platforms | All rejected with a `SchemaError` naming the file and JSON pointer |
| 4 | Reproducible on Windows and Linux | Verified Windows tree == Linux tree via `--check` | Added a fresh-clone test and a cross-OS manifest hash | Fresh `core.autocrlf=true` Windows clone: 0 CRLF files, `--check`/`verify` clean, fresh manifest `c012aa98…8bb2` == Linux CI |
| 5 | No silent overwriting | **Hole:** `generate` deleted user files and hand edits, and wiped a user directory containing a fake manifest | Refuses unless `--force` for hand edits, unmanaged files and another project's output; refuses even with `--force` for non-owned directories and symlinks; manifest written last (interrupted runs recover) | Attacks reproduced as regression tests in `tests/test_adversarial.py` |
| 6 | Hooks in a fresh Kiro session | Untested live | - | Guard **verified live** (real write blocked). PostFileSave hooks: commands verified, live trigger needs a user editor save (unresolved) |
| 7 | G0 Device Lab workflows unaffected | Adapters gained optional `DL_APP_*` overrides | - | Defaults unchanged; `android` and `ios-simulator` pass on the PR (see PR checks) |
| 8 | CI on final PR commit | - | CI also runs `verify` and prints the fresh manifest hash | See PR checks |

Found while verifying item 8: CI run 42995665802 failed its iOS log assertion although every Device
Lab op succeeded and the screenshot shows "verified". The app logged its integrity result at
`.info`, which unified logging keeps only in memory, and `log show` ran 71 s after launch. The
template now logs at `.notice` (persisted). Evidence:
`docs/evidence/g1-ios-simulator-ci/run-42995665802-log-dropped/`.

Other hardening found on the way: deeply nested JSON raised a raw `RecursionError` (now
`json.depth`); non-ASCII in error messages could break on non-UTF-8 consoles (messages are now
ASCII-escaped and output is UTF-8 with an escape fallback); a project id deriving an iOS product
equal to a model type (e.g. `game` gives `Game`) is now `semantic.product-name`.

## Generation examples

Sample (committed, `generated/monstera-sample/`):

```
$ tools/monstera/bin/monstera validate --all
spec/samples/monstera-sample/monstera.spec.json: valid, sha256 88ddd663d84e52761fa0834f814e1b737e75f6a62d7dddceee8af37912a977e1
$ tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json
generated/monstera-sample: generated 25 files from spec sha256 88ddd663…a977e1
$ tools/monstera/bin/monstera generate spec/samples/monstera-sample/monstera.spec.json --check
generated/monstera-sample: up to date (25 files, spec sha256 88ddd663…a977e1)
$ tools/monstera/bin/monstera verify generated/monstera-sample
generated/monstera-sample: matches its manifest
```

Changing only the spec changes the native output. A landscape variant (temporary, not
committed: `orientation: landscape`, world 1920x1080, `id: landscape-demo`,
`identifier: app.monstera.landscape`):

```
monstera.spec.json: valid, sha256 4f5cfd6c082932c17b2f6a04d727c4438e80993fca5856388ee4b85411732844
android/app/src/main/AndroidManifest.xml   android:screenOrientation="landscape"
android/app/build.gradle.kts               applicationId = "app.monstera.landscape"
ios/Info.plist                             UIInterfaceOrientationLandscapeLeft, UIInterfaceOrientationLandscapeRight
ios/Sources/                               LandscapeDemo/   (product name derived from the id)
```

Refusing to overwrite (real output):

```
generate: refusing to overwrite:
  not generator-owned: android/NOTES.md
  modified since last generation: ios/Sources/MonsteraSample/ContentView.swift
Move your changes into the spec or templates, or re-run with --force to discard them.
```

## Simulator-tested vs. physical-device-tested

| Capability | Android | iOS |
|---|---|---|
| Generated project compiles | COMPILED (local + Linux CI) | COMPILED (hosted macOS CI) |
| Launches and renders from the spec | SIMULATOR-TESTED (local Android 16 emulator) | SIMULATOR-TESTED (CI iPhone 17 Pro simulator) |
| Runtime spec integrity check | SIMULATOR-TESTED: `bundledMatches=true` | SIMULATOR-TESTED: `bundledMatches=true decodedMatches=true` |
| Anything on a physical phone | **Not tested** | **Not tested** |
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
- **PostFileSave hooks not observed live.** The PreToolUse guard was verified live in a fresh
  session. The two PostFileSave hooks fire only on user saves in the editor; their commands are
  verified, but a live trigger needs a human save (see "Unresolved" below). On Windows the hooks
  rely on Git's shell resolving `!` aliases (verified here).
- **Guard scope.** The guard covers Kiro file tools only. Shell commands can still write to
  `generated/` (that's how `monstera generate` works); `generate`/`verify`/CI catch such edits.
  If Python is missing, the guard exits 2 and blocks file-tool calls (fail-closed).
- **`--force` is destructive by design.** It discards hand edits and unmanaged files inside a
  generator-owned directory; build output, non-owned directories and symlinks are still protected.
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
