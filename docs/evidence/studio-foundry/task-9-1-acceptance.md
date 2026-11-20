# Task 9.1 acceptance summary (A1 to A7)

Hand-maintained evidence summary, authorized by the owner as the single Task 9.1 evidence file. Task 9.1 is not marked complete
by this file; the PENDING rows below remain open. Detailed logs and JSON stay outside the repo in the workflow output
(`.kiro/workflow-output/task-9-1/`: acceptance.md, e2e.log, e2e-report.json, foundry-flow.log, review.md).

## Commits

| What | SHA |
|---|---|
| Local acceptance run (Windows), branch `studio/foundry-task-9-1-accept` on base 814c11f | 2aeb695abae0d1890b1150f512f111e9e15a82dd |
| PR #49 head after rebase onto main 0036110 (PR #48), tested by CI | 5ef565f4b55ce865a7b623162274d67df1ad98d5 |
| PR #49 squash merge on main | 13f9fb4a0ce964b4c07838a32be60eda89c3fde7 |

The rebase replayed one commit with no conflicts; `.github/workflows/studio-ci.yml` keeps both the Task 9.3 hostile-input/dist
scan step and the Task 9.1 foundry flow step. The local rows below were observed on 2aeb695, not re-run on 5ef565f.

## CI on the exact PR head

GitHub Actions run 44678373511 (workflow `studio`) on 5ef565f4b55ce865a7b623162274d67df1ad98d5: `build-and-smoke` SUCCESS,
`deployed-smoke` SUCCESS. The earlier head 2aeb695 also passed both jobs before the rebase.

## Acceptance table (local Windows run, Chrome 157.0.8103.79)

| Row | Status | Command | Observed |
|---|---|---|---|
| A1 modules, statuses, no dead controls | PASS | `node scripts/shell.mjs` (and `smoke.mjs`) | `74/74 checks passed` |
| A2 existing behaviour | PASS (local), M2 see below | `npx tsc --noEmit` (inside `npm run build`), `npm run build`, targeted vitest (`src/release src/pack src/integrations src/project src/dashboard src/export src/kiro src/app/session.bundle.test.ts src/app/capabilities.test.ts src/app/shell.test.ts`) | build OK; vitest `38 files, 735 passed` after the exportPack fixture id fix (first run 3 failed: fixture id "p" is refused by kiroTemplates) |
| A3 create, edit, save, reload | PASS | `node scripts/a3-dashboard.mjs` | `16/16 checks passed` |
| A3 bundle export / re-import | PASS | `node scripts/foundry-flow.mjs` | 4 A3 checks PASS: bundle holds spec, manifests, asset bytes; import opens a new project with identical canonical spec, SHA-256, manifests, asset SHA-256s; re-export is byte-identical; `../x` bundle refused with alert and project unchanged. Unit: `session.bundle.test.ts` 3/3 |
| A4 image, provenance, slice, animation | PASS | `node scripts/foundry-flow.mjs` | 3 A4 checks PASS (asset-0001 with SHA-256 and license, one 32x32 frame, animation with 2 entries) |
| A5 two levels, validate | PASS | `node scripts/derive-apply.mjs`, `node scripts/a5-levels.mjs` | `32/32 checks passed`, `27/27 checks passed` (real `monstera validate` on every variant) |
| A6 lives, winScore, collisions + Backend/Monetization scaffold UI (task 6.3) | PASS | `node scripts/foundry-flow.mjs` | 4 gameplay checks + 5 scaffold-UI checks PASS (banners, no free-text input on Backend, modes exactly mock/test, no unit-id field, auth toggle reaches manifest and GENERATED preview, add placement, mock view GENERATED + MOCK). The former "pending task 6.3" line is gone and the steps run for real |
| A7 pack, ownership manifest, drift script | PASS | `node scripts/foundry-flow.mjs` | pack holds `tools/check-drift.sh`, `studio-pack/scaffold/**`, `.kiro/steering|hooks`; classes studio-scaffold / write-once / studio-data; scaffold reflects the UI auth choice; pack's own script: clean exit 0, edited scaffold exit 1 `edited studio-scaffold ...AdService.kt`, edited write-once exit 0 `scaffold-drift=0`, deleted scaffold exit 1 `missing`, edited studio-data exit 0 |
| Drift on re-import | PASS | `node scripts/foundry-flow.mjs` | edited ZIP in `/kiro/drift`: `edited studio-scaffold` + `edited write-once`, summary "1 scaffold file drifted"; Drift view rows == script rows (state, class, path) on the same tree; untouched ZIP shows 0 edited |
| Smoke 17/17 | PASS | `node scripts/smoke.mjs` (SMOKE_REPORT = temp file) | `smoke local-preview: PASS (17/17)` |
| M1 rerun | PASS | `node scripts/acceptance.mjs` | `PASS: 109/109 checks, Chrome 157.0.8103.79`. It rewrote docs/evidence/studio-m1/acceptance.json; the orchestrator restored that file; no existing docs/evidence file was changed |
| M2 rerun | FAIL (local Windows, CRLF-related only); full M2 matrix not demonstrated green | `node scripts/m2-acceptance.mjs` | local Windows run FAIL: CRLF only (gates 27/33, session.test.ts x7, nativeApps x1, variants x1); its M1 regression step PASS 109/109. Not rerun (orchestrator instruction: probable cause of the core.bare incident) |
| Task 1.6 live Vercel CSP review | PENDING | n/a | Owner-held dependency: deployed CSP report-only review and enforcement not done; local runs are not a substitute |
| Committed e2e evidence file under docs/evidence/studio-foundry/ | DONE (this file) | n/a | Owner authorized this single summary file; detailed logs and JSON stay in `.kiro/workflow-output/task-9-1/` |

## M2

M2 is **not** demonstrated green. The local Windows `node scripts/m2-acceptance.mjs` run failed, and every failure observed is
CRLF-related: `monstera gates` 27/33 (canonical, `generate --check` and `verify` for both committed apps),
`session.test.ts` x7, `nativeApps` x1, `variants` x1. Its embedded M1 regression step passed 109/109. The Studio CI
workflow passing on the PR head does not run the full M2 matrix and is not a substitute for it. M2 was not re-run after the
incident below.

## Limitations and open items

- Task 1.6 live Vercel CSP review (report-only, then enforced): PENDING, owner-held.
- M2 full acceptance matrix: not demonstrated green (see above).
- Incident during the M2 run: the shared `.git/config` was rewritten with `core.bare=true` and the worktree index staged a
  deletion of every file. Both were restored. Probable cause, inferred from code and an alias reproduction but not observed in a
  log: m2-acceptance runs gates through a git alias, git exports `GIT_DIR` from the linked worktree to the child, and a gate test
  then runs `git init` / `git add` in a temp directory with that `GIT_DIR` inherited. Until fixed, risky acceptance runs use
  a disposable clone.
- `studio/capabilities.json` still describes bundles and the pack as not yet available; that text belongs to Task 9.5.
