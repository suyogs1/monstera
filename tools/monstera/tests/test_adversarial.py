"""Regression tests from the G1 adversarial review (docs/G1-SPECIFICATION-REPORT.md, "Adversarial review").

Each test reproduces an attack that succeeded before the fix.
"""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from monstera import cli, generate
from monstera.jsonio import LoadError, canonical_bytes, loads_strict, sha256_hex
from monstera.schema import SchemaError, SchemaStore
from monstera.typemodel import build
from monstera.validate import validate_value

REPO = Path(__file__).resolve().parents[3]
SCHEMAS = REPO / "spec" / "schema"
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
LABEL = "spec/samples/monstera-sample/monstera.spec.json"


def sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


class SchemaEvolutionTests(unittest.TestCase):
    """Schema changes that would make validation lie or generated code break must fail at load."""

    def _load_with(self, mutate) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for f in SCHEMAS.glob("*.json"):
                shutil.copy(f, tmp)
            path = Path(tmp, "game.schema.json")
            game = json.loads(path.read_text(encoding="utf-8"))
            mutate(game)
            path.write_text(json.dumps(game), encoding="utf-8")
            build(SchemaStore.load(Path(tmp)))

    def assertRejected(self, mutate, fragment: str) -> None:
        with self.assertRaises(SchemaError) as ctx:
            self._load_with(mutate)
        self.assertIn(fragment, str(ctx.exception))

    def test_current_schemas_load(self) -> None:
        self._load_with(lambda g: None)

    def test_open_objects_rejected(self) -> None:
        # Extra data would be hashed into the canonical spec but dropped by the models.
        self.assertRejected(lambda g: g["properties"]["world"].update(additionalProperties=True),
                            '"additionalProperties": false')

    def test_optional_property_rejected(self) -> None:
        self.assertRejected(lambda g: g["properties"]["world"]["required"].remove("height"), "every property")

    def test_required_ghost_rejected(self) -> None:
        self.assertRejected(lambda g: g["required"].append("ghost"), "every property")

    def test_keyword_property_name_rejected(self) -> None:
        def mutate(g: dict) -> None:
            g["properties"]["class"] = {"type": "string"}
            g["required"].append("class")
        self.assertRejected(mutate, "Kotlin/Swift keyword")

    def test_reserved_title_rejected(self) -> None:
        self.assertRejected(lambda g: g["properties"]["world"].update(title="String"), "built-in")

    def test_unknown_type_rejected(self) -> None:
        self.assertRejected(lambda g: g["properties"]["genre"].update(type="strng"), "'type' must be one of")

    def test_enum_case_collision_rejected(self) -> None:
        self.assertRejected(lambda g: g["properties"]["genre"]["enum"].extend(["proto-type", "proto_type"]),
                            "duplicate case names")

    def test_bad_pattern_rejected(self) -> None:
        self.assertRejected(lambda g: g["$defs"]["color"].update(pattern="^#[0-9A-F{6}$"), "does not compile")

    def test_dangling_ref_rejected(self) -> None:
        self.assertRejected(
            lambda g: g["properties"]["palette"]["properties"]["accent"].update({"$ref": "#/$defs/missing"}),
            "unresolvable $ref")

    def test_unsupported_keyword_rejected(self) -> None:
        self.assertRejected(lambda g: g["properties"]["targetFps"].update(multipleOf=30), "unsupported keyword")


