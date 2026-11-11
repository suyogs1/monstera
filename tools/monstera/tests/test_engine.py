"""Tests for the MONSTERA specification engine (stdlib unittest).

Run: python3 -m unittest discover -s tools/monstera/tests -t tools/monstera -v
"""

from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from monstera import archcheck, generate
from monstera.jsonio import LoadError, canonical_bytes, loads_strict, sha256_hex
from monstera.schema import SchemaError, SchemaStore
from monstera.typemodel import Enum, build
from monstera.validate import validate_path, validate_value

REPO = Path(__file__).resolve().parents[3]
SCHEMAS = REPO / "spec" / "schema"
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
CASES = json.loads((REPO / "spec" / "fixtures" / "invalid-cases.json").read_text(encoding="utf-8"))
RAW = REPO / "spec" / "fixtures" / "raw"
COMMITTED = REPO / "generated" / "monstera-sample"


def _sample() -> dict:
    return json.loads(SAMPLE.read_text(encoding="utf-8"))


def _apply(spec: dict, case: dict) -> dict:
    spec = copy.deepcopy(spec)
    for pointer, value in case.get("set", {}).items():
        *parents, last = pointer.strip("/").split("/")
        node = spec
        for token in parents:
            node = node[token]
        node[last] = value
    for pointer in case.get("remove", []):
        *parents, last = pointer.strip("/").split("/")
        node = spec
        for token in parents:
            node = node[token]
        del node[last]
    return spec


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(SCHEMAS)


class ValidationTests(Base):
    def test_sample_is_valid(self) -> None:
        result = validate_path(SAMPLE, self.store)
        self.assertEqual(result.issues, ())

    def test_invalid_cases_report_expected_issues(self) -> None:
        for case in CASES["cases"]:
            with self.subTest(case["name"]):
                result = validate_value(_apply(_sample(), case), self.store)
                self.assertFalse(result.ok)
                for exp in case["expect"]:
                    matches = [i for i in result.issues if i.path == exp["path"] and i.code == exp["code"]]
                    self.assertTrue(matches, f"no {exp['code']} at {exp['path']}; got {list(map(str, result.issues))}")
                    self.assertIn(exp["contains"], matches[0].message)

    def test_validation_is_deterministic_and_sorted(self) -> None:
        case = next(c for c in CASES["cases"] if c["name"].startswith("several errors"))
        first = validate_value(_apply(_sample(), case), self.store).issues
        second = validate_value(_apply(_sample(), case), self.store).issues
        self.assertEqual(first, second)
        self.assertEqual(list(first), sorted(first))

    def test_semantic_rules_run_only_after_schema_passes(self) -> None:
        # Both a schema error and a would-be semantic error: only the schema error is reported.
        spec = _apply(_sample(), {"set": {"/game/genre": "rpg", "/game/world/width": 1920, "/game/world/height": 1080}})
        codes = {i.code for i in validate_value(spec, self.store).issues}
        self.assertEqual(codes, {"enum"})

    def test_malformed_json_has_line_and_column(self) -> None:
        result = validate_path(RAW / "trailing-comma.json", self.store)
        self.assertEqual(result.issues[0].code, "json.parse")
        # Python <3.13 reports the token after the comma (line 4); 3.13+ the comma itself (line 3).
        self.assertRegex(result.issues[0].path, r"trailing-comma\.json:line [34], column \d+")

    def test_duplicate_key_points_at_second_occurrence(self) -> None:
        result = validate_path(RAW / "duplicate-key.json", self.store)
        self.assertEqual(result.issues[0].code, "json.duplicate-key")
        self.assertIn("line 3", result.issues[0].path)

    def test_non_finite_numbers_rejected(self) -> None:
        with self.assertRaises(LoadError) as ctx:
            loads_strict('{"a": NaN}')
        self.assertEqual(ctx.exception.code, "json.non-finite")


