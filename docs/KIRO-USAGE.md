# Kiro usage and evidence ledger

How MONSTERA uses Kiro, and the evidence for each claim. Entries record the commands that were
actually run and what they printed. **PENDING** means not yet observed; it never means assumed
to work. This file is the source for the Devpost "built with Kiro" description.

Environment for local entries: Windows 11, Python 3.14.1, uv 0.12.19, git 2.51.0.windows.1,
Kiro IDE (this session). CI entries name their GitHub Actions run.

## Feature map

| Kiro feature | Artifacts | Used for | Status |
|---|---|---|---|
| Steering | `.kiro/steering/01`–`07` | Project rules: mission, native architecture, quality, provenance, Device Lab, spec engine, Studio (`fileMatch`) | Used since G0 |
| Kiro Specs | `.kiro/specs/g1-specification-engine/` (done), `g2-deterministic-runtime/` (proposed) | Phase requirements → design → tasks | G1 done |
| Custom agents | `.kiro/agents/` (7): `monstera`, `spec-engine`, `android-native`, `ios-native`, `device-lab`, `report-auditor`, `studio` | Bounded ownership per area | Structure gated; picker **PENDING** (L1) |
| Hooks | `.kiro/hooks/` (4) | Guard generated output, validate on save, architecture on save, gates on task completion | Guard verified live (G1); others **PENDING** (L2–L4) |
| Prompts | `.kiro/prompts/` (5) | Repeatable reviews and implementation | Present; first use **PENDING** (L5) |
| Workflows | `.kiro/workflows/` (5) | Multi-agent feature, generation, conformance, adversarial review, release | 1 run launched (W1) |
| Custom MCP server | `tools/monstera-mcp/`, `.kiro/settings/mcp.json` | Structured engine access | Protocol-tested; Kiro connection **PENDING** (L6) |
| Power | `powers/monstera/` | Distribution to other developers | Planned (G4) |

## G1.5 evidence

### E1. Repository migration (decision: `reference/g0/`)

| Check | Command | Result |
|---|---|---|
| Pure move | `git show --stat dc29888` | `17 files changed, 0 insertions(+), 0 deletions(-)` |
| History preserved | `git log --follow -- reference/g0/android/app/src/main/kotlin/app/monstera/hello/MainActivity.kt` | reaches `a6166f3 Add native Android hello world` |
| | same for `reference/g0/ios/Sources/MonsteraHello/PulseScene.swift` | reaches `a51320b Add SwiftUI + SpriteKit iOS app` |
| No stale references | `git grep -nE 'apps/(android\|ios)'` excluding historical reports, evidence and planning docs | 0 matches |
| G0 app builds from new path | `DL_APP_DIR=reference/g0/android bash device-lab/android/adapter.sh build` | `{"op":"build",...,"status":"ok",...}` |
| No silent default app | `bash device-lab/android/adapter.sh build` (no env) | `{"op":"build",...,"status":"failed",...,"detail":"missing env: DL_APP_DIR"}`, exit 2 |
| | `bash device-lab/ios/adapter.sh launch` (no env) | `...,"status":"failed",...,"detail":"missing env: DL_APP_BUNDLE_ID"}`, exit 2 |
| Scripts | ShellCheck 0.11.0 on `device-lab/*.sh`, adapters, smoke script, `tools/xtool/linux-build.sh`, `tools/monstera/bin/monstera` | exit 0, no findings |
| G0 CI pipelines (`android`, `ios-simulator`) on the new paths | GitHub Actions on the PR | **PENDING** (C1) |

### E2. Generator ownership limited to `apps/<id>/android/` and `apps/<id>/ios/` (decision 2)

The manifest records `layout` and `ownedRoots`. For `layout: app`, the owned roots are `android`,
`ios` and the single guidance file. `check`, `verify` and `write` only read, change or delete
paths inside those roots.

| Guarantee | Test (`tools/monstera/tests/test_app_layout.py`) |
|---|---|
| Spec, README, assets, notes and the user's own `.kiro/steering/*.md` are byte-identical after first generation, regeneration and `--force` | `test_first_generation_next_to_user_files`, `test_regeneration_and_force_never_touch_user_files` |
| User files are invisible to `--check` / `verify` | `test_user_files_are_invisible_to_check_and_verify` |
| Unlisted file inside an owned root: reported and refused | `test_unlisted_file_inside_owned_root_is_refused` |
| Hand edit inside an owned root: refused, edit kept | `test_hand_edit_inside_owned_root_is_refused` |
| Pre-existing files in owned roots without a manifest: refused **even with `--force`** | `test_preexisting_files_in_owned_roots_without_manifest_refused_even_with_force`, `test_user_owned_guidance_file_without_manifest_is_refused` |
| Layout change (app → fixture would claim user files): refused even with `--force` | `test_layout_change_is_refused_even_with_force` |
| Tampered `ownedRoots` (`.`, `../outside`, `/etc`, `android`+`assets`): refused even with `--force` | `test_tampered_owned_roots_cannot_widen_ownership` |
| Owned root replaced by a user file: refused, file kept | `test_owned_root_replaced_by_user_file_is_refused` |
| Symlinked owned root: refused, nothing written outside | `test_symlinked_owned_root_is_refused` (POSIX only; skipped on Windows, runs in CI) |
| Folder name must equal `project.id` | `test_folder_must_match_project_id` |

