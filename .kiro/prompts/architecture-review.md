Review the following against MONSTERA's architecture: $ARGUMENTS

Read first: `.kiro/steering/*.md`, `architecture/*.md`, and the active Kiro Spec under `.kiro/specs/`.
Keep the two kinds of spec apart: Kiro Specs (`.kiro/specs/`) describe how we develop;
`monstera.spec.json` describes the generated app.

Check, at minimum:
1. Generated apps stay independent native Kotlin/Swift projects: no Kiro, Python, Studio or
   cross-platform runtime dependency; no web tooling under `apps/`, `generated/`, `reference/`.
2. One source of truth: nothing duplicates data the canonical spec owns; no engine logic is
   copied into Studio, the MCP server or app folders.
3. Generator ownership: generated output changes only through the generator; hand-maintained
   files under `apps/<id>/` are never owned.
4. CI safety: explicit permissions, SHA-pinned actions, no `pull_request_target`, no secrets in PR
   workflows, no Apple SDK material on Linux.
5. Phase scope: nothing belongs to a later phase than the active one.

Name the steering rule or architecture section each finding violates. Separate **violations**
(must fix) from **suggestions** (optional). Do not report style preferences as violations.

Output exactly one table: `| # | Severity (violation/suggestion) | Rule | Location (file:line) | Evidence | Fix |`,
followed by one line: `VIOLATIONS: <n>`.
