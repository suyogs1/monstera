# G4 design: MONSTERA Studio (static, engine in the browser)
Status: **APPROVED 2026-11-12. M0 spike done; spec v4 schema FROZEN (visual batch).** (Kiro Spec; not a `monstera.spec.json`.)
`architecture/MONSTERA-STUDIO.md` (G1.5) is superseded where it describes a Railway API, Postgres,
GitHub dispatch and server-side builds. It is updated in M3.

## Architecture
```
studio/ (Vite + React + TypeScript, pinned)          Vercel: static files only
  UI thread: structured editors, canvas preview, export
  Worker:    Pyodide 0.29.5 (self-hosted, same origin)
               /repo/tools/monstera/**   unmodified engine
               /repo/spec/schema/*       schemas
               /repo/apps, /repo/spec/scenarios   templates and goldens
             glue.py: calls validate / plan / oracle, returns JSON
  state: one draft spec; localStorage; import and export JSON
```
The engine package is placed at its repository-relative path so `targets.REPO_ROOT`, template lookup
and scenario lookup behave exactly as in the CLI.

## Decisions
- D1 No backend. If the engine cannot run in the browser, G4 stops; no server is added.
- D2 Vercel static hosting.
- D3 The G3 visual batch freezes the schema (including glyph fields) before M2.
- D4 One Playwright smoke test in CI.
- D5 Pyodide is self-hosted and pinned by exact version (0.29.5, Python 3.13.2); the bundle is built
  from the repository files at build time, never copied by hand.
- D6 Studio is never shipped inside generated apps.

## M0 findings that shape M1 and M2
1. **Edited drafts have no recorded goldens.** `scenario.load_for_project` and `scenario.check` refuse a
   scenario whose recorded spec hash differs, which is correct for the CLI. For an edited draft, the export
   embeds no scenarios (`plan(..., scenarios=[])`) and says so. Only the unedited template exports with its goldens.
2. **The badge needs an in-memory engine entry point.** `scenario.oracle_checkpoints` reads the spec from a
   file and requires the recorded hash. The spike called `sim.Config` and `sim.run_scenario` directly and
   skipped frame-based scenarios (`frames.count > 0`). M2 adds one small engine function that runs a
   scenario against a given validated spec (handling frames), with a Python test, and the CLI keeps its behaviour.
   **M2 engine changes (approved 2026-11-13, the only exceptions to "Studio never edits tools/monstera"):** they are
   engine changes made for Studio, reviewed as such, and carry CLI-unchanged tests. (a) `scenario.checkpoints_for_game`
   (pure, in-memory; `oracle_checkpoints` keeps its recorded-hash check). (b) `scenario.StaleScenarios(ValueError)`,
   raised by `load_for_project` only when goldens were recorded for another spec SHA-256 (same message, same CLI exit
   codes), so the export omits goldens only in that case and refuses every other scenario failure like the CLI.
   "Unmodified engine" in `build-engine.mjs` means the bundle is the repository's engine files, byte for byte.
   The glue functions `golden_report`, `plan_template` and `preview_trace` are the acceptance interface
   (`studio/scripts/m2-*.mjs` compare them with host CPython); they are read-only and have no UI.
3. **CRLF**: a Windows checkout can hold CRLF in `apps/**` (git `text=auto`). The bundle script uses the LF form
   that git stores. Hashes are over canonical JSON, so validation is unaffected.
4. Draft validation should use `loads_strict` and `validate_value`; the spike showed it equals the file path.

5. **The M1 bundle is smaller than the M0 bundle on purpose.** M1 only validates and serializes, so
   `studio/scripts/build-engine.mjs` leaves out `spec/scenarios/**` and the binary `gradle-wrapper.jar`. M2 restores both
   (the spike's base64 handling for binaries): the jar is required for R6.1 plan parity and the source export, the
   scenarios for the badge and for exporting an unedited template with its goldens (finding 1). Until then
   `generate.plan` must not be called in Studio.

## Acceptance (M0)
Executed by `studio/spike`, evidence in `docs/evidence/studio-spike/spike-result.json`.

## Frozen schema: spec v4 (visual batch, 2026-11-12)
Studio editors are built against exactly this schema. Further visual fields need a new Kiro Spec decision.
All fields are required (the engine has no optional properties and no hidden defaults); "optional" below means a neutral value exists.
| Path | Type and constraint | Neutral value | Used by |
|---|---|---|---|
| `game.runtime.kinds[].glyph` | string, at most 8 characters, no control characters, `"`, `\`, `$` | `""` = draw the `color` rectangle | Entity symbol, drawn centred and scaled to 0.9 of the box's shorter side |
| `game.runtime.kinds[].effect` | enum `none`, `burst`, `pickup` | `"none"` | Burst: 8 particles. Pickup: ring, plus `+N` when the score rose in the same frame |
| `game.hud.lifeGlyph` | glyph | `""` = text `lives N` | One symbol per life (at most 8, then `+n`) |
| `game.hud.scoreLabel` | text, 1 to 40 characters | `"score"` | Label before the score |
| `game.screens.startHint` | text | `"Tap to start"` | Start card line |
| `game.screens.winTitle`, `loseTitle` | text | `"You win"`, `"Game over"` | End card title (win when lives remain) |
Existing: `kinds[].color` and `game.palette` (display only).

- **Layout and clipping have no schema fields.** The HUD bar takes `max(40, 9% of the shorter view side)` capped at 25% of the view height, below the
  status-bar or notch inset. The world rectangle is fitted into the rest. Everything inside is clipped to the world rectangle. Studio's preview
  uses the same rule, so it needs no field either.
- **Start and end cards have no fields beyond the three texts.** The start card title is `project.displayName`. The game runs unattended behind
  the start card; the first tap starts a fresh session. The best score is stored on the device (presentation only, never in the spec).
- **Visual-only guarantee.** The runtime configuration is generated only from non-visual fields; `check-architecture` rejects presentation names in
  core sources; `tests/test_presentation.py` proves identical golden checkpoints and identical runtime configuration for a spec with every
  visual field changed (contract section 9).
- **Backward compatibility.** v3 specs are rejected with `must be 4`; `docs/SPEC-V2-MIGRATION.md` lists the neutral values to add. Golden
  checkpoints did not change in the migration (29 scenarios, only the recorded spec hash).
- **Studio consequences.** Editors for glyph (text field plus emoji picker limited to 8 characters), effect (3-way choice), HUD and screens (text)
  are schema-driven. The preview draws glyphs with the browser's font, so Apple and Google artwork differences also apply there. The determinism
  badge treats all of these as display-only edits: they never diverge (R5.3).
- **Out of scope for G4:** idle motion, backgrounds, parallax, sound, haptics, sprites and assets (items 6 to 10 of the G3 visual plan).
