# Studio Foundry: requirements
Status: **DRAFT for owner approval (2026-11-16).** Planning only. No code, schema, engine or template change accompanies this document.
Base: `origin/main` = `71c77e4` (the G6 freeze commit). Branch `studio/foundry-spec`. G6 PR #15 (`g6/clean-room-regeneration`), its evidence in `docs/evidence/g6-cleanroom/` and its acceptance criteria are not touched.
Companion documents: `design.md` (architecture, data model, plan, risks), `tasks.md` (independently testable tasks).
Precedent: `.kiro/specs/g4-studio/` (M0 to M3, all done). This milestone extends that Studio; it does not replace it.

## 1. Goal
One Studio workspace in which a developer designs a game, manages assets and animations, configures levels and gameplay, prepares backend and monetization scaffolding, previews and validates it, exports genuine native Android and iOS projects, and continues in Kiro. Every capability carries an honest status.

## 2. Baseline (read from the repository, not assumed)
| Fact | Source |
|---|---|
| Canonical spec is v4. `project`, `game` only. The schema has no concept of assets, animations, sprites, audio, levels, ads, backend or progression. Entities are drawn as a colour plus a `glyph` symbol and an `effect`. | `spec/schema/*.schema.json` |
| One `runtime` per spec: `kinds`, `initialEntities`, `spawners`, `collisions`, `lives`, `winScore`, `maxEntities`. A spawner has `stream, kind, startTick, intervalTicks, xMin..yMax, vx, vy`: it starts at a tick and repeats forever. There is no wave count, end tick, per-level win rule, power-up state or progression. | `game.schema.json` |
| Every schema property is required, `additionalProperties` is false, unsupported keywords fail at load. Quantities are Q16.16 raw integers. | steering 06, 08 |
| The generator owns exactly `android/`, `ios/`, `.kiro/steering/monstera-generated.md`, `MONSTERA-MANIFEST.json`. Output is deterministic. A PreToolUse hook blocks hand edits under `generated/`. | steering 02, 06; `.kiro/hooks/` |
| Studio is a static Vite/React/TS app. The unmodified engine runs in a Pyodide worker. Eleven flat sections: Overview, Platforms, Gameplay, Entities, Rules, Spawns, Presentation, Spec, Determinism, Native source, Developer Integration. One draft in `localStorage` (`monstera.studio.draft.v1`). No backend, no account, no secret. | `studio/src/app/sections.ts`, `architecture/MONSTERA-STUDIO.md` |
| Studio preview, determinism badge (oracle against goldens), native evidence panel bound to the exact spec SHA-256, source ZIP export, bundle secret scan, Playwright smoke. | `docs/evidence/studio-m1..m3b/` |
| Kiro: steering 01 to 10, agents (`monstera`, `studio`, `game-author`, `spec-engine`, ...), five hooks, MCP server `monstera` (`engine_info`, `validate_spec`, `generate_project`, `inspect_manifest`, `run_conformance`, `get_device_report`), three games including Kiro-authored Lantern Run. | `.kiro/`, `tools/monstera-mcp/` |
| Today is 2026-11-16. Submission closes **2026-12-04 14:00 PT**, no extensions. | `docs/KIROWEEN-ALIGNMENT-REPORT.md` |

## 3. Vocabulary
**Capability status** (one per capability, shown in Studio and in the matrix):
| Status | Meaning | Evidence needed to claim it |
|---|---|---|
| implemented | Works end to end in the stated environment. | Automated test or acceptance output |
| prototype | Works for a bounded subset; the limits are shown in the UI. | Test plus a written limit list |
| mock | Behaves like a third-party feature but is simulated. Always labelled MOCK in UI, code and docs. | The label, and a test that the label renders |
| planned | Designed, not built. Shown as planned, never as a control. | none |
| unsupported | Cannot be done in this architecture. Reason stated. | none |

**Test environment** (reported on every test claim; maps onto the existing labels GENERATED, COMPILED, SIMULATOR-TESTED, PHYSICAL-DEVICE-TESTED without changing them): `browser` (Studio worker, oracle or preview), `oracle` (Python, CLI), `jvm` (Gradle unit tests), `swift-test` (`swift test`), `simulator`, `device`.

