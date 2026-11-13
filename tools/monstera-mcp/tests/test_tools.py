"""Tool parity (same answers as the engine/CLI) and security refusals. SDK-free."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from monstera_mcp import tools  # noqa: E402
from monstera import generate  # noqa: E402  (importable once tools is loaded)
from monstera.validate import validate_path  # noqa: E402

ROOT = tools.REPO_ROOT
SAMPLE_REL = "spec/samples/monstera-sample/monstera.spec.json"
SAMPLE = ROOT / SAMPLE_REL


class ParityTests(unittest.TestCase):
    def test_validate_matches_engine(self) -> None:
        engine = validate_path(SAMPLE, tools.store())
        out = tools.validate_spec(path=SAMPLE_REL)
        self.assertEqual((out["valid"], out["sha256"], out["canonical"]), (True, engine.sha256, True))

    def test_inline_invalid_spec_issues_match_engine(self) -> None:
        spec = json.loads(SAMPLE.read_text(encoding="utf-8"))
        spec["game"]["orientation"] = "portait"
        out = tools.validate_spec(spec=spec)
        self.assertFalse(out["valid"])
        self.assertEqual(out["issues"][0]["code"], "enum")
        self.assertIn("did you mean 'portrait'", out["issues"][0]["message"])

    def test_generate_dry_run_matches_cli_check(self) -> None:
        out = tools.generate_project(SAMPLE_REL)
        self.assertEqual(out["mode"], "check")
        self.assertEqual(out["out"], "generated/monstera-sample")
        self.assertEqual(out["drift"], {"changed": [], "missing": [], "unexpected": []})
        self.assertFalse(out["written"])

    def test_inspect_manifest_matches_verify(self) -> None:
        out = tools.inspect_manifest("generated/monstera-sample")
        manifest = generate.read_manifest(ROOT / "generated" / "monstera-sample")
        self.assertEqual(out["file_count"], len(manifest["files"]))
        self.assertEqual(out["spec"]["sha256"], manifest["spec"]["sha256"])
        self.assertTrue(out["verify"]["clean"])

    def test_inspect_manifest_lists_files_with_kind_and_source_on_request(self) -> None:
        plain = tools.inspect_manifest("generated/monstera-sample")
        self.assertNotIn("files", plain)
        out = tools.inspect_manifest("generated/monstera-sample", files=True)
        manifest = generate.read_manifest(ROOT / "generated" / "monstera-sample")
        self.assertEqual(out["files"], [{"path": e["path"], "kind": e["kind"], "source": e["source"]}
                                        for e in manifest["files"]])
        by_path = {f["path"]: f for f in out["files"]}
        presentation = [p for p in by_path if p.endswith("presentation/Presentation.kt")]
        self.assertEqual(len(presentation), 1)
        self.assertEqual(by_path[presentation[0]]["kind"], "template")
        self.assertTrue(by_path[presentation[0]]["source"].endswith("Presentation.kt.tmpl"))

    def test_engine_info_reports_the_engine_and_detects_staleness(self) -> None:
        info = tools.engine_info()
        self.assertEqual(info["generator"]["name"], "monstera-generator")
        self.assertEqual(info["spec_version"], 4)
        self.assertEqual(info["schema_digests"], tools.store().digests())
        self.assertFalse(info["stale"])
        # A schema that changed after this process loaded it makes the report stale.
        saved = dict(tools._loaded_digests)
        try:
            tools._loaded_digests["game.schema.json"] = "0" * 64
            stale = tools.engine_info()
            self.assertTrue(stale["stale"])
            self.assertEqual(stale["schemas_changed_since_start"], ["game.schema.json"])
            self.assertIn("Reconnect", stale["advice"])
        finally:
            tools._loaded_digests.clear()
            tools._loaded_digests.update(saved)
        # Engine files edited after the process started do the same.
        original = tools._STARTED
        try:
            tools._STARTED = 0.0
            self.assertTrue(tools.engine_info()["engine_files_newer_than_start"])
        finally:
            tools._STARTED = original

    def test_inspect_manifest_files_stay_confined(self) -> None:
        with self.assertRaises(tools.ToolError):
            tools.inspect_manifest("../outside", files=True)

    def test_device_report_reads_committed_evidence(self) -> None:
        out = tools.get_device_report(evidence="docs/evidence/g1-ios-simulator-ci")
        self.assertEqual(out["source"], "docs/evidence/g1-ios-simulator-ci/report.json")
        self.assertEqual(out["invalid_lines"], 0)
        self.assertGreater(out["summary"]["ok"], 0)

    def test_device_report_lists_runs_without_arguments(self) -> None:
        self.assertIn("available_runs", tools.get_device_report())


class SecurityTests(unittest.TestCase):
    def assertRefused(self, fn, *args, **kwargs) -> None:
        with self.assertRaises(tools.ToolError):
            fn(*args, **kwargs)

    def test_path_traversal_and_absolute_paths(self) -> None:
        for bad in ("../outside/monstera.spec.json", "spec/../../etc/passwd", str(SAMPLE), "/etc/passwd",
                    "C:\\Windows\\win.ini", "", "spec/\x00x"):
            with self.subTest(bad):
                self.assertRefused(tools.validate_spec, path=bad)

    def test_spec_paths_outside_spec_and_apps_refused(self) -> None:
        for bad in ("README.md", "tools/monstera/monstera/toolchain.json", "apps/x/assets/monstera.spec.json"):
            with self.subTest(bad):
                self.assertRefused(tools.validate_spec, path=bad)

    def test_output_outside_generated_and_apps_refused(self) -> None:
        for bad in (".", "docs", "tools/monstera", "../x", "spec/samples"):
            with self.subTest(bad):
                self.assertRefused(tools.generate_project, SAMPLE_REL, out=bad, write=True)

    def test_report_paths_confined(self) -> None:
        self.assertRefused(tools.get_device_report, run_id="../../docs")
        self.assertRefused(tools.get_device_report, evidence="device-lab/../README.md")
        self.assertRefused(tools.get_device_report, evidence="docs/evidence/g1-ios-simulator-ci", target="pc")

    def test_run_conformance_paths_and_arguments_confined(self) -> None:
        for bad in ("../outside", "docs", "/etc", "spec/samples/monstera-sample", "generated/../docs"):
            self.assertRefused(tools.run_conformance, bad)
        self.assertRefused(tools.run_conformance, "generated/monstera-sample", platforms=["rm"])
        self.assertRefused(tools.run_conformance, "generated/monstera-sample", platforms=["swift"],
                           swift_image="attacker/image:1")

    def test_oversized_inline_spec_refused(self) -> None:
        self.assertRefused(tools.validate_spec, spec={"x": "y" * (tools.MAX_INLINE_SPEC_BYTES + 1)})

    def test_exactly_one_of_path_or_spec(self) -> None:
        self.assertRefused(tools.validate_spec)
        self.assertRefused(tools.validate_spec, path=SAMPLE_REL, spec={})

    def test_write_never_forces_over_hand_edits(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "generated") as tmp:
            rel = Path(tmp).relative_to(ROOT).as_posix()
            first = tools.generate_project(SAMPLE_REL, out=rel, write=True)
            self.assertTrue(first["written"], first)
            edited = Path(tmp) / "android" / "app" / "build.gradle.kts"
            edited.write_bytes(edited.read_bytes() + b"// hand edit\n")
            second = tools.generate_project(SAMPLE_REL, out=rel, write=True)
            self.assertFalse(second["written"])
            self.assertIn("modified since last generation", second["refused"])
            self.assertTrue(edited.read_bytes().endswith(b"// hand edit\n"))

    @unittest.skipIf(os.name == "nt", "creating symlinks needs elevated rights on Windows")
    def test_symlinked_path_refused(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "spec") as tmp:
            link = Path(tmp) / "link"
            link.symlink_to(ROOT / "spec" / "samples", target_is_directory=True)
            rel = (link / "monstera-sample" / "monstera.spec.json").relative_to(ROOT).as_posix()
            self.assertRefused(tools.validate_spec, path=rel)


class NoDuplicatedLogicTests(unittest.TestCase):
    """The adapter must not grow its own validation/generation/hash logic."""

    def test_no_hashing_or_schema_logic_in_server(self) -> None:
        source = (Path(tools.__file__).read_text(encoding="utf-8")
                  + (ROOT / "tools/monstera-mcp/server.py").read_text(encoding="utf-8"))
        for forbidden in ("hashlib", "import re\n", "jsonschema", "string.Template"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
