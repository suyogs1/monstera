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
PUMPKIN_SPEC = "apps/pumpkin-blaster/monstera.spec.json"
RUSH_SPEC = "apps/trick-or-treat-rush/monstera.spec.json"
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


def pumpkin_aimer(seed: int, ticks: int) -> dict[int, list[dict]]:
    """Input trace of a deterministic player computed by driving the oracle: it slides its bullet row toward
    the nearest pumpkin or bat (at most 40 units per tick), avoids embers in its row, and
    fires every 6 ticks. Checkpoints are still recorded by `monstera scenarios record`."""
    import json as _json
    from monstera.oracle import sim
    game = _json.loads((REPO / PUMPKIN_SPEC).read_text(encoding="utf-8"))["game"]
    cfg = sim.Config(game)
    w = sim.new_world(cfg, seed)
    ids = [k["id"] for k in cfg.kinds]
    one = 65536
    out: dict[int, list[dict]] = {}
    for t in range(ticks):
        if w.ended:
            break
        ship = next(e for e in w.entities if e.controlled)
        targets = [e for e in w.entities if ids[e.kind] in ("pumpkin", "bat") and e.x > ship.x]
        events = []
        if targets:
            tgt = min(targets, key=lambda e: e.x)
            # A tap spawns the bullet at the ship's top-left, so aim the bullet row (not the ship centre).
            want = tgt.y + cfg.kinds[tgt.kind]["height"] // 2 - cfg.kinds[cfg.kind_index["bullet"]]["height"] // 2
            embers = [e for e in w.entities if ids[e.kind] == "ember" and ship.x < e.x < ship.x + 400 * one]
            for em in embers:
                if abs(em.y - want) < 120 * one:
                    want = em.y - 160 * one if em.y > 540 * one else em.y + 160 * one
            dy = max(-40 * one, min(40 * one, want - ship.y))
            if dy:
                events.append(ev("drag", 0, dy))
        if t % 6 == 0:
            events.append(ev("tap"))
        if events:
            out[t] = events
        sim.step(w, events)
    return out