Existing `generated/monstera-sample` keeps whole-directory ownership: manifest
`layout: fixture`, `ownedRoots: ["."]`, 25 listed files + the manifest = 26 tracked files.

### E3. Kiro guidance in generated apps (decision 1)

One generator-owned file per project, `.kiro/steering/monstera-generated.md`. It's plain Markdown,
states "documentation only", and contains the spec SHA-256. It isn't a copy of this repository's
`.kiro/`. Tests (`GuidanceFileTests`):
- exactly one `.kiro/` path in the plan for both layouts;
- no Gradle, Swift, XML, plist, YAML or properties file references `.kiro`.

Studio source zips will not add copies (the Studio export uses the plan as is; G4).

### E4. Public-worker CI safety (decision 3)

`monstera check-architecture` now also rejects these patterns, enforced on every workflow in
`.github/workflows/` (`CiSafetyRuleTests`):
- `pull_request_target`;
- a missing top-level `permissions:`;
- an action not pinned to a 40-hex SHA;
- `secrets.*` (other than `GITHUB_TOKEN`) in a `pull_request`-triggered workflow;
- Apple SDK generation or transfer (`xtool sdk build`, `xtoolsdk`).

It also rejects web tooling (`package.json`, lockfiles, `node_modules`) under `apps/`,
`generated/` and `reference/`, while `studio/` is allowed. Current repository: 0 violations.

### E5. MCP server (4 engine-backed tools)

`uv run --frozen --project tools/monstera-mcp python -m unittest discover -s tools/monstera-mcp/tests -t tools/monstera-mcp`:
`Ran 20 tests ... OK (skipped=1)` (symlink test skipped on Windows).

| Proof | Test |
|---|---|
| Real stdio MCP session: `initialize`, `tools/list` returns exactly `validate_spec`, `generate_project`, `inspect_manifest`, `get_device_report`, then one `tools/call` each | `test_protocol.py` |
| Read-only annotations on 3 tools; `generate_project` not read-only | `test_read_only_annotations` |
| Refusal arrives as an MCP tool error carrying its reason (`...is outside the repository`) | `test_refusal_is_a_tool_error_with_its_reason` |
| Results equal the engine/CLI (validation SHA and issues, dry-run drift, manifest, report) | `ParityTests` (6) |
| Traversal, absolute, Windows-absolute, NUL, out-of-scope spec/output/report paths, oversized inline spec: all refused | `SecurityTests` |
| `write=true` never overrides a hand edit (`refused: ...modified since last generation`, edit kept) | `test_write_never_forces_over_hand_edits` |
| No hashing, regex or schema logic in the adapter | `NoDuplicatedLogicTests` |

Dependency: `mcp==2.3.0`; 39 packages locked in `tools/monstera-mcp/uv.lock`. The engine stays stdlib-only.
`.kiro/settings/mcp.json` auto-approves the three read-only tools; `generate_project` always asks.

### E6. Gates (single definition of green)

`monstera gates` (local, via the hook command `git -c alias.monstera=!tools/monstera/bin/monstera monstera gates`):

```
PASS  unit-tests: Ran 85 tests in 11.106s | OK (skipped=2)
PASS  validate spec/samples/monstera-sample/monstera.spec.json: sha256 88ddd663d84e52761fa0834f814e1b737e75f6a62d7dddceee8af37912a977e1
PASS  canonical spec/samples/monstera-sample/monstera.spec.json: canonical
PASS  generate --check generated/monstera-sample: 26 files
PASS  verify generated/monstera-sample: matches manifest
PASS  architecture: ok
PASS  kiro-config: ok
gates: all passed (7/7)
```

The `kiro-config` gate asks `git check-ignore` whether any `.kiro` file or configuration
directory is ignored; only `.kiro/workflow-output/` (scratch) may be. Found while building it:
on Windows, `git check-ignore --stdin` matched nothing even for a path the argument form reported
as ignored. The gate passes paths as arguments.

### W1. Workflow run (Kiro validates the recipe at run creation)

`monstera-adversarial-review` launched from `.kiro/workflows/` against this branch: run
`wf_19bbf8ec6126f08a`. Kiro accepted the definition and started `attack` (`wf-coder`) and
`architecture` (`semantic_reviewer`) in parallel, followed by `aggregate`. Outcome: see
`docs/evidence/g1.5-adversarial-review/` once complete.

