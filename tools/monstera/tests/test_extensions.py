"""E2: developer-owned native extension roots. The generator emits only the build wiring and the no-op defaults inside the
engine-owned android/ and ios/ trees; <project>/extensions/** is never read, written, listed or deleted by it.
Every test that writes uses a temporary directory; nothing under the repository is modified.
"""
from __future__ import annotations
import json
import tempfile
import unittest
from pathlib import Path
from monstera import generate
from monstera.schema import SchemaStore
REPO = Path(__file__).resolve().parents[3]
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
LABEL = "apps/monstera-sample/monstera.spec.json"
EXTENSIONS = {
    "extensions/android/src/main/kotlin/monstera/extensions/MonsteraExtensions.kt": b"// mine\n",
    "extensions/android/src/test/kotlin/monstera/Mine.kt": b"// my test\n",
    "extensions/ios/MonsteraExtensions/Package.swift": b"// mine\n",
    "extensions/ios/MonsteraExtensions/Sources/MonsteraExtensions/Mine.swift": b"// mine\n",
    "extensions/SETUP.md": b"my notes\n",
}
KT_DEFAULT = "android/app/src/extensionDefaults/kotlin/monstera/extensions/MonsteraExtensions.kt"
SWIFT_DEFAULTS = ("ios/ExtensionDefaults/Package.swift", "ios/ExtensionDefaults/Sources/MonsteraExtensions/MonsteraExtensions.swift")
class ExtensionRootTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(REPO / "spec" / "schema")
        cls.spec = json.loads(SAMPLE.read_text(encoding="utf-8"))
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "app"
        self.root.mkdir()
        self.files = generate.plan(self.spec, LABEL, self.store, layout="app")
    def tearDown(self) -> None:
        self.tmp.cleanup()
    def text(self, path: str) -> str:
        return next(f.data for f in self.files if f.path == path).decode("utf-8")
    def put_extensions(self) -> None:
        for rel, data in EXTENSIONS.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_bytes(data)
    def assertExtensionsIntact(self) -> None:
        for rel, data in EXTENSIONS.items():
            self.assertEqual((self.root / rel).read_bytes(), data, f"extension file changed: {rel}")
    def test_no_planned_file_is_under_extensions(self) -> None:
        self.assertEqual([f.path for f in self.files if f.path.startswith("extensions")], [])
        manifest = json.loads(next(f.data for f in self.files if f.path == generate.MANIFEST))
        self.assertNotIn("extensions", " ".join(manifest["ownedRoots"]))
    def test_defaults_and_wiring_are_planned_inside_the_owned_trees(self) -> None:
        paths = {f.path for f in self.files}
        for p in (KT_DEFAULT, *SWIFT_DEFAULTS):
            self.assertIn(p, paths)
            self.assertTrue(generate._in_owned(p, ["android", "ios"]), p)
        gradle = self.text("android/app/build.gradle.kts")
        self.assertIn('rootProject.projectDir.resolve("../extensions/android")', gradle)
        self.assertIn("src/extensionDefaults/kotlin", gradle)
        self.assertIn('extensionsDir.resolve("src/test/kotlin")', gradle)
        package = self.text("ios/Package.swift")
        self.assertIn("../extensions/ios/MonsteraExtensions/Package.swift", package)
        self.assertIn('.package(path: extensionsPath)', package)
        self.assertIn('.product(name: "MonsteraExtensions", package: extensionsPackage)', package)
        self.assertIn("MonsteraExtensions.overlay()", self.text("ios/Sources/MonsteraSample/ContentView.swift"))
        self.assertIn("MonsteraExtensions.Overlay()", self.text("android/app/src/main/kotlin/app/monstera/sample/MainActivity.kt"))
    def test_default_and_extension_have_the_same_entry_point(self) -> None:
        self.assertIn("package monstera.extensions", self.text(KT_DEFAULT))
        self.assertIn("object MonsteraExtensions", self.text(KT_DEFAULT))
        self.assertIn("fun Overlay()", self.text(KT_DEFAULT))
        swift = self.text(SWIFT_DEFAULTS[1])
        self.assertIn("public enum MonsteraExtensions", swift)
        self.assertIn("public static func overlay()", swift)
        self.assertIn('.library(name: "MonsteraExtensions"', self.text(SWIFT_DEFAULTS[0]))
    def test_generation_never_writes_checks_or_deletes_extensions(self) -> None:
        generate.write(self.files, self.root)
        self.put_extensions()
        # Hand-written extension files are invisible to the ownership checks: no drift, no refusal, no deletion.
        self.assertTrue(generate.verify(self.root).clean)
        self.assertTrue(generate.check(self.files, self.root).clean)
        generate.write(self.files, self.root)
        generate.write(self.files, self.root, force=True)
        self.assertExtensionsIntact()
        self.assertTrue(generate.verify(self.root).clean)
    def test_regeneration_after_a_spec_change_keeps_extensions(self) -> None:
        generate.write(self.files, self.root)
        self.put_extensions()
        changed = json.loads(json.dumps(self.spec))
        changed["project"]["displayName"] = "Renamed"
        generate.write(generate.plan(changed, LABEL, self.store, layout="app"), self.root)
        self.assertExtensionsIntact()
        self.assertIn("Renamed", (self.root / "android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8"))
    def test_edits_to_the_generated_defaults_are_still_drift(self) -> None:
        generate.write(self.files, self.root)
        (self.root / KT_DEFAULT).write_text("// edited\n", encoding="utf-8")
        self.assertEqual(generate.verify(self.root).changed, (KT_DEFAULT,))
    def test_planning_is_deterministic(self) -> None:
        again = generate.plan(self.spec, LABEL, self.store, layout="app")
        self.assertEqual([(f.path, f.data) for f in self.files], [(f.path, f.data) for f in again])
if __name__ == "__main__":
    unittest.main()
