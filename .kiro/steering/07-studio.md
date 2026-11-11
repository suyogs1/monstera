---
inclusion: fileMatch
fileMatchPattern: ["studio/**", ".github/workflows/studio-*", "architecture/MONSTERA-STUDIO.md"]
---

# MONSTERA Studio rules

Design: `architecture/MONSTERA-STUDIO.md`. Owner agent: `studio`.

- Studio may use a modern web stack (frontend on Vercel, Python API on Railway). That freedom
  never extends into `apps/*` or `generated/*`.
- The canonical `monstera.spec.json` is the single source of truth. Studio state produces it,
  and Studio holds no configuration the schema can't express.
- No generation or validation logic in Studio: the API imports `tools/monstera`; forms are
  derived from `spec/schema/*.schema.json`.
- The browser never compiles native code. Builds run only on GitHub Actions workers (Linux for
  Android, hosted macOS for the iOS Simulator). No Apple SDK material ever moves to Linux.
- Secrets (GitHub token, any signing material) live only in Railway/GitHub secrets. They never
  appear in the frontend bundle, API responses or logs. Fork pull requests never receive secrets:
  no `pull_request_target`, explicit minimal `permissions:` on every workflow
  (`monstera check-architecture` enforces this).
- Studio hosting and visual polish must not delay G2.
