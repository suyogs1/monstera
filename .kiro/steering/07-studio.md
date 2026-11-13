---
inclusion: fileMatch
fileMatchPattern: ["studio/**", ".github/workflows/studio-*", "architecture/MONSTERA-STUDIO.md", ".kiro/specs/g4-studio/**"]
---
# MONSTERA Studio rules

Design: `.kiro/specs/g4-studio/` (requirements, design, tasks). `architecture/MONSTERA-STUDIO.md` is superseded where it
describes a Railway API, Postgres or build dispatch. Owner agent: `studio`.

- Studio is a **static web app** (Vite, React, TypeScript; Vercel). There is no backend, no account, no server-side secret and
  no build dispatch. The browser never compiles native code.
- The unmodified engine (`tools/monstera`, `spec/schema`) runs in a Pyodide Web Worker (M0 proved it). Studio holds no
  validation, generation or simulation logic and never edits `tools/monstera`, `spec/schema`, templates or generated output.
- The canonical `monstera.spec.json` is the single source of truth and the only contract with Kiro: Studio imports and exports it.
  Studio holds no configuration the schema cannot express. Forms derive from `spec/schema/*.schema.json`; values show in game
  units while the spec keeps raw Q16.16 integers.
- Developer Integration is a **static inventory** of the repository (MCP tools, agents, hooks, workflows, steering, stamped with
  the commit) plus copyable prompts and a handoff recipe. It never claims, simulates or probes a Kiro connection.
- No chatbot in Studio. Studio freedom (modern web stack) never extends into `apps/*` or `generated/*`.
- Pin every dependency exactly. Hosting and visual polish must not delay Kiro integration work.