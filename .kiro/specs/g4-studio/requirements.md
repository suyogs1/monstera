# G4 MONSTERA Studio: requirements
Status: **APPROVED 2026-11-12 (plan and decisions D1 to D4), M0 spike done, M1 not started.**
This is a **Kiro Spec** (how MONSTERA is developed in G4). It is not a MONSTERA canonical
specification (`monstera.spec.json`), which describes a generated app.

## Introduction
Studio makes MONSTERA a visual game foundry: a user edits a game through structured editors, sees the
real deterministic game run live, and downloads the native Android and iOS source. Studio is a static
web app. The unmodified Python engine runs in the browser (Pyodide). There is no backend.

Non-goals: Railway or any server, Postgres, accounts, build dispatch (deferred), asset upload,
native capabilities (G5), a chatbot, a TypeScript port of the simulation.

## Glossary
- **Draft**: the one canonical spec the user is editing. Studio holds nothing the schema cannot express.
- **Oracle**: `tools/monstera/monstera/oracle`, the reference simulation, run unmodified in the browser.
- **Golden scenario**: a recorded seed, input trace and expected checkpoints (`spec/scenarios`).
- **Badge**: the determinism badge comparing the edited draft with a golden scenario.

## Requirements
### R1 Real engine, no reimplementation
1. Validation, generation and simulation SHALL come from the files in `tools/monstera/monstera/`, loaded unmodified into Pyodide.
2. Studio SHALL contain no validation, generation or simulation logic. Glue only calls the engine.
3. For every case in the validation corpus, the browser result (valid, sha256, issues) SHALL equal `monstera validate --json`.

### R2 The canonical spec is the single source of truth
1. Exporting an unmodified template SHALL give the committed `apps/<id>/monstera.spec.json` content.
2. Editing a value and reverting it SHALL return the original spec SHA-256.
3. Draft state SHALL be one JSON document that validates against `spec/schema`.

### R3 Structured editing
1. Fields SHALL be bound by JSON path and constrained by the schema (type, enum, range, pattern).
2. Q16.16 quantities SHALL be shown in game units and stored as raw integers; the conversion is display only.
3. Editors SHALL exist for identity, orientation, palette, kinds, spawners, collisions, input, lives and win score.

### R4 Live preview
1. A valid edit SHALL restart the preview within 1 s.
2. The preview SHALL run the oracle in a worker and SHALL NOT block the main thread.
3. Preview input SHALL be labelled "simulation exact, touch mapping approximate".

### R5 Determinism badge
1. The badge SHALL run a chosen golden scenario against the edited draft and compare every checkpoint with the committed expected checkpoints.
2. A divergence SHALL be reported with the first divergent tick, and SHALL be explained as an expected consequence of a behaviour-changing edit when the edited path is simulation-relevant (spawners, kinds, collisions, input gains, lives, win score, world, simulation).
3. A display-only edit (palette, display name) SHALL NOT diverge.
4. The badge SHALL NOT assess the browser input mapping. Scenarios replay recorded input; the mapping is not exercised.

### R6 Native generation preserved
1. The source export SHALL contain exactly the file set and file contents of `monstera generate`, and the same `MONSTERA-MANIFEST.json`.
2. ZIP archive metadata (timestamps, ordering, compression) is NOT required to be byte-identical.
3. `apps/*` and `generated/*` SHALL stay free of web tooling.

### R7 Honest labels
1. Studio SHALL show only GENERATED, and COMPILED or SIMULATOR-TESTED where it links committed evidence.
2. Studio SHALL NOT show device-tested, and SHALL NOT offer a "build" button.

### R8 Two games on one foundation
Both `apps/*/monstera.spec.json` SHALL load as templates, edit, preview and export through the same UI.

### R9 Deployment
A public static URL on Vercel serves Studio. No bundle or response contains a secret (there are none).

## M0 feasibility gate (this milestone)
M0 passes only if all of the following hold in a real browser (Chrome, Pyodide in a Web Worker):
1. The engine runs unmodified; validation parity on the corpus (R1.3).
2. `plan()` with the real templates and the binary `gradle-wrapper.jar` equals CLI `generate` for both games (R6.1).
3. Every golden scenario of both games reproduces its committed checkpoints.
4. An edited in-memory draft runs on Pyodide with results equal to host CPython, a behaviour edit diverges and a no-op edit does not.
5. Cold engine ready <= 10 s on localhost; per-tick p95 <= 3 ms; main thread timer gap <= 100 ms; brotli first load <= 15 MiB.
Failure of any item stops G4 for a decision. No backend is introduced.
