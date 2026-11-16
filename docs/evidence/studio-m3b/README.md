# Studio M3-B evidence: production verification and CI

Date of runs: 2026-11-16. Commit under test: `072c54d` (main after PR #12). Browser: Chrome (local installed channel) and Playwright Chromium 158.

| File | What it is |
|---|---|
| `smoke-local-preview.json` | `npm run smoke` against `vite preview` of the production build. 17/17 checks. |
| `smoke-production.json` | The same script against https://monstera-phi.vercel.app/ . 17/17 checks. The page reports it was built from commit `072c54d`. |
| `secret-scan.json` | `npm run scan:secrets` over `studio/dist`: 34 files, no findings. Values are never recorded. |
| `ADVERSARIAL-REVIEW.md` | Final M3 review, with limits. |

Reproduce (from `studio/`): `npm ci && npm run build && npm run scan:secrets && npx playwright-core install chromium && npm run smoke`.
Deployed site: `SMOKE_URL=https://monstera-phi.vercel.app/ SMOKE_LABEL=production npm run smoke`.

What the smoke proves: the page loads without console, page or HTTP errors; the Pyodide worker starts and the Python engine validates each of the three
official games to the canonical SHA-256 of the committed spec; an invalid edit is rejected with issues; the preview produces frames and draws a scene;
the native evidence panel shows SIMULATOR-TESTED evidence for the exact hash, drops it after an edit, and restores it on revert; every request
stays on the Studio origin. What it does not prove: gameplay, input handling, physical devices, or behaviour in browsers other than Chromium.

Negative proof: with `dist/engine/engine-bundle.json` removed, the smoke fails (engine never becomes ready, exit 1).
Additionally, the production bundle (6 files: HTML, JS, CSS, engine bundle) was scanned once by the same scanner: no findings. No `.map` files are served (404).
