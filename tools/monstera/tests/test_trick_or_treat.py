"""G3: Trick or Treat Rush and Pumpkin Blaster behaviour, with expectations computed by hand from the
specs (not taken from the oracle), plus checks that the golden scenarios really exercise the mechanics.

Hand derivation for `hand-lane-zero` (apps/trick-or-treat-rush/monstera.spec.json):
- Lane swipe = drag(-460, 0) at tick 0: runner x 460 -> 0 (lane 0), still inside the world.
- Stripe (h 24) spawns at y -24 on ticks 0, 30, 60, ... and moves 12/tick in the same step, so after n moves
  y = -24 + 12n. It overlaps the runner row [1500, 1700) once -24 + 12n + 24 > 1500, i.e. n = 126: a stripe
  spawned at tick t scores in step t + 125. After N steps the score from stripes is #{t = 30k : t + 125 <= N - 1}.
- First lane-0 tombstone: spawner start 120 (x -30, width 220, overlaps the runner box [0, 160)).
  It spawns at tick 120 with y0 in [-100, -20] and overlaps the row once y0 + 12n + 150 > 1500, n in [115, 121],
  so the life is lost in step 120 + 114 .. 120 + 120 = 234 .. 240.
- First lane-0 candy (start 200): y0 + 12n + 100 > 1500 needs n >= 118, i.e. step >= 317: after the run.
- The middle-lane tombstone (start 210) and candy (start 60) never touch lane 0.
"""
from __future__ import annotations
import json
import unittest
from pathlib import Path
from monstera.oracle import sim

REPO = Path(__file__).resolve().parents[3]
RUSH = REPO / "apps" / "trick-or-treat-rush" / "monstera.spec.json"
PUMPKIN = REPO / "apps" / "pumpkin-blaster" / "monstera.spec.json"
SCEN = REPO / "spec" / "scenarios"


def game(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))["game"]


def scenario(project: str, name: str) -> dict:
    return json.loads((SCEN / project / f"{name}.scenario.json").read_text(encoding="utf-8"))


def run(spec: Path, sc: dict, ticks: int):
    """Tick-driven replay; yields the world after every step."""
    w = sim.new_world(sim.Config(game(spec)), sc["seed"])
    by_tick = {s["tick"]: s["events"] for s in sc["inputs"]}
    for t in range(ticks):
        sim.step(w, by_tick.get(t, []))
        yield t, w


def stripes_scored(steps: int) -> int:
    return len([t for t in range(0, steps, 30) if t + 125 <= steps - 1])


class HandVerifiedLaneZero(unittest.TestCase):
    def test_hand_computed_expectations(self) -> None:
        sc = scenario("trick-or-treat-rush", "hand-lane-zero")
        lives_lost_at = None
        for t, w in run(RUSH, sc, 300):
            runner = next(e for e in w.entities if e.controlled)
            self.assertEqual(runner.x, 0, "one left swipe puts the runner in lane 0")
            if lives_lost_at is None and w.lives == 2:
                lives_lost_at = t
            if t == 124:
                self.assertEqual(w.score, 0)
            if t == 125:
                self.assertEqual(w.score, 1, "first stripe scores in step 125")
        self.assertIsNotNone(lives_lost_at)
        self.assertTrue(234 <= lives_lost_at <= 240, lives_lost_at)
        self.assertEqual(w.lives, 2)
        self.assertEqual(w.score, stripes_scored(300))
        self.assertEqual(stripes_scored(300), 6)
        self.assertEqual(sc["checkpoints"][-1]["observe"]["score"], 6)
        self.assertEqual(sc["checkpoints"][-1]["observe"]["lives"], 2)


