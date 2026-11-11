"""Adversarial regression tests (G2 review). Each test encodes a guarantee that an attack probe broke on
branch g2/deterministic-runtime at 847e491; every test here FAILS until the corresponding fix lands.
Probe ids (A1..) refer to .kiro/workflow-output/adversarial/attack.md."""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from monstera import archcheck, conformance, generate, scenario
from monstera.jsonio import canonical_text
from monstera.schema import SchemaStore
from monstera.validate import validate_value

REPO = Path(__file__).resolve().parents[3]
STORE = SchemaStore.load(REPO / "spec" / "schema")
PROJECT = "boundary-lab"
SWIFT_SIM = Path("ios/Runtime/Sources/MonsteraRuntime/Simulation.swift")


def copy_generated(tmp: Path) -> Path:
    dest = tmp / "gen"
    shutil.copytree(REPO / "generated" / PROJECT, dest, ignore=shutil.ignore_patterns("build", ".gradle", ".build"))
    return dest


class ConformanceReportIntegrity(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def test_a1_oracle_only_run_is_not_a_pass(self) -> None:
        """A1: the oracle checked against its own recording says nothing about Kotlin or Swift."""
        report = conformance.run(copy_generated(self.tmp), STORE, ["oracle"])
        self.assertNotEqual(report["verdict"], "pass")

    def test_a2_duplicate_records_for_one_tick_are_refused(self) -> None:
        """A2: a wrong record followed by a right one for the same tick must not be read as a pass."""
        bad = {"platform": "kotlin", "scenario": "s", "tick": 1, "hash": "0" * 16, "observe": [1, 0, 3, 0, 0, 1]}
        good = dict(bad, hash="1" * 16)
        text = json.dumps(bad) + "\n" + json.dumps(good) + "\n"
        with self.assertRaises(conformance.ConformanceError):
            conformance.parse_output(text, "kotlin")

    def test_a3_malformed_platform_output_is_a_conformance_error(self) -> None:
        """A3: hostile or truncated platform output must produce a clean error, not a traceback."""
        for text in ('{"platform":"kotlin"}', "[1]", '{"platform":"kotlin","scenario":"s","tick":0,"hash":"0","observe":[1]}'):
            with self.subTest(text=text):
                try:
                    parsed = conformance.parse_output(text, "kotlin")
                    conformance.compare([{"tick": 0, "hash": "0", "observe": dict.fromkeys(scenario.OBSERVABLES, 0)}],
                                        parsed.get("s", {}))
                except conformance.ConformanceError:
                    pass

    def test_a4_edited_runtime_source_is_refused(self) -> None:
        """A4: the report lists the manifest digests of runtime files; the files must be the ones the manifest names."""
        gen = copy_generated(self.tmp)
        with (gen / SWIFT_SIM).open("a", encoding="utf-8") as fh:
            fh.write("\n// hand edit\n")
        with self.assertRaises((conformance.ConformanceError, generate.OutputError)):
            conformance.run(gen, STORE, ["oracle"])

    def test_a5_manifest_without_scenario_resource_is_refused(self) -> None:
        """A5: a project that embeds no scenarios must not pass a check that is meant to prove they were run."""
        gen = copy_generated(self.tmp)
        manifest_path = gen / generate.MANIFEST
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"] = [f for f in manifest["files"] if not f["path"].endswith("monstera-scenarios.txt")]
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        for f in gen.rglob("monstera-scenarios.txt"):
            f.unlink()
        with self.assertRaises((conformance.ConformanceError, generate.OutputError)):
            conformance.run(gen, STORE, ["oracle"])


class ScenarioGuards(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name) / PROJECT
        shutil.copytree(REPO / "spec" / "scenarios" / PROJECT, self.dir)
        patcher = mock.patch.object(scenario, "SCENARIOS", self.dir.parent)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _spec_sha(self) -> str:
        return json.loads((REPO / "generated" / PROJECT / generate.MANIFEST).read_text(encoding="utf-8"))["spec"]["sha256"]

    def test_a6_generation_refuses_a_scenario_whose_checkpoints_are_not_the_oracles(self) -> None:
        """A6: `generate` embeds scenarios after schema+sha checks only; a hand-edited checkpoint becomes the golden truth."""
        path = self.dir / "touching-edges.scenario.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["checkpoints"][-1]["hash"] = "f" * 16
        path.write_bytes(canonical_text(data).encode("utf-8"))
        with self.assertRaises(ValueError):
            scenario.load_for_project(PROJECT, self._spec_sha(), STORE)

    def test_a7_scenario_without_final_checkpoint_is_refused(self) -> None:
        """A7: truncating the checkpoints to tick 0 leaves a scenario every runtime passes without running a tick."""
        path = self.dir / "touching-edges.scenario.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["checkpoints"] = data["checkpoints"][:1]
        path.write_bytes(canonical_text(data).encode("utf-8"))
        self.assertTrue(scenario.check(path, STORE), "a scenario with no checkpoint at its last tick must be reported")

    def test_a8_record_refuses_an_invalid_scenario(self) -> None:
        """A8: `scenarios record` must not write checkpoints for a scenario that validate() rejects (duplicate input ticks)."""
        path = self.dir / "touching-edges.scenario.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["inputs"].append({"tick": data["ticks"] - 1, "events": [{"type": "tap", "dx": 0, "dy": 0, "dir": "none"}]})
        data["inputs"].insert(0, {"tick": data["ticks"] - 1, "events": [{"type": "tap", "dx": 0, "dy": 0, "dir": "none"}]})
        path.write_bytes(canonical_text(data).encode("utf-8"))
        issues = scenario.record(path, STORE)
        self.assertTrue(issues, "record accepted a scenario with non-ascending input ticks")


class OracleCost(unittest.TestCase):
    def test_a13_schema_valid_worst_case_scenario_is_rejected_before_it_hangs_the_oracle(self) -> None:
        """A13: maxEntities 1024, 3 same-kind rules and 100000 ticks is schema-valid and costs ~1 s per tick in the
        oracle (hours, no timeout) for `scenarios record`, `validate-scenario --oracle`, `conformance` and the MCP
        `run_conformance` tool. A work bound must reject it at validation time."""
        from types import SimpleNamespace
        spec = json.loads((REPO / "spec" / "samples" / PROJECT / "monstera.spec.json").read_text(encoding="utf-8"))
        rt = spec["game"]["runtime"]
        rt["maxEntities"] = 1024
        rt["collisions"] = [dict(a=rt["kinds"][0]["id"], b=rt["kinds"][0]["id"], despawnA=False, despawnB=False, score=1, lives=0)] * 3
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "touching-edges.scenario.json"
            data = json.loads((REPO / "spec" / "scenarios" / PROJECT / "touching-edges.scenario.json").read_text(encoding="utf-8"))
            data["ticks"] = 100000
            path.write_bytes(canonical_text(data).encode("utf-8"))
            with mock.patch.object(scenario, "_spec_for", return_value=(SimpleNamespace(spec=spec), [])):
                _, issues = scenario.validate(path, STORE)
        self.assertTrue(issues, "a 100000-tick scenario over a 1024-entity world with 3 rules was accepted")


class RecordInterruption(unittest.TestCase):
    def test_a12_interrupted_record_leaves_the_committed_golden_file_intact(self) -> None:
        """A12: `scenarios record` rewrites the committed golden file in place; a failure mid-write (disk full, kill)
        destroys it. The generator replaces files atomically; the recorder must too."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / PROJECT
            shutil.copytree(REPO / "spec" / "scenarios" / PROJECT, target)
            path = target / "touching-edges.scenario.json"
            original = path.read_bytes()
            data = json.loads(original)
            data["checkpoints"] = []
            path.write_bytes(canonical_text(data).encode("utf-8"))
            before = path.read_bytes()
            real = Path.write_bytes

            def half_write(self: Path, payload: bytes) -> int:
                real(self, payload[:10])
                raise OSError("disk full")

            with mock.patch.object(Path, "write_bytes", half_write), self.assertRaises(OSError):
                scenario.record(path, STORE)
            self.assertEqual(path.read_bytes(), before)


class CorePurityRules(unittest.TestCase):
    KT = "generated/x/android/app/src/main/kotlin/app/x/runtime/Evil.kt"
    SW = "generated/x/ios/Runtime/Sources/MonsteraRuntime/Evil.swift"

    def test_a10_float_use_without_a_float_type_name_is_flagged(self) -> None:
        """A10: `x.toDouble()`, `2f`, `1e3`, `.squareRoot()` are floating point but contain no banned token."""
        cases = [
            (self.KT, "fun f(a: Int) = a.toDouble()"),
            (self.KT, "val half = 2f"),
            (self.KT, "val big = 1e3"),
            (self.KT, "fun f(a: Int) = a.toFloat()"),
            (self.SW, "let r = x.squareRoot()"),
            (self.SW, "let v = 1e3"),
            (self.SW, "let a = [1, 2].shuffled()"),
            (self.SW, "let a = [1, 2].randomElement()"),
        ]
        for rel, code in cases:
            with self.subTest(code=code):
                self.assertTrue(archcheck.check_runtime_core(rel, code), f"not flagged: {code}")

    def test_a11_core_sources_in_subdirectories_are_scanned(self) -> None:
        """A11: SwiftPM and Gradle compile nested directories; archcheck only reads files directly in the core directory."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in ("generated/x/ios/Runtime/Sources/MonsteraRuntime/Sub/Evil.swift",
                        "generated/x/android/app/src/main/kotlin/app/x/runtime/sub/Evil.kt"):
                path = root / rel
                path.parent.mkdir(parents=True)
                path.write_text("val d: Double = 1.0\n", encoding="utf-8")
            flagged = {v.path for v in archcheck.check(root)}
            self.assertEqual(len(flagged), 2, f"only {sorted(flagged)} flagged")


class SpecValidatorRobustness(unittest.TestCase):
    def test_a9_validator_never_raises_on_schema_valid_but_odd_numbers(self) -> None:
        """A9: validate_value returns issues for any JSON value; it must not raise."""
        spec = json.loads((REPO / "spec" / "samples" / PROJECT / "monstera.spec.json").read_text(encoding="utf-8"))
        for width in (float("nan"), 1e5, 0.5, 1e-320, 5e-324, 32767.0, 99999.99999999999):
            with self.subTest(width=width):
                candidate = json.loads(json.dumps(spec))
                candidate["game"]["world"]["width"] = width
                validate_value(candidate, STORE)


if __name__ == "__main__":
    unittest.main()
