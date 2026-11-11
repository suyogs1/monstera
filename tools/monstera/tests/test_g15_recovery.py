"""G1.5 review follow-up: the guard self-lock incident and genuine findings not covered by
tests.patch (classification: docs/G15-REVIEW-TRIAGE.md)."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from monstera import archcheck, cli, generate
from monstera.schema import SchemaStore

REPO = Path(__file__).resolve().parents[3]
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
ENTRY = REPO / "tools" / "monstera" / "monstera.py"


def run_guard(path: str) -> subprocess.CompletedProcess:
    """Run the guard exactly as the PreToolUse hook does: a fresh interpreter on stdin JSON."""
    payload = json.dumps({"toolName": "str_replace", "toolInput": {"path": path}})
    return subprocess.run([sys.executable, str(ENTRY), "guard-generated"], input=payload,
                          capture_output=True, text=True, cwd=REPO)


class GuardSelfLockTests(unittest.TestCase):
    """Incident: a NameError inside the guard was caught and turned into "block", for every path,
    so the edit that fixed the guard was itself blocked."""

    def test_hook_process_allows_source_edits_and_blocks_generated(self) -> None:
        source = run_guard("tools/monstera/monstera/cli.py")
        self.assertEqual(source.returncode, 0, source.stderr)
        self.assertNotIn("guard error", source.stderr)
        owned = run_guard("generated/monstera-sample/README.md")
        self.assertEqual(owned.returncode, 2, owned.stderr)

    def test_guard_crash_does_not_lock_unrelated_files(self) -> None:
        with mock.patch.object(cli, "generator_owned", side_effect=NameError("os")):
            cases = {
                "tools/monstera/monstera/cli.py": 0,          # the guard's own source stays editable
                "README.md": 0,
                "generated/monstera-sample/README.md": 2,     # owned output stays protected
                "apps/x/android/app/build.gradle.kts": 2,
                "apps/x/MONSTERA-MANIFEST.json": 2,
                "\\\\server\\share\\x": 2,
            }
            for path, expected in cases.items():
                with self.subTest(path):
                    payload = json.dumps({"toolInput": {"path": path}})
                    with mock.patch("sys.stdin", __import__("io").StringIO(payload)), \
                            mock.patch("sys.stderr", __import__("io").StringIO()):
                        self.assertEqual(cli.cmd_guard_generated(None, None), expected)  # type: ignore[arg-type]


class OwnershipFollowUpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(REPO / "spec" / "schema")

    def test_user_data_in_a_replaced_guidance_path_survives_force(self) -> None:
        """probe 1.11: the guidance file replaced by a user directory; --force deleted its contents."""
        spec = json.loads(SAMPLE.read_text(encoding="utf-8"))
        files = generate.plan(spec, "apps/monstera-sample/monstera.spec.json", self.store, layout="app")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            generate.write(files, root)
            guidance = root / generate.GUIDANCE_FILE
            guidance.unlink()
            guidance.mkdir()
            (guidance / "mine.txt").write_text("mine", encoding="utf-8")
            with self.assertRaises(generate.OutputError):
                generate.write(files, root, force=True)
            self.assertTrue((guidance / "mine.txt").exists())


class CiFollowUpTests(unittest.TestCase):
    SHA = "a" * 40

    def scan(self, rel: str, text: str) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, rel)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            return [str(v) for v in archcheck.check(Path(tmp))]

    def wf(self, on: str, permissions: str = "permissions:\n  contents: read\n", run: str = "echo hi") -> str:
        return (f"name: ci\non: {on}\n{permissions}jobs:\n  b:\n    runs-on: x\n    steps:\n"
                f"      - uses: actions/checkout@{self.SHA}\n      - run: {run}\n")

    def test_workflow_run_with_secrets_is_flagged(self) -> None:
        """probe 6.04[workflow_run] (filed as NOTE, genuine): workflow_run runs with secrets after a fork PR."""
        self.assertTrue(self.scan(".github/workflows/w.yml",
                                  self.wf("workflow_run", run="echo ${{ secrets.DEPLOY }}")))

    def test_github_token_in_any_case_is_not_a_secret_finding(self) -> None:
        """probe 6.04[github_token lower] false positive."""
        self.assertEqual(self.scan(".github/workflows/w.yml",
                                   self.wf("pull_request", run="echo ${{ secrets.github_token }}")), [])

    def test_broad_permissions_are_flagged(self) -> None:
        """probe 6.02 variants: write-all, empty block, write scope in a flow map."""
        for name, perms in (("write-all", "permissions: write-all\n"), ("empty", "permissions:\n"),
                            ("flow write", "permissions: {contents: write}\n"),
                            ("block write", "permissions:\n  contents: write\n")):
            with self.subTest(name):
                self.assertTrue(self.scan(".github/workflows/w.yml", self.wf("push", permissions=perms)))

    def test_upper_case_extension_and_root_action_are_scanned(self) -> None:
        """probes 6.06[.YML], 6.03[root action.yml]."""
        self.assertTrue(self.scan(".github/workflows/EVIL.YML", self.wf("push", permissions="")))
        self.assertTrue(self.scan("action.yml", "runs:\n  using: composite\n  steps:\n    - uses: evil/x@main\n"))

    def test_remaining_spelling_variants_from_the_probe_log(self) -> None:
        """6.03[merge-key], 6.04[not-first, mixed case], 6.05[tar/scp/rsync/via var/script]."""
        cases = {
            "merge-key": "x: &a\n  uses: actions/checkout@v4\n" + self.wf("push"),
            "not-first": self.wf("pull_request", run="echo ${{ !secrets.K }}"),
            "mixed case": self.wf("pull_request", run="echo ${{ Secrets.K }}"),
            "tar sdk": self.wf("push", run='tar czf s.tgz "$(xcrun --show-sdk-path)"'),
            "scp platform": self.wf("push", run="scp -r /Applications/Xcode.app/Contents u@l:/o/"),
            "via var": self.wf("push", run="XT=xtool; $XT sdk build Xcode.app out"),
            "script arg": self.wf("push", run="bash tools/xtool/linux-build.sh Xcode.xip"),
        }
        for name, text in cases.items():
            with self.subTest(name):
                self.assertTrue(self.scan(".github/workflows/w.yml", text))

    def test_repository_ci_files_pass(self) -> None:
        self.assertEqual([v for v in archcheck.check(REPO) if v.path.startswith((".github/", "action."))], [])


class RobustnessTests(unittest.TestCase):
    def test_kirocheck_reports_malformed_config_instead_of_crashing(self) -> None:
        """probe 7.01."""
        from monstera import kirocheck
        with tempfile.TemporaryDirectory() as tmp:
            hooks = Path(tmp, ".kiro", "hooks")
            hooks.mkdir(parents=True)
            (hooks / "h.json").write_text(json.dumps({"hooks": ["not-an-object"]}), encoding="utf-8")
            problems = kirocheck.check(Path(tmp))
            self.assertTrue(any("malformed" in p for p in problems), problems)

    def test_mcp_config_must_not_auto_approve_writes(self) -> None:
        """review issue 21: generate_project must always ask."""
        from monstera import kirocheck
        with tempfile.TemporaryDirectory() as tmp:
            settings = Path(tmp, ".kiro", "settings")
            settings.mkdir(parents=True)
            (settings / "mcp.json").write_text(json.dumps({"mcpServers": {"monstera": {
                "command": "uv", "autoApprove": ["validate_spec", "generate_project"]}}}), encoding="utf-8")
            self.assertTrue(any("must not auto-approve" in p for p in kirocheck.check(Path(tmp))))


if __name__ == "__main__":
    unittest.main()
