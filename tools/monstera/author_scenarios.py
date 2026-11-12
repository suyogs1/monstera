"""Writes the input traces of the monstera-sample golden scenarios (definitions only).

    python3 tools/monstera/author_scenarios.py        # writes spec/scenarios/monstera-sample/*.scenario.json
    monstera scenarios record --all                    # then record expected checkpoints with the oracle

Deterministic: no clock, no randomness beyond the fixed LCG below. Seeds were chosen by searching
the oracle for ticks with several simultaneous collisions (see the `collision-order` description).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from monstera.jsonio import canonical_text  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SPEC = "spec/samples/monstera-sample/monstera.spec.json"
LAB_SPEC = "spec/samples/boundary-lab/monstera.spec.json"
SCENARIOS = REPO / "spec" / "scenarios"
PLACEHOLDER_SHA = "0" * 64  # replaced by `monstera scenarios record`
MAX, MIN = 2147483647, -2147483648


def units(n: float) -> int:
    return int(n * 65536)


def ev(kind: str, dx: int = 0, dy: int = 0, direction: str = "none") -> dict:
    return {"type": kind, "dx": dx, "dy": dy, "dir": direction}


def steps(by_tick: dict[int, list[dict]]) -> list[dict]:
    return [{"tick": t, "events": by_tick[t]} for t in sorted(by_tick)]


def scenario(name: str, description: str, seed: int, ticks: int, by_tick: dict[int, list[dict]],
             spec: str = SPEC, frames: dict | None = None) -> dict:
    return {
        "scenarioVersion": 1, "name": name, "description": description,
        "spec": {"path": spec, "sha256": PLACEHOLDER_SHA},
        "seed": seed, "ticks": ticks, "frames": frames or {"count": 0, "seed": 0, "minNanos": 0, "maxNanos": 0},
        "inputs": steps(by_tick), "checkpoints": [],
    }


def collision_inputs(n: int) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    for t in range(n):
        events = []
        if t % 6 == 0:
            events.append(ev("tap"))
        if t % 20 == 0:
            events.append(ev("drag", units(((t // 20) * 137) % 600 - 300)))
        if events:
            out[t] = events
    return out


def long_run_inputs(n: int) -> dict[int, list[dict]]:
    out: dict[int, list[dict]] = {}
    x = 12345
    for t in range(n):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        events = []
        if t % 10 == 0:
            events.append(ev("tap"))
        if t % 25 == 0:
            events.append(ev("drag", units((x >> 8) % 400 - 200)))
        if events:
            out[t] = events
    return out


def build() -> list[dict]:
    return [
        scenario("idle", "No input for 600 ticks: two PRNG streams, spawning, ball bounce, clamped drifter at saturated velocity, enemies hitting the idle player.",
                 1, 600, {}),
        scenario("spawn-determinism", "3000 ticks with only press/release: the state hash must follow the PRNG streams exactly, including the pressed flag.",
                 424242, 3000, {10: [ev("press")], 2000: [ev("release")]}),
        scenario("collision-order", "Bullets, enemies and the player collide in the same tick (multi-kill ticks and a kill plus a life lost in one tick); resolution must not depend on pair order.",
                 17, 900, collision_inputs(900)),
        scenario("input-order", "Several events in one tick (drag, tap, drag, tap, swipe) are applied in listed order, so the two bullets spawn at different x; later swipes retarget velocity.",
                 99, 120, {
                     3: [ev("drag", units(100)), ev("tap"), ev("drag", units(-50)), ev("tap"), ev("swipe", direction="left")],
                     4: [ev("tap")],
                     40: [ev("swipe", direction="up")],
                     80: [ev("swipe", direction="none"), ev("drag", units(-3.5), units(2.25))],
                 }),
        scenario("saturation", "Extreme drag deltas (int32 limits), negative deltas and swipes against every wall: saturation, clamping and bounce reflection with negative values.",
                 7, 90, {
                     0: [ev("drag", MAX, MIN)],
                     5: [ev("drag", MIN, MAX)],
                     10: [ev("swipe", direction="right")],
                     25: [ev("swipe", direction="down")],
                     45: [ev("swipe", direction="left")],
                     60: [ev("drag", MIN, MIN), ev("tap")],
                     70: [ev("swipe", direction="up")],
                 }),
        scenario("entity-cap", "80 taps in a single tick hit maxEntities; skipped spawns must still consume the PRNG draws, and spawning resumes once bullets expire.",
                 5, 220, {10: [ev("tap")] * 80}),
        scenario("long-run", "10,000 ticks of pseudo-random drags and taps from a fixed LCG: long-horizon drift would show up as a hash mismatch.",
                 5, 10000, long_run_inputs(10000)),
        scenario("loop-jitter", "Frame-driven: 1500 frames of 4-40 ms jitter drive the fixed-tick GameLoop; taps and drags are submitted per frame and land on whatever tick comes next. A different tick count or input placement diverges.",
                 31, 1500, {f: [ev("tap")] for f in range(5, 1500, 37)} | {f: [ev("drag", units((f % 9) - 4))] for f in range(11, 1500, 53)},
                 frames={"count": 1500, "seed": 12345, "minNanos": 4000000, "maxNanos": 40000000}),
        scenario("loop-120hz", "Frame-driven: 120 Hz display (about 8.3 ms frames, +-0.1 ms jitter) against a 60 tick/s simulation: zero- and one-tick frames alternate with exact integer accumulation.",
                 32, 1200, {f: [ev("tap")] for f in range(3, 1200, 29)},
                 frames={"count": 1200, "seed": 777, "minNanos": 8233333, "maxNanos": 8433333}),
        scenario("loop-hitch", "Frame-driven: frame times from 1 ms to 1.5 s, so long hitches are clamped to one second and capped at maxTicksPerFrame with the backlog dropped.",
                 33, 800, {f: [ev("tap")] for f in range(2, 800, 17)},
                 frames={"count": 800, "seed": 4242, "minNanos": 1000000, "maxNanos": 1500000000}),
        scenario("game-over", "Idle player until lives reach 0 (about tick 11900); afterwards stepping is a no-op and the tick stops advancing.",
                 3, 20000, {}),
    ]


def build_lab() -> list[dict]:
    """boundary-lab: every expectation is hand-computable (see tools/monstera/tests/test_boundary_lab.py)."""
    def lab(name: str, description: str, seed: int, ticks: int, by_tick: dict[int, list[dict]]) -> dict:
        return scenario(name, description, seed, ticks, by_tick, spec=LAB_SPEC)

    return [
        lab("touching-edges", "Boxes that touch exactly (edge, edge, corner) do not collide, overlap by one raw unit does, a zero-size box on a corner does not, identical boxes do.",
            1, 3, {}),
        lab("world-exit", "Entities leave the world exactly when their box is entirely outside (x + w <= 0 or x >= W): ticks 5, 5 and 15.",
            2, 30, {}),
        lab("bounce-clamp", "Bounce reflects position and velocity at the exact wall (right, left, bottom), clamp pins at the wall, saturated velocity ends clamped.",
            3, 12, {}),
        lab("lifetime-and-cap", "Lifetime 5 despawns at tick 5; a filler spawner reaches maxEntities and later spawns are skipped while their PRNG draws continue.",
            4, 150, {}),
        lab("negative-rounding", "Odd negative and positive drag deltas through a 1.5 gain: mul rounds toward negative infinity (-4.5 -> -5); int32 extremes clamp at the walls.",
            5, 40, {
                0: [ev("drag", -3, -1)],
                1: [ev("drag", 1, 3)],
                2: [ev("drag", MIN, MIN)],
                3: [ev("drag", MAX, MAX)],
                4: [ev("drag", -7, 5)],
                5: [ev("swipe", direction="left")],
                15: [ev("swipe", direction="none"), ev("drag", -1, -1)],
                20: [ev("swipe", direction="down")],
            }),
        scenario("loop-lives-end", "Frame-driven: taps on the mine through a jittery 30 Hz display end the game; later frames change nothing.",
                 34, 300, {f: [ev("tap")] for f in range(10, 300, 20)},
                 spec=LAB_SPEC, frames={"count": 300, "seed": 99, "minNanos": 25000000, "maxNanos": 45000000}),
        lab("lives-end", "Three taps each spawn a bullet on the mine (one life each): the game ends on the third and later input is ignored with the tick frozen.",
            6, 40, {10: [ev("tap")], 11: [ev("tap")], 12: [ev("tap")], 20: [ev("tap")], 25: [ev("drag", 65536, 65536)]}),
    ]


def main() -> int:
    for project, scenarios in (("monstera-sample", build()), ("boundary-lab", build_lab())):
        out = SCENARIOS / project
        out.mkdir(parents=True, exist_ok=True)
        for sc in scenarios:
            (out / f"{sc['name']}.scenario.json").write_bytes(canonical_text(sc).encode("utf-8"))
            print(f"wrote {project}/{sc['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
