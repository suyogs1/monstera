"""Protocol smoke test: start the real server over stdio with the SDK client, list the tools and
call each one. Proves the server speaks MCP, not just that the Python functions work."""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[3]
SERVER = ROOT / "tools" / "monstera-mcp" / "server.py"
EXPECTED_TOOLS = {"validate_spec", "generate_project", "inspect_manifest", "get_device_report"}


def _payload(result) -> dict:
    if getattr(result, "structured_content", None):
        return result.structured_content
    return json.loads(result.content[0].text)


async def _session_run():
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)], cwd=str(ROOT))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            listed = await session.list_tools()
            calls = {
                "validate_spec": await session.call_tool(
                    "validate_spec", {"path": "spec/samples/monstera-sample/monstera.spec.json"}),
                "generate_project": await session.call_tool(
                    "generate_project", {"spec_path": "spec/samples/monstera-sample/monstera.spec.json"}),
                "inspect_manifest": await session.call_tool(
                    "inspect_manifest", {"dir": "generated/monstera-sample"}),
                "get_device_report": await session.call_tool(
                    "get_device_report", {"evidence": "docs/evidence/g1-ios-simulator-ci"}),
                "refused": await session.call_tool("inspect_manifest", {"dir": "../outside"}),
            }
            return init, listed, calls


class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.init, cls.listed, cls.calls = asyncio.run(_session_run())

    def test_server_identity(self) -> None:
        self.assertEqual(self.init.server_info.name, "monstera")

    def test_exactly_the_four_engine_backed_tools(self) -> None:
        self.assertEqual({t.name for t in self.listed.tools}, EXPECTED_TOOLS)

    def test_read_only_annotations(self) -> None:
        by_name = {t.name: t for t in self.listed.tools}
        for name in ("validate_spec", "inspect_manifest", "get_device_report"):
            self.assertTrue(by_name[name].annotations.read_only_hint, name)
        self.assertFalse(by_name["generate_project"].annotations.read_only_hint)

    def test_calls_return_engine_results(self) -> None:
        self.assertTrue(_payload(self.calls["validate_spec"])["valid"])
        gen = _payload(self.calls["generate_project"])
        self.assertEqual(gen["mode"], "check")
        self.assertFalse(gen["written"])
        self.assertTrue(_payload(self.calls["inspect_manifest"])["verify"]["clean"])
        self.assertGreater(_payload(self.calls["get_device_report"])["summary"]["ok"], 0)

    def test_refusal_is_a_tool_error_with_its_reason(self) -> None:
        refused = self.calls["refused"]
        self.assertTrue(refused.is_error)
        self.assertIn("outside the repository", refused.content[0].text)


if __name__ == "__main__":
    unittest.main()
