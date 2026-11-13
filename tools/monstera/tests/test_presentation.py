"""G4 visual batch: the presentation fields (spec v4) are validated, have documented neutral values,
and cannot reach the simulation (contract section 9)."""
from __future__ import annotations

import copy
import json
import re
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


DISPLAY_ONLY_GAME = ("palette", "hud", "screens")
DISPLAY_ONLY_KIND = ("color", "glyph", "effect")
NOT_READ_GAME = ("genre", "orientation", "targetFps")
NOT_READ_INPUT = ("scheme",)


def strip_unread(game: dict) -> dict:
    """`game` without any field the oracle must not read (studio/src/badge/classify.ts lists the same fields)."""
    out = copy.deepcopy(game)
    for key in DISPLAY_ONLY_GAME + NOT_READ_GAME:
        del out[key]
    for key in NOT_READ_INPUT:
        del out["input"][key]
    for kind in out["runtime"]["kinds"]:
        for key in DISPLAY_ONLY_KIND:
            del kind[key]
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

    def test_display_only_and_unread_fields_are_unreachable_by_the_oracle(self) -> None:
        """Structural proof for the Studio determinism badge (R5.3): every display-only field (palette, HUD, screens,
        kinds[].color/glyph/effect) and every game field the oracle is not meant to read (genre, orientation, targetFps,
        input.scheme) is DELETED, and every committed golden of every project, tick- and frame-driven, still produces its
        recorded checkpoints. The oracle reads the spec only by subscript (no .get, no key iteration), so a read of any
        deleted field would raise KeyError; project fields (displayName, ...) never reach it, it is given `game` only."""
        files = sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}"))
        self.assertGreaterEqual(len(files), 33)
        frame_driven = 0
        for path in files:
            data = load_path(path)
            game = strip_unread(load_path(REPO / data["spec"]["path"])["game"])
            ticks = [c["tick"] for c in data["checkpoints"]]
            self.assertEqual(scenario.checkpoints_for_game(game, data, ticks), data["checkpoints"], path.name)
            frame_driven += data["frames"]["count"] > 0
        self.assertGreater(frame_driven, 0)

    def test_studio_badge_classification_agrees_with_this_proof(self) -> None:
        """Drift guard: Studio's badge classifier (studio/src/badge/classify.ts) may call a field display-only or
        not read only if `strip_unread` deletes it (proven unreachable above), and must call every other game
        field behaviour. Checked for every leaf of every shipped spec; it fails when either list changes alone."""
        source = (REPO / "studio" / "src" / "badge" / "classify.ts").read_text(encoding="utf-8")
        def ts_list(name: str) -> list[str]:
            block = re.search(rf"const {name} = \[(.*?)\](?: as const)?;", source, re.S)
            self.assertIsNotNone(block, f"{name} not found in classify.ts")
            return re.findall(r'"([^"]+)"', block.group(1))
        display, behaviour = set(ts_list("DISPLAY_ONLY_PATTERNS")), ts_list("BEHAVIOUR_PREFIXES")
        self.assertTrue(display and behaviour)

        def ts_class(pattern: str) -> str:
            if pattern in display:
                return "display"
            if any(pattern == p or pattern.startswith(p + ".") or pattern.startswith(p + "[") for p in behaviour):
                return "behaviour"
            return "other"

        deleted_game = {f"game.{k}" for k in DISPLAY_ONLY_GAME + NOT_READ_GAME} | {f"game.input.{k}" for k in NOT_READ_INPUT}
        deleted_kind = {f"game.runtime.kinds[].{k}" for k in DISPLAY_ONLY_KIND}
        self.assertEqual(display - {"project.displayName"},
                         {p for p in self.leaf_patterns(load(SPECS["pumpkin-blaster"])) if p in deleted_kind
                          or any(p.startswith(f"game.{k}.") for k in DISPLAY_ONLY_GAME)},
                         "the Studio display-only list must equal the display-only fields deleted by strip_unread")
        checked = 0
        for path in list(SPECS.values()) + [REPO / "spec" / "samples" / "lantern-run" / "monstera.spec.json"]:
            for pattern in self.leaf_patterns(load(path)):
                unread = pattern.startswith(("project.", "specVersion")) or pattern in deleted_kind or \
                    any(pattern == d or pattern.startswith(d + ".") for d in deleted_game)
                got = ts_class(pattern)
                self.assertEqual(got != "behaviour", unread, f"{path.parent.name}: {pattern} is '{got}' in classify.ts")
                checked += 1
        self.assertGreater(checked, 100)

    @staticmethod
    def leaf_patterns(value, prefix: str = "") -> set[str]:
        if isinstance(value, dict):
            return set().union(*(PresentationCannotReachTheSimulationTests.leaf_patterns(v, f"{prefix}.{k}" if prefix else k)
                                 for k, v in value.items())) if value else {prefix}
        if isinstance(value, list):
            return set().union(*(PresentationCannotReachTheSimulationTests.leaf_patterns(v, prefix + "[]") for v in value)) if value else {prefix}
        return {prefix}

    def test_the_deletion_proof_detects_a_field_the_oracle_reads(self) -> None:
        data = load_path(scenario.scenario_files("pumpkin-blaster")[0])
        for drop in (("runtime", "lives"), ("input", "dragGain"), ("world", "width")):
            game = strip_unread(load(SPECS["pumpkin-blaster"])["game"])
            del game[drop[0]][drop[1]]
            with self.assertRaises(KeyError, msg=drop):
                scenario.checkpoints_for_game(game, data, [data["ticks"]])
        frames = next(load_path(p) for p in scenario.scenario_files("pumpkin-blaster") if load_path(p)["frames"]["count"])
        game = strip_unread(load(SPECS["pumpkin-blaster"])["game"])
        del game["simulation"]["tickRate"]
        with self.assertRaises(KeyError):
            scenario.checkpoints_for_game(game, frames, [frames["ticks"]])

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
