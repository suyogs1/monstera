"""Adversarial regression tests (G2 review) for the MCP tool layer. Every test here FAILS until the
corresponding fix lands; probe ids refer to .kiro/workflow-output/adversarial/attack.md."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from monstera_mcp import tools  # noqa: E402

SAMPLE = tools.REPO_ROOT / "spec" / "samples" / "boundary-lab" / "monstera.spec.json"


class RunConformanceInputs(unittest.TestCase):
    def test_b1_non_string_platform_entries_are_a_tool_error(self) -> None:
        """B1: wrong-typed arguments must surface as ToolError, never as an unhandled TypeError."""
        for platforms in ([["oracle"]], [1], [None], [{"a": 1}]):
            with self.subTest(platforms=platforms):
                with self.assertRaises(tools.ToolError):
                    tools.run_conformance("generated/boundary-lab", platforms)

    def test_b2_non_string_swift_image_is_a_tool_error(self) -> None:
        """B2: same for swift_image."""
        for image in (5, ["swift:6.1-noble"], {"a": 1}):
            with self.subTest(image=image):
                with self.assertRaises(tools.ToolError):
                    tools.run_conformance("generated/boundary-lab", ["oracle"], image)

    def test_b3_default_run_does_not_claim_a_pass(self) -> None:
        """B3: the default (oracle only) report of the MCP tool must not carry verdict 'pass'."""
        out = tools.run_conformance("generated/boundary-lab")
        self.assertNotEqual(out["report"]["verdict"], "pass")
        self.assertNotIn("PASS", out["summary"][0])

    def test_b4_inline_spec_with_nan_is_reported_not_raised(self) -> None:
        """B4: validate_spec(spec=...) returns issues for any inline value; NaN must not escape as ValueError."""
        spec = json.loads(SAMPLE.read_text(encoding="utf-8"))
        spec["game"]["world"]["width"] = float("nan")
        out = tools.validate_spec(spec=spec)
        self.assertFalse(out["valid"])


if __name__ == "__main__":
    unittest.main()
