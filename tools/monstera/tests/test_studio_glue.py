"""Studio glue (studio/src/engine/glue.py) on host CPython: export goldens rules, export label, preview recovery.

The glue normally runs in Pyodide with the repository mounted at /repo; MONSTERA_STUDIO_REPO points it at this
checkout. Includes the regression tests of the M2 adversarial review (workflow wf_d86b541f4b210b32) and the
StaleScenarios rule: only goldens recorded for another spec SHA-256 are omitted; every other scenario failure refuses
the export with the engine's own message, exactly as `monstera generate` does.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from monstera import scenario
from monstera.cli import DEFAULT_SCHEMAS
from monstera.jsonio import canonical_text, load_path
from monstera.oracle import loop, sim
from monstera.schema import SchemaStore
from monstera.validate import validate_path

REPO = Path(__file__).resolve().parents[3]
LANTERN = "spec/samples/lantern-run/monstera.spec.json"
PUMPKIN = "apps/pumpkin-blaster/monstera.spec.json"
STORE = SchemaStore.load(DEFAULT_SCHEMAS)


def load_glue():
    with mock.patch.dict(os.environ, {"MONSTERA_STUDIO_REPO": str(REPO)}):
        spec = importlib.util.spec_from_file_location("studio_glue", REPO / "studio" / "src" / "engine" / "glue.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


GLUE = load_glue()


def text_of(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def edited_pumpkin() -> str:
    doc = json.loads(text_of(PUMPKIN))
    doc["game"]["runtime"]["lives"] += 2
    return canonical_text(doc)


class StaleScenariosTests(unittest.TestCase):
    def test_stale_is_a_value_error_with_the_unchanged_message(self) -> None:
        sha = validate_path(REPO / PUMPKIN, STORE).sha256
        with self.assertRaises(scenario.StaleScenarios) as ctx:
            scenario.load_for_project("pumpkin-blaster", "0" * 64, STORE)
        self.assertIsInstance(ctx.exception, ValueError)
        self.assertEqual(str(ctx.exception), "frame-jitter-60hz.scenario.json: recorded against a different spec; "
                                             "run `monstera scenarios record`")
        self.assertEqual(len(scenario.load_for_project("pumpkin-blaster", sha, STORE)), 5)

    def test_cli_generate_still_refuses_a_stale_spec_with_exit_1_and_the_same_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp) / "monstera.spec.json"
            spec.write_text(edited_pumpkin(), encoding="utf-8")
            code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))"
            proc = subprocess.run([sys.executable, "-c", code, "generate", str(spec), "--out", str(Path(tmp) / "out"), "--layout", "app"],
                                  cwd=REPO, capture_output=True, text=True, encoding="utf-8",
                                  env=dict(os.environ, PYTHONPATH=str(REPO / "tools" / "monstera")))
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(proc.stderr.strip(), "generate: frame-jitter-60hz.scenario.json: recorded against a different spec; "
                                                  "run `monstera scenarios record`")
            self.assertFalse((Path(tmp) / "out").exists())


class ExportGoldensTests(unittest.TestCase):
    """Corrupt a temporary copy of pumpkin-blaster's goldens; the committed files are never touched."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "scenarios"
        shutil.copytree(REPO / "spec" / "scenarios" / "pumpkin-blaster", self.root / "pumpkin-blaster")
        patcher = mock.patch.object(scenario, "SCENARIOS", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)
        self.target = self.root / "pumpkin-blaster" / "sweep-and-fire.scenario.json"

    def rewrite(self, fn) -> None:
        data = load_path(self.target)
        fn(data)
        self.target.write_text(canonical_text(data), encoding="utf-8")

    def export(self, text: str) -> dict:
        return json.loads(GLUE.export_plan(text, PUMPKIN))

    def engine_error(self) -> str:
        sha = validate_path(REPO / PUMPKIN, STORE).sha256
        with self.assertRaises(ValueError) as ctx:
            scenario.load_for_project("pumpkin-blaster", sha, STORE)
        self.assertNotIsInstance(ctx.exception, scenario.StaleScenarios)
        return str(ctx.exception)

    def assert_refused_like_the_cli(self) -> None:
        r = self.export(text_of(PUMPKIN))
        self.assertEqual(r, {"ok": False, "message": self.engine_error()})  # no files, so no ZIP

    def test_unedited_template_embeds_its_goldens(self) -> None:
        r = self.export(text_of(PUMPKIN))
        self.assertTrue(r["ok"])
        self.assertEqual((r["scenariosIncluded"], r["scenariosOmitted"]), (5, None))

    def test_stale_spec_sha_omits_the_goldens_with_an_accurate_count_and_reason(self) -> None:
        r = self.export(edited_pumpkin())
        self.assertTrue(r["ok"])
        self.assertEqual(r["scenariosIncluded"], 0)
        self.assertEqual(r["scenariosOmitted"]["count"], 5)
        self.assertIn("recorded against a different spec", r["scenariosOmitted"]["reason"])

    def test_corrupted_checkpoint_with_the_current_spec_refuses_the_export(self) -> None:
        self.rewrite(lambda d: d["checkpoints"][-1].update(hash="f" * 16))
        self.assert_refused_like_the_cli()

    def test_invalid_scenario_refuses_the_export(self) -> None:
        self.rewrite(lambda d: d.update(ticks=d["ticks"] + 1))  # the last checkpoint is no longer at `ticks`
        self.assert_refused_like_the_cli()

    def test_unrecorded_scenario_refuses_the_export(self) -> None:
        self.rewrite(lambda d: d.update(checkpoints=[]))
        self.assert_refused_like_the_cli()


