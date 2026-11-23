# MONSTERA Studio Foundry architecture

Status: describes the Studio Foundry as built on `main` at the Task 9.5 documentation closeout. Status words (implemented,
prototype, mock, planned, unsupported) come from one source, `studio/capabilities.json`, and are rendered in
[`docs/STUDIO-CAPABILITIES.md`](../docs/STUDIO-CAPABILITIES.md). When this document and the registry disagree, the registry
wins and this document is wrong. Design record: `.kiro/specs/studio-foundry/` (requirements, design, tasks). Rules:
`.kiro/steering/07-studio.md` and `.kiro/steering/11-studio-foundry.md`. The earlier G4 milestones (M0 to M3) are the
foundation this builds on; they are not the whole product.

## 1. Purpose

MONSTERA Studio is a static web app in `studio/` (Vite, React, TypeScript). A person edits a game in the browser. The
repository's own Python engine runs unmodified in the page (Pyodide) to validate the game, preview it, check determinism and
produce the native Android (Kotlin) and iOS (Swift) **source** as a ZIP. Nothing is uploaded and there is no server.

The canonical specification file, `monstera.spec.json` (schema v4), is the only contract between Studio, the engine, Kiro
and the generated apps. Studio never pretends to be Kiro and has no connection to Kiro.

Studio is a source authoring and verification tool. **The browser does not compile native applications.** The engine
generates source. Compilation, emulator and simulator results come from the Device Lab adapters and CI workflows that build
the generated projects, are committed as evidence, and are only displayed by Studio.

## 2. Modules

The shell lists 11 modules in a fixed order. Each shows its status from the registry and offers editing only as far as that
status allows.

| Module | Role | Reaches native output |
|---|---|---|
| Project Dashboard | Create, open, rename, duplicate, delete projects; status cards; project bundle export and import | Studio only |
| Game Designer | The canonical v5 spec editors with engine validation, spec view, import, export | Yes (it is the spec) |
| Asset Studio | Import, library, provenance, preview, delete protection, assignment of an asset to a kind | Studio only |
| Sprite and Animation Editor | Sheet slicing, frames, animation sequences, tick-based preview | Studio only |
| Level Studio | Levels as Studio data; the active level compiles into the spec; other levels export as variants | Active level only |
| Gameplay Systems | Lives, win score, collectibles, enemies compiled into `lives`, `winScore`, `collisions` | Yes, as v4 fields |
| Backend and Services | Firebase service choices as scaffold text | Scaffold only |
| Monetization | AdMob mock and test placements with a labelled mock preview | Mock only |
| Kiro Development | Developer Integration inventory, handoff prompts, pack drift view, proposal inbox | Studio only |
| Preview and Device Lab | Browser preview, determinism badge, environments table, committed native evidence | Studio only |
| Build and Release | Source ZIP with the Studio pack, completeness check, readiness checklist | Source only |

## 3. Frontend architecture

- A single-page app with a hash router and a module registry (`studio/src/app/`). The registry drives the navigation rail,
  the status badges and the editability of each module page.
- One shared **project context** (`studio/src/project/context.tsx`, `controller.ts`) owns the open project: the spec draft,
  the sidecar manifests, the asset files, undo and redo history, validation state and save state. Modules read and change the
  project only through it, so the Designer, Level Studio, Gameplay Systems and the exporters see the same data.
- The engine runs in a module Web Worker (`studio/src/engine/`). The UI sends JSON text and receives JSON text; the
  functions of `glue.py` are validate, plan, oracle check, preview start and frame, badge check and export plan.
- Pyodide 0.29.5 and the engine files are self-hosted and pinned. Pages make no request outside their own origin.
- Editors for spec fields are derived from `spec/schema/*.schema.json`, and values display in game units while the spec
  keeps raw Q16.16 integers.

## 4. Browser storage and persistence

- Projects live in IndexedDB (database `monstera-studio`: stores `projects`, `blobs` and `meta`). One project is one atomic
  record: the spec, its baseline and the manifests. Asset files are stored as blobs keyed by project and asset id.
- `ProjectStore` is the only persistence authority. It reports `saved` only after a committed transaction. Other states are
  explicit and visible: `saving`, `unsaved`, `failed`, `memory-only` (IndexedDB unavailable), `conflict` (another tab wrote
  the record), `read-only` (database or record newer than this build), `quarantined` (stored record unreadable) and `closed`.
  A conflicting, newer or unreadable stored record is never overwritten; recovery exports keep the in-memory work.
- Only a spec the engine validated is persisted. The legacy `localStorage` draft of the earlier Studio is read once and
  migrated, never written.
- Storage is local to one browser profile. Clearing site data deletes projects. Moving a project between browsers uses the
  project bundle, a ZIP with the spec, the Studio manifests and the asset files.
