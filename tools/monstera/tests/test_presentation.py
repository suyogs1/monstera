"""G4 visual batch: the presentation fields (spec v4) are validated, have documented neutral values,
and cannot reach the simulation (contract section 9)."""
from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from monstera import archcheck, emit_runtime, generate, scenario
from monstera.jsonio import load_path
from monstera.oracle import sim
from monstera.schema import SchemaStore
from monstera.validate import validate_value

REPO = Path(__file__).resolve().parents[3]
STORE = SchemaStore.load(REPO / "spec" / "schema")
SAMPLE = REPO / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"
SPECS = {
    "pumpkin-blaster": REPO / "apps" / "pumpkin-blaster" / "monstera.spec.json",
    "trick-or-treat-rush": REPO / "apps" / "trick-or-treat-rush" / "monstera.spec.json",
    "monstera-sample": SAMPLE,
    "boundary-lab": REPO / "spec" / "samples" / "boundary-lab" / "monstera.spec.json",
}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def issues(spec: dict) -> list[tuple[str, str]]:
    return [(i.path, i.code) for i in validate_value(spec, STORE).issues]


class VisualSchemaTests(unittest.TestCase):
    def edit(self, fn) -> dict:
        spec = load(SAMPLE)
        fn(spec)
        return spec

    def test_all_shipped_specs_are_valid_v4(self) -> None:
        for name, path in SPECS.items():
            spec = load(path)
            self.assertEqual(spec["specVersion"], 4, name)
            self.assertEqual(issues(spec), [], name)

    def test_neutral_values_of_the_samples_are_the_documented_defaults(self) -> None:
        for name in ("monstera-sample", "boundary-lab"):
            game = load(SPECS[name])["game"]
            self.assertEqual(game["hud"], {"lifeGlyph": "", "scoreLabel": "score"}, name)
            self.assertEqual(game["screens"], {"startHint": "Tap to start", "winTitle": "You win", "loseTitle": "Game over"}, name)
            for kind in game["runtime"]["kinds"]:
                self.assertEqual((kind["glyph"], kind["effect"]), ("", "none"), name)

    def test_accepted_glyphs_and_texts(self) -> None:
        for glyph in ("", "\u2665", "\U0001F383", "\u26B0\uFE0F", "\U0001F468\u200D\U0001F469\u200D\U0001F467"):
            spec = self.edit(lambda s, g=glyph: s["game"]["runtime"]["kinds"][0].update(glyph=g))
            self.assertEqual(issues(spec), [], repr(glyph))
        spec = self.edit(lambda s: s["game"]["screens"].update(startHint="x" * 40))
        self.assertEqual(issues(spec), [])

    def test_rejected_glyphs(self) -> None:
        cases = {"nine code points": "a" * 9, "quote": '"', "backslash": "\\", "dollar": "$", "newline": "\n",
                 "control": "\u0007", "delete": "\u007f", "number": 5}
        for label, glyph in cases.items():
            spec = self.edit(lambda s, g=glyph: s["game"]["runtime"]["kinds"][0].update(glyph=g))
            found = issues(spec)
            self.assertTrue(found and found[0][0] == "$.game.runtime.kinds[0].glyph", f"{label}: {found}")

    def test_rejected_texts(self) -> None:
        for field in ("startHint", "winTitle", "loseTitle"):
            for label, value in {"empty": "", "41 characters": "x" * 41, "quote": 'say "hi"', "tab": "a\tb", "dollar": "$5"}.items():
                spec = self.edit(lambda s, f=field, v=value: s["game"]["screens"].update({f: v}))
                self.assertTrue(issues(spec), f"{field} {label}")
        spec = self.edit(lambda s: s["game"]["hud"].update(scoreLabel=""))
        self.assertTrue(issues(spec))

    def test_effect_is_a_closed_enum_with_a_hint(self) -> None:
        spec = self.edit(lambda s: s["game"]["runtime"]["kinds"][0].update(effect="sparkle"))
        result = validate_value(spec, STORE)
        self.assertEqual([i.code for i in result.issues], ["enum"])
        for effect in ("none", "burst", "pickup"):
            ok = self.edit(lambda s, e=effect: s["game"]["runtime"]["kinds"][0].update(effect=e))
            self.assertEqual(issues(ok), [])

    def test_every_visual_field_is_required_and_closed(self) -> None:
        for path in (("game", "hud"), ("game", "screens"), ("game", "hud", "lifeGlyph"), ("game", "screens", "winTitle")):
            def remove(s, p=path):
                node = s
                for key in p[:-1]:
                    node = node[key]
                del node[p[-1]]
            self.assertTrue(any(code == "required" for _, code in issues(self.edit(remove))), path)
        for key in ("glyph", "effect"):
            spec = self.edit(lambda s, k=key: s["game"]["runtime"]["kinds"][0].pop(k))
            self.assertTrue(any(code == "required" for _, code in issues(spec)), key)
        spec = self.edit(lambda s: s["game"]["hud"].update(extra=1))
        self.assertTrue(any(code == "additionalProperties" for _, code in issues(spec)))

    def test_v3_is_rejected_with_the_new_version(self) -> None:
        spec = self.edit(lambda s: s.update(specVersion=3))
        result = validate_value(spec, STORE)
        self.assertIn("must be 4", result.issues[0].message)


