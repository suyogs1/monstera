"""Hand-computed expectations for spec/samples/boundary-lab, independent of recorded checkpoints.

Every number below was worked out on paper from architecture/RUNTIME-CONTRACT.md (see the
comments), then compared with the oracle. If this fails, either the oracle or the contract
derivation is wrong; the recorded scenario checkpoints are not consulted here.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from monstera.oracle import fixed as fx
from monstera.oracle import sim

LAB = Path(__file__).resolve().parents[3] / "spec" / "samples" / "boundary-lab" / "monstera.spec.json"
U = 65536  # one world unit


def world(seed: int = 1) -> sim.World:
    return sim.new_world(sim.Config(json.loads(LAB.read_text(encoding="utf-8"))["game"]), seed)


def ids(w: sim.World) -> set:
    return {e.id for e in w.entities}


def get(w: sim.World, entity_id: int):
    return next(e for e in w.entities if e.id == entity_id)


def run(w: sim.World, steps: int, events: dict | None = None) -> None:
    for i in range(steps):
        sim.step(w, (events or {}).get(w.tick, []))


class TouchingEdges(unittest.TestCase):
    def test_collisions_after_one_tick(self) -> None:
        w = world()
        self.assertEqual(len([i for i in ids(w) if i <= 31]), 31)
        run(w, 1)
        # Pairs (3,4) overlap by one raw unit horizontally, (7,8) vertically, (13,14) are identical: 3 points.
        # The twin pair (30,31) is one pair for the same-kind rule: +5 once, and only the lower id goes.
        self.assertEqual(w.score, 8)
        self.assertEqual(ids(w) & set(range(1, 32)), set(range(1, 32)) - {3, 4, 7, 8, 13, 14, 30})

    def test_touching_and_zero_size_never_collide(self) -> None:
        w = world()
        run(w, 3)
        # (1,2) edge, (5,6) edge, (9,10) exact corner, dot (11) on the corner of target (12): all survive.
        for survivor in (1, 2, 5, 6, 9, 10, 11, 12, 26, 27, 28, 29):
            self.assertIn(survivor, ids(w))
        self.assertEqual(w.score, 8, "the dot rule is worth 100 and must never fire")

    def test_overlap_predicate_boundaries(self) -> None:
        # a=[0,10) b=[10,20): touching. One raw unit of overlap collides. Zero-size never does.
        self.assertFalse(sim.overlaps(0, 0, 10 * U, 10 * U, 10 * U, 0, 10 * U, 10 * U))
        self.assertTrue(sim.overlaps(0, 0, 10 * U, 10 * U, 10 * U - 1, 0, 10 * U, 10 * U))
        # A zero-size box is a point: strictly inside collides, on the top-left corner or any edge does not.
        self.assertTrue(sim.overlaps(5 * U, 5 * U, 0, 0, 0, 0, 10 * U, 10 * U))
        self.assertFalse(sim.overlaps(0, 0, 0, 0, 0, 0, 10 * U, 10 * U))
        self.assertFalse(sim.overlaps(10 * U, 5 * U, 0, 0, 0, 0, 10 * U, 10 * U))
        self.assertFalse(sim.overlaps(5 * U, 10 * U, 0, 0, 0, 0, 10 * U, 10 * U))


class WorldExitAndWalls(unittest.TestCase):
    def test_exit_ticks_are_exact(self) -> None:
        w = world()
        run(w, 4)
        self.assertEqual({15, 16, 17} - ids(w), set())          # all still present after 4 steps
        run(w, 1)                                               # step 5: x=400 >= W, y=300 >= H
        self.assertEqual({15, 16, 17} - ids(w), {16, 17})
        run(w, 9)                                               # step 14: x = -9, box ends at +1
        self.assertIn(15, ids(w))
        run(w, 1)                                               # step 15: x = -10, box ends at 0
        self.assertNotIn(15, ids(w))

    def test_bounce_reflects_position_and_velocity(self) -> None:
        w = world()
        xs = []
        for _ in range(4):
            run(w, 1)
            xs.append(get(w, 18).x // U)
        # maxX = 390: 389, 390, 391 -> reflected to 2*390-391 = 389 (vx -1), then 388
        self.assertEqual(xs, [389, 390, 389, 388])
        w = world(); run(w, 3)
        self.assertEqual((get(w, 18).vx, get(w, 19).x // U, get(w, 19).vx, get(w, 20).y // U, get(w, 20).vy),
                         (-U, 1, U, 289, -U))

    def test_clamp_and_saturated_velocity(self) -> None:
        w = world(); run(w, 2)
        self.assertEqual(get(w, 21).x, 0)                       # 3 - 5 = -2 -> clamped, stays at 0
        self.assertEqual((get(w, 25).x, get(w, 25).y), (396 * U, 0))  # sat(x + RAW_MAX), sat(y + RAW_MIN), clamped

    def test_lifetime_exact(self) -> None:
        w = world(); run(w, 4)
        self.assertIn(22, ids(w))
        run(w, 1)
        self.assertNotIn(22, ids(w))                            # age 5 >= lifetime 5


class CapAndStreams(unittest.TestCase):
    def test_cap_never_exceeded_and_skipped_spawns_still_draw(self) -> None:
        w = world(4)
        skipped = 0
        filler = w.cfg.kind_index["filler"]
        for _ in range(150):
            was_even = w.tick % 2 == 0
            before_fillers = sum(1 for e in w.entities if e.kind == filler)
            before_rng = w.rngs["fill"].state
            sim.step(w, [])
            self.assertLessEqual(len(w.entities), 40)
            fillers = sum(1 for e in w.entities if e.kind == filler)
            # The filler spawner fires on even ticks and always draws; fillers never despawn here.
            self.assertEqual(w.rngs["fill"].state != before_rng, was_even)
            if was_even and fillers == before_fillers:
                skipped += 1
        self.assertGreater(skipped, 0, "scenario must reach the cap so skipped spawns are exercised")


class NegativeRounding(unittest.TestCase):
    def test_player_after_each_drag(self) -> None:
        w = world(5)
        p = lambda: (get(w, 23).x, get(w, 23).y)
        x0, y0 = 190 * U, 140 * U
        sim.step(w, [{"type": "drag", "dx": -3, "dy": -1, "dir": "none"}])
        self.assertEqual(p(), (x0 - 5, y0 - 2))                 # floor(-4.5) = -5, floor(-1.5) = -2
        sim.step(w, [{"type": "drag", "dx": 1, "dy": 3, "dir": "none"}])
        self.assertEqual(p(), (x0 - 5 + 1, y0 - 2 + 4))         # floor(1.5) = 1, floor(4.5) = 4
        sim.step(w, [{"type": "drag", "dx": fx.RAW_MIN, "dy": fx.RAW_MIN, "dir": "none"}])
        self.assertEqual(p(), (0, 0))                           # saturated delta, clamped at the walls
        sim.step(w, [{"type": "drag", "dx": fx.RAW_MAX, "dy": fx.RAW_MAX, "dir": "none"}])
        self.assertEqual(p(), (380 * U, 280 * U))               # clamped to W-w, H-h
        sim.step(w, [{"type": "drag", "dx": -7, "dy": 5, "dir": "none"}])
        self.assertEqual(p(), (380 * U - 11, 280 * U))          # floor(-10.5) = -11; y clamps back

    def test_scenario_final_state(self) -> None:
        w = world(5)
        events = {0: [{"type": "drag", "dx": -3, "dy": -1, "dir": "none"}], 1: [{"type": "drag", "dx": 1, "dy": 3, "dir": "none"}],
                  2: [{"type": "drag", "dx": fx.RAW_MIN, "dy": fx.RAW_MIN, "dir": "none"}],
                  3: [{"type": "drag", "dx": fx.RAW_MAX, "dy": fx.RAW_MAX, "dir": "none"}],
                  4: [{"type": "drag", "dx": -7, "dy": 5, "dir": "none"}],
                  5: [{"type": "swipe", "dx": 0, "dy": 0, "dir": "left"}],
                  15: [{"type": "swipe", "dx": 0, "dy": 0, "dir": "none"}, {"type": "drag", "dx": -1, "dy": -1, "dir": "none"}],
                  20: [{"type": "swipe", "dx": 0, "dy": 0, "dir": "down"}]}
        run(w, 40, events)
        player = get(w, 23)
        # ten moves of -2 units from tick 5 to 14, then drag(-1,-1) -> (-2,-2) raw; then 20 moves down, clamped
        self.assertEqual((player.x, player.y), (380 * U - 11 - 10 * 2 * U - 2, 280 * U))
        self.assertEqual((player.vx, player.vy), (0, 2 * U))


class LivesEnd(unittest.TestCase):
    def test_third_tap_ends_the_game_and_freezes_the_tick(self) -> None:
        w = world(6)
        tap = [{"type": "tap", "dx": 0, "dy": 0, "dir": "none"}]
        events = {10: tap, 11: tap, 12: tap, 20: tap, 25: [{"type": "drag", "dx": U, "dy": U, "dir": "none"}]}
        lives = []
        for _ in range(40):
            sim.step(w, events.get(w.tick, []))
            lives.append(w.lives)
        self.assertEqual((w.ended, w.lives, w.tick), (True, 0, 13))   # tap at tick 12 is the 13th step
        self.assertEqual(lives[10:14], [2, 1, 0, 0])
        self.assertEqual(get(w, 23).x, 190 * U, "input after the end is ignored")
        next_id = w.next_id
        sim.step(w, tap)
        self.assertEqual(w.next_id, next_id)


if __name__ == "__main__":
    unittest.main()
