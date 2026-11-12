# MONSTERA MCP server

Status: **IMPLEMENTED in G1.5** (`tools/monstera-mcp/`, 20 tests). Live-in-Kiro status: `docs/KIRO-USAGE.md`.

The server gives Kiro structured, typed access to the MONSTERA engine. Today an agent has to shell
out to the CLI and parse its text. With MCP tools it gets schemas, structured results and
per-tool permissions.

## Principles

1. **Adapter only.** Every tool calls existing `tools/monstera` functions. The server contains no
   validation, generation, hashing or manifest logic of its own.
2. **Only tools backed by working functionality.** A tool exists only when the function behind
   it exists and is tested.
3. **Least privilege.** Read-only tools by default; one write path, which obeys the engine's
   ownership rules; no shell, no `--force`; the single exception is `run_conformance`, which starts test builds, is never auto-approved, and runs containers without network and with read-only sources (see Security).

## Tools

| Tool | Backed by (exists today) | Side effects | Kiro approval |
|---|---|---|---|
| `validate_spec` | `validate.validate_path` / `validate_value` | none | auto-approve |
| `generate_project` | `generate.plan` + `generate.check` / `generate.write(force=False)` | writes **only** when `write=true` | ask |
| `inspect_manifest` | `generate.read_manifest` + `generate.verify` | none | auto-approve |
| `get_device_report` | reads Device Lab `report.json` (contract: `device-lab/contract/result.schema.json`) | none | auto-approve |
| `run_conformance` | `conformance.run` (`monstera conformance`) | none to the repository; starts Gradle / a Swift container; `platforms` defaults to `oracle`; `swift_image` must be an official `swift:<version>` tag | ask (added in G2) |
| `build_native_app` | Studio build dispatch / Device Lab `build` op | builds; may dispatch CI | **added in G4**, when dispatch exists |

### `validate_spec`

```json
{
  "input": {
    "type": "object", "additionalProperties": false,
    "oneOf_note": "exactly one of path / spec",
    "properties": {
      "path": { "type": "string", "description": "Repository-relative path to a monstera.spec.json" },
      "spec": { "type": "object", "description": "Inline candidate spec (not written anywhere)" }
    }
  },
  "output": {
    "valid": "boolean",
    "sha256": "string|null (canonical spec SHA-256 when valid)",
    "canonical": "boolean (path only: file bytes are already canonical)",
    "issues": [{ "path": "string", "code": "string", "message": "string" }]
  }
}
```

`issues` are exactly the engine's issues: same order, same text as `monstera validate`.

### `generate_project`

```json
{
  "input": {
    "type": "object", "additionalProperties": false, "required": ["spec_path"],
    "properties": {
      "spec_path": { "type": "string" },
      "out": { "type": "string", "description": "Default: generated/<project.id> (G3: apps/<id>)" },
      "write": { "type": "boolean", "default": false, "description": "false = dry run (check only)" }
    }
  },
  "output": {
    "spec_sha256": "string",
    "files": "integer",
    "mode": "check|write",
    "drift": { "changed": ["path"], "missing": ["path"], "unexpected": ["path"] },
    "written": "boolean",
    "refused": "string|null (engine OutputError text when write was refused)"
  }
}
```

- An invalid spec returns the validation issues and doesn't generate.
- `write=true` calls `generate.write(..., force=False)`. Hand edits, unmanaged files, symlinks,
  another project's output and non-owned directories are refused exactly as in the CLI. **There
  is no force parameter.** Discarding hand edits is a deliberate human action through the CLI.
- This server is the one sanctioned writer to generator-owned paths besides the CLI. The
  `guard-generated-output` hook keeps blocking *file-tool* edits there; it doesn't apply to MCP
  tool calls, which go through the engine's checks.

### `inspect_manifest`

```json
{
  "input": { "type": "object", "additionalProperties": false, "required": ["dir"],
             "properties": { "dir": { "type": "string" } } },
  "output": {
    "generator": { "name": "string", "version": "string" },
    "spec": { "path": "string", "projectId": "string", "sha256": "string" },
    "schemas": { "<file>": "sha256" },
    "toolchain": "object",
    "file_count": "integer",
    "files_by_kind": { "template": "integer", "static": "integer", "model": "integer", "spec": "integer" },
    "verify": { "clean": "boolean", "changed": ["path"], "missing": ["path"], "unexpected": ["path"] }
  }
}
```