- A bundle is read by a hardened ZIP reader (`studio/src/export/unzip.ts`): central directory only, every entry checked before
  inflation (path, layout, declared sizes, ratio, overlap, CRC), STORED and DEFLATE only, with entry-count and size limits.
  A bundle that fails any check is refused and changes nothing.

## 5. Canonical spec and the unmodified engine

- All validation, canonical serialization, SHA-256 of the spec, generation, oracle simulation and the determinism check run
  in `tools/monstera/` inside the worker. Studio never reimplements them.
- The one deliberate exception is the display-only drawing code of the preview (`studio/src/preview/presentation.ts`,
  `worldDraw.ts`), which mirrors the generated presentation modules and cannot change a simulation result.
- "Unmodified" means the bundled engine, schemas, templates and golden scenarios equal the repository files byte for byte
  (LF form). `npm run regression` (Task 9.2) enforces the freeze: the engine, `spec/schema/` and templates differ from the
  baseline `71c77e4` only by the approved test-only change recorded in `docs/STUDIO-FOUNDRY-GATE-E.md`.
- Studio holds no configuration the schema cannot express. A spec the engine refuses is shown with the engine's issues and is
  never exported as valid.

## 6. Studio-owned sidecar manifests

Data the v5 spec cannot express lives in versioned sidecar manifests, each with a JSON Schema in `studio/schemas/` and a strict
TypeScript validator in `studio/src/project/manifests/`: `project`, `levels`, `gameplay`, `assets`, `animations`,
`integrations` (and `proposal`, used by the inbox). The validators reject unknown keys, wrong types, over-long values and
duplicate JSON keys, reject unsafe paths and ids, and run before anything is stored, imported or exported.

Manifests never replace the spec. The engine validates the spec; Studio validates the manifests. The two are different
contracts and are not mixed.

## 7. Cross-references and derivation

- A read-only **cross-reference index** (`studio/src/project/xref.ts`) lists every place that refers to a spec kind, an asset
  or a level. Renaming or deleting a kind is project-wide and blocked, with the referencing places listed, while references
  remain.
- **Derivation is explicit opt-in** and off by default. With it off, the Designer owns every spec field. With a derivation
  switch on, the module that owns a set of spec pointers (`studio/src/derive/ownership.ts`) writes them and the Designer shows
  them read-only. Pointer ownership tables are disjoint.
- Nothing is written to the spec silently. A change goes through Review (a diff and the engine verdict) and an explicit Apply
  that is one undo step.

## 8. Level and gameplay compilers

- The **level compiler** (`studio/src/derive/levels.ts`) turns the active level's placements, waves and difficulty steps into
  `initialEntities` and `spawners`. A difficulty step compiles to an extra spawner that starts later, because v4 spawners
  cannot stop or change. Output is deterministic and covered by golden fixtures.
- The **gameplay compiler** (`studio/src/derive/gameplay.ts`) turns lives, win score, collectibles and enemies into `lives`,
  `winScore` and `collisions`.
- Both follow the same apply path: compile, engine validation, a bounded oracle run, then commit or reject. The engine and the
  oracle must accept the result. A rejected result leaves the project unchanged.
- Other levels are Studio-only variants. Level Studio exports each as a standalone `monstera.spec.json` under
  `studio-pack/derived/levels/<id>/`, and every exported variant is checked with `monstera validate`.
- **Not supported:** level selection, per-level win rules and wave end inside the native app. Schema v4 has one runtime and
  spawners that never stop. Health, power-ups and progression need a contract change and are planned only.

## 9. Assets, sprites and animations

- Asset Studio imports images and audio after content sniffing and limits (file size, image side, asset count, project size).
  Origin and license are user declarations; only the shape of the license is checked. Each asset records its SHA-256.
- An asset can be assigned to a kind (a link stored in the `assets` manifest, shown as a thumbnail in the Designer).
- The Sprite and Animation Editor slices a sheet into frames, edits frames and builds animation sequences. A tick-based
  preview player plays them in the browser.
- **Native sprites (spec v5, Gate E1, `architecture/RUNTIME-CONTRACT.md` section 10).** The spec embeds one PNG atlas
  (`game.atlas`), and each kind names 0 to 4 of its frames (`kinds[].sprite`). At most two kinds animate, and the frame is
  `frames[(tick div ticksPerFrame) mod count]`. The generator bundles the PNG as a real resource on both platforms. Compose and
  SpriteKit draw it with nearest-neighbour sampling and fall back to the glyph. Evidence: `docs/evidence/e1-native-apps/`.
