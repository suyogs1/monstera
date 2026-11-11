"""G1.5: manifest-scoped ownership for apps/<id>/ (decision 2), the generalized guard hook,
the Kiro guidance file (decision 1) and the CI-safety architecture rules (decision 3).

Every test that writes uses a temporary directory; nothing under the repository is modified.
"""

from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from monstera import archcheck, cli, generate, kirocheck, targets
from monstera.jsonio import sha256_hex
from monstera.schema import SchemaStore

REPO = Path(__file__).resolve().parents[3]
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
LABEL = "apps/monstera-sample/monstera.spec.json"
USER_FILES = {
    "monstera.spec.json": b'{"hand": "maintained"}\n',
    "README.md": b"# My game\nHand-written instructions.\n",
    "assets/player.png": b"\x89PNG\r\n\x1a\nnot-really-a-png",
    "assets/PROVENANCE.md": b"player.png: drawn by me, CC0\n",
    "notes/design.md": b"ideas\n",
    ".kiro/steering/my-own.md": b"my steering\n",
}


def sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


class AppLayoutOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(REPO / "spec" / "schema")

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "monstera-sample"
        self.root.mkdir()
        for rel, data in USER_FILES.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_bytes(data)
        self.files = generate.plan(sample(), LABEL, self.store, layout="app")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def assertUserFilesIntact(self) -> None:
        for rel, data in USER_FILES.items():
            self.assertEqual((self.root / rel).read_bytes(), data, f"user file changed: {rel}")

    def test_manifest_declares_owned_roots(self) -> None:
        manifest = json.loads(next(f.data for f in self.files if f.path == generate.MANIFEST))
        self.assertEqual(manifest["layout"], "app")
        self.assertEqual(manifest["ownedRoots"], [generate.GUIDANCE_FILE, "android", "ios"])
        for entry in manifest["files"]:
            self.assertTrue(generate._in_owned(entry["path"], manifest["ownedRoots"]), entry["path"])

    def test_no_readme_is_generated_in_app_layout(self) -> None:
        self.assertNotIn("README.md", [f.path for f in self.files])

    def test_first_generation_next_to_user_files(self) -> None:
        generate.write(self.files, self.root)
        self.assertUserFilesIntact()
        self.assertTrue(generate.verify(self.root).clean)
        self.assertTrue(generate.check(self.files, self.root).clean)

    def test_regeneration_and_force_never_touch_user_files(self) -> None:
        generate.write(self.files, self.root)
        changed = sample()
        changed["game"]["targetFps"] = 120
        new_files = generate.plan(changed, LABEL, self.store, layout="app")
        generate.write(new_files, self.root)
        self.assertUserFilesIntact()
        (self.root / "ios/Sources/MonsteraSample/ContentView.swift").write_text("edit", encoding="utf-8")
        generate.write(new_files, self.root, force=True)  # discards the owned edit only
        self.assertUserFilesIntact()
        self.assertTrue(generate.verify(self.root).clean)

    def test_user_files_are_invisible_to_check_and_verify(self) -> None:
        generate.write(self.files, self.root)
        (self.root / "assets/new-sprite.png").write_bytes(b"new")
        self.assertTrue(generate.check(self.files, self.root).clean)
        self.assertTrue(generate.verify(self.root).clean)

    def test_unlisted_file_inside_owned_root_is_refused(self) -> None:
        generate.write(self.files, self.root)
        stray = self.root / "android/app/src/main/kotlin/Extra.kt"
        stray.write_text("class Extra", encoding="utf-8")
        self.assertIn("android/app/src/main/kotlin/Extra.kt", generate.verify(self.root).unexpected)
        with self.assertRaises(generate.OutputError) as ctx:
            generate.write(self.files, self.root)
        self.assertIn("not generator-owned", str(ctx.exception))
        self.assertTrue(stray.exists())

    def test_hand_edit_inside_owned_root_is_refused(self) -> None:
        generate.write(self.files, self.root)
        target = self.root / "android/app/build.gradle.kts"
        target.write_bytes(target.read_bytes() + b"// mine\n")
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, self.root)
        self.assertTrue(target.read_bytes().endswith(b"// mine\n"))

    def test_preexisting_files_in_owned_roots_without_manifest_refused_even_with_force(self) -> None:
        (self.root / "ios").mkdir()
        (self.root / "ios/Handwritten.swift").write_text("let x = 1", encoding="utf-8")
        for force in (False, True):
            with self.assertRaises(generate.OutputError):
                generate.write(self.files, self.root, force=force)
        self.assertTrue((self.root / "ios/Handwritten.swift").exists())
        self.assertUserFilesIntact()

    def test_user_owned_guidance_file_without_manifest_is_refused(self) -> None:
        guidance = self.root / generate.GUIDANCE_FILE
        guidance.write_text("my own text", encoding="utf-8")
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, self.root, force=True)
        self.assertEqual(guidance.read_text(encoding="utf-8"), "my own text")

    def test_layout_change_is_refused_even_with_force(self) -> None:
        generate.write(self.files, self.root)
        fixture = generate.plan(sample(), LABEL, self.store, layout="fixture")
        for force in (False, True):
            with self.assertRaises(generate.OutputError) as ctx:
                generate.write(fixture, self.root, force=force)
            self.assertIn("layout", str(ctx.exception))
        self.assertUserFilesIntact()

    def test_tampered_owned_roots_cannot_widen_ownership(self) -> None:
        generate.write(self.files, self.root)
        manifest_path = self.root / generate.MANIFEST
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for evil in (["."], ["../outside"], ["/etc"], ["android", "assets"]):
            manifest["ownedRoots"] = evil
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(generate.OutputError):
                generate.write(self.files, self.root, force=True)
        self.assertUserFilesIntact()

    def test_owned_root_replaced_by_user_file_is_refused(self) -> None:
        (self.root / "android").write_text("not a directory", encoding="utf-8")
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, self.root)
        self.assertEqual((self.root / "android").read_text(encoding="utf-8"), "not a directory")

    def test_targets_filter_owned_roots(self) -> None:
        spec = sample()
        spec["project"]["targets"] = ["android"]
        files = generate.plan(spec, LABEL, self.store, layout="app")
        manifest = json.loads(next(f.data for f in files if f.path == generate.MANIFEST))
        # ownedRoots are fixed for the app layout, so dropping a target never changes ownership.
        self.assertEqual(manifest["ownedRoots"], [generate.GUIDANCE_FILE, "android", "ios"])
        generate.write(files, self.root)
        self.assertFalse((self.root / "ios").exists())
        self.assertUserFilesIntact()

    @unittest.skipIf(os.name == "nt", "creating symlinks needs elevated rights on Windows")
    def test_symlinked_owned_root_is_refused(self) -> None:
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (self.root / "android").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, self.root, force=True)
        self.assertEqual(list(outside.iterdir()), [])


