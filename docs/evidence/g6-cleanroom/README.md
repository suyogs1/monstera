# G6-B clean-room regeneration evidence

Raw files in this directory are unedited CI outputs (artifacts `g1-android-43824361862` and `g1-ios-simulator-43824361862`), except `no-game-branching.json`, which was produced by the same script (`tools/clean-room/clean_room.py branching`) at the PR head.

## Identity

| Item | Value |
|---|---|
| Frozen baseline (`origin/main` at start, verified equal) | `71c77e448972bd5cd997993d518d3cf91adb3328` |
| Branch / PR | `g6/clean-room-regeneration`, PR #15 |
| Commit CI ran on (all five jobs green) | `5255763965c0fb444d4af473725d4014d674f59f` |
| CI run | `monstera` workflow run `43824361862` (pull_request) |
| Jobs | spec `133154532025`, mcp `133154532267`, android-generated `133154832476`, conformance `133154832530`, ios-generated `133154832831` |

Later commits only add or change files under `docs/` and `.kiro/specs/g4-studio/`; the workflow ran again on them (pull_request and workflow_dispatch). Run IDs and conclusions for the final PR head are recorded in the PR conversation, because a file cannot contain the ID of the run that tests it.

## Method

`tools/clean-room/clean-room.sh apps/<id>` runs, for each game, inside the checkout (Device Lab adapters resolve `DL_APP_DIR` against the repository root):

1. creates `g6-clean-room/<id>/` and requires it to be empty (the script refuses an existing directory, never deletes, never uses `--force`);
2. `monstera generate apps/<id>/monstera.spec.json --out g6-clean-room/<id> --layout app`;
3. `monstera verify g6-clean-room/<id>`;
4. `clean_room.py compare`: file set, bytes, mode (git index mode of the committed file against the executable bit of the fresh file) and SHA-256 of every generator-owned path (`android/`, `ios/`, `.kiro/steering/monstera-generated.md`, `MONSTERA-MANIFEST.json`), manifest equality, and every manifest hash against the fresh file.

Both the Android and the iOS job do this on their own runner. The Android and iOS compare reports are byte-identical for each game. The fresh trees are removed at the end of each job. In those two jobs the official games are built only from the fresh trees; the committed `apps/<id>/android|ios` are not built there (they are byte-identical, see below).

## Generation inputs

- The canonical JSON spec (`apps/<id>/monstera.spec.json`) is the primary game definition.
- `monstera generate` also loads the committed golden scenario files for the project automatically: `cmd_generate` calls `scenario.load_for_project(result.spec["project"]["id"], result.sha256, store)`. That reads `spec/scenarios/<project-id>/*.scenario.json`, validates each against the canonical spec (a stale scenario or one without checkpoints raises an error) and checks the recorded oracle checkpoints before embedding them in the generated native resources. These files are therefore inputs to the generator-owned output.
- The frozen schema, generator, templates and toolchain are shared infrastructure, identical for both games.
- The golden scenarios are game-specific data, not game-specific generator or template changes. They were not modified by G6-B.

Reproducibility claim: byte-identical generator-owned output from the same committed inputs (spec, scenarios, schema, generator, templates, toolchain).

SHA-256 of the committed scenario files at the PR head (computed from the git blobs):

Pumpkin Blaster (`spec/scenarios/pumpkin-blaster/`)

| File | SHA-256 |
|---|---|
| `frame-jitter-60hz.scenario.json` | `6cc1d0ff2fe9c96474fb280e9b83e7722412dfdc4e8edf4b684aad9976988697` |
| `idle-defence.scenario.json` | `524db3d94c37df01fd662c521c77fd566e28818c30a32c5967415c1efd4420eb` |
| `sweep-and-fire.scenario.json` | `f75d7c20882c37286c2615fa62e8c0271d4231809a4479a004058ab1ecfad1e5` |
| `volley-cap.scenario.json` | `3bf43245e56ee3ed05c7abfd7d72f4bc37b9e28d6f6396278520b316a6552907` |
| `win-1000.scenario.json` | `2c1d452e294bfebdd0a4c769cd4db4e1ff3ab87504e40d28594dd1c3f8685ad8` |

Trick or Treat Rush (`spec/scenarios/trick-or-treat-rush/`)

