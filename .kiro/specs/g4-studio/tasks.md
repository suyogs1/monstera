# G4 tasks
Status: **APPROVED 2026-11-12. M0 done and approved. Visual batch and schema freeze implemented; waiting for approval before M1.**
Order: M0 spike, bounded G3 visual batch with schema freeze, M1 editor, M2 preview and export, M3 deployment and evidence.

- [x] 0. M0 spike: unmodified engine in a Pyodide Web Worker, validate and plan parity with the CLI, golden scenarios for both games, edited-spec run, size and responsiveness (`studio/spike`, `docs/evidence/studio-spike/`) [R1, R6, R5.1]
- [x] 1. Bounded G3 visual batch (items 1 to 5 of the G3 visual plan): layout and clipping, `kinds[].glyph`, `kinds[].effect`, `game.hud`, `game.screens`, start and end cards, HUD lives. Spec v4 frozen (see design.md), contract section 9, goldens re-recorded (checkpoints unchanged), presentation modules and tests on both platforms, apps regenerated [D3]
- [ ] 2. M1: scaffold `studio/` (Vite, React, TypeScript), move the worker and glue out of the spike, template loading, schema-bounded editors with unit display, validation panel [R1 to R3, R8]
- [ ] 3. M2: engine function for in-memory scenario runs; preview in a worker with pointer input; click-through between preview and editor; determinism badge with explanation; source export [R4 to R6]
- [ ] 4. M3: evidence panel, Vercel deployment, Playwright smoke test and CI job, update `architecture/MONSTERA-STUDIO.md`, one adversarial review, bundle secret grep [R7, R9, D4]

Notes (2026-11-12): M0 passed. Details and measurements are in `docs/evidence/studio-spike/spike-result.json`.
- [ ] 5. G6 clean-room regeneration and recording milestone (after the MONSTERA framework is complete): (a) final framework and specification freeze, no open schema or template change; (b) generate both games fresh from the same skeleton into empty directories, from the two committed specs only; (c) Android and iOS source and build verification (Gradle, `swift test`, xtool or Xcode build, CI green on the head); (d) recorded demonstration of Studio, then generated source, then both native games running; (e) evidence that no game-specific generator or template change was needed: diff of `tools/monstera/` and `spec/schema/` between the freeze commit and the regeneration, generated trees equal to the manifests, and no `if (game)` branches in templates [R6, R8]

## Optional proposal: "Explore Native Code" view (not approved, not implemented)
Selecting a Project Brain field (for example a kind's `glyph`, a spawner's `intervalTicks`, or `hud.scoreLabel`) shows which generated Kotlin and Swift
files and lines carry its value, with a link to the file in the source export. The mapping is derived, not hand-written: a build-time script lists, for each spec
JSON path, the generated files whose text contains the rendered value (spec constant, runtime config, or model), using the engine's own `plan()`; fields
that are display-only point to the shell and presentation files, and simulation fields point to `GeneratedRuntimeConfig`. Estimated size: one engine-side index
function, one panel, one test. Risks: values that occur in many files need ranking, and the view must say "generated, read only". Decide after M2.
