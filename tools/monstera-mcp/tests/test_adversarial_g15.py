"""Adversarial regression tests for the MCP tools (G1.5 review). They FAIL until fixed.
Probes: .kiro/workflow-output/adversarial/attack.md (4.02, 4.03, 4.06)."""
from __future__ import annotations
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from monstera_mcp import tools  # noqa: E402
from monstera import generate, targets  # noqa: E402

REAL = tools.REPO_ROOT
SPEC = "spec/samples/monstera-sample/monstera.spec.json"


class McpContainmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        shutil.copytree(REAL / "spec", self.root / "spec")
        for name, value in (("REPO_ROOT", self.root), ("_store", None)):
            patcher = mock.patch.object(tools, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in (("APPS", self.root / "apps"), ("GENERATED", self.root / "generated")):
            patcher = mock.patch.object(targets, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def written(self, out: str) -> bool:
        try:
            return bool(tools.generate_project(SPEC, out=out, write=True)["written"])
        except tools.ToolError:
            return False

    def test_container_directories_are_not_valid_outputs(self) -> None:
        """probe 4.02: out='apps' (or 'apps/.') wrote a whole-directory manifest at apps/, which makes
        every future apps/<id>/ file generator-owned (the guard hook then blocks user specs)."""
        for out in ("apps", "apps/.", "generated"):
            with self.subTest(out):
                self.assertFalse(self.written(out))
                self.assertFalse((self.root / out / generate.MANIFEST).exists())

    def test_output_inside_a_hand_maintained_dir_is_refused(self) -> None:
        """probe 4.02: out='apps/x/assets/gen' created a generator-owned tree inside user assets."""
        (self.root / "apps/x/assets").mkdir(parents=True)
        self.assertFalse(self.written("apps/x/assets/gen"))

    def test_output_inside_another_apps_owned_root_is_refused(self) -> None:
        """probe 4.03: out='apps/p/android/zzz' nested a project inside another app's owned root."""
        store = tools.store()
        spec = generate.validate_path if False else None  # noqa: F841 - keep imports minimal
        from monstera.validate import validate_path
        result = validate_path(self.root / SPEC, store)
        generate.write(generate.plan(result.spec, "apps/p/monstera.spec.json", store, layout="app"), self.root / "apps/p")
        self.assertFalse(self.written("apps/p/android/zzz"))

    @unittest.skipUnless(os.name == "nt", "NTFS junctions")
    def test_inspect_manifest_does_not_list_files_behind_a_junction(self) -> None:
        """probe 4.06: a junction inside an app dir exposed file names outside the repository."""
        from monstera.validate import validate_path
        store = tools.store()
        result = validate_path(self.root / SPEC, store)
        app = self.root / "apps/q"
        generate.write(generate.plan(result.spec, "apps/q/monstera.spec.json", store, layout="app"), app)
        outside = Path(self.tmp.name).parent / "mcp_adv_outside"
        outside.mkdir(exist_ok=True)
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "secret_name.txt").write_text("s", encoding="utf-8")
        link = app / "android" / "jin"
        if subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True).returncode:
            self.skipTest("cannot create junction")
        self.addCleanup(lambda: subprocess.run(["cmd", "/c", "rmdir", str(link)], capture_output=True))
        listed = tools.inspect_manifest("apps/q")["verify"]["unexpected"]
        self.assertFalse(any("secret_name" in u for u in listed), listed)


if __name__ == "__main__":
    unittest.main()