- **Native limitation.** Studio's own assets, sheets and animations are still Studio data. They travel in the bundle and the Studio
  pack and are shown in Studio previews, but the generated apps do not read them: the Asset and Sprite editors are not yet wired to
  `game.atlas` and `kinds[].sprite`, which Studio keeps read-only. Content written for spec v4 (stored projects, imports, bundles,
  legacy drafts) is upgraded to v5 on opening with neutral sprite fields; the upgraded project is saved as one atomic record, and
  a refused upgrade leaves the original untouched. Gate decision (`docs/STUDIO-FOUNDRY-GATE-E.md`): E1 approved, E2 conditional,
  E3 deferred.

## 10. Studio pack, ownership and drift

The release export is one ZIP: the engine-generated native projects and `MONSTERA-MANIFEST.json`, plus the **Studio pack**.
The pack layout (`studio/src/pack/layout.ts`) assigns every path to one ownership class:

| Class | Examples | Rule on re-export |
|---|---|---|
| `spec`, `engine-owned` | `monstera.spec.json`, `android/`, `ios/`, `MONSTERA-MANIFEST.json` | Owned by the engine; not in the Studio manifest |
| `studio-data` | `studio-pack/*.json`, `studio-pack/assets/` | Rewritten every export |
| `studio-scaffold` | `studio-pack/scaffold/`, `studio-pack/derived/`, `tools/check-drift.sh` | Regenerated only when unedited; an edited file triggers an explicit choice |
| `write-once` | `extensions/`, `.kiro/steering|specs|hooks/`, `.gitignore`, `studio-pack/PROJECT-NOTES.md` | Written once, never overwritten |

`MONSTERA-STUDIO-MANIFEST.json` records each Studio-written file with its class and SHA-256. The export is deterministic
(double export is byte-identical) and ZIP file modes come from the engine plan, so `android/gradlew` stays executable.

**Drift** is reported, never repaired. `tools/check-drift.sh` in the export and the Drift view in Studio classify files as
unchanged, edited, missing or unknown. Only scaffold files count as drift. Edits to write-once files, studio data and
engine-owned files do not.

Extension roots and scaffold files are not compiled into the app. Compiling developer-owned source roots is engine track E2,
which is deferred.

## 11. Backend and monetization scaffolding

- Backend and Services records Firebase service choices (a toggle model with no free-text fields). Monetization records AdMob
  placements and frequency rules and shows a labelled mock rewarded-ad preview.
- Both emit **scaffold text** (Kotlin and Swift interface stubs, a mock rewarded ad service, a SETUP guide) into
  `studio-pack/scaffold/`. The developer adopts the files by hand.
- **Firebase is scaffold and mock. It is not a live backend.** Studio makes no call to Firebase and creates no account or
  resource. **AdMob is mock and test only.** No ad is shown, nothing is compiled into the app, and Studio never stores or
  emits a production ad id. Real ad ids and `google-services.json` or `GoogleService-Info.plist` are added by the developer
  after export.

## 12. Preview, determinism and native evidence

- **Browser preview** runs the unmodified engine's simulation from the spec and draws it on a canvas.
- **Determinism badge** runs the oracle against the recorded golden scenarios for the exact spec. It reports a match, a divergence,
  or that no goldens exist for that spec, and goes stale when the spec is edited. It says nothing about devices.
- **Native evidence** (`studio/scripts/native-evidence.mjs`) evaluates committed records of generated app builds and
  simulator launches, and fails closed. The spec SHA-256 is computed from the canonical spec, never copied from a summary. A
  record counts only when its logs, report and results agree and the app logged the same spec hash. Evidence attaches to a
  draft only when the draft's validated SHA-256 equals the evidence's hash; an edited draft shows none.
- The **environments table** folds committed records per environment (browser, oracle, JVM, Swift test, simulator, device) for
  the current spec hash. A row reads `passed` only when a source record backs it, otherwise `no evidence for this hash`. The
  device row never has a source.
- Labels follow `.kiro/steering/04-generation-and-provenance.md`. The recorded simulator and emulator evidence covers build,
  install, launch and the first runtime ticks. It does not show gameplay, input, performance or haptics, and no physical
  device has been tested.

## 13. Build completeness and release readiness

- The **completeness check** blocks export on errors: an invalid spec, a missing asset file, a plan the engine did not
  verify, or an invalid manifest. Warnings do not block.
- The **readiness checklist** states what is proven for one spec hash. Studio can prove only `generated`, for the hash the
  current engine plan was verified for. `compiled`, `simulator-tested` and `device-tested` read as not proven unless a
  committed record for that exact hash is supplied.
- The checklist lists what only the developer can do: signing, store listing, privacy declarations, real ad ids and Firebase
  files. Studio signs nothing, uploads nothing and makes no store-ready claim.

## 14. Security

- **No server, no accounts, no secrets.** The deployed artifact is static files.
- **Hostile input.** Imported specs, bundles, packs and proposals are untrusted data. They are parsed with strict JSON rules
  (duplicate keys, BOM and invalid UTF-8 refused), validated by the engine or the manifest validators, and never evaluated.
  The ZIP reader is hardened (section 4). Paths with `..`, absolute paths, symlinks and path-shaped ids are refused. React
  renders values without `dangerouslySetInnerHTML`.