### `get_device_report`

```json
{
  "input": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "run_id": { "type": "string", "description": "device-lab/reports/runs/<run_id>/" },
      "evidence": { "type": "string", "description": "or a docs/evidence/<dir>/ containing report.json" },
      "target": { "enum": ["android-emulator", "android-device", "ios-simulator", "ios-device"] }
    }
  },
  "output": {
    "source": "string (resolved report path)",
    "results": [{ "op": "string", "target": "string", "status": "ok|failed|unsupported",
                  "run_id": "string", "timestamp": "string", "artifact": "string?", "detail": "string?" }],
    "summary": { "ok": "integer", "failed": "integer", "unsupported": "integer" },
    "invalid_lines": "integer (lines not matching result.schema.json)"
  }
}
```

With neither `run_id` nor `evidence`, it lists the available runs (newest first, capped at 20).

## Implementation

| Item | Choice |
|---|---|
| Location | `tools/monstera-mcp/`: `pyproject.toml`, `uv.lock`, `monstera_mcp/server.py`, `tests/` |
| SDK | Official MCP Python SDK, **pinned exactly** (latest on PyPI at design time: `mcp==2.3.0`; the exact API is confirmed when implementing). Locked with `uv.lock` |
| Isolation | The engine stays stdlib-only. Only `tools/monstera-mcp/` has dependencies; it imports `tools/monstera` by path |
| Transport | stdio |
| Runtime | `uv` (installed on dev machines; `astral-sh/setup-uv` pinned by SHA in CI) |

Proposed `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "monstera": {
      "command": "uv",
      "args": ["run", "--frozen", "--project", "tools/monstera-mcp", "python", "tools/monstera-mcp/server.py"],
      "disabled": false,
      "autoApprove": ["validate_spec", "inspect_manifest", "get_device_report"]
    }
  }
}
```

`generate_project` is deliberately absent from `autoApprove`. If `uv` turns out not to resolve
relative paths from the workspace root under Kiro on Windows, the fallback is the same
`git -c alias…` wrapper pattern the hooks use. Either way, the result is verified during implementation.

## Security

| Concern | Control |
|---|---|
| Path traversal | Every path argument is resolved and must be inside the repository root. Specs only under `spec/` or `apps/*/monstera.spec.json`; outputs only under `generated/` or `apps/<id>/`; reports only under `device-lab/reports/runs/` or `docs/evidence/`. Symlinks are refused |
| Destructive writes | Write only through `generate.write(force=False)`; no force anywhere in the server |
| Command execution | Only `run_conformance` spawns processes: `gradlew` (Kotlin unit tests) and `docker run` / `swift test` (Swift). Arguments are never shell-interpolated; `platforms` is a fixed set and `swift_image` must match an official `swift:<version>` tag (or `toolchain`). Reviewed in G2 (adversarial review, 2026-11-11). `build_native_app`, when added, gets its own review |
| Network | The server opens none. `run_conformance` may make Docker pull the pinned Swift image if it is absent; the test container itself runs with `--network none`, the package mounted read-only (`:ro`) and only a results directory writable |
| Resource use | Inline spec size cap (64 KiB); report results capped; JSON depth limits come from the engine loader |
| Secrets | The server reads no environment secrets and never returns file contents outside its declared outputs |
| Supply chain | One pinned dependency tree in `uv.lock`, reviewed with the `security-dependency-review` prompt |

## Tests

1. **Unit tests**: each tool handler called directly against fixtures. Results must equal the CLI
   for the same input (identical issues, SHA-256, drift lists).
2. **Protocol smoke test**: start the server over stdio with the SDK's client, then `initialize`,
   `tools/list` (exactly the five tools, with their schemas) and one `tools/call` per tool.
3. **Security tests**: a path outside the repo, `../` traversal, a symlink, an oversized inline
   spec, and `write=true` against a hand-edited tree must all be refused.
4. **Live Kiro check**: Kiro lists the server's tools and an agent calls `validate_spec`. Recorded
   in `docs/KIRO-USAGE.md`.

CI: a `mcp` job runs tests 1–3 on Linux with `uv`.

## Gate for adding tools

A tool may be added only when all three hold:
- The function behind it is merged and tested.
- The tool's contract is documented here.
- Its permission class is decided (auto-approve, ask, or not exposed).
