"""Adversarial regression tests (G1.5 review). Each test encodes a guarantee that an attack probe
broke on branch g1.5/product-alignment; every test here FAILS until the corresponding fix lands.
See .kiro/workflow-output/adversarial/attack.md for the probes (ids in the docstrings)."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from monstera import archcheck, cli, generate, targets
from monstera.schema import SchemaStore

REPO = Path(__file__).resolve().parents[3]
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
LABEL = "apps/monstera-sample/monstera.spec.json"
USER_FILES = {
    "monstera.spec.json": b'{"hand": "maintained"}\n',
    "README.md": b"# My game\nHand-written instructions.\n",
    "assets/player.png": b"\x89PNG\r\n\x1a\nnot-really-a-png",
    ".kiro/steering/my-own.md": b"my steering\n",
}
IS_WINDOWS = os.name == "nt"


def sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def make_junction(link: Path, target: Path) -> None:
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
    if result.returncode != 0:
        raise unittest.SkipTest("cannot create a directory junction here")


class AppDirCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(REPO / "spec" / "schema")

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / "monstera-sample"
        self.root.mkdir()
        for rel, data in USER_FILES.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_bytes(data)
        self.files = generate.plan(sample(), LABEL, self.store, layout="app")

    def assertUserFilesIntact(self) -> None:
        for rel, data in USER_FILES.items():
            self.assertEqual((self.root / rel).read_bytes(), data, f"user file changed: {rel}")

    def write_ignoring_refusal(self, files, force: bool = True) -> None:
        try:
            generate.write(files, self.root, force=force)
        except generate.OutputError:
            pass  # refusing is a correct outcome; destroying outside data is not


class OwnershipAttackTests(AppDirCase):
    @unittest.skipUnless(IS_WINDOWS, "NTFS junctions are not symlinks; POSIX symlinks are already refused")
    def test_force_never_deletes_through_a_junction(self) -> None:
        """probe 1.03: --force walked a junction inside android/ and unlinked the files behind it."""
        generate.write(self.files, self.root)
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "precious.txt").write_text("precious", encoding="utf-8")
        make_junction(self.root / "android" / "jx", outside)
        self.write_ignoring_refusal(self.files)
        self.assertTrue((outside / "precious.txt").exists(), "file behind a junction was deleted")

    @unittest.skipUnless(IS_WINDOWS, "NTFS junctions are not symlinks; POSIX symlinks are already refused")
    def test_verify_reports_a_junction_without_following_it(self) -> None:
        """probes 3.23 / 4.06: verify listed the files behind a junction as if they were owned."""
        generate.write(self.files, self.root)
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "payload.kt").write_text("x", encoding="utf-8")
        make_junction(self.root / "android" / "jx", outside)
        unexpected = generate.verify(self.root).unexpected
        self.assertTrue(any(u.endswith("jx") for u in unexpected), unexpected)
        self.assertFalse(any("payload.kt" in u for u in unexpected), unexpected)

    @unittest.skipUnless(IS_WINDOWS, "NTFS junctions are not symlinks; POSIX symlinks are already refused")
    def test_junction_output_root_is_refused_like_a_symlink(self) -> None:
        """probe 2.12: write() checked root.is_symlink() only, so a junction root was written through."""
        real = self.base / "real"
        real.mkdir()
        link = self.base / "linked-out"
        make_junction(link, real)
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, link)

    def test_force_never_writes_through_a_hardlink_to_a_user_file(self) -> None:
        """probe 1.05: an owned file hard-linked to README.md was overwritten in place, changing README.md."""
        generate.write(self.files, self.root)
        owned = self.root / "android" / "gradle.properties"
        owned.unlink()
        try:
            os.link(self.root / "README.md", owned)
        except OSError:
            self.skipTest("hard links unavailable")
        self.write_ignoring_refusal(self.files)
        self.assertUserFilesIntact()

    def test_interrupted_first_generation_can_be_rerun(self) -> None:
        """probe 1.06: a first run killed before the manifest left owned files without a manifest;
        every re-run (even --force) was refused as 'not generator-owned'. The docstring promises a re-run works."""
        empty = self.base / "fresh"
        original = Path.write_bytes
        calls = {"n": 0}

        def flaky(self_path: Path, data: bytes) -> int:
            calls["n"] += 1
            if calls["n"] == 10:
                raise OSError("disk full (simulated)")
            return original(self_path, data)

        with mock.patch.object(Path, "write_bytes", flaky):
            with self.assertRaises(OSError):
                generate.write(self.files, empty)
        generate.write(self.files, empty)  # must recover without deleting anything by hand
        self.assertTrue(generate.verify(empty).clean)

    def test_forged_manifest_without_layout_cannot_widen_ownership(self) -> None:
        """probe 2.07: a hand-made manifest lacking layout/ownedRoots is read as a whole-directory
        (fixture) manifest, so `--layout fixture --force` deleted/overwrote every user file."""
        forged = {"generator": {"name": "monstera-generator", "version": "0"}, "files": [],
                  "spec": {"projectId": "monstera-sample"}}
        (self.root / generate.MANIFEST).write_text(json.dumps(forged), encoding="utf-8")
        fixture = generate.plan(sample(), LABEL, self.store, layout="fixture")
        self.write_ignoring_refusal(fixture)
        self.assertUserFilesIntact()

    def test_mode_only_change_is_reported(self) -> None:
        """probe 3.10: the manifest records each file's mode but verify/check ignore it."""
        generate.write(self.files, self.root)
        os.chmod(self.root / "android" / "gradlew", 0o444)
        self.assertFalse(generate.verify(self.root).clean)
        self.assertFalse(generate.check(self.files, self.root).clean)

    def test_malformed_manifest_is_a_refusal_not_a_traceback(self) -> None:
        """probes 2.05a-f, 2.04h: well-formed JSON with wrong field types crashed verify/write
        (AttributeError/TypeError/KeyError/ValueError) instead of raising OutputError."""
        generate.write(self.files, self.root)
        good = json.loads((self.root / generate.MANIFEST).read_text(encoding="utf-8"))
        mutations = {
            "generator is a string": {"generator": "monstera-generator"},
            "generator is null": {"generator": None},
            "files entries are strings": {"files": ["x"]},
            "files entry without path": {"files": [{"sha256": "0"}]},
            "spec is a string": {"spec": "x"},
        }
        if IS_WINDOWS:
            mutations["ownedRoots rooted without drive"] = {"ownedRoots": ["\\Windows"]}
        for name, change in mutations.items():
            with self.subTest(name):
                (self.root / generate.MANIFEST).write_text(json.dumps({**good, **change}), encoding="utf-8")
                for call in (lambda: generate.verify(self.root), lambda: generate.write(self.files, self.root, force=True)):
                    try:
                        call()
                    except generate.OutputError:
                        continue
                    except Exception as exc:  # noqa: BLE001 - the failure under test
                        self.fail(f"uncaught {type(exc).__name__}: {exc}")


class GuardAttackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=REPO / "tools" / "monstera" / "tests")
        self.addCleanup(self.tmp.cleanup)
        self.app = Path(self.tmp.name)
        store = SchemaStore.load(REPO / "spec" / "schema")
        generate.write(generate.plan(sample(), LABEL, store, layout="app"), self.app)
        (self.app / "README.md").write_text("mine", encoding="utf-8")

    def guard(self, value, key: str = "path", tool: str = "fs_write") -> int:
        payload = json.dumps({"toolName": tool, "toolInput": {key: value}})
        with mock.patch("sys.stdin", io.StringIO(payload)), redirect_stderr(io.StringIO()):
            return cli.cmd_guard_generated(None, None)  # type: ignore[arg-type]

    def test_moving_or_deleting_a_directory_that_contains_owned_files_is_blocked(self) -> None:
        """probe 5.05: smart_relocate of apps/<id>, its .kiro or .kiro/steering was allowed although
        each holds generator-owned files (generated/ itself is blocked)."""
        for directory in (self.app, self.app / ".kiro", self.app / ".kiro" / "steering"):
            with self.subTest(directory.name):
                self.assertEqual(self.guard(str(directory), key="sourcePath", tool="smart_relocate"), 2)

    @unittest.skipUnless(IS_WINDOWS, "Windows extended-length / UNC spellings")
    def test_extended_length_and_unc_spellings_are_blocked(self) -> None:
        """probe 5.01: `\\\\?\\C:\\...` and `\\\\localhost\\C$\\...` address the same file but skipped the guard."""
        target = self.app / "android" / "app" / "build.gradle.kts"
        drive, rest = os.path.splitdrive(str(target))
        for spelling in ("\\\\?\\" + str(target), "\\\\localhost\\" + drive.replace(":", "$") + rest):
            with self.subTest(spelling):
                self.assertEqual(self.guard(spelling), 2)

    def test_path_list_value_is_inspected(self) -> None:
        """probe 5.03b: {"path": ["<owned file>"]} was ignored."""
        owned = str(self.app / "android" / "app" / "build.gradle.kts")
        self.assertEqual(self.guard([owned]), 2)

    def test_malformed_manifest_fails_closed(self) -> None:
        """probe 5.07: a manifest with a non-object generator made the guard crash (exit 1, which
        Kiro treats as a non-blocking hook error), so owned files became editable."""
        (self.app / generate.MANIFEST).write_text(json.dumps({"files": [], "generator": "monstera-generator"}),
                                                  encoding="utf-8")
        self.assertEqual(self.guard(str(self.app / "android" / "app" / "build.gradle.kts")), 2)

    def test_nested_decoy_manifest_does_not_unprotect_owned_files(self) -> None:
        """probe 5.07b: the nearest manifest wins, so a decoy planted at android/app/ with
        ownedRoots ['zzz'] released every file below it."""
        decoy = {"files": [], "generator": {"name": "monstera-generator"}, "ownedRoots": ["zzz"]}
        (self.app / "android" / "app" / generate.MANIFEST).write_text(json.dumps(decoy), encoding="utf-8")
        self.assertEqual(self.guard(str(self.app / "android" / "app" / "build.gradle.kts")), 2)


