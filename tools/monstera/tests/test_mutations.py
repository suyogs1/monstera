"""Mutation tests for the golden scenarios.

Each mutant re-implements the oracle with one deliberate, plausible mistake (the kind two
independent ports make: an off-by-one at an edge, the wrong rounding, a skipped PRNG draw, an
operation in the wrong phase). The committed scenarios must detect every mutant. A surviving
mutant means the scenarios would let a real divergence through.

Primitives whose effect the simulation cannot observe (for example add/sub saturation, which a
later clamp or despawn masks) are covered by the known-answer vectors that the generated Kotlin
and Swift test suites also run.
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

from monstera import scenario
from monstera.cli import DEFAULT_SCHEMAS
from monstera.jsonio import load_path
from monstera.schema import SchemaStore

import json

ORACLE = Path(__file__).resolve().parents[1] / "monstera" / "oracle"
REPO = Path(__file__).resolve().parents[3]

# (name, file, old, new)
MUTANTS = [
    ("mul rounds toward zero", "fixed.py", "return sat((a * b) >> FRAC_BITS)",
     "return sat(-((-a * b) >> FRAC_BITS) if a * b < 0 else (a * b) >> FRAC_BITS)"),
    ("PRNG rejection loop removed", "prng.py", "if r >= threshold:", "if True:"),
    ("stream ignores the seed", "prng.py", "sm = (seed ^ fnv1a64(name.encode(\"utf-8\"))) & M64",
     "sm = fnv1a64(name.encode(\"utf-8\")) & M64"),
    ("PRNG increment forced even", "prng.py", "self.inc = ((initseq << 1) | 1) & M64", "self.inc = (initseq << 1) & M64"),
    ("overlap: ax <= bx + bw", "sim.py", "return ax < bx + bw and", "return ax <= bx + bw and"),
    ("overlap: bx <= ax + aw", "sim.py", "and bx < ax + aw and", "and bx <= ax + aw and"),
    ("overlap: ay <= by + bh", "sim.py", "and ay < by + bh and", "and ay <= by + bh and"),
    ("overlap: by <= ay + ah", "sim.py", "and by < ay + ah\n", "and by <= ay + ah\n"),
    ("same-kind pairs counted twice", "sim.py", "or (same and a.id > b.id)", ""),
    ("bounce at x == maxX", "sim.py", "elif e.x > max_x:", "elif e.x >= max_x:"),
    ("bounce at x == 0", "sim.py", "if e.x < 0:\n                e.x, e.vx", "if e.x <= 0:\n                e.x, e.vx"),
    ("bounce keeps velocity (y)", "sim.py", "e.y, e.vy = fx.sub(fx.add(max_y, max_y), e.y), fx.neg(e.vy)",
     "e.y, e.vy = fx.sub(fx.add(max_y, max_y), e.y), e.vy"),
    ("despawn when x + w < 0", "sim.py", "e.x + k[\"width\"] <= 0", "e.x + k[\"width\"] < 0"),
    ("despawn when x > W", "sim.py", "or e.x >= w.cfg.world_w", "or e.x > w.cfg.world_w"),
    ("despawn when y >= H missed", "sim.py", "or e.y >= w.cfg.world_h", "or False"),
    ("lifetime off by one", "sim.py", "e.age >= k[\"lifetimeTicks\"]", "e.age > k[\"lifetimeTicks\"]"),
    ("spawn skips draws when full", "sim.py",
     "        x = sp[\"xMin\"] + rng.next_below(sp[\"xMax\"] - sp[\"xMin\"] + 1)\n"
     "        y = sp[\"yMin\"] + rng.next_below(sp[\"yMax\"] - sp[\"yMin\"] + 1)\n"
     "        if len(w.entities) < w.cfg.max_entities:\n",
     "        if len(w.entities) < w.cfg.max_entities:\n"
     "            x = sp[\"xMin\"] + rng.next_below(sp[\"xMax\"] - sp[\"xMin\"] + 1)\n"
     "            y = sp[\"yMin\"] + rng.next_below(sp[\"yMax\"] - sp[\"yMin\"] + 1)\n"),
    ("tap ignores the entity cap", "sim.py", "and len(w.entities) < w.cfg.max_entities:\n            _add_entity(w, w.cfg.kind_index[w.cfg.tap_kind]",
     ":\n            _add_entity(w, w.cfg.kind_index[w.cfg.tap_kind]"),
    ("swipe up points down", "sim.py", '"up": (0, -1)', '"up": (0, 1)'),
    ("drag not clamped", "sim.py", "                e.y = fx.add(e.y, fx.mul(ev[\"dy\"], gain))\n                _clamp_to_world(w, e)",
     "                e.y = fx.add(e.y, fx.mul(ev[\"dy\"], gain))"),
    ("game ends only below zero lives", "sim.py", "if w.lives <= 0 or", "if w.lives < 0 or"),
    ("ended world keeps stepping", "sim.py", "    if w.ended:\n        return\n    for ev in events:", "    for ev in events:"),
    ("spawn after move", "sim.py", "    _spawn(w)\n    _move(w)\n", "    _move(w)\n    _spawn(w)\n"),
    ("collision resolved before move", "sim.py", "    _spawn(w)\n    _move(w)\n    doomed = _collide_and_resolve(w)",
     "    _spawn(w)\n    doomed = _collide_and_resolve(w)\n    _move(w)"),
    ("score applied per rule not per pair", "sim.py", "                    score_delta += rule[\"score\"]", "                    score_delta = rule[\"score\"]"),
    ("pressed flag not serialized", "sim.py", "1 if w.ended else 0, 1 if w.pressed else 0))", "1 if w.ended else 0, 0))"),
    ("RNG state not hashed", "sim.py", "out += struct.pack(\"<QQ\", r.state, r.inc)", "out += struct.pack(\"<QQ\", 0, 0)"),
    ("tick period off by one", "sim.py", "if w.tick % sp[\"intervalTicks\"] != 0:", "if (w.tick + 1) % sp[\"intervalTicks\"] != 0:"),
]


def load_oracle(mutation: tuple[str, str, str] | None) -> types.ModuleType:
    """Execute the oracle sources as a private package, applying at most one textual mutation."""
    name = f"_mut_{abs(hash(mutation))}"
    pkg = types.ModuleType(name)
    pkg.__path__ = []  # type: ignore[attr-defined]
    sys.modules[name] = pkg
    try:
        for part in ("fixed", "prng", "sim"):
            source = (ORACLE / f"{part}.py").read_text(encoding="utf-8")
            if mutation and mutation[0] == f"{part}.py":
                if mutation[1] not in source:
                    raise AssertionError(f"mutation target not found in {part}.py: {mutation[1]!r}")
                source = source.replace(mutation[1], mutation[2], 1)
            module = types.ModuleType(f"{name}.{part}")
            module.__package__ = name
            sys.modules[f"{name}.{part}"] = module
            setattr(pkg, part, module)
            exec(compile(source, f"{part}.py", "exec"), module.__dict__)  # noqa: S102 - test-only mutation harness
        return sys.modules[f"{name}.sim"]
    finally:
        pass


def release(module_name: str) -> None:
    prefix = module_name.rsplit(".", 1)[0]
    for key in [k for k in sys.modules if k == prefix or k.startswith(prefix + ".")]:
        del sys.modules[key]


def scenario_set() -> list[tuple[dict, dict]]:
    """(game, scenario) for every committed scenario, cheapest first."""
    out = []
    for path in sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}")):
        data = load_path(path)
        spec = json.loads((REPO / data["spec"]["path"]).read_text(encoding="utf-8"))
        out.append((spec["game"], data))
    return sorted(out, key=lambda pair: pair[1]["ticks"])


def detects(sim_module: types.ModuleType, scenarios: list[tuple[dict, dict]]) -> str | None:
    """Name of the first scenario whose checkpoints the (mutated) oracle fails to reproduce."""
    for game, data in scenarios:
        try:
            cfg = sim_module.Config(game)
            got = sim_module.run_scenario(cfg, data)
        except Exception:  # a crash is also a detected divergence
            return data["name"]
        want = [(c["tick"], c["hash"], c["observe"]) for c in data["checkpoints"]]
        have = [(r["tick"], format(r["hash"], "016x"), r["observe"]) for r in got]
        if want != have:
            return data["name"]
    return None


class MutationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.store = SchemaStore.load(DEFAULT_SCHEMAS)
        cls.scenarios = scenario_set()

    def test_unmutated_oracle_reproduces_every_scenario(self) -> None:
        module = load_oracle(None)
        try:
            self.assertIsNone(detects(module, self.scenarios))
        finally:
            release(module.__name__)

    def test_every_mutant_is_killed(self) -> None:
        survivors = []
        for name, file, old, new in MUTANTS:
            module = load_oracle((file, old, new))
            try:
                if detects(module, self.scenarios) is None:
                    survivors.append(name)
            finally:
                release(module.__name__)
        self.assertEqual(survivors, [], "scenarios let these mutants through; add a scenario that exercises them")


if __name__ == "__main__":
    unittest.main()
