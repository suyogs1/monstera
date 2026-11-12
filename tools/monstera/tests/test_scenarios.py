"""Scenario format, recording, staleness, conformance comparison, runtime purity rules and the
behaviours the committed scenarios actually exercise."""
from __future__ import annotations

import json
from unittest import mock
import shutil
import tempfile
import unittest
from pathlib import Path

from monstera import archcheck, conformance, generate, scenario
from monstera.cli import DEFAULT_SCHEMAS
from monstera.jsonio import canonical_bytes, canonical_text, load_path, sha256_hex
from monstera.oracle import sim
from monstera.schema import SchemaStore

REPO = Path(__file__).resolve().parents[3]
SAMPLE_SCENARIOS = REPO / "spec" / "scenarios" / "monstera-sample"
LAB_SCENARIOS = REPO / "spec" / "scenarios" / "boundary-lab"


def game_for(project: str) -> dict:
    return json.loads((REPO / "spec" / "samples" / project / "monstera.spec.json").read_text(encoding="utf-8"))["game"]


def load_scenario(project: str, name: str) -> dict:
    return json.loads((REPO / "spec" / "scenarios" / project / f"{name}{scenario.SUFFIX}").read_text(encoding="utf-8"))


class Base(unittest.TestCase):
    store = SchemaStore.load(DEFAULT_SCHEMAS)

    def tmp_copy(self, project: str, name: str, mutate=None) -> Path:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        data = load_scenario(project, name)
        if mutate:
            mutate(data)
        path = tmp / f"{data['name']}{scenario.SUFFIX}"
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    def codes(self, path: Path) -> set:
        return {i.code for i in scenario.validate(path, self.store)[1]}


class ScenarioFiles(Base):
    def test_every_committed_scenario_matches_the_oracle(self) -> None:
        files = sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}"))
        self.assertGreaterEqual(len(files), 14)
        for path in files:
            self.assertEqual(scenario.check(path, self.store), [], path.name)

    def test_committed_files_are_canonical(self) -> None:
        for path in scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}"):
            self.assertEqual(path.read_bytes(), canonical_text(load_path(path)).encode(), path.name)

    def test_schema_rejects_unknown_and_malformed(self) -> None:
        cases = {
            "unknown property": lambda d: d.update(extra=1),
            "bad hash": lambda d: d["checkpoints"][0].update(hash="XYZ"),
            "bad direction": lambda d: d["inputs"][0]["events"][0].update(dir="sideways") if d["inputs"] else d.update(extra=1),
            "seed too large": lambda d: d.update(seed=2 ** 53),
            "zero ticks": lambda d: d.update(ticks=0),
            "bad name": lambda d: d.update(name="Bad Name"),
        }
        for label, mutate in cases.items():
            path = self.tmp_copy("monstera-sample", "input-order", mutate)
            self.assertTrue(scenario.validate(path, self.store)[1], label)

    def test_semantic_rules(self) -> None:
        def reverse_inputs(d): d["inputs"].reverse()
        self.assertIn("scenario.order", self.codes(self.tmp_copy("monstera-sample", "input-order", reverse_inputs)))
        self.assertIn("scenario.range", self.codes(self.tmp_copy("monstera-sample", "input-order", lambda d: d["inputs"][-1].update(tick=d["ticks"]))))
        self.assertIn("scenario.checkpoint-range", self.codes(self.tmp_copy("monstera-sample", "input-order", lambda d: d["checkpoints"][-1].update(tick=d["ticks"] + 1))))
        path = self.tmp_copy("monstera-sample", "input-order")
        renamed = path.with_name("other.scenario.json")
        path.rename(renamed)
        self.assertIn("scenario.name", self.codes(renamed))

    def test_stale_spec_is_detected(self) -> None:
        path = self.tmp_copy("monstera-sample", "idle", lambda d: d["spec"].update(sha256="0" * 64))
        self.assertIn("scenario.spec-stale", self.codes(path))
        with self.assertRaises(ValueError):
            scenario.load_for_project("monstera-sample", "f" * 64, self.store)

    def test_spec_path_cannot_escape_the_repository(self) -> None:
        path = self.tmp_copy("monstera-sample", "idle", lambda d: d["spec"].update(path="../../outside.json"))
        self.assertTrue(self.codes(path) & {"scenario.spec-path", "scenario.spec-missing"})

    def test_tampered_checkpoint_fails_oracle_check_and_record_restores_it(self) -> None:
        path = self.tmp_copy("monstera-sample", "input-order", lambda d: d["checkpoints"][5].update(hash="0" * 16))
        self.assertEqual({i.code for i in scenario.check(path, self.store)}, {"scenario.oracle-mismatch"})
        self.assertEqual(scenario.record(path, self.store), [])
        self.assertEqual(scenario.check(path, self.store), [])
        self.assertEqual(path.read_bytes(), (SAMPLE_SCENARIOS / "input-order.scenario.json").read_bytes(),
                         "recording is deterministic and idempotent")

    def test_unrecorded_scenario_is_rejected_by_check_and_generation(self) -> None:
        path = self.tmp_copy("monstera-sample", "idle", lambda d: d.update(checkpoints=[]))
        self.assertEqual({i.code for i in scenario.check(path, self.store)}, {"scenario.unrecorded"})


