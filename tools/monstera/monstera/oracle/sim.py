"""Reference simulation (the conformance oracle). Contract: architecture/RUNTIME-CONTRACT.md.

Pure integer arithmetic, no floats, no time, no unordered iteration. The Kotlin and Swift
cores are independent re-implementations of exactly this behaviour.
"""
import struct
from dataclasses import dataclass, field
from typing import Dict, List

from . import fixed as fx
from .prng import Pcg32, fnv1a64

FORMAT_VERSION = 1
DIRECTIONS = {"none": (0, 0), "up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


@dataclass
class Entity:
    id: int
    kind: int
    controlled: bool
    x: int
    y: int
    vx: int
    vy: int
    age: int = 0


class Config:
    """Runtime configuration derived from a validated canonical spec (game.world + game.runtime)."""

    def __init__(self, game: dict) -> None:
        rt = game["runtime"]
        self.world_w = int(game["world"]["width"]) << fx.FRAC_BITS
        self.world_h = int(game["world"]["height"]) << fx.FRAC_BITS
        self.max_entities = rt["maxEntities"]
        self.lives = rt["lives"]
        self.win_score = rt["winScore"]
        inp = game["input"]
        self.drag_gain = inp["dragGain"]
        self.swipe_speed = inp["swipeSpeed"]
        self.tap_kind = inp["tapKind"]
        self.tap_vx = inp["tapVx"]
        self.tap_vy = inp["tapVy"]
        self.kinds = rt["kinds"]
        self.kind_index = {k["id"]: i for i, k in enumerate(self.kinds)}
        self.initial = rt["initialEntities"]
        self.spawners = rt["spawners"]
        self.collisions = rt["collisions"]
        self.streams = sorted({s["stream"] for s in self.spawners}, key=lambda n: n.encode("utf-8"))


@dataclass
class World:
    cfg: Config
    seed: int
    tick: int = 0
    next_id: int = 1
    score: int = 0
    lives: int = 0
    ended: bool = False
    pressed: bool = False
    entities: List[Entity] = field(default_factory=list)
    rngs: Dict[str, Pcg32] = field(default_factory=dict)


def new_world(cfg: Config, seed: int) -> World:
    w = World(cfg, seed, lives=cfg.lives)
    w.rngs = {name: Pcg32.for_stream(seed, name) for name in cfg.streams}
    for e in cfg.initial:
        _add_entity(w, cfg.kind_index[e["kind"]], e["controlled"], e["x"], e["y"], e["vx"], e["vy"])
    return w


def _add_entity(w: World, kind: int, controlled: bool, x: int, y: int, vx: int, vy: int) -> None:
    w.entities.append(Entity(w.next_id, kind, controlled, x, y, vx, vy))
    w.next_id += 1


def _first_controlled(w: World):
    for e in w.entities:
        if e.controlled:
            return e
    return None


def _clamp_to_world(w: World, e: Entity) -> None:
    k = w.cfg.kinds[e.kind]
    e.x = fx.clamp(e.x, 0, w.cfg.world_w - k["width"])
    e.y = fx.clamp(e.y, 0, w.cfg.world_h - k["height"])


def _apply_input(w: World, ev: dict) -> None:
    t = ev["type"]
    if t == "press":
        w.pressed = True
    elif t == "release":
        w.pressed = False
    elif t == "tap":
        src = _first_controlled(w)
        if w.cfg.tap_kind != "" and src is not None and len(w.entities) < w.cfg.max_entities:
            _add_entity(w, w.cfg.kind_index[w.cfg.tap_kind], False, src.x, src.y, w.cfg.tap_vx, w.cfg.tap_vy)
    elif t == "drag":
        gain = w.cfg.drag_gain
        for e in w.entities:
            if e.controlled:
                e.x = fx.add(e.x, fx.mul(ev["dx"], gain))
                e.y = fx.add(e.y, fx.mul(ev["dy"], gain))
                _clamp_to_world(w, e)
    elif t == "swipe":
        dx, dy = DIRECTIONS[ev["dir"]]
        for e in w.entities:
            if e.controlled:
                e.vx = fx.sat(dx * w.cfg.swipe_speed)
                e.vy = fx.sat(dy * w.cfg.swipe_speed)


def _spawn(w: World) -> None:
    for sp in w.cfg.spawners:
        if w.tick < sp["startTick"] or (w.tick - sp["startTick"]) % sp["intervalTicks"] != 0:
            continue
        rng = w.rngs[sp["stream"]]
        # Always draw x then y, even when the entity cap skips the spawn, so streams stay aligned.
        x = sp["xMin"] + rng.next_below(sp["xMax"] - sp["xMin"] + 1)
        y = sp["yMin"] + rng.next_below(sp["yMax"] - sp["yMin"] + 1)
        if len(w.entities) < w.cfg.max_entities:
            _add_entity(w, w.cfg.kind_index[sp["kind"]], False, x, y, sp["vx"], sp["vy"])


def _move(w: World) -> None:
    for e in w.entities:
        e.x = fx.add(e.x, e.vx)
        e.y = fx.add(e.y, e.vy)
        e.age += 1
        k = w.cfg.kinds[e.kind]
        policy = k["exitPolicy"]
        if policy == "clamp":
            _clamp_to_world(w, e)
        elif policy == "bounce":
            max_x = w.cfg.world_w - k["width"]
            max_y = w.cfg.world_h - k["height"]
            if e.x < 0:
                e.x, e.vx = fx.neg(e.x), fx.neg(e.vx)
            elif e.x > max_x:
                e.x, e.vx = fx.sub(fx.add(max_x, max_x), e.x), fx.neg(e.vx)
            if e.y < 0:
                e.y, e.vy = fx.neg(e.y), fx.neg(e.vy)
            elif e.y > max_y:
                e.y, e.vy = fx.sub(fx.add(max_y, max_y), e.y), fx.neg(e.vy)
            _clamp_to_world(w, e)


def overlaps(ax: int, ay: int, aw: int, ah: int, bx: int, by: int, bw: int, bh: int) -> bool:
    """Half-open boxes [x, x+w) x [y, y+h): touching edges do not overlap; a zero-size box (a point)
    overlaps only a box that contains it strictly inside."""
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


def _collide_and_resolve(w: World) -> set:
    doomed = set()
    score_delta = 0
    lives_delta = 0
    for rule in w.cfg.collisions:
        ka = w.cfg.kind_index[rule["a"]]
        kb = w.cfg.kind_index[rule["b"]]
        same = ka == kb
        for a in w.entities:
            if a.kind != ka:
                continue
            for b in w.entities:
                if b.kind != kb or a.id == b.id or (same and a.id > b.id):
                    continue
                da, db = w.cfg.kinds[ka], w.cfg.kinds[kb]
                if overlaps(a.x, a.y, da["width"], da["height"], b.x, b.y, db["width"], db["height"]):
                    if rule["despawnA"]:
                        doomed.add(a.id)
                    if rule["despawnB"]:
                        doomed.add(b.id)
                    score_delta += rule["score"]
                    lives_delta += rule["lives"]
    w.score = fx.sat32(w.score + score_delta)
    w.lives = fx.sat32(w.lives + lives_delta)
    return doomed


def _outside(w: World, e: Entity) -> bool:
    k = w.cfg.kinds[e.kind]
    return e.x + k["width"] <= 0 or e.x >= w.cfg.world_w or e.y + k["height"] <= 0 or e.y >= w.cfg.world_h


def step(w: World, events: List[dict]) -> None:
    """One tick: input, spawn, move, collide, resolve, despawn, score. No-op once ended."""
    if w.ended:
        return
    for ev in events:
        _apply_input(w, ev)
    _spawn(w)
    _move(w)
    doomed = _collide_and_resolve(w)
    keep = []
    for e in w.entities:
        k = w.cfg.kinds[e.kind]
        gone = e.id in doomed or (k["exitPolicy"] == "despawn" and _outside(w, e)) or (
            k["lifetimeTicks"] > 0 and e.age >= k["lifetimeTicks"])
        if not gone:
            keep.append(e)
    w.entities = keep
    w.tick += 1
    if w.lives <= 0 or (w.cfg.win_score > 0 and w.score >= w.cfg.win_score):
        w.ended = True


def serialize(w: World) -> bytes:
    """Canonical little-endian state serialization (contract section 6)."""
    out = bytearray(struct.pack("<IIIiiBB", FORMAT_VERSION, w.tick, w.next_id, w.score, w.lives,
                                1 if w.ended else 0, 1 if w.pressed else 0))
    out += struct.pack("<I", len(w.cfg.streams))
    for name in w.cfg.streams:
        r = w.rngs[name]
        out += struct.pack("<QQ", r.state, r.inc)
    out += struct.pack("<I", len(w.entities))
    for e in w.entities:
        out += struct.pack("<IIBiiiiI", e.id, e.kind, 1 if e.controlled else 0, e.x, e.y, e.vx, e.vy, e.age)
    return bytes(out)


def state_hash(w: World) -> int:
    return fnv1a64(serialize(w))


def observe(w: World) -> dict:
    return {"tick": w.tick, "score": w.score, "lives": w.lives, "entityCount": len(w.entities),
            "ended": 1 if w.ended else 0, "nextId": w.next_id}


def run_scenario(cfg: Config, scenario: dict) -> List[dict]:
    """Runs a scenario and returns one {steps, hash, observe} record per requested checkpoint."""
    w = new_world(cfg, scenario["seed"])
    by_tick: Dict[int, List[dict]] = {}
    for item in scenario["inputs"]:
        by_tick.setdefault(item["tick"], []).extend(item["events"])
    wanted = {c["tick"] for c in scenario["checkpoints"]}
    out = []
    if 0 in wanted:
        out.append({"tick": 0, "hash": state_hash(w), "observe": observe(w)})
    for i in range(scenario["ticks"]):
        step(w, by_tick.get(i, []))
        if (i + 1) in wanted:
            out.append({"tick": i + 1, "hash": state_hash(w), "observe": observe(w)})
    return out
