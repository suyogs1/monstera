---
inclusion: fileMatch
fileMatchPattern: ["studio/**", ".github/workflows/studio-*", "architecture/MONSTERA-STUDIO.md", ".kiro/specs/g4-studio/**"]
---
# MONSTERA Studio rules

Design: `.kiro/specs/g4-studio/` (requirements, design, tasks). `architecture/MONSTERA-STUDIO.md` describes the implemented static architecture (rewritten in M3-A). Owner agent: `studio`.

- Studio is a **static web app** (Vite, React, TypeScript; Vercel). There is no backend, no account, no server-side secret and
  no build dispatch. The browser never compiles native code.
- The unmodified engine (`tools/monstera`, `spec/schema`) runs in a Pyodide Web Worker (M0 proved it). The engine stays
  authoritative for the canonical v4 specification, its validation, deterministic simulation and generation. Studio holds no
  copy of those semantics and never edits `tools/monstera`, `spec/schema`, templates or generated output.
- The canonical `monstera.spec.json` is the single source of truth for the generated native apps and the only contract with
  the engine and Kiro: Studio imports and exports it. Forms for the spec derive from `spec/schema/*.schema.json`; values show
  in game units while the spec keeps raw Q16.16 integers.
- **Studio-owned sidecar manifests** (Studio Foundry, `.kiro/specs/studio-foundry/`) are allowed for: project configuration,
  gameplay, assets and atlases, animations, levels, and integrations and monetization. Each is versioned
  (`monstera.studio.<name>` plus an integer `version`), has a JSON Schema under `studio/schemas/`, and is validated in
  TypeScript at runtime with the engine's discipline (every property required, no additional properties, unsupported keywords
  fail at load, integers for game quantities). Studio is the authority for these manifests only.
- **Compile, then let the engine decide.** A sidecar capability that schema v4 can express is compiled into the v4 spec by a
  pure function, only on explicit user action (derivation is off by default, and the derived diff and engine verdict are shown before the user accepts). The unmodified engine then validates and simulates the result; nothing is committed to the spec until it
  passes. Studio never re-implements engine rules (collision, scoring, ticks, RNG, spec validation) in TypeScript to predict
  or replace an engine answer. Capabilities v4 cannot express are Studio-only, scaffolding or mock and are labelled as such
  (statuses: implemented, prototype, mock, planned, unsupported). Every module states whether it reaches native output.
- No engine, schema or template change is made for Studio Foundry before G6 is closed. Any such change is an engine-track item
  that needs an explicit owner decision.
- Developer Integration is a **static inventory** of the repository (MCP tools, agents, hooks, workflows, steering, stamped with
  the commit) plus copyable prompts and a handoff recipe. It never claims, simulates or probes a Kiro connection.
- No chatbot in Studio. Studio freedom (modern web stack) never extends into `apps/*` or `generated/*`.
- Pin every dependency exactly. Hosting and visual polish must not delay Kiro integration work.