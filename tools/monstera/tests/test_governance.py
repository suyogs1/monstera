"""Value-for-credit governance: config validation, the effort log, honesty about credits."""
from __future__ import annotations
import json
import tempfile
import unittest
from pathlib import Path
from monstera import effort, kirocheck

REPO = Path(__file__).resolve().parents[3]


class GovernanceTests(unittest.TestCase):
    def test_committed_config_is_valid_and_all_profiles_defined(self) -> None:
        data = json.loads((REPO / ".kiro" / "governance.json").read_text(encoding="utf-8"))
        self.assertEqual(effort.validate_governance(data), [])
        self.assertEqual(set(data["profiles"]), {"lean", "balanced", "thorough"})

    def test_invalid_configs_are_reported(self) -> None:
        good = json.loads((REPO / ".kiro" / "governance.json").read_text(encoding="utf-8"))
        for mutate in (lambda d: d.update(active="missing"),
                       lambda d: d["profiles"]["lean"].update(ciWaitMinutes=0),
                       lambda d: d["profiles"]["lean"].update(ciWaitMinutes=True),
                       lambda d: d["profiles"]["lean"].pop("gatesCadence"),
                       lambda d: d.update(version=2)):
            bad = json.loads(json.dumps(good))
            mutate(bad)
            self.assertTrue(effort.validate_governance(bad))
        self.assertTrue(effort.validate_governance([]))

    def test_every_agent_references_the_policy(self) -> None:
        for path in (REPO / ".kiro" / "agents").glob("*.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("09-value-for-credit", data["prompt"], path.name)

    def test_kiro_config_gate_passes(self) -> None:
        self.assertEqual(kirocheck.check(REPO), [])

    def test_effort_log_and_report_never_invent_credits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            effort.append(root, "wait", 30, "ci")
            effort.append(root, "retry", 0, "docker")
            text = effort.report(root, None)
            self.assertIn("wait: 1 entries, 30 s", text)
            self.assertIn("retry: 1 entries", text)
            self.assertIn("not available", text)
            self.assertNotRegex(text.lower(), r"\bsaved\b|\$\d")
            with self.assertRaises(ValueError):
                effort.append(root, "credits", 1, "")
            with self.assertRaises(ValueError):
                effort.append(root, "wait", -1, "")


if __name__ == "__main__":
    unittest.main()
