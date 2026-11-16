# MONSTERA Studio architecture

Status: **IMPLEMENTED through M3-A (static app, local-only).** Rewritten for G4 M3-A; it replaces the G1.5 proposal
(Railway API, Postgres, GitHub dispatch, remote build workers), which was never built and is no longer planned.
Design record: `.kiro/specs/g4-studio/` (requirements, design, tasks). Rules: `.kiro/steering/07-studio.md`.

MONSTERA Studio is a static web app in `studio/`. A user edits a game in the browser (the **Project Brain**), and the
repository's own Python engine, running in the page, validates the result, previews it, checks determinism against recorded
goldens and packs the generated native Android (Kotlin) and iOS (Swift) source as a ZIP. Nothing is sent anywhere.

## Status at a glance

| Capability | State | Evidence |
|---|---|---|
| Static Vite + React + TypeScript SPA | Implemented | `studio/`, `npm run build` |
| Engine in a Pyodide 0.29.5 Web Worker | Implemented, verified | M0 spike, M1/M2 acceptance (`docs/evidence/studio-spike/`, `studio-m1/`, `studio-m2/`) |
| Project Brain editing, validation, canonical Spec view, import/export | Implemented, verified | `docs/evidence/studio-m1/acceptance.json` |
| Live preview, determinism badge, source ZIP | Implemented, verified | `docs/evidence/studio-m2/acceptance.json` |
| Native conformance report display (exact spec hash only) | Implemented, verified | M2 badge acceptance |
| Native app build and simulator-launch evidence panel | Implemented in M3-A | `docs/evidence/studio-m3a/ui-acceptance.json`, `studio/src/badge/nativeApps.test.ts` |
| Developer Integration (static repository inventory) | Implemented, verified | M1 acceptance |
| Vercel hosting | **Selected, not deployed** | none |
| Playwright smoke test in CI | **Planned** (M3), not implemented | none |
| Secret scan of the bundle in CI, final adversarial review | **Planned** (M3), not done | none |
| Backend, API, database, accounts, server-side projects | **Not implemented and not planned** | n/a |
| Native builds triggered from Studio, remote build workers | **Not implemented and not planned** | n/a |
| Live Kiro connection | **Not implemented and not planned** | n/a |
| Physical-device testing, gameplay/input/performance evidence | **Not implemented** (Device Lab, G5) | n/a |

## Non-negotiable rules

1. The canonical `monstera.spec.json` is the single source of truth. Studio state *produces* it; nothing else describes
   the generated app. It is also the only thing Studio and Kiro share.
2. All validation, generation and simulation logic lives in `tools/monstera/`. Studio runs it and never reimplements it.
   The one deliberate exception is display-only drawing code in the preview (`studio/src/preview/presentation.ts`), which
   mirrors the generated presentation modules and cannot change simulation results.
3. Generated apps are independent native Kotlin/Swift projects. They do not depend on Studio, Kiro, a web view or any
   cross-platform runtime.
4. The browser never compiles native code and Studio never dispatches a build.
5. There is no server-side secret because there is no server. The bundle contains no credentials.
6. Studio's own stack is a modern web stack. That freedom stops at `apps/*` and `generated/*` (`monstera check-architecture`).

## Runtime architecture

```
Browser (static files only)
  UI thread (React)                      Web Worker (module worker)
    Project Brain editors                  Pyodide 0.29.5, Python 3.13.2
    Spec view, validation panel              /repo/tools/monstera/**   engine, unmodified
    Preview canvas                           /repo/spec/schema/*       schemas
    Determinism, Native evidence, Export     /repo/apps, /repo/spec/**  templates, samples, goldens
    Developer Integration                  glue.py: validate / plan / oracle / preview, returns JSON
  localStorage: one draft                  Messages: JSON text in, JSON out
```

- The engine package is placed at its repository-relative path inside Pyodide's virtual file system, so `REPO_ROOT`, template
  lookup and scenario lookup behave as in the CLI. "Unmodified" means the bundled files equal the repository files byte for
  byte (LF form, as git stores them).
- Pyodide is self-hosted and pinned (`pyodide` 0.29.5). Pages make no request outside their own origin; the M2 acceptance
  asserts this.
- Validation, canonical serialization, the SHA-256 shown in the Spec view, the preview simulation, the determinism check
  (oracle against recorded goldens) and the source ZIP (generated Android and iOS projects plus `MONSTERA-MANIFEST.json`) all
  run in the worker through the engine.
- Studio holds no configuration that the schema cannot express. Editors are derived from `spec/schema/*.schema.json`; values
  display in game units while the spec keeps raw Q16.16 integers.

## Build pipeline

`npm run build` in `studio/`:

1. `scripts/build-engine.mjs` packs the repository engine, schemas, templates and golden scenarios into `public/engine/`
   and copies the pinned Pyodide runtime into `public/pyodide/` (both git-ignored).
2. `scripts/build-inventory.mjs` reads the repository and writes git-ignored files under `src/generated/`:
   the Developer Integration inventory (stamped with the commit), the native conformance report index and the native app
   evidence index. It also copies the native app evidence files to `public/evidence/native-apps/` (git-ignored).
