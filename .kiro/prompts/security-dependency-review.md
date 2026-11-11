Security and dependency review of: $ARGUMENTS (a path, a branch, or a PR).

1. **Dependency inventory.** List every dependency the change adds or changes: Gradle (versions in
   `tools/monstera/monstera/toolchain.json`), SwiftPM, `tools/monstera-mcp/uv.lock`, Studio
   package manifests, and GitHub Actions. For each one give: name, exact version or SHA, why it
   is needed, and its licence.
   Flag anything that is unpinned, uses a range, is unmaintained, or has a typosquat-like name.
2. **Secrets.** No credential in source, workflows, logs, frontend bundles or API responses.
   GitHub/Railway/Vercel tokens are server-side only. No Apple signing material or Apple SDK
   files are committed or moved to Linux.
3. **CI.**
   - Every workflow has explicit minimal `permissions:` and no `pull_request_target`.
   - Actions are pinned by SHA.
   - No secrets are used in `pull_request` workflows.
   - Artifacts contain evidence only (no `.app`, no SDKs).
4. **Injection boundaries.**
   - Spec strings into Kotlin/Swift/XML/plist go through the schema patterns and the emitter
     escaping.
   - User input reaches no shell command.
   - Paths are confined: MCP tools, Studio uploads, `--out`.
5. **Data handling.** Uploaded assets: type and size limits, stored by hash, never executed.

Run `monstera check-architecture` and include its output.

Output a findings table `| # | Severity (critical/high/medium/low) | Area | Location | Evidence | Fix |`,
then the dependency inventory table, then `BLOCKERS: <n>` (critical + high).
