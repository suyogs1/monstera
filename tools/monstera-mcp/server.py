"""MONSTERA MCP server (stdio). Run:
    uv run --frozen --project tools/monstera-mcp python tools/monstera-mcp/server.py

Registers exactly the four engine-backed tools (architecture/MONSTERA-MCP.md). Adding a tool
requires a merged, tested engine function and a documented contract first.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import functools  # noqa: E402

from mcp.server.mcpserver import MCPServer  # noqa: E402
from mcp.server.mcpserver.exceptions import ToolError as SdkToolError  # noqa: E402
from mcp.types import ToolAnnotations  # noqa: E402

from monstera_mcp import tools  # noqa: E402


def _refusals_as_tool_errors(fn):
    """A refused request (bad path, invalid arguments) is an anticipated failure: the client gets
    the reason, not a generic crash message."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except tools.ToolError as exc:
            raise SdkToolError(str(exc)) from None
    return wrapper

server = MCPServer(
    name="monstera",
    version="0.1.0",
    instructions=(
        "Structured access to the MONSTERA engine. These tools validate MONSTERA canonical "
        "specifications (monstera.spec.json), not Kiro Specs. generate_project is a dry run unless "
        "write=true, and it never overrides the generator's ownership rules."
    ),
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITES = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)


@server.tool(annotations=READ_ONLY)
@_refusals_as_tool_errors
def validate_spec(path: str | None = None, spec: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate a MONSTERA canonical specification with the engine.

    Give exactly one of: `path` (repository-relative monstera.spec.json under spec/ or apps/<id>/)
    or `spec` (an inline candidate object, not written anywhere). Returns valid, the canonical
    SHA-256 when valid, whether the file is already canonical, and the engine's issues (same
    order and text as `monstera validate`).
    """
    return tools.validate_spec(path=path, spec=spec)


@server.tool(annotations=WRITES)
@_refusals_as_tool_errors
def generate_project(spec_path: str, out: str | None = None, write: bool = False) -> dict[str, Any]:
    """Generate native Android and iOS projects from a canonical spec.

    Default is a dry run (write=false): reports drift against the output directory without
    writing. With write=true, writes through the engine's ownership rules (never forced): hand
    edits, unmanaged files, symlinks and non-owned directories are refused and reported in
    `refused`. Default output: apps/<id>/ for apps/<id>/monstera.spec.json, else generated/<id>/.
    """
    return tools.generate_project(spec_path=spec_path, out=out, write=write)


@server.tool(annotations=READ_ONLY)
@_refusals_as_tool_errors
def inspect_manifest(dir: str) -> dict[str, Any]:  # noqa: A002 - contract name
    """Summarize a generated directory's MONSTERA-MANIFEST.json (generator, spec SHA-256, layout,
    owned roots, schema digests, toolchain, file counts by kind) and verify the directory
    against it (changed / missing / unexpected files). `dir` is under generated/ or apps/."""
    return tools.inspect_manifest(dir=dir)


@server.tool(annotations=READ_ONLY)
@_refusals_as_tool_errors
def get_device_report(run_id: str | None = None, evidence: str | None = None,
                      target: str | None = None) -> dict[str, Any]:
    """Read a Device Lab report. `run_id` = device-lab/reports/runs/<run_id>/ (optionally one
    `target`: android-emulator, android-device, ios-simulator, ios-device), or `evidence` = a
    docs/evidence/<dir>/ containing report.json. With neither, lists the newest local runs.
    Only lines matching device-lab/contract/result.schema.json are returned."""
    return tools.get_device_report(run_id=run_id, evidence=evidence, target=target)


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