class CiRuleBypassTests(unittest.TestCase):
    """archcheck must reject what GitHub's YAML parser would treat as a violation (probes 6.x)."""

    SHA = "a" * 40

    def scan(self, files: dict[str, str]) -> list[str]:
        with tempfile.TemporaryDirectory() as tmp:
            for rel, text in files.items():
                path = Path(tmp, rel)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
            return [str(v) for v in archcheck.check(Path(tmp))]

    def workflow(self, *, trigger: str = "\n  push:\n", permissions: str = "permissions:\n  contents: read\n",
                 steps: str | None = None) -> str:
        steps = steps if steps is not None else f"      - uses: actions/checkout@{self.SHA}\n"
        return (f"name: ci\non:{trigger}{permissions}jobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n{steps}")

    def assertRejected(self, name: str, files: dict[str, str]) -> None:
        with self.subTest(name):
            self.assertTrue(self.scan(files), f"{name}: accepted")

    def wf(self, text: str) -> dict[str, str]:
        return {".github/workflows/ci.yml": text}

    def test_pull_request_target_escaped_in_a_quoted_key(self) -> None:
        """probe 6.01: "pull_request\\x5ftarget" is the same key to YAML but not to a substring test."""
        for name, key in (("\\x5f", '"pull_request\\x5ftarget"'), ("\\u005f", '"pull_request\\u005ftarget"'),
                          ("\\x74", '"pull_request_\\x74arget"')):
            self.assertRejected(name, self.wf(self.workflow(trigger=f"\n  {key}:\n")))

    def test_permissions_hidden_inside_a_quoted_multiline_scalar(self) -> None:
        """probe 6.02: a column-0 `permissions:` line inside a quoted scalar satisfied the regex."""
        text = 'name: ci\non:\n  push:\nnote: "x\npermissions:\n y"\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: hi\n'
        self.assertRejected("quoted scalar", self.wf(text))

    def test_unpinned_actions_in_other_yaml_spellings(self) -> None:
        """probe 6.03: only `- uses: x` / `uses: x` at a line start was recognised."""
        unpinned = "actions/checkout@v4"
        cases = {
            "space before colon": f"      - uses : {unpinned}\n",
            "quoted key": f'      - "uses": {unpinned}\n',
            "flow mapping step": f"      - {{uses: {unpinned}}}\n",
        }
        for name, steps in cases.items():
            self.assertRejected(name, self.wf(self.workflow(steps=steps)))
        flow = f"name: ci\non: push\npermissions: {{contents: read}}\njobs:\n  b:\n    runs-on: x\n    steps: [{{uses: {unpinned}}}]\n"
        self.assertRejected("flow steps list", self.wf(flow))

    def test_unpinned_action_inside_a_local_composite_action(self) -> None:
        """probe 6.03[composite]: .github/actions/**/action.yml runs in CI but was never scanned."""
        composite = "name: x\nruns:\n  using: composite\n  steps:\n    - uses: evil/action@main\n      shell: bash\n"
        files = self.wf(self.workflow(steps="      - uses: ./.github/actions/x\n"))
        files[".github/actions/x/action.yml"] = composite
        self.assertRejected("composite action", files)

    def test_secrets_in_pull_request_workflows_in_other_spellings(self) -> None:
        """probe 6.04: the trigger regex needed `  pull_request:` at exactly 2 spaces, and the secret
        regex needed lower-case `${{ secrets.NAME`."""
        env = "      - run: echo hi\n        env:\n          T: {expr}\n"
        triggers = {"block, 4 spaces": "\n    pull_request:\n", "flow list": " [pull_request]",
                    "scalar": " pull_request", "flow map": " {pull_request: {}}", "quoted key": '\n  "pull_request":\n'}
        for name, trigger in triggers.items():
            self.assertRejected(f"trigger {name}",
                                self.wf(self.workflow(trigger=trigger, steps=env.format(expr="${{ secrets.DEPLOY_KEY }}"))))
        expressions = {"upper-case context": "${{ SECRETS.DEPLOY_KEY }}", "index": "${{ secrets['DEPLOY_KEY'] }}",
                       "toJSON": "${{ toJSON(secrets) }}", "inside format()": "${{ format('{0}', secrets.DEPLOY_KEY) }}",
                       "after ||": "${{ env.A || secrets.DEPLOY_KEY }}"}
        for name, expr in expressions.items():
            self.assertRejected(f"expression {name}",
                                self.wf(self.workflow(trigger="\n  pull_request:\n", steps=env.format(expr=expr))))
        inherit = (f"name: ci\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  b:\n"
                   f"    uses: org/repo/.github/workflows/w.yml@{self.SHA}\n    secrets: inherit\n")
        self.assertRejected("secrets: inherit", self.wf(inherit))

    def test_apple_sdk_generation_and_transfer_beyond_three_keywords(self) -> None:
        """probe 6.05: only `xtoolsdk`, `xtool sdk build` and `darwin-xtoolsdk` were recognised,
        although the repo's own docs name `xtool sdk install` and `xtool setup` as the SDK commands."""
        commands = {
            "xtool sdk install": 'xtool sdk install "$SDK_PATH"',
            "xtool setup": "xtool setup",
            "line continuation": "xtool \\\n          sdk build Xcode.app out",
            "Xcode xip download": "curl -L -o Xcode.xip https://example.invalid/Xcode_16.xip",
            "darwin.artifactbundle": "tar czf x.tgz ~/.swiftpm/swift-sdks/darwin.artifactbundle",
        }
        for name, command in commands.items():
            steps = f"      - uses: actions/checkout@{self.SHA}\n      - run: |\n          {command}\n"
            self.assertRejected(name, self.wf(self.workflow(steps=steps)))
        cache = (f"      - uses: actions/checkout@{self.SHA}\n      - uses: actions/cache@{self.SHA}\n"
                 f"        with:\n          path: ~/.swiftpm/swift-sdks\n          key: sdk\n")
        self.assertRejected("actions/cache of swift-sdks", self.wf(self.workflow(steps=cache)))

    def test_forbidden_framework_files_in_dirs_named_build_or_xtool(self) -> None:
        """probe 6.07: SKIP_DIRS prunes any directory called build/xtool/.build at any depth."""
        self.assertRejected("pubspec.yaml under build/", {"apps/x/build/pubspec.yaml": "name: x\n"})


if __name__ == "__main__":
    unittest.main()
