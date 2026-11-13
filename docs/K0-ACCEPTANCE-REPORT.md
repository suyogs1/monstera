# K0 acceptance report: Kiro authors a third game

Branch `g4/k0-kiro-integration`, based on `d80765f` (head of PR #6, `g4/studio-spike`). Uncommitted at the time
of writing. Date: 2026-11-13.

**Goal.** Show that Kiro, using only the MONSTERA MCP tools, the CLI and the game-authoring steering, can create a
third native game without changing the engine, schemas, templates or the two official apps.

**Verdict.** Passed for the GENERATED and conformance stages. Lantern Run has not been compiled into an app or run on
a simulator or device.

## Verified results (observed in this rehearsal)

| Claim | Evidence |
|---|---|
| MCP server current | `engine_info`: `stale: false`, generator 0.1.0, spec version 4. Schema digests: `conformance` 04e5184d…, `game` f3e90b23…, `monstera.spec` 15e02669…, `project` 741ca6be…, `scenario` 317bf00b… |
| Spec valid and canonical | `validate_spec spec/samples/lantern-run/monstera.spec.json`: valid, canonical, SHA-256 `cc08da835eab0e59b23ddb58e766cd9420e41514124e09b7903438a5fd0d60b1`. The first draft failed once (`$.game.genre` enum: "collector"); fixed to `endless-runner`. |
| Existing vocabulary only | Portrait world, `swipe` input, three kinds (keeper, lantern, wisp), three spawners (the third starts at tick 1200 with a shorter interval and faster wisps), lantern +10 score, wisp -1 life, `winScore` 150, 3 lives |
| Four golden scenarios | `spec/scenarios/lantern-run/*.scenario.json`. Each has 101 checkpoints, recorded only by `monstera scenarios record` |
| Conformance PASS (MCP session evidence, no persisted log) | `run_conformance generated/lantern-run` with platforms oracle, kotlin and swift (image `swift:6.1-noble`): verdict `pass`, 4 scenarios x 101 checkpoints = 404 checkpoints per platform, zero divergences. Kotlin: `gradlew.bat cleanTestDebugUnitTest testDebugUnitTest` exit 0. Swift: `docker run swift:6.1-noble swift test` (package `ios/Runtime`) exit 0 |
| Generated output matches source | `generated/lantern-run/` holds 49 generator-written files: the 48 files listed in `MONSTERA-MANIFEST.json` plus the manifest itself, which does not list itself. So `inspect_manifest` reports `file_count: 48` and `generate_project` reports `files: 49`. On disk, the only file not in the manifest is the manifest, and no manifest entry is missing. `inspect_manifest`: verify clean. `generate_project` dry run: no drift. Android and iOS embedded scenario files are byte-identical, and each scenario's final checkpoint hash appears in them |
| Approved write was exact | One authorized `generate_project write=true`. File hashes before and after differ for exactly `MONSTERA-MANIFEST.json`, `android/app/src/test/resources/monstera-scenarios.txt` and `ios/Runtime/Tests/MonsteraRuntimeTests/Resources/monstera-scenarios.txt` |
| Engine and apps untouched | `git status` shows no changes under `tools/monstera/monstera/` (engine, generator, templates), `spec/schema/` or `apps/` |

### Scenario coverage

| Scenario | Seed / length | Demonstrates | Final observed state |
|---|---|---|---|
| `idle-keeper` | 1 / 3000 ticks | One lantern scores, wisps take 3, 2, 1, 0 lives, game lost | tick 2815, score 10, lives 0, ended, hash `f2661e7417ba3c6f` |
| `lantern-win` | 1 / 7600 ticks | Long run through both wisp spawners, 15 lanterns, win at `winScore` | tick 7591, score 150, lives 3, ended, hash `525f59feb8a2f4ba` |
| `swipe-patrol` | 4242 / 1800 ticks | Swipe velocity, wall clamp, one pickup, one hit | tick 1800, score 10, lives 2, hash `88cd1c14814b0e96` |
| `frame-jitter` | 31 / 900 frames | Frame-driven game loop with uneven frame durations | tick 1211, score 0, lives 3, hash `520782c302ae3387` |

The `lantern-win` input trace (29 swipe events) was chosen by a throwaway local script that ran the oracle in
memory. The script is not committed. All checkpoints come from `monstera scenarios record`.

## Evidence locations

- Spec: `spec/samples/lantern-run/monstera.spec.json`
- Scenarios: `spec/scenarios/lantern-run/`
- Generated project and manifest: `generated/lantern-run/`, `generated/lantern-run/MONSTERA-MANIFEST.json`
- Conformance report: the three-platform PASS is **recorded MCP session evidence**. It is the structured result
  (`conformance.schema.json` report plus summary) returned by the `run_conformance` tool in this Kiro session. **No raw
  test log was persisted**: no Gradle or `swift test` output and no report file exists in the repository or under
  `docs/evidence/`. The runtime digests and scenario SHA-256s in that result can be re-derived from the committed
  files. For durable evidence, re-run `monstera conformance generated/lantern-run --swift-image swift:6.1-noble --report <file>`, or add
  a CI step (see the limitations below).

## Limitations

- **Label: GENERATED + CONFORMANCE-TESTED.** No `assembleDebug`, no Xcode build, no emulator, simulator or device
  run. Not COMPILED, not SIMULATOR-TESTED, not PHYSICAL-DEVICE-TESTED. The Kotlin conformance run compiles the JVM
  unit-test sources, not an installable APK.
- `.github/workflows/monstera.yml` has no step for `generated/lantern-run` (checked by grep). Its conformance is not
  yet proven in CI. Whether `monstera gates` covers it was not checked.
- `lantern-win` wins without losing a life. Losing lives and winning are covered by separate scenarios.
- The rehearsal was run by the default project agent in this session, not the `game-author` agent profile.
- Windows friction: `python` and the bash launcher `tools/monstera/bin/monstera` do not run in PowerShell; used
  `py -3 tools/monstera/monstera.py`. PowerShell `ConvertTo-Json` wrote a BOM into one scenario file; the recorder
  refused it (`json.bom`), and the file was rewritten without a BOM.
- The rehearsal skipped the steering step "the user approves" before the first `generate_project` write. Two
  writes ran without asking. Only the third write was explicitly authorized.

## Unresolved: automatic approval in Autopilot

**Verified.** `.kiro/settings/mcp.json` auto-approves only `validate_spec`, `engine_info`, `inspect_manifest` and
`get_device_report`. There is no user-level `~/.kiro/settings/mcp.json`. Even so, `generate_project` (annotated
`destructiveHint: true`) and `run_conformance` (whose description asks for per-call approval) ran without any approval
prompt.

**Inferred, not confirmed.** The session ran in Autopilot mode and called MCP tools through the deferred
`tool_call` path, and the host did not apply MCP approval prompts there. The host's permission decision cannot be
observed from the repository.

**Not done.** No permission was weakened or added. A PreToolUse hook returning `permissionDecision: "ask"` for
`generate_project` is a possible follow-up, but it was not applied.
