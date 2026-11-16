# Adversarial review of Studio M3 (author review, not independent)

Performed by the agent that wrote M3-B. It is a set of probes with results, not a second reviewer's opinion. Independent review is still available at the owner's request.

## Probes and results
| Probe | Result |
|---|---|
| Does the smoke fail when the engine cannot start? | Yes. Removing the engine bundle fails it after 90 s (exit 1). |
| Can evidence show for an edited spec? | Smoke edits `lives` and requires `data-matched=no`, label GENERATED, no platform cards; revert restores. Hash binding and PNG/log validation have unit tests from M3-A. |
| Does production serve what main contains? | The deployed page reports commit `072c54d`, equal to main. Production engine hashes equal the committed specs for all three games. |
| Does the deployed bundle leak credentials or source maps? | Scanner found nothing in 6 downloaded files. `.map` URLs return 404. Local build has no maps and no local paths in shipped evidence files. |
| Does Studio contact anything but its own origin? | No cross-origin request in either run. |
| Does the scanner print values? | No. Unit test asserts the findings contain none of the synthetic secrets. |
| Is the scanner trivially bypassed? | Yes for unknown token formats: it is pattern-based, not entropy-based. It reduces risk and does not prove absence. |

## Findings
1. Open, owner (hosting, not changed): no `Content-Security-Policy` or `X-Content-Type-Options` response header. HSTS is present. Studio runs Pyodide (needs `wasm-unsafe-eval`), so a CSP needs testing before it is added.
2. Open, owner (hosting): hashed assets and the 8.6 MB Pyodide wasm are served `max-age=0, must-revalidate`. Correct, but revalidated on every visit. Long `immutable` caching for `/assets/*` and `/pyodide/*` would help repeat loads.
3. Limit: the smoke edits through `window.session.store` (the same store the controls use), so the form controls are not exercised by it. The M2 and M3-A acceptance scripts cover forms but need an installed Chrome and are not in CI.
4. Limit: the deployed-site job compares hashes with the repository head. After a spec change merges and before redeploy it fails for a legitimate reason. It is a report, not a gate for PRs.
5. Limit: the preview check shows frames and a drawn scene. No click, key or touch gameplay was tested.
6. Unverified until the PR runs: `studio-ci.yml` has not run on GitHub. `monstera.yml` now ignores `studio-ci.yml` and `.kiro/specs/g4-studio/**`, but this PR edits `monstera.yml` itself, which still triggers native CI once. The exclusion is proven only by a later Studio-only change.
7. Unexplained, harmless: the Vercel bundle `index-Dm4WYqAd.js` differs from the local `index-DcfItGbI.js` by 24 bytes for the same commit. Vite content-hashes the file, and the build embeds git-derived inventory text. The cause was not isolated.

No blocker was found in the engine, schema, generators or templates, and none was changed.
