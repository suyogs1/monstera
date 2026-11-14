# M3 Phase 0: native conformance evidence refresh

Base commit `6972795` (local `main` equals `origin/main`). Run on 2026-11-14 on one Windows machine. Each game was run once.
Nothing here reuses or relabels an earlier report: every file in this directory was written by the run below.

## Result

| Game | Spec SHA-256 | Scenarios | Checkpoints per platform | oracle | kotlin | swift | Verdict |
|---|---|---|---|---|---|---|---|
| Pumpkin Blaster (`apps/pumpkin-blaster`) | `08c7a90d9fcfd599c0b5f83743ba339e61f57f1fb10938cf6806d70cda7e0be3` | 5 | 505 | pass | pass | pass | PASS |
| Trick or Treat Rush (`apps/trick-or-treat-rush`) | `edcc2000685684cfc17fcbe3634bb01d2967b7d590cfceabb02a2286eaa79b4c` | 6 | 606 | pass | pass | pass | PASS |
| Lantern Run (`generated/lantern-run`) | `cc08da835eab0e59b23ddb58e766cd9420e41514124e09b7903438a5fd0d60b1` | 4 | 404 | pass | pass | pass | PASS |

Each scenario has 101 checkpoints. No divergences. Per-scenario SHA-256 values, runtime file digests and per-platform
commands are in `<game>.report.json` (schema `spec/schema/conformance.schema.json`); the console output is in `<game>.txt`.

## What each platform run was

| Platform | How it ran | Not what it was |
|---|---|---|
| oracle | Python engine in process, compared with its own recording | Not independent evidence about Kotlin or Swift |
| kotlin | `cmd /c gradlew.bat --no-daemon --console=plain cleanTestDebugUnitTest testDebugUnitTest` in `android/`, JVM unit tests | Not an APK, not an emulator |
| swift | `docker run --network none swift:6.1-noble swift test` on `ios/Runtime`, Linux | Not Xcode, not iOS, not a simulator |

## Preflight (before any conformance run)

All exit 0, working tree clean: `validate` on the three specs, `verify` on the three generated directories,
`validate-scenario --all --oracle` (all scenarios of all five projects match the oracle), and
`generate <spec> --check` for the three games (generated output equals a fresh generation, no file written).

## Verification labels (steering 04)

| Game | Label supported by this evidence | Earlier evidence at higher levels (not re-run here, may predate spec v4) |
|---|---|---|
| Pumpkin Blaster | CONFORMANCE-TESTED on the current spec hash | COMPILED and SIMULATOR-TESTED in `docs/evidence/g3-android-emulator/`, `g3-ios-simulator-ci/` |
| Trick or Treat Rush | CONFORMANCE-TESTED on the current spec hash | same |
| Lantern Run | GENERATED + CONFORMANCE-TESTED | none: never compiled into an app, never on a simulator or device |

PHYSICAL-DEVICE-TESTED: none of the three games. A conformance pass proves the simulation core is identical on the
three platforms for the recorded scenarios. It does not prove rendering, input handling, haptics or app behaviour.

## Supersedes, without replacing

`docs/evidence/g3-conformance/` recorded spec hashes `c65ebbdd…` (Pumpkin Blaster) and `93fb53e0…` (Trick or Treat Rush).
Those no longer match the current specs (spec v4 visual batch). They stay as history for their own hashes.
`docs/K0-ACCEPTANCE-REPORT.md` held Lantern Run's PASS only as unpersisted MCP session output; this directory replaces
that gap with a persisted report and log.

## Limits

- Produced locally, not by CI. The `conformance` job in `.github/workflows/monstera.yml` now also runs Lantern Run, but
  that step has not yet run on GitHub.
- `monstera-sample` and `boundary-lab` were not refreshed (out of scope).
- Android build and iOS simulator evidence for the current spec v4 apps was not regenerated in this phase.