def build_pumpkin() -> list[dict]:
    """pumpkin-blaster (G3): the shipped game's own behaviour, driven by plausible play."""
    def play(n: int) -> dict[int, list[dict]]:
        out: dict[int, list[dict]] = {}
        for t in range(n):
            events = []
            if t % 10 == 0:
                events.append(ev("tap"))
            if t % 15 == 0:
                events.append(ev("drag", units(((t // 15) % 4) * 3 - 4), units(70 if (t // 120) % 2 == 0 else -70)))
            if events:
                out[t] = events
        return out
    def pb(name: str, description: str, seed: int, ticks: int, by_tick: dict[int, list[dict]], frames: dict | None = None) -> dict:
        return scenario(name, description, seed, ticks, by_tick, spec=PUMPKIN_SPEC, frames=frames)
    return [
        pb("sweep-and-fire", "A player sweeping up and down while firing every 10 ticks: bullets and pumpkins/bats collide, score accumulates (+10 pumpkin, +25 bat) and some hazards still reach the ship.",
           2026, 2400, play(2400)),
        pb("idle-defence", "No input: four PRNG streams (pumpkins, bats, embers, stars) spawn from the right edge and the idle ship loses all five lives (the game ends near tick 1140); later ticks change nothing.",
           11, 6000, {}),
        pb("win-1000", "A deterministic aiming player (row tracking, ember avoidance, a shot every 6 ticks) reaches the 1000-point winScore: the game ends with ended = 1 and lives left, and later ticks change nothing.",
           1000, 6000, pumpkin_aimer(1000, 6000)),
        pb("volley-cap", "200 taps in one tick against maxEntities 128: surplus bullets are skipped, PRNG draws continue, and the volley expires before spawning resumes.",
           13, 300, {20: [ev("tap")] * 200}),
        pb("frame-jitter-60hz", "Frame-driven: 1800 frames of 12-22 ms (about 60 Hz with jitter) feed taps and drags into the fixed-tick loop of the landscape shooter.",
           17, 1800, {f: [ev("tap")] for f in range(4, 1800, 11)} | {f: [ev("drag", units(2), units(((f // 40) % 2) * 120 - 60))] for f in range(9, 1800, 40)},
           frames={"count": 1800, "seed": 606, "minNanos": 12000000, "maxNanos": 22000000}),
    ]
# --- trick-or-treat-rush (G3) -------------------------------------------------------------------
RUSH_STEP = 460 * 65536            # lane step = input.swipeSpeed; a lane swipe is drag(+-step, 0)
RUSH_HAZARDS = ("tombstone", "ghost")


def lane_left() -> dict:
    return ev("drag", -RUSH_STEP)


def lane_right() -> dict:
    return ev("drag", RUSH_STEP)


def rush_bot(seed: int, ticks: int, chase_candy: bool, dodge: bool) -> dict[int, list[dict]]:
    """Input trace of a deterministic player, computed by driving the oracle (the oracle is only
    used to see the world; the checkpoints are still recorded by `monstera scenarios record`).
    Each tick it picks the nearest lane that no hazard reaches within the next 2 ticks, preferring a
    lane with candy approaching, and swipes there one lane per event."""
    import json as _json
    from monstera.oracle import sim
    game = _json.loads((REPO / RUSH_SPEC).read_text(encoding="utf-8"))["game"]
    cfg = sim.Config(game)
    w = sim.new_world(cfg, seed)
    kinds = cfg.kinds
    runner_k = kinds[cfg.kind_index["runner"]]
    lanes = [0, RUSH_STEP, 2 * RUSH_STEP]

    def hits(e, lane_x: int, horizon: int, runner) -> bool:
        k = kinds[e.kind]
        if not sim.overlaps(e.x, 0, k["width"], 1, lane_x, 0, runner_k["width"], 1):
            return False
        for s in range(1, horizon + 1):
            y = e.y + e.vy * s
            if sim.overlaps(0, y, 1, k["height"], 0, runner.y, 1, runner_k["height"]):
                return True
        return False

    out: dict[int, list[dict]] = {}
    for t in range(ticks):
        if w.ended:
            break
        runner = next(e for e in w.entities if e.controlled)
        cur = lanes.index(runner.x) if runner.x in lanes else min(range(3), key=lambda i: abs(lanes[i] - runner.x))
        danger = [dodge and any(kinds[e.kind]["id"] in RUSH_HAZARDS and hits(e, lanes[i], 2, runner) for e in w.entities)
                  for i in range(3)]
        sweet = [chase_candy and any(kinds[e.kind]["id"] == "candy" and hits(e, lanes[i], 60, runner) for e in w.entities)
                 for i in range(3)]
        safe = [i for i in range(3) if not danger[i]] or [cur]
        target = min(safe, key=lambda i: (not sweet[i], abs(i - cur), i))
        if danger[cur] or (sweet[target] and not sweet[cur]):
            events = [lane_right() if target > cur else lane_left() for _ in range(abs(target - cur))]
        else:
            events = []
        if events:
            out[t] = events
        sim.step(w, events)
    return out


def build_rush() -> list[dict]:
    def rush(name: str, description: str, seed: int, ticks: int, by_tick: dict[int, list[dict]],
             frames: dict | None = None) -> dict:
        return scenario(name, description, seed, ticks, by_tick, spec=RUSH_SPEC, frames=frames)
    return [
        rush("hand-lane-zero", "Hand-verified (tools/monstera/tests/test_trick_or_treat.py): one left swipe at tick 0 puts the runner in lane 0; the first stripe scores at step 125, the first lane-0 tombstone (spawned tick 120) costs a life in steps 234..240, and after 300 steps the score is exactly 6.",
             3, 300, {0: [lane_left()]}),
        rush("idle-run", "No input: the runner stays in the middle lane, scores one point per distance stripe, collects the middle-lane candy and loses all three lives to middle-lane tombstones; the run ends and later ticks change nothing.",
             8, 1500, {}),
        rush("lane-input-order", "Several lane swipes in one tick are applied in order and each is clamped at the world edge: left, left, right from the middle ends in the middle lane (a summed delta would end in lane 0); right, right, right ends in lane 2.",
             21, 400, {3: [lane_left(), lane_left(), lane_right()], 50: [lane_right(), lane_right(), lane_right()],
                       90: [lane_left()], 140: [lane_left(), lane_right(), lane_left(), lane_left()]}),
        rush("dodge-run", "A deterministic player dodges every hazard for 90 seconds through all three difficulty phases (tombstones, ghosts from 30 s, doubled tombstones from 60 s) and keeps all three lives; candy only when it is safe.",
             2026, 5400, rush_bot(2026, 5400, chase_candy=True, dodge=True)),
        rush("candy-chase", "A greedy player chases candy and ignores hazards: candy scores 10 each, collisions with tombstones in the candy lanes cost lives and end the run.",
             44, 3000, rush_bot(44, 3000, chase_candy=True, dodge=False)),
        rush("frame-jitter", "Frame-driven: 2400 frames of 10-24 ms jitter at a 60 tick/s simulation; lane swipes are submitted per frame and land on whatever tick comes next.",
             55, 2400, {f: [lane_left() if (f // 97) % 2 else lane_right()] for f in range(7, 2400, 41)},
             frames={"count": 2400, "seed": 3131, "minNanos": 10000000, "maxNanos": 24000000}),
    ]


def main(argv: list[str]) -> int:
    projects = (("monstera-sample", build), ("boundary-lab", build_lab), ("pumpkin-blaster", build_pumpkin),
                ("trick-or-treat-rush", build_rush))
    for project, factory in projects:
        if argv and project not in argv:
            continue  # name projects to write only those (existing recorded scenarios stay untouched)
        scenarios = factory()
        out = SCENARIOS / project
        out.mkdir(parents=True, exist_ok=True)
        for sc in scenarios:
            (out / f"{sc['name']}.scenario.json").write_bytes(canonical_text(sc).encode("utf-8"))
            print(f"wrote {project}/{sc['name']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
