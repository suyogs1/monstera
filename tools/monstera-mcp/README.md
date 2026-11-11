# monstera-mcp

MCP server exposing the MONSTERA engine to Kiro. It's an adapter only: every tool calls an
existing `tools/monstera` function. Design and tool contracts: `architecture/MONSTERA-MCP.md`.

| Tool | Engine function | Writes |
|---|---|---|
| `validate_spec` | `validate_path` / `validate_value` | no |
| `generate_project` | `generate.plan` + `check` / `write(force=False)` | only with `write=true` |
| `inspect_manifest` | `read_manifest` + `verify` | no |
| `get_device_report` | Device Lab `report.json` reader | no |

```bash
# Kiro starts it from .kiro/settings/mcp.json; to run it by hand:
uv run --frozen --project tools/monstera-mcp python tools/monstera-mcp/server.py

# Tests (parity with the CLI, security refusals, real stdio protocol session):
uv run --frozen --project tools/monstera-mcp python -m unittest discover -s tools/monstera-mcp/tests -t tools/monstera-mcp
```

Dependencies: `mcp==2.3.0`, with the full tree locked in `uv.lock`. The engine itself stays
standard-library only.
