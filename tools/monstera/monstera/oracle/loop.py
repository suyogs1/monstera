"""Fixed-tick frame loop (contract section 1): exact integer accumulator and input queue.

The shell measures wall-clock time and feeds elapsed nanoseconds; everything else, including how
many ticks run, is integer arithmetic that is identical on every platform.
"""
from . import sim

NANOS = 1_000_000_000
MAX_FRAME_NANOS = NANOS  # a longer frame (pause, breakpoint) is treated as one second


class FrameClock:
    def __init__(self, tick_rate: int, max_ticks_per_frame: int) -> None:
        self.tick_rate = tick_rate
        self.max_ticks = max_ticks_per_frame
        self.acc = 0  # elapsed nanoseconds times tickRate; one tick is NANOS units

    def advance(self, elapsed_nanos: int) -> int:
        """Ticks to run for a frame of `elapsed_nanos`. Negative durations count as zero. Ticks beyond
        maxTicksPerFrame are dropped (the backlog is discarded, only the sub-tick remainder is kept)."""
        elapsed = min(max(elapsed_nanos, 0), MAX_FRAME_NANOS)
        self.acc += elapsed * self.tick_rate
        ticks, self.acc = divmod(self.acc, NANOS)
        return min(ticks, self.max_ticks)

    @property
    def alpha(self) -> int:
        """Progress toward the next tick as a Q16.16 raw value in [0, 65535], for render interpolation only."""
        return (self.acc << 16) // NANOS


class GameLoop:
    def __init__(self, world: sim.World, tick_rate: int, max_ticks_per_frame: int) -> None:
        self.world = world
        self.clock = FrameClock(tick_rate, max_ticks_per_frame)
        self.pending: list = []

    def submit(self, event: dict) -> None:
        """Queue an input event; it is applied at the start of the next tick, in submission order."""
        self.pending.append(event)

    def frame(self, elapsed_nanos: int) -> int:
        ticks = self.clock.advance(elapsed_nanos)
        for i in range(ticks):
            sim.step(self.world, self.pending if i == 0 else [])
            if i == 0:
                self.pending = []
        return ticks

def frame_durations(frames: dict) -> list:
    """Frame durations of a frame-driven scenario: an LCG (x = x*1103515245+12345 & 0x7FFFFFFF) from
    frames.seed, duration = minNanos + (x * (maxNanos - minNanos + 1)) >> 31, which spreads the full
    31-bit output over the whole span (x * span < 2^31 * (4e9 + 1) < 2^63)."""
    x = frames["seed"]
    span = frames["maxNanos"] - frames["minNanos"] + 1
    out = []
    for _ in range(frames["count"]):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(frames["minNanos"] + ((x * span) >> 31))
    return out


def run_frame_scenario(cfg: sim.Config, scenario: dict, tick_rate: int, max_ticks_per_frame: int) -> list:
    """Drive a GameLoop with the scenario's frame durations. `inputs[].tick` is a FRAME index: those events
    are submitted just before that frame. A checkpoint `tick` is the number of frames completed; its
    observables still report the world's own tick count."""
    loop = GameLoop(sim.new_world(cfg, scenario["seed"]), tick_rate, max_ticks_per_frame)
    by_frame: dict = {}
    for item in scenario["inputs"]:
        by_frame.setdefault(item["tick"], []).extend(item["events"])
    wanted = {c["tick"] for c in scenario["checkpoints"]}
    out = []
    if 0 in wanted:
        out.append({"tick": 0, "hash": sim.state_hash(loop.world), "observe": sim.observe(loop.world)})
    for i, nanos in enumerate(frame_durations(scenario["frames"])):
        for event in by_frame.get(i, []):
            loop.submit(event)
        loop.frame(nanos)
        if (i + 1) in wanted:
            out.append({"tick": i + 1, "hash": sim.state_hash(loop.world), "observe": sim.observe(loop.world)})
    return out
