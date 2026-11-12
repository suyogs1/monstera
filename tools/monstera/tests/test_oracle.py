"""Oracle primitives against the known-answer vectors in architecture/RUNTIME-CONTRACT.md and
exact-arithmetic references (fractions), including every int32 boundary pair."""
from __future__ import annotations

import itertools
import json
import unittest
from fractions import Fraction
from pathlib import Path

from monstera.oracle import fixed as fx
from monstera.oracle import prng, sim

SAMPLE = Path(__file__).resolve().parents[3] / "spec" / "samples" / "monstera-sample" / "monstera.spec.json"

EDGES = [fx.RAW_MIN, fx.RAW_MIN + 1, -fx.ONE - 1, -fx.ONE, -3, -2, -1, 0, 1, 2, 3, fx.ONE - 1, fx.ONE,
         fx.ONE + 1, fx.RAW_MAX - 1, fx.RAW_MAX]


class PrngVectors(unittest.TestCase):
    def test_reference_pcg32_demo(self) -> None:
        r = prng.Pcg32(42, 54)
        self.assertEqual([r.next_u32() for _ in range(6)],
                         [0xA15C02B7, 0x7B47F409, 0xBA1D3330, 0x83D2F293, 0xBFA4784B, 0xCBED606E])

    def test_splitmix_and_fnv(self) -> None:
        state, first = prng.splitmix64_next(0)
        _, second = prng.splitmix64_next(state)
        self.assertEqual((first, second), (0xE220A8397B1DCDAF, 0x6E789E6AA1B965F4))
        self.assertEqual(prng.fnv1a64(b""), 0xCBF29CE484222325)
        self.assertEqual(prng.fnv1a64(b"a"), 0xAF63DC4C8601EC8C)
        self.assertEqual(prng.fnv1a64(b"foobar"), 0x85944171F73967E8)

    def test_named_streams(self) -> None:
        spawn = prng.Pcg32.for_stream(12345, "spawn")
        self.assertEqual([spawn.next_u32() for _ in range(4)], [3836204951, 2901556457, 1288830458, 20171900])
        self.assertEqual((spawn.state, spawn.inc), (0xBE81DAF6F5B5D3BB, 0x6F4A8582F6E4629F))
        fxs = prng.Pcg32.for_stream(12345, "fx")
        self.assertEqual([fxs.next_u32() for _ in range(4)], [3544770967, 1588508108, 78643710, 1025764217])

    def test_bounded_values(self) -> None:
        r = prng.Pcg32.for_stream(1, "spawn")
        self.assertEqual([r.next_below(10) for _ in range(8)], [6, 0, 2, 2, 1, 0, 3, 7])
        self.assertEqual([r.next_below(1), r.next_below(1)], [0, 0])
        self.assertEqual(r.next_below(2 ** 31), 1771058001)

    def test_streams_are_independent_and_seed_dependent(self) -> None:
        a = [prng.Pcg32.for_stream(7, "spawn").next_u32() for _ in range(1)]
        self.assertNotEqual(a, [prng.Pcg32.for_stream(7, "fx").next_u32()])
        self.assertNotEqual(a, [prng.Pcg32.for_stream(8, "spawn").next_u32()])

    def test_bounds_respected_and_rejection_threshold(self) -> None:
        r = prng.Pcg32.for_stream(3, "t")
        for bound in (1, 2, 3, 7, 1000, 65537, 2 ** 31, 2 ** 32 - 1):
            self.assertTrue(all(r.next_below(bound) < bound for _ in range(200)), bound)


