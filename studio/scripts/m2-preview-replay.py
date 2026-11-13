"""Host CPython replay of live preview sessions recorded in the browser.

Usage: python m2-preview-replay.py <traces.json> <out.json>. Each trace is {name, text, seed, frames, hash, tick}:
the spec text the session ran, its seed, and every frame [elapsedNanos, events] the page gave the engine's GameLoop.
The same GameLoop is driven here with the same frames; the final state hash must equal the browser's.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "monstera"))

from monstera.jsonio import loads_strict  # noqa: E402
from monstera.oracle import loop, sim  # noqa: E402


def replay(t: dict) -> dict:
    game = loads_strict(t["text"])["game"]
    lp = loop.GameLoop(sim.new_world(sim.Config(game), t["seed"]), game["simulation"]["tickRate"],
                       game["simulation"]["maxTicksPerFrame"])
    for nanos, events in t["frames"]:
        for e in events:
            lp.submit(e)
        lp.frame(nanos)
    return {"name": t["name"], "hash": format(sim.state_hash(lp.world), "016x"), "tick": lp.world.tick,
            "frames": len(t["frames"]), "events": sum(len(e) for _, e in t["frames"])}


traces = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
Path(sys.argv[2]).write_text(json.dumps([replay(t) for t in traces]), encoding="utf-8")