class ConformanceComparison(Base):
    def setUp(self) -> None:
        self.expected = load_scenario("monstera-sample", "input-order")["checkpoints"]
        self.actual = {c["tick"]: {"hash": c["hash"], "observe": dict(c["observe"])} for c in self.expected}

    def test_equal_output_passes(self) -> None:
        self.assertEqual(conformance.compare(self.expected, self.actual), [])

    def test_first_divergence_is_localized_with_fields(self) -> None:
        tick = self.expected[40]["tick"]
        for t in (tick, tick + 5):
            self.actual[t]["observe"]["score"] += 1
            self.actual[t]["hash"] = "ffffffffffffffff"
        [d] = conformance.compare(self.expected, self.actual)
        self.assertEqual((d["tick"], d["fields"]), (tick, ["score", "hash"]))

    def test_hash_only_difference_is_reported(self) -> None:
        self.actual[self.expected[3]["tick"]]["hash"] = "0" * 16
        [d] = conformance.compare(self.expected, self.actual)
        self.assertEqual((d["tick"], d["fields"]), (self.expected[3]["tick"], ["hash"]))

    def test_missing_checkpoint_is_a_divergence(self) -> None:
        del self.actual[self.expected[7]["tick"]]
        [d] = conformance.compare(self.expected, self.actual)
        self.assertEqual((d["tick"], d["fields"]), (self.expected[7]["tick"], ["missing"]))

    def test_output_from_the_wrong_platform_is_refused(self) -> None:
        line = json.dumps({"platform": "swift", "scenario": "x", "tick": 0, "hash": "0" * 16, "observe": [0] * 6})
        with self.assertRaises(conformance.ConformanceError):
            conformance.parse_output(line, "kotlin")
        self.assertEqual(conformance.parse_output(line, "swift")["x"][0]["observe"]["tick"], 0)

    def test_oracle_only_run_produces_a_schema_valid_report(self) -> None:
        report = conformance.run(REPO / "generated" / "monstera-sample", self.store, ["oracle"])
        self.assertEqual(self.store.validate(report, "conformance.schema.json"), [])
        self.assertEqual(report["verdict"], "incomplete", "the oracle alone is compared with its own recording")
        self.assertTrue(any(d["path"].endswith("Simulation.kt") for d in report["runtimeDigests"]))
        self.assertTrue(any(d["path"].endswith("Simulation.swift") for d in report["runtimeDigests"]))
        self.assertEqual({s["name"] for s in report["scenarios"]},
                         {p.name[:-len(scenario.SUFFIX)] for p in SAMPLE_SCENARIOS.glob("*.json")})

    def test_unknown_platform_and_arbitrary_images_are_refused(self) -> None:
        gen = REPO / "generated" / "monstera-sample"
        with self.assertRaises(conformance.ConformanceError):
            conformance.run(gen, self.store, ["bogus"])
        with self.assertRaises(conformance.ConformanceError):
            conformance.run(gen, self.store, [])
        for image in ("evil/image:latest", "swift:6.1-noble; rm -rf /", "swift:latest", "SWIFT:6.1"):
            with self.assertRaises(conformance.ConformanceError, msg=image):
                conformance.run(gen, self.store, ["swift"], image)

    def test_a_skipped_platform_is_incomplete_not_pass(self) -> None:
        gen = REPO / "generated" / "monstera-sample"
        with mock.patch.object(conformance, "_kotlin", return_value=("skipped", "no gradle")), \
                mock.patch.object(conformance, "_swift", return_value=("skipped", "no swift")):
            report = conformance.run(gen, self.store, ["oracle", "kotlin", "swift"])
        self.assertEqual({p["platform"]: p["status"] for p in report["platforms"]},
                         {"oracle": "pass", "kotlin": "skipped", "swift": "skipped"})
        self.assertEqual(report["verdict"], "incomplete")

    def test_all_three_platforms_passing_is_the_only_pass(self) -> None:
        gen = REPO / "generated" / "monstera-sample"
        def fake(gen_, out_file, *rest):
            platform = "kotlin" if "android" in str(out_file) or out_file.name.startswith("kotlin") else "swift"
            lines = []
            for sc in scenario.load_for_project("monstera-sample", json.loads((gen / generate.MANIFEST).read_text())["spec"]["sha256"], self.store):
                for c in sc["checkpoints"]:
                    lines.append(json.dumps({"platform": platform, "scenario": sc["name"], "tick": c["tick"], "hash": c["hash"],
                                             "observe": [c["observe"][k] for k in scenario.OBSERVABLES]}))
            out_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return "pass", "stub"
        with mock.patch.object(conformance, "_kotlin", side_effect=fake), mock.patch.object(conformance, "_swift", side_effect=fake):
            report = conformance.run(gen, self.store, ["oracle", "kotlin", "swift"])
        self.assertEqual(report["verdict"], "pass")