class RushMechanics(unittest.TestCase):
    def test_lane_swipes_apply_in_order_with_clamping(self) -> None:
        sc = scenario("trick-or-treat-rush", "lane-input-order")
        seen = {}
        for t, w in run(RUSH, sc, 141):
            seen[t] = next(e for e in w.entities if e.controlled).x >> 16
        self.assertEqual(seen[3], 460, "left, left (clamped at 0), right: middle lane, not lane 0")
        self.assertEqual(seen[50], 920, "right x3 clamps at lane 2")
        self.assertEqual(seen[90], 460)
        self.assertEqual(seen[140], 0, "left, right, left, left from the middle")

    def test_dodging_player_keeps_every_life_across_difficulty_phases(self) -> None:
        sc = scenario("trick-or-treat-rush", "dodge-run")
        final = sc["checkpoints"][-1]["observe"]
        self.assertEqual((final["lives"], final["ended"], final["tick"]), (3, 0, 5400))
        self.assertGreater(sum(len(s["events"]) for s in sc["inputs"]), 50, "the player actually moves")

    def test_idle_runner_collides_and_the_run_ends(self) -> None:
        sc = scenario("trick-or-treat-rush", "idle-run")
        cps = sc["checkpoints"]
        self.assertEqual(cps[-1]["observe"]["ended"], 1)
        end = next(c for c in cps if c["observe"]["ended"])
        self.assertLess(end["observe"]["tick"], sc["ticks"], "the run ends before the scenario does")
        self.assertEqual({c["observe"]["tick"] for c in cps if c["observe"]["ended"]}, {cps[-1]["observe"]["tick"]},
                         "after game over the tick no longer advances")

    def test_candy_scores_ten(self) -> None:
        sc = scenario("trick-or-treat-rush", "candy-chase")
        candy = 0
        prev = 0
        for t, w in run(RUSH, sc, sc["ticks"]):
            delta = w.score - prev
            prev = w.score
            if delta >= 10:
                candy += delta // 10
        self.assertGreaterEqual(candy, 3, "the chasing player collects several candies")

    def test_difficulty_rises(self) -> None:
        spawns = {"tombstone": [0, 0, 0], "ghost": [0, 0, 0]}
        for sp in game(RUSH)["runtime"]["spawners"]:
            if sp["kind"] in spawns:
                for phase, (lo, hi) in enumerate(((0, 1800), (1800, 3600), (3600, 5400))):
                    spawns[sp["kind"]][phase] += len([t for t in range(lo, hi)
                                                      if t >= sp["startTick"] and (t - sp["startTick"]) % sp["intervalTicks"] == 0])
        hazards = [spawns["tombstone"][i] + spawns["ghost"][i] for i in range(3)]
        self.assertEqual(spawns["ghost"][0], 0)
        self.assertTrue(hazards[0] < hazards[1] < hazards[2], hazards)

    def test_at_most_two_lanes_blocked_so_a_run_is_always_survivable(self) -> None:
        """Crossing windows of every hazard spawn for both extreme spawn heights (the windows for heights in between
        lie between them and overlap both): no tick in the first 200 s has all three lanes blocked."""
        g = game(RUSH)
        rt = g["runtime"]
        kinds = {k["id"]: k for k in rt["kinds"]}
        runner = rt["initialEntities"][0]
        ry, rh = runner["y"], kinds["runner"]["height"]
        horizon = 12000
        blocked = [[False] * horizon for _ in range(3)]
        for sp in rt["spawners"]:
            if sp["kind"] not in ("tombstone", "ghost"):
                continue
            lane = (sp["xMin"] + 30 * 65536) // (460 * 65536)
            h = kinds[sp["kind"]]["height"]
            for t in range(sp["startTick"], horizon, sp["intervalTicks"]):
                for y0 in (sp["yMin"], sp["yMax"]):
                    for n in range(1, 400):
                        y = y0 + sp["vy"] * n
                        if y + h > ry and y < ry + rh and t + n - 1 < horizon:
                            blocked[lane][t + n - 1] = True
        all_three = [t for t in range(horizon) if all(blocked[l][t] for l in range(3))]
        self.assertEqual(all_three, [])


class PumpkinWin(unittest.TestCase):
    def test_win_scenario_reaches_win_score_with_lives_left(self) -> None:
        sc = scenario("pumpkin-blaster", "win-1000")
        win = game(PUMPKIN)["runtime"]["winScore"]
        self.assertEqual(win, 1000)
        final = sc["checkpoints"][-1]["observe"]
        self.assertEqual(final["ended"], 1)
        self.assertGreaterEqual(final["score"], win)
        self.assertGreater(final["lives"], 0, "ended by winning, not by losing")
        self.assertLess(final["tick"], sc["ticks"], "the run ends before the scenario does")


class Replay(unittest.TestCase):
    def test_same_seed_and_inputs_reproduce_the_same_state(self) -> None:
        sc = scenario("trick-or-treat-rush", "dodge-run")
        a = [sim.state_hash(w) for t, w in run(RUSH, sc, 600) if t % 50 == 0]
        b = [sim.state_hash(w) for t, w in run(RUSH, sc, 600) if t % 50 == 0]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