class FixedPoint(unittest.TestCase):
    def test_contract_vectors(self) -> None:
        self.assertEqual(fx.mul(-1, 1), -1)
        self.assertEqual((fx.mul(fx.RAW_MAX, fx.RAW_MAX), fx.mul(fx.RAW_MIN, fx.RAW_MIN)), (fx.RAW_MAX, fx.RAW_MAX))
        self.assertEqual((fx.mul(-3, 32768), fx.mul(3, -32768)), (-2, -2))
        self.assertEqual((fx.div(65536, 196608), fx.div(-65536, 196608), fx.div(65536, -196608)), (21845, -21845, -21845))
        self.assertEqual((fx.div(5, 0), fx.div(-5, 0), fx.div(0, 0)), (fx.RAW_MAX, fx.RAW_MIN, 0))
        self.assertEqual(fx.div(fx.RAW_MIN, -1), fx.RAW_MAX)
        self.assertEqual((fx.neg(fx.RAW_MIN), fx.add(fx.RAW_MAX, 1), fx.sub(fx.RAW_MIN, 1)),
                         (fx.RAW_MAX, fx.RAW_MAX, fx.RAW_MIN))

    def test_every_boundary_pair_against_exact_arithmetic(self) -> None:
        for a, b in itertools.product(EDGES, EDGES):
            self.assertEqual(fx.add(a, b), min(max(a + b, fx.RAW_MIN), fx.RAW_MAX), (a, b))
            self.assertEqual(fx.sub(a, b), min(max(a - b, fx.RAW_MIN), fx.RAW_MAX), (a, b))
            floor_product = (Fraction(a) * b / fx.ONE).__floor__()
            self.assertEqual(fx.mul(a, b), min(max(floor_product, fx.RAW_MIN), fx.RAW_MAX), (a, b))
            if b:
                trunc_quotient = int(Fraction(a * fx.ONE, b))  # int() truncates toward zero
                self.assertEqual(fx.div(a, b), min(max(trunc_quotient, fx.RAW_MIN), fx.RAW_MAX), (a, b))
            for v in (fx.mul(a, b), fx.add(a, b), fx.sub(a, b), fx.div(a, b)):
                self.assertTrue(fx.RAW_MIN <= v <= fx.RAW_MAX)

    def test_operands_outside_the_range_are_saturated_first(self) -> None:
        i64_max, i64_min = 2 ** 63 - 1, -(2 ** 63)
        self.assertEqual((fx.add(i64_max, 1), fx.sub(i64_min, i64_max), fx.neg(i64_min)), (fx.RAW_MAX, fx.RAW_MIN, fx.RAW_MAX))
        self.assertEqual((fx.mul(i64_max, i64_max), fx.mul(i64_min, fx.ONE), fx.div(i64_max, 1), fx.div(1, i64_min)),
                         (fx.RAW_MAX, fx.RAW_MIN, fx.RAW_MAX, 0))

    def test_products_fit_signed_64_bit(self) -> None:
        self.assertLessEqual(abs(fx.RAW_MIN * fx.RAW_MIN), 2 ** 62)

    def test_counter_saturation(self) -> None:
        self.assertEqual((fx.sat32(2 ** 40), fx.sat32(-2 ** 40), fx.sat32(5)), (fx.I32_MAX, fx.I32_MIN, 5))


class Serialization(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = sim.Config(json.loads(SAMPLE.read_text(encoding="utf-8"))["game"])

    def test_layout_and_size(self) -> None:
        w = sim.new_world(self.cfg, 1)
        data = sim.serialize(w)
        header = 4 + 4 + 4 + 4 + 4 + 1 + 1
        expected = header + 4 + 16 * len(self.cfg.streams) + 4 + 29 * len(w.entities)
        self.assertEqual(len(data), expected)
        self.assertEqual(data[:4], b"\x01\x00\x00\x00", "formatVersion is a little-endian u32")
        self.assertEqual(self.cfg.streams, ["fx", "spawn"], "streams sorted by name")

    def test_two_runs_are_byte_identical(self) -> None:
        def run() -> bytes:
            w = sim.new_world(self.cfg, 99)
            for t in range(300):
                sim.step(w, [{"type": "tap", "dx": 0, "dy": 0, "dir": "none"}] if t % 9 == 0 else [])
            return sim.serialize(w)
        self.assertEqual(run(), run())

    def test_different_seeds_diverge_quickly(self) -> None:
        hashes = set()
        for seed in (1, 2):
            w = sim.new_world(self.cfg, seed)
            sim.step(w, [])
            hashes.add(sim.state_hash(w))
        self.assertEqual(len(hashes), 2)


if __name__ == "__main__":
    unittest.main()


class SpawnerStartTick(unittest.TestCase):
    """Contract section 4, step 2: a spawner is inactive, and draws nothing, before `startTick`."""

    def world(self, start: int):
        game = json.loads(SAMPLE.read_text(encoding="utf-8"))["game"]
        rt = game["runtime"]
        rt["spawners"] = [dict(rt["spawners"][1], stream="late", kind="spark", startTick=start, intervalTicks=3,
                               yMin=0, yMax=1000)]
        rt["initialEntities"] = []
        return sim.new_world(sim.Config(game), 77)

    def test_hand_computed_spawn_ticks(self) -> None:
        # startTick 5, interval 3: spawns at ticks 5, 8, 11 (phase from startTick, not from 0). Steps 0..12: 3 spawns.
        w = self.world(5)
        counts = []
        for _ in range(13):
            sim.step(w, [])
            counts.append(len(w.entities))
        self.assertEqual(counts, [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3])

    def test_start_zero_includes_tick_zero(self) -> None:
        w = self.world(0)
        sim.step(w, [])
        self.assertEqual(len(w.entities), 1)

    def test_first_eligible_spawn_uses_the_streams_first_draws(self) -> None:
        w = self.world(5)
        for _ in range(6):
            sim.step(w, [])
        ref = prng.Pcg32.for_stream(77, "late")
        x = w.cfg.spawners[0]["xMin"] + ref.next_below(w.cfg.spawners[0]["xMax"] - w.cfg.spawners[0]["xMin"] + 1)
        y = ref.next_below(1001)
        self.assertEqual((w.entities[0].x, w.entities[0].y), (x, y + w.entities[0].vy))