def visual_variant(spec: dict) -> dict:
    """The same game with every presentation field changed (including the display-only color)."""
    out = copy.deepcopy(spec)
    game = out["game"]
    game["hud"] = {"lifeGlyph": "\U0001F49A", "scoreLabel": "POINTS"}
    game["screens"] = {"startHint": "Other hint", "winTitle": "Other win", "loseTitle": "Other lose"}
    for i, kind in enumerate(game["runtime"]["kinds"]):
        kind["glyph"] = "\U0001F383"
        kind["effect"] = ("burst", "pickup", "none")[i % 3]
        kind["color"] = "#123456"
    return out


class PresentationCannotReachTheSimulationTests(unittest.TestCase):
    def test_goldens_and_runtime_config_are_independent_of_every_visual_field(self) -> None:
        checked = 0
        for project in ("pumpkin-blaster", "trick-or-treat-rush", "monstera-sample", "boundary-lab"):
            spec = load(SPECS[project])
            variant = visual_variant(spec)
            self.assertNotEqual(validate_value(spec, STORE).sha256, validate_value(variant, STORE).sha256)
            self.assertEqual(issues(variant), [], project)
            # The generated runtime configuration (what the native cores are built from) is identical.
            package = spec["project"]["identifier"]
            self.assertEqual(emit_runtime.kotlin_config(spec["game"], package, ""), emit_runtime.kotlin_config(variant["game"], package, ""))
            self.assertEqual(emit_runtime.swift_config(spec["game"], ""), emit_runtime.swift_config(variant["game"], ""))
            # The oracle produces the recorded checkpoints for the changed game, tick for tick.
            for path in scenario.scenario_files(project):
                data = load_path(path)
                if data["frames"]["count"]:
                    continue
                got = [{"tick": r["tick"], "hash": format(r["hash"], "016x"), "observe": r["observe"]}
                       for r in sim.run_scenario(sim.Config(variant["game"]), data)]
                self.assertEqual(got, data["checkpoints"], f"{project}/{path.name}")
                checked += 1
        self.assertGreaterEqual(checked, 8)

    def test_runtime_sources_contain_no_presentation_data(self) -> None:
        spec = load(SPECS["trick-or-treat-rush"])
        files = generate.plan(spec, "apps/trick-or-treat-rush/monstera.spec.json", STORE, layout="app")
        core = [f for f in files if "/runtime/" in f.path or f.path.startswith("ios/Runtime/")]
        self.assertGreater(len(core), 10)
        banned = [k["glyph"] for k in spec["game"]["runtime"]["kinds"] if k["glyph"]] + [spec["game"]["screens"]["startHint"]]
        for f in core:
            if f.path.endswith((".jar", ".txt")):
                continue
            text = f.data.decode("utf-8")
            for word in banned:
                self.assertNotIn(word, text, f.path)
            if archcheck._CORE_PATH.match("apps/x/" + f.path):   # sources only, not Package.swift or build files
                self.assertEqual(archcheck.check_runtime_core(f.path, text), [], f.path)

    def test_architecture_check_rejects_presentation_names_in_the_core(self) -> None:
        for snippet in ("val g = kind.glyph", "import app.x.presentation.Layout", "let e: KindEffect = .none", "import MonsteraPresentation"):
            found = archcheck.check_runtime_core("apps/x/android/app/src/main/kotlin/a/runtime/Simulation.kt", snippet)
            self.assertTrue(any("presentation-only name" in v.rule for v in found), snippet)

    def test_presentation_modules_are_planned_for_both_platforms(self) -> None:
        spec = load(SPECS["pumpkin-blaster"])
        paths = {f.path for f in generate.plan(spec, "apps/pumpkin-blaster/monstera.spec.json", STORE, layout="app")}
        pkg = "android/app/src/main/kotlin/app/monstera/pumpkinblaster"
        for expected in (
            f"{pkg}/presentation/Presentation.kt",
            "android/app/src/test/kotlin/app/monstera/pumpkinblaster/presentation/PresentationTest.kt",
            "ios/Presentation/Package.swift",
            "ios/Presentation/Sources/MonsteraPresentation/Presentation.swift",
            "ios/Presentation/Tests/MonsteraPresentationTests/PresentationTests.swift",
        ):
            self.assertIn(expected, paths)
        # Presentation code is not part of the runtime core directories the architecture check treats as pure.
        self.assertFalse(any(archcheck._CORE_PATH.match("apps/x/" + p) for p in paths if "Presentation" in p or "/presentation/" in p))


if __name__ == "__main__":
    unittest.main()