**Studio pack**: the directory of Studio-owned manifests and assets stored next to `monstera.spec.json` (design section 3).

## 4. Scope rules (apply to every requirement)
- S1. Only `studio/`, `.kiro/specs/studio-foundry/`, new steering and docs change in the planned work. `tools/monstera/`, `spec/schema/`, templates, `generated/`, `apps/` generator-owned paths and `docs/evidence/g6-cleanroom/` do not change. Anything that needs them is an **engine-track** item (design section 6), not part of the committed plan, and needs an explicit owner decision.
- S2. The canonical spec stays the only contract with the engine. Studio-owned data is a separate, versioned layer that compiles down to the spec or is exported beside it.
- S3. No secret reaches the bundle, a manifest, the ZIP, Git or a generated binary.
- S4. No control is shown that does nothing. A feature that is not built appears only as a `planned` or `unsupported` entry in the capability list, not as a button, tab or form.
- S5. Adding scope records its trade-off against the deadline in `tasks.md` (section "Scope ledger").

## 5. Requirements
Priority: **P0** demo-critical and must ship, **P1** ships if P0 is green by the feature freeze, **P2** only after P1, cut first.

### R1. Shared project context and navigation (P0)
Acceptance criteria:
1. The Studio has 11 modules in the order of the mission: Dashboard, Game Designer, Asset Studio, Sprite and Animation Editor, Level Studio, Gameplay Systems, Backend and Services, Monetization, Kiro Development, Preview and Device Lab, Build and Release. Each is reachable at `#/<module>[/<section>]`.
2. Every existing section keeps working and has a stable new home (table in design section 2). Old hashes such as `#/entities` redirect. The 17 existing smoke checks and the M1, M2 acceptance scripts still pass.
3. All modules read and write one project context (one project id, one spec, one set of manifests). Switching modules loses no unsaved edit.
4. Every module header shows its capability status from the registry. A module whose status is `planned` or `unsupported` renders an explanation and no editing controls.
5. A test fails if a module has no registry entry, if an `implemented` entry has no existing evidence path, or if a status other than the five above appears.

### R2. Project Dashboard (P0)
1. Create a project from the three templates or from an imported spec or project bundle; open, rename, duplicate and delete projects held in the browser. Deleting asks for confirmation and names what is lost.
2. Shows per project: id, targets, spec SHA-256, engine validation state (valid, N issues), determinism badge, generation state (plan matches or not), native evidence state bound to the exact hash, and which Studio-pack modules are populated.
3. A project that exists only in this browser says so, with a one-click bundle export.
4. Opening a project made by Studio M1 to M3 (draft key `monstera.studio.draft.v1`) migrates it without loss; the old key is kept until the new copy is verified.