class CanonicalBytesTests(unittest.TestCase):
    """The SHA-256 must identify the exact canonical bytes that both apps bundle."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(SCHEMAS)

    def test_integral_floats_have_one_spelling(self) -> None:
        a, b = sample(), sample()
        b["game"]["world"]["width"] = 1080.0
        self.assertEqual(canonical_bytes(a), canonical_bytes(b))

    def test_bundled_bytes_hash_to_the_embedded_constant(self) -> None:
        files = {f.path: f.data for f in generate.plan(sample(), LABEL, self.store)}
        expected = validate_value(sample(), self.store).sha256
        for path in ("android/app/src/main/assets/monstera.spec.json",
                     "ios/Sources/MonsteraSample/Resources/monstera.spec.json"):
            self.assertEqual(sha256_hex(files[path]), expected, path)
        manifest = json.loads(files[generate.MANIFEST])
        self.assertEqual(manifest["spec"]["sha256"], expected)
        self.assertIn(expected, files["android/app/src/main/kotlin/app/monstera/sample/generated/GeneratedSpec.kt"].decode())
        self.assertIn(expected, files["ios/Sources/MonsteraSample/Generated/GeneratedSpec.swift"].decode())

    def test_committed_bundles_hash_to_committed_constant(self) -> None:
        root = REPO / "generated" / "monstera-sample"
        manifest = json.loads((root / generate.MANIFEST).read_text(encoding="utf-8"))
        for rel in ("android/app/src/main/assets/monstera.spec.json",
                    "ios/Sources/MonsteraSample/Resources/monstera.spec.json"):
            self.assertEqual(sha256_hex((root / rel).read_bytes()), manifest["spec"]["sha256"], rel)

    def test_overflowing_number_rejected(self) -> None:
        with self.assertRaises(LoadError) as ctx:
            loads_strict('{"specVersion": 1e400}')
        self.assertEqual(ctx.exception.code, "json.non-finite")

    def test_deep_nesting_is_an_error_not_a_crash(self) -> None:
        with self.assertRaises(LoadError) as ctx:
            loads_strict("[" * 100000)
        self.assertEqual(ctx.exception.code, "json.depth")

    def test_messages_are_ascii(self) -> None:
        spec = sample()
        spec["project"]["\u540d\u524d"] = "\u5024"
        issues = validate_value(spec, self.store).issues
        self.assertTrue(all(str(i).isascii() for i in issues))

    def test_product_name_colliding_with_model_type_rejected(self) -> None:
        spec = sample()
        spec["project"]["id"] = "game"  # product "Game" == model type Game
        codes = {i.code for i in validate_value(spec, self.store).issues}
        self.assertIn("semantic.product-name", codes)


class OwnershipTests(unittest.TestCase):
    """Generated-file ownership: modification detection and no silent overwrites."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(SCHEMAS)

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "out"
        self.files = generate.plan(sample(), LABEL, self.store)
        generate.write(self.files, self.root)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_source_dir_named_build_is_not_ignored(self) -> None:
        injected = self.root / "ios/Sources/MonsteraSample/build/Injected.swift"
        injected.parent.mkdir(parents=True)
        injected.write_text("let injected = 1\n", encoding="utf-8")
        rel = "ios/Sources/MonsteraSample/build/Injected.swift"
        self.assertIn(rel, generate.check(self.files, self.root).unexpected)
        self.assertIn(rel, generate.verify(self.root).unexpected)

    def test_real_build_output_is_ignored_and_kept(self) -> None:
        out = self.root / "android/app/build/intermediates/x.bin"
        out.parent.mkdir(parents=True)
        out.write_bytes(b"\0")
        self.assertTrue(generate.check(self.files, self.root).clean)
        generate.write(self.files, self.root)
        self.assertTrue(out.exists())

    def test_verify_detects_hand_edit_without_regenerating(self) -> None:
        target = self.root / "android/app/build.gradle.kts"
        target.write_bytes(target.read_bytes() + b"// edit\n")
        self.assertEqual(generate.verify(self.root).changed, ("android/app/build.gradle.kts",))

    def test_hand_edit_is_not_overwritten(self) -> None:
        target = self.root / "ios/Sources/MonsteraSample/ContentView.swift"
        target.write_bytes(target.read_bytes() + b"// edit\n")
        with self.assertRaises(generate.OutputError) as ctx:
            generate.write(self.files, self.root)
        self.assertIn("modified since last generation", str(ctx.exception))
        self.assertTrue(target.read_bytes().endswith(b"// edit\n"))

    def test_user_file_is_not_deleted(self) -> None:
        notes = self.root / "android/NOTES.md"
        notes.write_text("mine", encoding="utf-8")
        with self.assertRaises(generate.OutputError):
            generate.write(self.files, self.root)
        self.assertTrue(notes.exists())

    def test_force_discards_local_changes_but_keeps_build_output(self) -> None:
        (self.root / "android/NOTES.md").write_text("mine", encoding="utf-8")
        build_out = self.root / "ios/.build/cache"
        build_out.parent.mkdir(parents=True)
        build_out.write_bytes(b"\0")
        generate.write(self.files, self.root, force=True)
        self.assertTrue(generate.verify(self.root).clean)
        self.assertTrue(build_out.exists())

    def test_unowned_directory_refused_even_with_force(self) -> None:
        user = Path(self.tmp.name) / "user"
        user.mkdir()
        (user / "precious.txt").write_text("data", encoding="utf-8")
        (user / generate.MANIFEST).write_text("{}", encoding="utf-8")  # fake manifest
        for force in (False, True):
            with self.assertRaises(generate.OutputError):
                generate.write(self.files, user, force=force)
        self.assertTrue((user / "precious.txt").exists())

    def test_other_projects_output_refused(self) -> None:
        other = sample()
        other["project"]["id"] = "other-project"
        with self.assertRaises(generate.OutputError) as ctx:
            generate.write(generate.plan(other, LABEL, self.store), self.root)
        self.assertIn("belongs to project", str(ctx.exception))

    def test_interrupted_run_recovers(self) -> None:
        changed = sample()
        changed["game"]["targetFps"] = 120
        new_files = generate.plan(changed, LABEL, self.store)
        # Simulate a crash after half the new files were written but before the manifest.
        for f in [f for f in new_files if f.path != generate.MANIFEST][::2]:
            (self.root / f.path).write_bytes(f.data)
        generate.write(new_files, self.root)
        self.assertTrue(generate.check(new_files, self.root).clean)

    @unittest.skipIf(os.name == "nt", "creating symlinks needs elevated rights on Windows")
    def test_symlinks_refused_even_with_force(self) -> None:
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_text("keep", encoding="utf-8")
        link = self.root / "README.md"
        link.unlink()
        link.symlink_to(outside)
        for force in (False, True):
            with self.assertRaises(generate.OutputError):
                generate.write(self.files, self.root, force=force)
        self.assertEqual(outside.read_text(encoding="utf-8"), "keep")


