---
inclusion: fileMatch
fileMatchPattern: [".kiro/specs/studio-foundry/**", "studio/schemas/**", "studio/security/**", "studio/src/project/**", "docs/evidence/studio-foundry/**"]
---
# Studio Foundry rules (product and governance)
Spec: `.kiro/specs/studio-foundry/` (requirements, design, tasks). Implementation constraints and the engine boundary are in
`07-studio.md`; this file does not repeat them and must not contradict them. If the two ever disagree, 07 decides and this file is fixed.

## Architecture decisions (owner, 2026-11-16)
- **Two layers, one project identity.** The canonical v5 spec stays authoritative for its supported game semantics. Versioned
  Studio sidecar manifests own the new Studio domains. A fact has exactly one owner; there are no competing sources of truth.
  The project identity (`project.json` `projectId`) equals `spec.project.id`.
- **Derivation is opt-in and explicit, default OFF.** Compiling sidecar settings into the v5 spec happens only when the user
  asks for it. Studio shows the derived diff and the engine's validation result first, and changes the spec only after the user
  accepts. It never mutates the canonical spec silently, on load, on import or as a side effect of editing a sidecar.
- **Engine track.** E1 (native sprite references and bundling, spec v5) is approved by the owner with a sequencing override
  and recorded in `docs/STUDIO-FOUNDRY-GATE-E.md`; E1 changes to `tools/monstera/`, `spec/schema/` and templates are limited to the
  allowlist checked by the Task 9.2 proof. E2 (compiled extension roots) is conditional on E1 acceptance; E3 (level table) is
  deferred. The G6 baseline `71c77e4` and its evidence are not rewritten.
- **Format upgrade exception.** The one load-time spec change Studio makes is the documented v4 to v5 upgrade
  (`docs/SPEC-V2-MIGRATION.md`): only for valid v4 content, only when the v5 engine accepts the result, adding neutral sprite fields,
  saved atomically, with a visible notice. Every other change to the spec still needs the user's explicit action.
- **No direct AI provider calls from the browser in this milestone.** Importing externally produced assets and proposals stays
  possible. A secure replaceable provider architecture stays on the roadmap and is `planned`, not built.
- **Monetization.** Studio supports mock and official Google test configurations only. It never stores or emits a production
  AdMob app id or ad unit id; the developer adds them after export in developer-owned files.

## Status vocabulary (every capability, in UI and docs)
`implemented` (works end to end, with a test), `prototype` (bounded subset, limits shown), `mock` (simulated, labelled MOCK),
`planned` (designed, not built, no controls), `unsupported` (cannot be done here, reason stated). Each module also shows its
native output: `compiles to native`, `studio only`, `scaffold`, `mock` or `planned`. Never present a mock, scaffold or Studio-only
feature as a live integration or as part of the generated app. No control may exist for a feature that is not built.

## Ownership classes (exported project)
`engine-owned` (`android/`, `ios/`, `MONSTERA-MANIFEST.json`, `.kiro/steering/monstera-generated.md`), `spec`, `studio-data`
(`studio-pack/*.json`, assets), `studio-scaffold` (written by Studio, drift-checked), `write-once` (developer-owned after export,
never overwritten). Studio never edits engine-owned files and never merges or reverse-engineers native code.

## Evidence and review
- A task is complete only when its stated acceptance test passed and the exact command and result are recorded. A task that
  depends on something not yet verified (remote CI, a live deployment) stays unchecked or is marked as locally tested only.
- Local enforced-CSP results are not evidence about the deployed site. Deployed headers are reviewed after a report-only
  deployment at the Vercel project's confirmed Root Directory.
- ChatGPT performs the adversarial implementation review against the committed spec and the Git diff; Claude may add an
  architectural critique. These are LLM reviews and are recorded as such, never as independent human review. The repository
  owner gives final acceptance.