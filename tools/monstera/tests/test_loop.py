"""Frame loop semantics (contract section 1): exact accumulator vectors, frame-rate independence,
and equivalence of the loop with a shell-free replay."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from monstera.oracle import sim
from monstera.oracle.loop import FrameClock, GameLoop

REPO = Path(__file__).resolve().parents[3]


def clock(rate: int, mx: int, frames: list) -> tuple:
    c = FrameClock(rate, mx)
    return [c.advance(f) for f in frames], c.acc, c.alpha


def lcg(seed: int):
    x = seed
    while True:
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        yield x


class ClockVectors(unittest.TestCase):
    def test_contract_table(self) -> None:
        self.assertEqual(clock(60, 5, [16666667] * 4), ([1, 1, 1, 1], 80, 0))
        self.assertEqual(clock(60, 5, [16666666] * 4), ([0, 1, 1, 1], 999999840, 65535))
        self.assertEqual(clock(60, 5, [8333333] * 6), ([0, 0, 1, 0, 1, 0], 999999880, 65535))
        self.assertEqual(clock(60, 5, [500000000, 16666667]), ([5, 1], 20, 0))
        self.assertEqual(clock(60, 5, [-5, 0, 2000000000]), ([0, 0, 5], 0, 0))
        self.assertEqual(clock(60, 5, [8333333]), ([0], 499999980, 32767))
        self.assertEqual(clock(120, 5, [8333334, 8333333, 8333333]), ([1, 1, 1], 0, 0))

    def test_jitter_vector(self) -> None:
        gen = lcg(12345)
        frames = [4_000_000 + (next(gen) >> 8) % 36_000_000 for _ in range(1000)]
        c = FrameClock(60, 5)
        self.assertEqual(sum(c.advance(f) for f in frames), 490)
        self.assertEqual(c.acc, 103339700)

    def test_no_drift_over_an_hour(self) -> None:
        c = FrameClock(60, 5)
        total = sum(c.advance(16_666_667) for _ in range(216_000))  # 3600 s at ~60 Hz
        self.assertEqual(total, (216_000 * 16_666_667 * 60) // 1_000_000_000)

    def test_alpha_is_always_below_one(self) -> None:
        c = FrameClock(60, 5)
        gen = lcg(7)
        for _ in range(5000):
            c.advance((next(gen) >> 4) % 50_000_000)
            self.assertTrue(0 <= c.alpha < 65536)


class LoopSemantics(unittest.TestCase):
    def setUp(self) -> None:
        game = json.loads((REPO / "spec/samples/monstera-sample/monstera.spec.json").read_text(encoding="utf-8"))["game"]
        self.cfg = sim.Config(game)
        self.rate, self.cap = game["simulation"]["tickRate"], game["simulation"]["maxTicksPerFrame"]

    def replay_hash(self, seed: int, ticks: int, inputs: dict) -> int:
        w = sim.new_world(self.cfg, seed)
        for t in range(ticks):
            sim.step(w, inputs.get(t, []))
        return sim.state_hash(w)

    def test_idle_state_is_independent_of_display_rate_and_jitter(self) -> None:
        for hz in (30, 60, 90, 120, 144):
            loop = GameLoop(sim.new_world(self.cfg, 7), self.rate, self.cap)
            gen = lcg(hz)
            for i in range(400):
                loop.frame(1_000_000_000 // hz + (next(gen) >> 8) % 2_000_000 - 1_000_000)
                if i % 40 == 0:
                    self.assertEqual(sim.state_hash(loop.world), self.replay_hash(7, loop.world.tick, {}), (hz, i))

    def test_inputs_apply_at_the_start_of_the_next_tick_in_order(self) -> None:
        loop = GameLoop(sim.new_world(self.cfg, 9), self.rate, self.cap)
        recorded: dict = {}
        gen = lcg(3)
        for i in range(600):
            for ev in ([{"type": "tap", "dx": 0, "dy": 0, "dir": "none"}] if i % 7 == 0 else []) + \
                    ([{"type": "drag", "dx": (i % 13 - 6) * 65536, "dy": 0, "dir": "none"}] if i % 11 == 0 else []):
                loop.submit(ev)
                recorded.setdefault(loop.world.tick, []).append(ev)
            loop.frame(10_000_000 + (next(gen) >> 8) % 25_000_000)
        self.assertGreater(loop.world.tick, 100)
        self.assertEqual(sim.state_hash(loop.world), self.replay_hash(9, loop.world.tick, recorded))

    def test_zero_tick_frame_keeps_events_queued_and_state_unchanged(self) -> None:
        loop = GameLoop(sim.new_world(self.cfg, 1), self.rate, self.cap)
        before = sim.serialize(loop.world)
        loop.submit({"type": "press", "dx": 0, "dy": 0, "dir": "none"})
        self.assertEqual(loop.frame(1_000_000), 0)
        self.assertEqual(sim.serialize(loop.world), before)
        loop.frame(20_000_000)
        self.assertTrue(loop.world.pressed)

    def test_hitch_is_capped_and_backlog_dropped(self) -> None:
        loop = GameLoop(sim.new_world(self.cfg, 1), self.rate, self.cap)
        self.assertEqual(loop.frame(2_000_000_000), self.cap)
        self.assertEqual(loop.world.tick, self.cap)
        self.assertEqual(loop.frame(1_000_000), 0, "the dropped backlog is not repaid")


if __name__ == "__main__":
    unittest.main()