- **Secret scanning.** A field guard refuses credential-shaped text (API keys, private key blocks, service-account JSON,
  AdMob ids, tokens, AI provider hosts) at manifest, name and spec-edit seams and when a pack is imported. A scan of the
  built bundle, the source maps and the schemas runs in CI. Findings never print values. The scans are pattern based and
  reduce accidental leaks; they are not a guarantee.
- **No AI calls from the browser.** Studio sends no request to any AI provider and holds no provider key. There is no live
  Kiro connection. A proposal produced elsewhere can be loaded as a file, reviewed and applied only on acceptance; who wrote
  it is not verified.
- **Content-Security-Policy.** The policy source is `studio/security/headers.json` (`default-src 'self'`, `script-src 'self'
  'wasm-unsafe-eval'`, `object-src 'none'`, `frame-ancestors 'none'` and others) with `nosniff`. It is verified on a local
  preview of the built site in report-only and enforce modes. **It is not deployed.** The owner confirmed the Vercel Root
  Directory as the repository root on 2026-11-16. The live report-only deployment is pending owner action, the owner's review
  of production violations is pending, and enforcement on production is not approved (Task 1.6).
- **Evidence integrity.** Evidence is committed to Git and reviewed there. Studio checks internal consistency and the hash
  binding; it cannot prove that a committed log was not fabricated.

## 15. CI, regression and deployment

`.github/workflows/studio-ci.yml` runs from `studio/`: lockfile install, unit tests, TypeScript check and production build,
bundle and source scans, the hostile-input suite with the final `dist` scan, a Playwright smoke test against a local
production preview, the shell check, the level apply path through the real engine worker, the A5 level flow, the A3
dashboard flow, the foundry flow (bundle round trip, asset to animation, gameplay, scaffold UI, pack and drift), the
Task 9.2 regression proof, and the smoke test under the report-only and enforced header policies. A separate job runs the
smoke test against the deployed site; it observes and never deploys or configures hosting.

Regression proof (`npm run regression`): engine and schema freeze diff against `71c77e4`, `monstera gates`,
`generate --check` and `verify` for the committed apps, and a comparison with the G6 evidence. **The G6 evidence comparison
is pending** because the 18 evidence files are not on `main`; the other checks pass in CI.

The Studio is hosted as static files on Vercel at https://monstera-phi.vercel.app/, configured by the owner. Studio CI never
deploys. Chromium is the only browser exercised by the smoke and flow scripts.

## 16. Status summary

Exact per-capability statuses, limits and evidence are in [`docs/STUDIO-CAPABILITIES.md`](../docs/STUDIO-CAPABILITIES.md).

| Status | What is in it |
|---|---|
| Implemented | Game Designer editors and spec view, source ZIP, browser preview, determinism badge, hash-bound native evidence, Developer Integration inventory, Studio pack export with ownership manifest and drift check, manifest schemas, secret scan |
| Prototype | Dashboard with bundles, Asset Studio, Sprite and Animation Editor, Level Studio and variants, difficulty steps, Gameplay Systems core, field locks, proposal inbox, environments table, completeness and readiness, project identity, security headers (not deployed) |
| Mock | AdMob placements and the mock rewarded ad |
| Scaffold | Firebase and AdMob stub text in the Studio pack |
| Planned | Native use of Studio library assets and audio, health, power-ups and progression, AI provider architecture |
| Unsupported | Live Firebase, production AdMob ids, in-browser AI calls, device testing from Studio, level selection inside the native app, signing, store upload and store-ready claims |

## 17. Explicitly not part of Studio

A backend, database, accounts, server-side generation or build, GitHub dispatch, remote build workers, a build button, a
chatbot, a live Kiro connection, in-browser AI calls, signing apps for users, store upload, and shipping Studio inside a
generated app.

## 18. Pending acceptance

Not complete, and not claimed complete here:

- Task 1.6: live Vercel report-only deployment (owner action), the owner's review of production violations, and enforcement. The Root Directory is confirmed; enforcement on production is not approved.
- G6 clean-room regeneration: PR #15 is not accepted or merged.
- Task 9.2: the G6 evidence comparison stays pending until that evidence is on `main`.
- Task 9.4: a ChatGPT LLM adversarial implementation review against the specification and the actual Git diff, with an optional Claude LLM architectural critique. These are LLM reviews, not independent human reviews. Final acceptance belongs to the repository owner.
- Task 9.6: demo script and recording.
- Full M2 acceptance matrix on a clean clone: a local Windows run failed on CRLF differences only and is not a substitute
  for a green run (`docs/evidence/studio-foundry/task-9-1-acceptance.md`).