### W1 result: adversarial review (run `wf_19bbf8ec6126f08a`, completed)

- Attack step: 182 probes. Architecture step: 15 rule violations. Aggregate: 26 issues, 11 blockers.
- Every probe classified in [`docs/G15-REVIEW-TRIAGE.md`](G15-REVIEW-TRIAGE.md), generated by
  `tools/kiro/triage_g15.py`: 88 held, 27 genuine (18 root causes, all fixed), 45 duplicates,
  21 expected limitations, 1 false positive. All 11 blockers fixed.
- Regression tests: the review's own `tests.patch` (24 tests: `test_adversarial_g15.py` in the engine
  and in the MCP server), plus `test_g15_recovery.py` (14). All of them failed before the fixes
  and pass now.
- `--force` semantics changed: it discards edits to files the previous manifest lists and never
  deletes a file the generator didn't write (steering 06).

### Incident: the guard hook locked every file edit (live PreToolUse evidence)

While the guard code was being edited, `cli.py` used `os` before its `import os` edit landed.
The live `guard-generated-output` hook ran that code, hit `NameError`, and the new fail-closed
rule turned the crash into "blocked" for every path. That included the edit repairing the guard.
Observed hook output: `guard error (NameError: name 'os' is not defined); blocking to be safe`.

- Recovery (controlled): the owner disabled the hook in the Kiro Agent Hooks UI. The import was
  restored with a normal file edit, with no shell write or other bypass.
- Fix: a guard crash now falls back to a minimal string-only check. It still blocks
  `generated/**`, `apps/<id>/{android,ios,.kiro}/**`, manifests, UNC paths and paths under any
  manifest directory, but no longer every path.
- Regression tests (`GuardSelfLockTests`):
  - run the hook command in a fresh interpreter: a source edit gets exit 0, a generated file exit 2;
  - with the guard forced to crash: source files are allowed, owned paths blocked.
- Re-enable and live verification: H1 below.

## Pending live checks (need the owner in the Kiro IDE)

| ID | Check | How to close it | Why I couldn't |
|---|---|---|---|
| H1 | **Verified live (2026-11-11).** Owner re-enabled the guard hook in Agent Hooks. A real `fs_write` to `generated/monstera-sample/README.md` was rejected by the hook (`Blocked: ...README.md is generator-owned output...`, file unchanged). This `str_replace` on `docs/KIRO-USAGE.md` passed the same hook | done | - |
| L1 | All 7 agents load in the agent picker | Open the agent picker in the chat bottom bar; confirm each of the 7 names appears and selecting it shows no error | No tool here lists the picker |
| L2 | `validate-specs-on-save` fires on a real editor save | Open `spec/samples/monstera-sample/monstera.spec.json`, change `"portrait"` → `"portait"`, **save**: hook output should show the enum error. Revert and save: `valid` | PostFileSave fires on user saves, not agent writes |
| L3 | `architecture-check-on-build-file-save` fires | Open `reference/g0/android/build.gradle.kts`, add a trailing space, **save**: hook prints `architecture check: ok`. Revert | Same |
| L4 | `gates-on-task-complete` fires | Mark any task in a Kiro Spec complete in the spec UI | PostTaskExec needs a spec task transition |
| L5 | Prompts appear as `/` commands | Type `/` in chat; the 5 prompt names should be listed | No tool here lists slash commands |
| L6 | Kiro connects to the MCP server and an agent calls a tool | Kiro panel → MCP servers: `monstera` connected, 4 tools. In a **new session**, ask: "call validate_spec on spec/samples/monstera-sample/monstera.spec.json" | Writing `.kiro/settings/mcp.json` is blocked for the agent by a Kiro permission rule; the owner must create it (content below), then start a new session |
| L7 | Kiro's standalone `validate_workflow` on all 5 recipes | In a session where the tool is offered, ask Kiro to run it on each `.kiro/workflows/*.workflow.json` | `validate_workflow` is not in this session's tool set; W1 covers run-creation validation for one recipe |

`.kiro/settings/mcp.json` (owner to create, L6):

```json
{
  "mcpServers": {
    "monstera": {
      "command": "uv",
      "args": ["run", "--frozen", "--project", "tools/monstera-mcp", "python", "tools/monstera-mcp/server.py"],
      "disabled": false,
      "autoApprove": ["validate_spec", "inspect_manifest", "get_device_report"]
    }
  }
}
```

## Pending CI checks

| ID | Check |
|---|---|
| C1 | `android` and `ios-simulator` (G0 reference apps from `reference/g0/`), `monstera` (spec, mcp, android-generated, ios-generated) green on the final PR commit |
