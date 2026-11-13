"""K0: the Kiro configuration that lets Kiro author MONSTERA games stays consistent with the repository.
SDK-free. These tests live here, not in tools/monstera, so the engine stays untouched by the Kiro layer."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
KIRO = ROOT / ".kiro"


def load(rel: str) -> dict:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def property_names(node, found: set[str]) -> set[str]:
    if isinstance(node, dict):
        for name, sub in node.get("properties", {}).items():
            found.add(name)
            property_names(sub, found)
        for sub in node.get("$defs", {}).values():
            property_names(sub, found)
        if "items" in node:
            property_names(node["items"], found)
    return found


class AuthoringSteeringTests(unittest.TestCase):
    text = (KIRO / "steering" / "10-game-authoring.md").read_text(encoding="utf-8")

    def test_every_spec_field_is_documented(self) -> None:
        names: set[str] = set()
        for schema in ("project.schema.json", "game.schema.json"):
            property_names(load(f"spec/schema/{schema}"), names)
        missing = sorted(n for n in names if f"`{n}`" not in self.text)
        self.assertEqual(missing, [], "steering 10 must name every schema property so it cannot drift from the contract")

    def test_loads_for_spec_files_and_names_the_tools(self) -> None:
        self.assertIn("fileMatchPattern", self.text.split("---")[1])
        self.assertIn("monstera.spec.json", self.text.split("---")[1])
        for tool in ("engine_info", "validate_spec", "generate_project", "run_conformance", "inspect_manifest"):
            self.assertIn(tool, self.text)

    def test_states_the_boundaries(self) -> None:
        for phrase in ("spec/samples/<id>", "generated/<id>", "Never add a game there", "never by hand", "Do not change `tools/monstera/`"):
            self.assertIn(phrase, self.text)


class AgentConfigTests(unittest.TestCase):
    def test_game_author_is_scoped(self) -> None:
        agent = load(".kiro/agents/game-author.json")
        self.assertIn("@monstera", agent["tools"])
        rules = agent["permissions"]["rules"]
        allowed = {m for r in rules if r["effect"] == "allow" and r["capability"] == "fs_write" for m in r["match"]}
        denied = {m for r in rules if r["effect"] == "deny" and r["capability"] == "fs_write" for m in r["match"]}
        self.assertEqual(allowed, {"spec/samples/**", "spec/scenarios/**"})
        for protected in ("generated/**", "apps/**", "tools/**", "spec/schema/**"):
            self.assertIn(protected, denied)
        self.assertIn("09-value-for-credit", agent["prompt"])
        self.assertIn("10-game-authoring.md", " ".join(agent["resources"]))
        self.assertNotIn("allowedTools", agent, "current agent schema uses permissions, not the CLI 2.x allowedTools")

    def test_studio_agent_describes_the_static_architecture(self) -> None:
        text = json.dumps(load(".kiro/agents/studio.json"))
        for stale in ("Railway", "GitHub Actions workers", "dispatched", "Python API"):
            self.assertNotIn(stale, text)
        self.assertIn("Pyodide", text)
        self.assertIn("never claim that Studio has a Kiro connection", text)

    def test_project_agent_delegates_game_requests(self) -> None:
        self.assertIn("game-author", load(".kiro/agents/monstera.json")["prompt"])


class McpAndHookConfigTests(unittest.TestCase):
    def test_auto_approval_is_read_only_only(self) -> None:
        approved = set(load(".kiro/settings/mcp.json")["mcpServers"]["monstera"]["autoApprove"])
        self.assertEqual(approved, {"validate_spec", "engine_info", "inspect_manifest", "get_device_report"})

    def test_spec_saves_also_check_scenarios(self) -> None:
        hook = load(".kiro/hooks/scenario-validate-on-save.json")["hooks"][0]
        matcher = re.compile(hook["matcher"])
        for path in ("spec/scenarios/x/a.scenario.json", "spec/samples/lantern-run/monstera.spec.json", "apps/pumpkin-blaster/monstera.spec.json"):
            self.assertTrue(matcher.search(path), path)
        self.assertFalse(matcher.search("spec/schema/game.schema.json"))
        self.assertIn("--oracle", hook["action"]["command"])
        self.assertNotIn("record", hook["action"]["command"], "the hook must never rewrite checkpoints")

    def test_create_game_prompt_exists_and_points_at_the_steering(self) -> None:
        text = (KIRO / "prompts" / "create-game.md").read_text(encoding="utf-8")
        for needle in ("engine_info", "10-game-authoring.md", "scenarios record", "files=true", "spec/samples/<id>"):
            self.assertIn(needle, text)


if __name__ == "__main__":
    unittest.main()