class ContainerAndPins(unittest.TestCase):
    def test_swift_container_is_offline_read_only_and_writes_only_results(self) -> None:
        pkg, results = Path("/repo/ios/Runtime"), Path("/tmp/results")
        argv = conformance.docker_command(pkg, results, "swift:6.1-noble")
        self.assertEqual(argv[argv.index("--network") + 1], "none")
        mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
        self.assertEqual(len(mounts), 2)
        self.assertTrue(mounts[0].endswith(":/pkg:ro"), "sources must be mounted read-only")
        self.assertTrue(mounts[1].endswith(":/out") and not mounts[1].endswith(":ro"))
        self.assertNotIn("--privileged", argv)

    def test_toolchain_pins_load_strictly_and_ci_uses_the_pinned_swift_image(self) -> None:
        image = generate.toolchain()["ios"]["swiftConformanceImage"]
        self.assertTrue(conformance.SWIFT_IMAGE.fullmatch(image))
        workflow = (REPO / ".github" / "workflows" / "monstera.yml").read_text(encoding="utf-8")
        self.assertNotIn("swift:6", workflow, "the conformance job must use --swift-image toolchain")
        self.assertIn("--swift-image toolchain", workflow)
        from monstera.jsonio import LoadError, loads_strict
        with self.assertRaises(LoadError):
            loads_strict('{"junit": "4.13.2", "junit": "4.13.2"}')