class GuardHookTests(unittest.TestCase):
    """The PreToolUse hook command must block every spelling of a path under generated/."""

    def run_guard(self, payload: object) -> int:
        stdin = io.StringIO(json.dumps(payload))
        with mock.patch("sys.stdin", stdin), redirect_stderr(io.StringIO()):
            return cli.cmd_guard_generated(None, None)  # type: ignore[arg-type]

    def test_blocks_generated_paths(self) -> None:
        for path in ("generated/monstera-sample/README.md",
                     "./generated/x",
                     "spec/../generated/monstera-sample/ios/xtool.yml",
                     str(REPO / "generated" / "monstera-sample" / "MONSTERA-MANIFEST.json"),
                     "generated"):
            with self.subTest(path):
                self.assertEqual(self.run_guard({"toolName": "fs_write", "toolInput": {"path": path}}), 2)

    def test_blocks_moves_and_deletes(self) -> None:
        self.assertEqual(self.run_guard({"toolInput": {"sourcePath": "README.md",
                                                       "destinationPath": "generated/x/README.md"}}), 2)
        self.assertEqual(self.run_guard({"toolInput": {"targetFile": "generated/x/a.kt"}}), 2)

    @unittest.skipUnless(os.name == "nt", "case-insensitive paths are a Windows property")
    def test_blocks_case_variants_on_windows(self) -> None:
        self.assertEqual(self.run_guard({"toolInput": {"path": "GENERATED/monstera-sample/README.md"}}), 2)

    def test_allows_other_paths(self) -> None:
        for path in ("spec/samples/monstera-sample/monstera.spec.json", "generated-notes.md",
                     "tools/monstera/monstera/templates/ios/xtool.yml.tmpl"):
            with self.subTest(path):
                self.assertEqual(self.run_guard({"toolInput": {"path": path}}), 0)


if __name__ == "__main__":
    unittest.main()