3. `tsc --noEmit`, then `vite build` emits `dist/`: static files, relative base (`./`), hostable by any static server.

Everything in `dist/` is derived from the repository at the commit being built. Nothing is typed into the app by hand.

## Data flow and browser storage

- **Draft.** One draft spec lives in memory and in `localStorage` under `monstera.studio.draft.v1` (spec text plus the
  starting template and its origin). It is restored and re-validated on reload. Nothing is uploaded; clearing site data
  deletes it. There is no account and no server-side project store.
- **Import.** A user-selected `monstera.spec.json` is read in the page, parsed with the engine's strict JSON rules and
  validated. Refused files (duplicate keys, BOM, invalid UTF-8, non-object) leave the draft unchanged.
- **Export.** The canonical spec (engine serialization) and the source ZIP are generated locally and downloaded. An unedited
  template exports byte-identically to the committed file; an edited draft exports without recorded goldens.
- **Kiro.** Kiro reads and writes the same `monstera.spec.json` in the repository through the developer's normal workflow
  (editor, git, MCP tools). Studio never talks to Kiro. Developer Integration is a static inventory of `.kiro/` and
  `tools/monstera-mcp/server.py` stamped with the commit it was read at, plus copyable prompts.

## Native evidence flow

Two separate, read-only evidence displays appear on the Determinism page. They prove different things.

1. **Simulation conformance** (`monstera conformance` reports, `docs/evidence/**/*.report.json`): the Kotlin and Swift
   simulation cores reproduce the oracle's checkpoints.
2. **Native app build and launch** (`docs/evidence/m3-native-apps/<android|ios>/<game>/`): the generated apps were compiled
   and launched on an Android emulator and an iOS simulator (Device Lab adapters).

For (2), the build script evaluates each game and platform with `studio/scripts/native-evidence.mjs`, which fails closed:

- The spec SHA-256 is computed from the canonical spec file (`apps/*/monstera.spec.json`,
  `spec/samples/lantern-run/monstera.spec.json`), never copied from `SUMMARY.md`.
- `report.json` and `results.jsonl` must parse, name the right target and game, record each operation once in a plausible
  order, and agree with each other. Otherwise nothing from them counts.
- The app's own log lines (Android `MonsteraSpec`/`MonsteraRuntime`, iOS `:spec`/`:runtime`) are parsed strictly. The logged
  spec hash must equal the canonical hash, the app must confirm its bundled specification (iOS also the decoded one), and
  the runtime must log ticks from the same process.
- Each result is shown separately: native compilation, installation and launch, exact specification hash, bundled
  integrity, runtime observed, screenshot (a valid PNG) and logs.
- Labels: `COMPILED` needs a successful build bound to the canonical hash by the app's own log. `SIMULATOR-TESTED` also needs
  successful install, launch, screenshot, log capture and an observed runtime. Anything weaker is `GENERATED`.
  `PHYSICAL-DEVICE-TESTED` is never derived from this evidence.
- In the browser, evidence is attached to a draft only when the draft's validated SHA-256 equals the evidence's canonical
  SHA-256. An edited draft, or an imported file with a different hash, gets no label from it, even for the same project;
  editing back to the original hash restores it. Same-project evidence for a different hash is described as belonging to an
  earlier or different specification.
- The screenshot, `report.json`, `results.jsonl` and `logs.txt` are copied to the static output and linked.

**What this evidence does not prove:** Phase 1 verifies build, install, launch and runtime startup only. It does not show
gameplay, input handling, restart, performance, haptics or physical-device behaviour. The committed APK and `.app` build
artifacts named in the reports are not stored. Studio cannot produce or refresh this evidence; it is recorded by Device Lab
and CI and committed.

## Trust boundaries and security model

- **No server, no accounts, no secrets.** The deployed artifact is static files. There is no credential to leak. The bundle
  contains only repository content and public Pyodide files.
- **User input** (imported specs, edited fields) is untrusted data. It is parsed as JSON and validated by the engine; it is
  never evaluated as code. Rendered values go through React (no `dangerouslySetInnerHTML`).
- **Same-origin only.** The page and worker load nothing from other origins and make no network requests during use.
- **Local state.** The draft in `localStorage` is readable by scripts on the same origin. Studio holds no sensitive data.
- **Evidence integrity.** Evidence is committed to git and reviewed there. Studio checks internal consistency and the
  spec hash binding, but it cannot prove that a committed log was not fabricated; the provenance rules
  (`04-generation-and-provenance.md`) apply to whoever commits it.
- **Hosting.** Vercel is the selected static host. No deployment exists yet. When it does, response headers (CSP,
  `Cross-Origin` policies as Pyodide requires) must be decided and verified then; none are claimed now.

## Explicitly not part of Studio

Railway or any API service, Postgres or any database, authentication, server-side generation, GitHub dispatch, remote
build workers, build buttons, a chatbot, a live Kiro connection, signing apps for users, and shipping Studio inside a
generated app.

## Remaining M3 work

Vercel deployment, a Playwright smoke test and CI job, a secret scan of the production bundle, and the final adversarial
review. See `.kiro/specs/g4-studio/tasks.md`.