class WhatTheScenariosExercise(Base):
    """Guards against scenarios that pass without exercising the behaviour they claim to."""

    def trace(self, project: str, name: str):
        sc = load_scenario(project, name)
        cfg = sim.Config(game_for(project))
        w = sim.new_world(cfg, sc["seed"])
        by_tick = {s["tick"]: s["events"] for s in sc["inputs"]}
        for _ in range(sc["ticks"]):
            before = (w.score, w.lives, w.tick)
            sim.step(w, by_tick.get(w.tick, []))
            yield w, before

    def test_game_over_actually_ends_and_freezes(self) -> None:
        last = None
        for w, _ in self.trace("monstera-sample", "game-over"):
            last = (w.ended, w.tick, w.lives)
        self.assertTrue(last[0] and last[2] <= 0 and last[1] < 20000)

    def test_long_run_survives_10000_ticks(self) -> None:
        for w, _ in self.trace("monstera-sample", "long-run"):
            pass
        self.assertEqual((w.ended, w.tick), (False, 10000))
        self.assertGreater(w.score, 100)

    def test_entity_cap_is_reached(self) -> None:
        peak = max(len(w.entities) for w, _ in self.trace("monstera-sample", "entity-cap"))
        self.assertEqual(peak, game_for("monstera-sample")["runtime"]["maxEntities"])

    def test_collision_order_has_multi_kill_and_kill_plus_hit_ticks(self) -> None:
        multi = both = 0
        for w, (score, lives, _) in self.trace("monstera-sample", "collision-order"):
            multi += (w.score - score) >= 20
            both += (w.lives < lives) and (w.score - score) >= 10
        self.assertGreater(multi, 0)
        self.assertGreater(both, 0)

    def test_sample_scenarios_hit_every_wall_policy(self) -> None:
        kinds = {k["id"]: i for i, k in enumerate(game_for("monstera-sample")["runtime"]["kinds"])}
        flips = clamped = 0
        prev_vx = None
        for w, _ in self.trace("monstera-sample", "idle"):
            ball = next(e for e in w.entities if e.kind == kinds["ball"])
            if prev_vx is not None and (ball.vx > 0) != (prev_vx > 0):
                flips += 1
            prev_vx = ball.vx
            drifter = next(e for e in w.entities if e.kind == kinds["drifter"])
            clamped += drifter.x == w.cfg.world_w - w.cfg.kinds[kinds["drifter"]]["width"]
        self.assertGreater(flips, 0, "ball must bounce")
        self.assertGreater(clamped, 0, "saturated drifter must end up clamped at the wall")

    def test_lab_scenarios_pin_exact_edges(self) -> None:
        final = {}
        for name in ("touching-edges", "world-exit", "bounce-clamp", "lifetime-and-cap", "negative-rounding", "lives-end"):
            for w, _ in self.trace("boundary-lab", name):
                pass
            final[name] = (w.score, w.lives, w.ended, w.tick)
        self.assertEqual(final["touching-edges"][0], 8)
        self.assertEqual(final["lives-end"], (8, 0, True, 13))


class RuntimeCorePurity(unittest.TestCase):
    CLEAN = "package x.runtime\nobject Fx { fun add(a: Long, b: Long): Long = a + b } // Q16.16, 1.5 in comments is fine\n"

    def violations(self, text: str) -> list:
        return archcheck.check_runtime_core("generated/p/android/app/src/main/kotlin/x/runtime/A.kt", text)

    def test_clean_core_passes(self) -> None:
        self.assertEqual(self.violations(self.CLEAN), [])

    def test_each_forbidden_construct_is_flagged(self) -> None:
        bad = {
            "import android.os.Bundle": "platform import",
            "import SwiftUI": "platform import",
            "import Foundation": "platform import",
            "val x: Double = 0": "floating point type",
            "let y = 3.14": "floating point literal",
            "val z = kotlin.math.sqrt(2)": "floating point math",
            "val t = System.nanoTime()": "wall-clock time",
            "val r = kotlin.random.Random(1)": "system randomness",
            "val l = Locale.ROOT": "locale",
            "val s = v ushr 3": "logical shift",
        }
        for source, rule in bad.items():
            found = self.violations(self.CLEAN + source + "\n")
            self.assertTrue(any(rule in v.rule for v in found), source)

    def test_generated_cores_are_clean(self) -> None:
        self.assertEqual([v for v in archcheck.check(REPO) if "runtime core" in v.rule], [])


class GenerationEmbedsScenarios(Base):
    def test_resources_equal_on_both_platforms_and_deterministic(self) -> None:
        spec_path = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        sha = sha256_hex(canonical_bytes(spec))
        data = scenario.load_for_project("monstera-sample", sha, self.store)
        a = {f.path: f.data for f in generate.plan(spec, "x", self.store, scenarios=data)}
        b = {f.path: f.data for f in generate.plan(spec, "x", self.store, scenarios=data)}
        self.assertEqual(a, b)
        kt = a["android/app/src/test/resources/monstera-scenarios.txt"]
        sw = a["ios/Runtime/Tests/MonsteraRuntimeTests/Resources/monstera-scenarios.txt"]
        self.assertEqual(kt, sw)
        self.assertIn(b"scenario game-over 3 20000", kt)
        self.assertNotIn(b"\r", kt)

    def test_no_scenarios_still_generates_an_empty_resource(self) -> None:
        spec = json.loads((REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json").read_text(encoding="utf-8"))
        files = {f.path: f.data for f in generate.plan(spec, "x", self.store)}
        self.assertNotIn(b"scenario ", files["android/app/src/test/resources/monstera-scenarios.txt"])


if __name__ == "__main__":
    unittest.main()