class ExportLabelTests(unittest.TestCase):
    def test_export_label_follows_the_exact_template_not_a_wrong_declared_origin(self) -> None:
        """Adversarial #1: a draft identical to lantern-run exports like `monstera generate` does for it."""
        text = text_of(LANTERN)
        right = json.loads(GLUE.export_plan(text, LANTERN))
        wrong = json.loads(GLUE.export_plan(text, PUMPKIN))
        none = json.loads(GLUE.export_plan(text, ""))
        for r in (right, wrong, none):
            self.assertEqual((r["label"], r["layout"], r["manifestSha256"]), (LANTERN, "fixture", right["manifestSha256"]))

    def test_renamed_id_and_unknown_origins(self) -> None:
        doc = json.loads(text_of(PUMPKIN))
        doc["project"]["id"] = "renamed-game"
        r = json.loads(GLUE.export_plan(canonical_text(doc), PUMPKIN))
        self.assertEqual((r["label"], r["layout"], r["scenariosIncluded"], r["scenariosOmitted"]),
                         ("apps/renamed-game/monstera.spec.json", "app", 0, None))
        self.assertTrue(all(f["path"].split("/")[0] in ("android", "ios", ".kiro", "MONSTERA-MANIFEST.json") for f in r["files"]))
        for bad in ("../../etc/passwd", "tools/monstera/monstera/scenario.py", "spec/samples"):
            self.assertEqual(json.loads(GLUE.export_plan(text_of(PUMPKIN), bad))["ok"], False, bad)


class PreviewRecoveryTests(unittest.TestCase):
    def test_a_failing_preview_frame_leaves_the_session_replayable_from_its_trace(self) -> None:
        """Adversarial #3: a frame that raises after applying part of its input must not desynchronize the live world
        from its trace, nor wedge later frames."""
        text = text_of(PUMPKIN)
        session = json.loads(GLUE.preview_start(text, 4242))["session"]
        GLUE.preview_frame(session, 0, "[]")
        for _ in range(5):
            GLUE.preview_frame(session, 16_666_667, "[]")
        drag = {"type": "drag", "dx": 65536, "dy": 0, "dir": "none"}
        failed = json.loads(GLUE.preview_frame(session, 16_666_667, json.dumps([drag, "not an event"])))
        self.assertFalse(failed["ok"])
        for _ in range(5):
            self.assertTrue(json.loads(GLUE.preview_frame(session, 16_666_667, "[]"))["ok"])
        trace = json.loads(GLUE.preview_trace())
        game = json.loads(text)["game"]
        replay = loop.GameLoop(sim.new_world(sim.Config(game), trace["seed"]), game["simulation"]["tickRate"],
                               game["simulation"]["maxTicksPerFrame"])
        for nanos, events in trace["frames"]:
            for event in events:
                replay.submit(event)
            replay.frame(nanos)
        self.assertEqual(trace["hash"], format(sim.state_hash(replay.world), "016x"))
        self.assertEqual(trace["tick"], replay.world.tick)


if __name__ == "__main__":
    unittest.main()