class GuidanceFileTests(unittest.TestCase):
    """Decision 1: optional, documentation-only, one copy, never read by a build."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(REPO / "spec" / "schema")

    def test_exactly_one_guidance_file_and_no_kiro_config(self) -> None:
        for layout in ("fixture", "app"):
            paths = [f.path for f in generate.plan(sample(), LABEL, self.store, layout=layout)]
            kiro = [p for p in paths if p.startswith(".kiro/") or "/.kiro/" in p]
            self.assertEqual(kiro, [generate.GUIDANCE_FILE], layout)

    def test_no_build_file_references_kiro(self) -> None:
        for f in generate.plan(sample(), LABEL, self.store, layout="app"):
            if f.path.endswith((".kts", ".swift", ".xml", ".plist", ".yml", ".properties")):
                self.assertNotIn(b".kiro", f.data, f.path)

    def test_guidance_states_it_is_documentation_only(self) -> None:
        files = generate.plan(sample(), LABEL, self.store)
        f = next(f for f in files if f.path == generate.GUIDANCE_FILE)
        spec_sha = sha256_hex(next(x.data for x in files if x.kind == "spec"))
        self.assertIn(b"documentation only", f.data)
        self.assertIn(spec_sha.encode(), f.data)


class DefaultOutTests(unittest.TestCase):
    def test_app_specs_use_app_layout(self) -> None:
        out, layout = targets.default_out(targets.APPS / "pumpkin-blaster" / "monstera.spec.json", "pumpkin-blaster")
        self.assertEqual((out, layout), (targets.APPS / "pumpkin-blaster", "app"))

    def test_folder_must_match_project_id(self) -> None:
        with self.assertRaises(ValueError):
            targets.default_out(targets.APPS / "pumpkin-blaster" / "monstera.spec.json", "other")

    def test_samples_use_fixture_layout(self) -> None:
        self.assertEqual(targets.default_out(SAMPLE, "monstera-sample"),
                         (targets.GENERATED / "monstera-sample", "fixture"))


class GuardTests(unittest.TestCase):
    """The PreToolUse hook blocks owned app paths and the manifest, but not user files."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=REPO / "tools" / "monstera" / "tests")
        self.app = Path(self.tmp.name)
        store = SchemaStore.load(REPO / "spec" / "schema")
        generate.write(generate.plan(sample(), LABEL, store, layout="app"), self.app)
        (self.app / "README.md").write_text("mine", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def guard(self, path: Path) -> int:
        payload = json.dumps({"toolName": "fs_write", "toolInput": {"path": str(path)}})
        with mock.patch("sys.stdin", io.StringIO(payload)), redirect_stderr(io.StringIO()):
            return cli.cmd_guard_generated(None, None)  # type: ignore[arg-type]

    def test_owned_paths_blocked(self) -> None:
        for rel in ("android/app/build.gradle.kts", "ios/Package.swift", "android/new-file.kt",
                    generate.MANIFEST, generate.GUIDANCE_FILE):
            with self.subTest(rel):
                self.assertEqual(self.guard(self.app / rel), 2)

    def test_user_paths_allowed(self) -> None:
        for rel in ("README.md", "monstera.spec.json", "assets/x.png", ".kiro/steering/my-own.md"):
            with self.subTest(rel):
                self.assertEqual(self.guard(self.app / rel), 0)


class CiSafetyRuleTests(unittest.TestCase):
    """Decision 3: public build workers stay safe."""

    def scan(self, files: dict[str, str]) -> set[tuple[str, str]]:
        with tempfile.TemporaryDirectory() as tmp:
            for rel, text in files.items():
                p = Path(tmp, rel)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(text, encoding="utf-8")
            return {(v.path, v.rule.split(" (")[0]) for v in archcheck.check(Path(tmp))}

    def test_unsafe_workflow_patterns_detected(self) -> None:
        bad = ("on:\n  pull_request_target:\n  pull_request:\njobs:\n  x:\n    steps:\n"
               "      - uses: actions/checkout@v5\n      - run: echo ${{ secrets.DEPLOY_TOKEN }}\n"
               "      - run: xtool sdk build Xcode.app out\n")
        rules = {r for _, r in self.scan({".github/workflows/bad.yml": bad})}
        self.assertTrue({"pull_request_target trigger", "workflow without an explicit top-level permissions: block",
                         "action not pinned to a commit SHA",
                         "secrets used in a pull_request/workflow_run-triggered workflow",
                         "Apple SDK generation or transfer in CI"} <= rules, rules)

    def test_safe_workflow_passes(self) -> None:
        good = ("on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  x:\n    steps:\n"
                "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0\n")
        self.assertEqual(self.scan({".github/workflows/good.yml": good}), set())

    def test_web_tooling_forbidden_in_native_trees_only(self) -> None:
        found = self.scan({"apps/x/package.json": "{}", "studio/web/package.json": '{"name": "studio"}'})
        self.assertEqual(found, {("apps/x/package.json", "web/JS dependency inside a native app tree")})

    def test_repository_workflows_pass(self) -> None:
        self.assertEqual([v for v in archcheck.check(REPO) if v.path.startswith(".github/")], [])


class KiroConfigTests(unittest.TestCase):
    def _ignore_problems(self, gitignore: str) -> list[str]:
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q", tmp], check=True)
            Path(tmp, ".kiro", "steering").mkdir(parents=True)
            Path(tmp, ".kiro", "steering", "01.md").write_text("x", encoding="utf-8")
            Path(tmp, ".kiro", "hooks").mkdir()
            Path(tmp, ".kiro", "hooks", "h.json").write_text("{}", encoding="utf-8")  # real files are probed
            Path(tmp, ".gitignore").write_text(gitignore, encoding="utf-8")
            return [p for p in kirocheck.check(Path(tmp)) if ".gitignore" in p]

    def test_gitignoring_kiro_config_is_rejected(self) -> None:
        for entry in (".kiro/", "/.kiro", ".kiro/steering/", ".kiro/specs", ".kiro/hooks/*", ".kiro*",
                      "*", "**/*.md", ".*", "*.json"):
            with self.subTest(entry):
                self.assertTrue(self._ignore_problems(entry + "\n"), entry)

    def test_scratch_output_and_unrelated_patterns_may_be_ignored(self) -> None:
        allowed = (".kiro/workflow-output/\n# .kiro/ comment\n*.apk\n*.iml\nbuild/\n"
                   "generated/**/.bsp/\napps/*/ios/.bsp/\n__pycache__/\n")
        self.assertEqual(self._ignore_problems(allowed), [])

    def test_workflow_lint_catches_structural_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wf = Path(tmp, ".kiro", "workflows")
            wf.mkdir(parents=True)
            (wf / "bad.workflow.json").write_text(json.dumps({"name": "bad", "steps": [
                {"type": "step", "id": "a", "agent": "nobody", "prompt": "{{previous.output}} {{ghost}}"},
                {"type": "repeat", "id": "a", "steps": [], "maxIterations": 0, "onMaxIterations": "pause"}]}),
                encoding="utf-8")
            problems = " ".join(kirocheck.check(Path(tmp)))
            for fragment in ("unknown agent", "previous.output", "undeclared input", "finite maxIterations",
                             "duplicate node ids"):
                self.assertIn(fragment, problems)


if __name__ == "__main__":
    unittest.main()