class CanonicalTests(Base):
    def test_committed_sample_is_canonical(self) -> None:
        on_disk = SAMPLE.read_bytes().replace(b"\r\n", b"\n")
        self.assertEqual(on_disk, canonical_bytes(_sample()))

    def test_key_order_and_whitespace_do_not_change_hash(self) -> None:
        spec = _sample()
        reordered = json.loads(json.dumps(spec), object_pairs_hook=lambda pairs: dict(reversed(pairs)))
        compact = json.dumps(reordered, separators=(",", ":"))
        self.assertEqual(sha256_hex(canonical_bytes(loads_strict(compact))), sha256_hex(canonical_bytes(spec)))


class SchemaGuardTests(unittest.TestCase):
    def test_unsupported_keyword_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("project.schema.json", "game.schema.json"):
                shutil.copy(SCHEMAS / name, tmp)
            root = json.loads((SCHEMAS / "monstera.spec.schema.json").read_text(encoding="utf-8"))
            root["properties"]["specVersion"]["multipleOf"] = 1
            Path(tmp, "monstera.spec.schema.json").write_text(json.dumps(root), encoding="utf-8")
            with self.assertRaises(SchemaError):
                SchemaStore.load(Path(tmp))


class GenerationTests(Base):
    def _plan(self, spec: dict | None = None) -> list[generate.OutFile]:
        return generate.plan(spec or _sample(), "spec/samples/monstera-sample/monstera.spec.json", self.store)

    def test_plan_is_reproducible(self) -> None:
        self.assertEqual(self._plan(), self._plan())

    def test_written_trees_are_byte_identical(self) -> None:
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            generate.write(self._plan(), Path(a))
            generate.write(self._plan(), Path(b))
            files_a = sorted(p.relative_to(a).as_posix() for p in Path(a).rglob("*") if p.is_file())
            files_b = sorted(p.relative_to(b).as_posix() for p in Path(b).rglob("*") if p.is_file())
            self.assertEqual(files_a, files_b)
            for rel in files_a:
                self.assertEqual(Path(a, rel).read_bytes(), Path(b, rel).read_bytes(), rel)

    def test_committed_output_matches_fresh_generation(self) -> None:
        drift = generate.check(self._plan(), COMMITTED)
        self.assertTrue(drift.clean, f"regenerate generated/monstera-sample: {drift}")

    def test_manifest_lists_every_file_with_correct_hash(self) -> None:
        files = self._plan()
        manifest = json.loads(next(f for f in files if f.path == generate.MANIFEST).data)
        listed = {e["path"]: e["sha256"] for e in manifest["files"]}
        actual = {f.path: sha256_hex(f.data) for f in files if f.path != generate.MANIFEST}
        self.assertEqual(listed, actual)
        self.assertNotIn("time", json.dumps(manifest).lower())

    def test_drift_detection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._plan()
            generate.write(files, root)
            self.assertTrue(generate.check(files, root).clean)
            (root / "README.md").write_text("hand edit", encoding="utf-8")
            (root / "android" / "extra.txt").write_text("stray", encoding="utf-8")
            (root / "android" / "build").mkdir()
            (root / "android" / "build" / "ignored.bin").write_bytes(b"build output")
            drift = generate.check(files, root)
            self.assertEqual(drift.changed, ("README.md",))
            self.assertEqual(drift.unexpected, ("android/extra.txt",))
            for force in (False, True):  # a stray file is never deleted, not even with --force (G1.5)
                with self.assertRaises(generate.OutputError):
                    generate.write(files, root, force=force)
            self.assertTrue((root / "android" / "extra.txt").exists())
            (root / "android" / "extra.txt").unlink()  # the user removes it deliberately
            with self.assertRaises(generate.OutputError):  # hand edits are never silently discarded
                generate.write(files, root)
            generate.write(files, root, force=True)  # explicit --force discards the edit, keeps build output
            self.assertTrue(generate.check(files, root).clean)
            self.assertTrue((root / "android" / "build" / "ignored.bin").exists())

    def test_refuses_to_overwrite_unmanaged_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "keep.txt").write_text("mine", encoding="utf-8")
            with self.assertRaises(generate.OutputError):
                generate.write(self._plan(), Path(tmp))

    def test_both_platforms_embed_identical_canonical_spec(self) -> None:
        files = {f.path: f for f in self._plan()}
        android = files["android/app/src/main/assets/monstera.spec.json"].data
        ios = files["ios/Sources/MonsteraSample/Resources/monstera.spec.json"].data
        self.assertEqual(android, ios)
        self.assertEqual(android, canonical_bytes(_sample()))
        sha = sha256_hex(android)
        kotlin = files["android/app/src/main/kotlin/app/monstera/sample/generated/GeneratedSpec.kt"].data.decode()
        swift = files["ios/Sources/MonsteraSample/Generated/GeneratedSpec.swift"].data.decode()
        self.assertIn(f'SHA256: String = "{sha}"', kotlin)
        self.assertIn(f'sha256 = "{sha}"', swift)

    def test_every_schema_type_is_emitted_on_both_platforms(self) -> None:
        files = {f.path: f.data.decode() for f in self._plan() if f.kind == "model"}
        kotlin = files["android/app/src/main/kotlin/app/monstera/sample/generated/MonsteraSpec.kt"]
        swift = files["ios/Sources/MonsteraSample/Generated/MonsteraSpec.swift"]
        for name, t in build(self.store).types.items():
            kw_kt, kw_sw = ("enum class", "enum") if isinstance(t, Enum) else ("data class", "struct")
            self.assertIn(f"{kw_kt} {name}(", kotlin)
            self.assertIn(f"{kw_sw} {name}:", swift)

    def test_generated_text_files_are_marked(self) -> None:
        for f in self._plan():
            if f.kind in ("template", "model"):
                self.assertIn(b"GENERATED by monstera-generator", f.data[:400], f.path)

    def test_line_endings_are_fixed(self) -> None:
        for f in self._plan():
            if f.path.endswith(".bat"):
                self.assertNotIn(b"\n", f.data.replace(b"\r\n", b""), f.path)
            elif not f.path.endswith(".jar"):
                self.assertNotIn(b"\r", f.data, f.path)

    def test_targets_limit_output(self) -> None:
        spec = _apply(_sample(), {"set": {"/project/targets": ["android"]}})
        paths = [f.path for f in self._plan(spec)]
        self.assertTrue(any(p.startswith("android/") for p in paths))
        self.assertFalse(any(p.startswith("ios/") for p in paths))

    def test_spec_change_changes_spec_dependent_files_only(self) -> None:
        before = {f.path: f.data for f in self._plan()}
        after = {f.path: f.data for f in self._plan(_apply(_sample(), {"set": {"/game/targetFps": 120}}))}
        self.assertEqual(before.keys(), after.keys())
        self.assertEqual(before["android/gradlew"], after["android/gradlew"])
        self.assertNotEqual(before["android/app/src/main/assets/monstera.spec.json"],
                            after["android/app/src/main/assets/monstera.spec.json"])


class ArchitectureTests(unittest.TestCase):
    def test_repository_is_clean(self) -> None:
        self.assertEqual(archcheck.check(REPO), [])

    def test_forbidden_frameworks_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "package.json").write_text('{"dependencies": {"react-native": "0.80.0"}}', encoding="utf-8")
            Path(tmp, "pubspec.yaml").write_text("name: x", encoding="utf-8")
            sub = Path(tmp, "app")
            sub.mkdir()
            sub.joinpath("build.gradle.kts").write_text('plugins { kotlin("multiplatform") }', encoding="utf-8")
            rules = {(v.path, v.rule) for v in archcheck.check(Path(tmp))}
            self.assertIn(("package.json", "React Native"), rules)
            self.assertIn(("pubspec.yaml", "Flutter project file"), rules)
            self.assertIn(("app/build.gradle.kts", "Kotlin Multiplatform"), rules)


if __name__ == "__main__":
    unittest.main()
