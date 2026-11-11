# Specification engine (G1)

Design: `architecture/SPECIFICATION-ENGINE.md`. CLI: `tools/monstera/bin/monstera` (Python 3.10+, stdlib only).

- One canonical `monstera.spec.json` per project is the only source of truth for generated code.
  Its format is `spec/schema/monstera.spec.schema.json` (+ `project.schema.json`, `game.schema.json`).
- Change order: schema contract -> emitters/generator -> platform templates -> regenerate.
  Platform work must not start against an unmerged contract change.
- Never edit `generated/` by hand (a PreToolUse hook blocks it). Run
  `monstera generate <spec>` and commit the result; CI runs `generate --check`.
- Every schema property is required and `additionalProperties` is false: no hidden defaults.
- Schema object/enum `title` = generated Kotlin/Swift type name. New schema keywords need
  validator support first; unsupported keywords fail at load.
- Platform-specific values belong in `project.platforms.<platform>` and only when no shared
  equivalent exists. Do not duplicate a shared value per platform.
- Toolchain versions for generated projects are pinned in `tools/monstera/monstera/toolchain.json`.
- Generator output must be deterministic: no timestamps, sorted manifest, LF (CRLF only for
  `.bat`), fixed file modes.