### R3. Game Designer (P0)
1. The existing Project Brain editors are retained unchanged in behaviour and live under this module.
2. Each field has an owner: Designer or a derived module (R6, R7). A field owned by a derived module is read-only here, labelled with its owner and a link. Without derivation enabled, every field is Designer-owned (today's behaviour).
3. AI design assistance is a **proposal inbox** (R12), not a chatbot and not an in-browser model call.

### R4. Asset Studio (P0 import and manifest, P1 assignment)
1. Import PNG, JPEG, WebP and GIF images and WAV, OGG and MP3 audio from the user's machine. SVG and any other type are refused with a reason.
2. Type is decided by content bytes, not file extension or declared MIME. Limits are enforced: 5 MiB per file, 64 MiB per project, 4096 px per side, 256 assets per project (design section 8 table). An over-limit or undecodable file is refused and leaves the project unchanged.
3. Every asset gets a stable id (`asset-<slug>`, never reused after deletion within a project), its SHA-256, size, dimensions or duration, a category and a provenance record. Provenance requires `origin` (`user-owned`, `third-party-licensed`, `ai-generated`), `author`, `license` (SPDX id or `proprietary-owned`), `source` and a `notes` field. A file cannot be added without a license value; the UI says Studio cannot verify it.
4. Assets are listed and filtered by category and by entity. Images and audio preview in place (audio plays only on user action).
5. An asset can be linked to a spec kind id (`kindRef`). Deleting a kind or an asset that is referenced is blocked and lists the references.
6. **Status shown in UI: prototype.** The native apps do not render or play these assets until the engine track (design section 6) is approved and built. The UI and the export README say so. Assets travel in the export under the Studio pack.

### R5. Sprite and Animation Editor (P0 slicing and manifest, P1 editing operations)
1. Choose a spritesheet asset; slice by grid (frame width and height, columns and rows, margin, spacing, all integers). Invalid grids (outside the image, zero size) are rejected with the exact reason.
2. Basic manual selection: add, move and resize a frame rectangle in pixel coordinates; crop is a rectangle, not freehand.
3. Reorder, duplicate and remove frames. Removing a frame that an animation uses is blocked or removes it from the sequence after confirmation.
4. Animations: ordered frame list, `fps` (integer 1 to 60), optional per-frame `holdFrames` (integer 1 to 60), loop mode `once`, `loop`, `pingpong`.
5. Animation timing is defined in simulation ticks, not wall-clock time, so a given tick always shows the same frame: `frameIndex = f(tick, tickRate, fps, holds, loopMode)`, integer arithmetic only. The Studio preview player uses the same function and a unit test pins it with hand-computed cases.
6. Everything is stored in `animations.manifest` v1 and validates against its schema.
7. **Status: prototype** (same native limit as R4.6). Explicitly out of scope: onion skin, pixel painting, layers, palettes, timeline scrubbing beyond play/pause/step.

### R6. Level Studio (P0)
1. Multiple levels per project, each a schema-validated record in `levels.manifest` v1: id, name, order, initial placements (kind, x, y), spawn waves (kind, start tick, interval, x and y range, vx, vy), difficulty steps. No scripting, no expressions, no code.
2. The editor shows a visual preview of the world (same canvas rules as the existing preview) and a timeline of when each spawner starts.
3. **Compile rule.** Enabling derivation compiles the active level into the spec's `runtime.initialEntities` and `runtime.spawners` only. The result is validated by the unmodified engine and run on the oracle before it can replace the spec. If the engine rejects it, the spec is unchanged and the issues are shown against the level field that caused them.
4. A difficulty step is expressed as an additional spawner that starts later. Spec v4 cannot stop a spawner, cap a wave count, or hold a per-level win rule; the editor does not offer those controls (`unsupported` entries in the capability list).
5. Non-active levels are validated by compiling each to a standalone spec variant and running validation and a bounded oracle run (determinism: same level, same result twice). The export contains a spec per level at `studio-pack/derived/levels/<id>/monstera.spec.json`, each independently generable with the existing CLI. **Status: prototype.** The generated app contains the active level only; in-app level selection is planned (engine track).
6. Same level manifest and same engine produce byte-identical compiled specs.

### R7. Gameplay Systems (P0 for lives, score, collectibles, enemies; P1 difficulty; planned for the rest)
1. `gameplay.manifest` v1 holds parameterized modules, not rules text: `lives` (starting lives, 1 to 99), `score` (win score, per-kind points), `collectibles` (kind, points, despawn), `enemies` (kind, damage in lives, despawn), `difficulty` (list of ramp steps that feed R6.4).
2. The compile rule is R6.3 applied to `runtime.lives`, `runtime.winScore` and `runtime.collisions`. Entities (`kinds`) stay Designer-owned; modules reference them by id.
3. `health` (hit points distinct from lives), `power-ups` (timed effects), `progression` (levels unlocking, persistent score) are **planned**: the v4 contract has no timed state or persistence. They appear as `planned` entries with the missing contract piece named, never as controls.
4. No visual programming, no event graph, no free-form expression anywhere.

### R8. Backend and Services (P1; scaffold only)
1. Firebase is the one provider. The module records which services the developer wants (Authentication, Firestore, Analytics, Crashlytics, Remote Config) and the identifiers the developer will supply.
2. Studio generates **scaffolding**: Kotlin and Swift interface files and a `SETUP.md` listing the console steps. It never contacts Firebase, never holds `google-services.json`, `GoogleService-Info.plist`, service-account keys or API keys, and never creates a Firebase resource.
3. The UI header reads "Scaffold only. Not connected to any backend." The export README repeats it. Status: **mock** for the stub implementations (they return fixed values and are labelled) and **planned** for a live connection.
4. If a user pastes text that matches a secret pattern into any Studio field, the field is refused (client check) and the value is never written to storage or export (design section 8).

### R9. Monetization (P1; scaffold plus mock)
1. AdMob placement configuration: id, type (`banner`, `interstitial`, `rewarded`), trigger (`game-start`, `game-won`, `game-lost`, manual), frequency (minimum seconds between shows, maximum per session), reward (kind and integer amount, rewarded only).
2. Mode is `test` or `mock`. `production` is not selectable in Studio: a production ad unit id is entered by the developer in a developer-owned file after export. Studio stores only placement names, never unit ids. This keeps real ids out of Git history by default.
3. Generated scaffolding: placement constants, interface (`AdPlacement`, `AdService`), a `MockRewardedAdService` whose class name, log lines and on-screen text say MOCK, and a `SETUP.md` for adding the real SDK with Google's test ids.
4. Status: **mock** (rewarded behaviour), **prototype** (placement config and interfaces). A real SDK integration is **planned**. Studio and the export never describe the mock as a live integration; a test asserts the label strings.
5. Frequency rules are enforced in the scaffolded service logic and covered by a unit test of the generated logic's pure function in Studio test code (design section 5).

### R10. Kiro Development (P0 export and drift check, P1 templates)
1. Export one project directory containing: canonical spec, generator output (unchanged `android/`, `ios/`, manifest), the Studio pack, `extensions/android/` and `extensions/ios/` (developer-owned, written once, with a README stating that the generated build does not yet compile them unless the engine track lands), `.kiro/steering/` and `.kiro/specs/` templates for continuing the game, and relevant hooks.
2. An **ownership manifest** `MONSTERA-STUDIO-MANIFEST.json` lists every Studio-written file with SHA-256 and class (`studio-data`, `studio-scaffold`, `write-once`). The engine's `MONSTERA-MANIFEST.json` remains authoritative for its own files and is not edited.
3. A **drift check** script in the export (`tools/check-drift.sh`, POSIX, `set -euo pipefail`, needs only `sha256sum` or `shasum`) reports, per file, unchanged, edited, missing or unknown, and exits non-zero on edited or missing scaffold. Studio shows the same classification when a bundle is re-imported. Write-once files may be edited freely and are never reported as drift.
4. Re-export never overwrites a write-once or developer-owned file. A scaffold file edited by the developer is reported and not overwritten without an explicit choice.
5. Out of scope: reverse-engineering native code into the spec, and three-way merging.
6. Developer Integration (existing static inventory and handoff) lives here and keeps its "no Kiro connection" statement.

### R11. Preview and Device Lab (P0)
1. The existing preview, determinism badge and native evidence panel are retained.
2. A test-environment table shows, for the current spec hash, which checks exist at which environment (`browser`, `oracle`, `jvm`, `swift-test`, `simulator`, `device`) with state `passed`, `failed`, `not run` or `no evidence for this hash`. The source is the committed evidence indexes already built into Studio. Nothing is inferred; an absent record reads `no evidence for this hash`.
3. A modified spec never inherits evidence from the template it started from (existing behaviour; keep and test).

### R12. AI-assisted authoring without browser secrets (P1)
1. The Studio contains no API key, no model call and no endpoint for an AI provider. A static scan test fails the build if a provider hostname or key pattern appears in `dist/`.
2. A **proposal inbox** accepts a JSON proposal file produced elsewhere (for example by Kiro using the `monstera` MCP tools): a list of operations against the spec or a manifest. Proposals are validated by the engine or the manifest schemas, shown as a diff, and applied only when the user accepts them. A rejected proposal changes nothing.
3. Proposals and AI-generated assets record their origin (`ai-generated`, tool, model, prompt hash) in provenance. Origin is user-declared; Studio cannot verify it and says so.
4. A replaceable provider interface is defined in design section 8, with exactly one implementation: manual handoff. A hosted provider needs a backend and is `unsupported` in the static Studio.

### R13. Build and Release (P0)
1. Export the complete native source project as today (ZIP, from the engine), now optionally including the Studio pack (R10).
2. A **completeness check** lists problems before export: engine validation errors, a derived spec out of date with its manifests, assets referenced but missing, animations referencing missing frames, placements referencing unknown ads, a generated tree that does not equal the engine plan. Errors block export; warnings do not.
3. **Release readiness** is a checklist of what has and has not been proven for this spec hash (generated, compiled, simulator-launched, device-tested), plus the developer's own steps (signing, store listing, privacy declarations, real ad ids, Firebase files). Studio never says "store-ready". The words appear only inside the sentence that says it is not claimed.
4. No signing, no upload, no build dispatch (unchanged from M3).

### R14. Reproducibility, security and non-regression (P0)
1. Studio output is a pure function of recorded inputs: spec, manifests, asset bytes, engine commit. Exporting twice yields byte-identical ZIPs (sorted entries, fixed timestamps and modes, LF), tested.
2. No weakening of existing tests: the Python suite, `monstera gates`, goldens and conformance stay unchanged and green. `git diff 71c77e4 -- tools/monstera spec/schema` is empty at the end of the milestone; this is part of the acceptance run.
3. Studio-owned manifest validation follows the engine's discipline (all properties required, no additional properties, unsupported keywords fail at load, integers only for game quantities) and lives in `studio/` (design decision D2).
4. Bundle and source-map secret scan runs in CI with the extended pattern set (design section 8) and covers sample projects and exports.
5. Importing hostile input (oversized files, zip-slip paths, duplicate keys, huge dimensions, decompression bombs, prototype-pollution keys such as `__proto__`) fails closed without changing the project. Tests exist per class.

## 6. Prioritized acceptance criteria (the milestone is accepted when these hold)
| # | Criterion | Priority | Check |
|---|---|---|---|
| A1 | The 11 modules exist; each shows its registry status; no control without function | P0 | registry test, Playwright click-through of every module |
| A2 | Existing behaviour unchanged: unit tests, typecheck, build, M1/M2 acceptance, smoke 17/17 | P0 | `npm test`, `npm run build`, `npm run acceptance`, `npm run smoke` |
| A3 | Create project from template, edit in Designer, save, reload, export bundle, import bundle: identical project | P0 | e2e |
| A4 | Import an image, record provenance, slice a sheet, define an animation, all validated and exported | P0 | e2e + unit |
| A5 | Author two levels; the active level compiles to a spec that the unmodified engine validates and the oracle runs; both level variants export and each passes `monstera validate` | P0 | e2e + CLI run on exported files |
| A6 | Gameplay modules compile to `lives`, `winScore`, `collisions` and the result validates | P0 | unit + engine |
| A7 | Export contains the pack, ownership manifest and drift script; drift script detects an edited scaffold file and ignores an edited write-once file | P0 | script test |
| A8 | Firebase and AdMob scaffolds export; every mock is labelled; no secret pattern in output; the bundle scan is clean | P1 | label test + scan |
| A9 | The exported spec still generates with the unmodified CLI, `generate --check` and `verify` pass, `git diff 71c77e4 -- tools/monstera spec/schema` is empty | P0 | commands |
| A10 | Hostile-input suite passes (R14.5) | P0 | unit |
| A11 | Capability matrix in docs equals the registry (generated, not hand-written) | P1 | test |
| A12 | Recorded demonstration of the full flow, honest about each status | P0 | recording + script |
| A13 | Independent adversarial review of the milestone, findings triaged | P1 | report |

## 7. Non-goals
Real-time collaboration, accounts, server-side project storage, remote builds, signing, store upload, live Firebase or AdMob connection, in-browser AI calls, visual scripting, a full pixel editor, native-code reverse engineering, three-way merge, changing the oracle or the contract, any change to PR #15.