| File | SHA-256 |
|---|---|
| `candy-chase.scenario.json` | `6435976726e416d62bd6519ad30ecc8e2058ad14c78b07c673c24810513a98f8` |
| `dodge-run.scenario.json` | `4da764f7fb6b7f6006ac4228747a6b251f380b1ebd1ec75e5c604a95d8d023cb` |
| `frame-jitter.scenario.json` | `d18c4ff85646740738b8017c48c6356a9ba0e25b71a44210bc098f7260a0e0b1` |
| `hand-lane-zero.scenario.json` | `c507160acd788e917f74381111f3a3b62dd9f9f265756fb6fe025695c652dbcf` |
| `idle-run.scenario.json` | `fa981610306961784084a84b72c4875c55211668a095fd7ebea9fcf2d2fba685` |
| `lane-input-order.scenario.json` | `c04f4607787603e07c587a53bdff94d8a86f6ba77df543c8f4d48481d363c56e` |
## Results (all PASS)

| Game | Canonical spec SHA-256 | Fresh manifest SHA-256 (= committed) | Files compared | Differences |
|---|---|---|---|---|
| Pumpkin Blaster | `08c7a90d9fcfd599c0b5f83743ba339e61f57f1fb10938cf6806d70cda7e0be3` | `fd2331dc0b5043acf08c2c64f813da62f77e555f0094606788bcb095bfa9f8a1` | 48 (47 manifest entries + manifest) | none: content, modes, file set |
| Trick or Treat Rush | `edcc2000685684cfc17fcbe3634bb01d2967b7d590cfceabb02a2286eaa79b4c` | `6103e7e572724bc83423f411de2097b7800a30cfc1db7616820a48f58968b025` | 48 (47 + manifest) | none: content, modes, file set |

Reports: `compare/<id>.compare.json`.

### Android (fresh trees, Ubuntu 24.04, JDK 21, Gradle from the generated wrapper)

| Game | `assembleDebug` (Device Lab `build` op) | `testDebugUnitTest` |
|---|---|---|
| Pumpkin Blaster | ok (`android/pumpkin-blaster.build-results.jsonl`) | 22 tests, 0 failures, 0 errors, 0 skipped (PresentationTest 15, ConformanceTest 7) |
| Trick or Treat Rush | ok | 22 tests, 0 failures, 0 errors, 0 skipped (PresentationTest 15, ConformanceTest 7) |

### iOS (fresh trees, macOS 26 runner, xtool 1.24.0, iOS simulator)

| Game | `swift test` Runtime | `swift test` Presentation | xtool build | install, launch, screenshot, logs |
|---|---|---|---|---|
| Pumpkin Blaster | 7 tests, 0 failures | 15 tests, 0 failures | ok | ok |
| Trick or Treat Rush | 7 tests, 0 failures | 15 tests, 0 failures | ok | ok |

The simulator logs show the app logged the SHA-256 of the canonical spec file (`bundledMatches=true decodedMatches=true`) and that the fixed-tick loop ran (`runtime ticks=60`). Files: `ios/`. Screenshots show the game's start card (the landscape game is captured rotated in the portrait frame).

## Frozen framework

`git diff --exit-code 71c77e448972bd5cd997993d518d3cf91adb3328 HEAD -- tools/monstera spec/schema` exits 0 (empty) at `5255763`. The milestone adds only `tools/clean-room/`, `.github/workflows/monstera.yml`, `.gitignore` (two scratch directories), and documentation and evidence. `monstera gates --skip-tests` passes 32/32 locally on this branch.

No project-specific branching (`no-game-branching.json`, also a `spec`-job CI step): the check scans every file under `tools/monstera/monstera/` (62 files: generator, schema loader, oracle, templates). Python files are parsed, and only string literals and identifiers outside docstrings are tested; all 354 comparison expressions are inspected for literals; template text is scanned as text. It looks for the `id`, `displayName` and `identifier` of every project in `apps/*` and `spec/samples/*` (read from the specs, 15 strings) and for name stems of the projects (pumpkin, blaster, trick-or-treat, treat-rush, lantern, boundary-lab, monstera-sample). Result: 0 hits. `tools/monstera/author_scenarios.py` and `tools/monstera/tests/` name games but are scenario-authoring and test code, not generator or template code, and are outside the scan. Limitation: this proves no game is named in generator code; it does not prove the generic conditionals are free of behaviour that happens to fit one game. The byte-identical regeneration of both games from one generator is the evidence for that.

## Limitations and untested

- The simulator launch shows the app starts, loads its spec and ticks. It does not show gameplay or touch input (`simctl` cannot inject touches).
- Android was built and unit-tested on the JVM only. No emulator or physical device was used in this milestone.
- iOS was built and run on a simulator only. No physical device, no signing.
- The mode comparison ran on Linux (Android job) and macOS (iOS job). It was not meaningful on Windows (no executable bit), where a local run reports mode differences for `gradlew`.
- Gradle and xtool were not built twice, so APK/app byte reproducibility is not claimed. Only generator output is claimed to be reproducible.
- The recorded demonstration (task 5(d)) is not done.
