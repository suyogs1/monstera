"""Runtime data emission: the game's runtime configuration as Kotlin/Swift literals, and the
golden scenarios as a line-oriented text resource read by the native conformance tests.

Only data is emitted here. Behaviour lives in the hand-written runtime templates, which are
independent implementations of architecture/RUNTIME-CONTRACT.md.
"""
from __future__ import annotations

from typing import Any

_EXIT = {"despawn": "DESPAWN", "clamp": "CLAMP", "bounce": "BOUNCE"}


def _units(value: float) -> int:
    return int(value) << 16  # semantic validation guarantees whole units


def _kstr(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$") + '"'


def _sstr(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def kotlin_config(game: dict[str, Any], package: str, header: str) -> str:
    rt, inp, world = game["runtime"], game["input"], game["world"]
    kinds = ",\n".join(
        f"            KindConfig({_kstr(k['id'])}, {k['width']}L, {k['height']}L, {k['lifetimeTicks']}, ExitPolicy.{_EXIT[k['exitPolicy']]})"
        for k in rt["kinds"])
    initial = ",\n".join(
        f"            InitialEntity({_kstr(e['kind'])}, {e['x']}L, {e['y']}L, {e['vx']}L, {e['vy']}L, {str(e['controlled']).lower()})"
        for e in rt["initialEntities"])
    spawners = ",\n".join(
        f"            SpawnerConfig({_kstr(s['stream'])}, {_kstr(s['kind'])}, {s['intervalTicks']}, {s['xMin']}L, {s['xMax']}L, "
        f"{s['yMin']}L, {s['yMax']}L, {s['vx']}L, {s['vy']}L)" for s in rt["spawners"])
    rules = ",\n".join(
        f"            CollisionRule({_kstr(c['a'])}, {_kstr(c['b'])}, {str(c['despawnA']).lower()}, "
        f"{str(c['despawnB']).lower()}, {c['score']}L, {c['lives']}L)" for c in rt["collisions"])

    def block(name: str, kind: str, items: str) -> str:
        body = f"\n{items},\n        " if items else ""
        return f"        {name} = listOf<{kind}>({body}),"

    return "\n".join([
        header, f"package {package}.runtime", "",
        "/** The runtime configuration of the canonical specification this app was generated from. */",
        "object GeneratedRuntimeConfig {",
        f"    const val TICK_RATE: Int = {game['simulation']['tickRate']}",
        f"    const val MAX_TICKS_PER_FRAME: Int = {game['simulation']['maxTicksPerFrame']}",
        "",
        "    val config: RuntimeConfig = RuntimeConfig(",
        f"        worldWidth = {_units(world['width'])}L,",
        f"        worldHeight = {_units(world['height'])}L,",
        f"        maxEntities = {rt['maxEntities']},",
        f"        lives = {rt['lives']}L,",
        f"        winScore = {rt['winScore']}L,",
        f"        dragGain = {inp['dragGain']}L,",
        f"        swipeSpeed = {inp['swipeSpeed']}L,",
        f"        tapKind = {_kstr(inp['tapKind'])},",
        f"        tapVx = {inp['tapVx']}L,",
        f"        tapVy = {inp['tapVy']}L,",
        block("kinds", "KindConfig", kinds),
        block("initialEntities", "InitialEntity", initial),
        block("spawners", "SpawnerConfig", spawners),
        block("collisions", "CollisionRule", rules),
        "    )",
        "}", ""])


def swift_config(game: dict[str, Any], header: str) -> str:
    rt, inp, world = game["runtime"], game["input"], game["world"]
    kinds = ",\n".join(
        f"            KindConfig(id: {_sstr(k['id'])}, width: {k['width']}, height: {k['height']}, "
        f"lifetimeTicks: {k['lifetimeTicks']}, exitPolicy: .{k['exitPolicy']})" for k in rt["kinds"])
    initial = ",\n".join(
        f"            InitialEntity(kind: {_sstr(e['kind'])}, x: {e['x']}, y: {e['y']}, vx: {e['vx']}, vy: {e['vy']}, "
        f"controlled: {str(e['controlled']).lower()})" for e in rt["initialEntities"])
    spawners = ",\n".join(
        f"            SpawnerConfig(stream: {_sstr(s['stream'])}, kind: {_sstr(s['kind'])}, intervalTicks: {s['intervalTicks']}, "
        f"xMin: {s['xMin']}, xMax: {s['xMax']}, yMin: {s['yMin']}, yMax: {s['yMax']}, vx: {s['vx']}, vy: {s['vy']})"
        for s in rt["spawners"])
    rules = ",\n".join(
        f"            CollisionRule(a: {_sstr(c['a'])}, b: {_sstr(c['b'])}, despawnA: {str(c['despawnA']).lower()}, "
        f"despawnB: {str(c['despawnB']).lower()}, score: {c['score']}, lives: {c['lives']})" for c in rt["collisions"])

    return "\n".join([
        header, "",
        "/// The runtime configuration of the canonical specification this app was generated from.",
        "public enum GeneratedRuntimeConfig {",
        f"    public static let tickRate = {game['simulation']['tickRate']}",
        f"    public static let maxTicksPerFrame = {game['simulation']['maxTicksPerFrame']}",
        "",
        "    public static let config = RuntimeConfig(",
        f"        worldWidth: {_units(world['width'])},",
        f"        worldHeight: {_units(world['height'])},",
        f"        maxEntities: {rt['maxEntities']},",
        f"        lives: {rt['lives']},",
        f"        winScore: {rt['winScore']},",
        f"        dragGain: {inp['dragGain']},",
        f"        swipeSpeed: {inp['swipeSpeed']},",
        f"        tapKind: {_sstr(inp['tapKind'])},",
        f"        tapVx: {inp['tapVx']},",
        f"        tapVy: {inp['tapVy']},",
        _swift_list("kinds", kinds) + ",",
        _swift_list("initialEntities", initial) + ",",
        _swift_list("spawners", spawners) + ",",
        _swift_list("collisions", rules),
        "    )",
        "}", ""])


def _swift_list(label: str, items: str) -> str:
    if not items:
        return f"        {label}: []"
    return f"        {label}: [\n{items},\n        ]"


def scenarios_text(scenarios: list[dict[str, Any]]) -> str:
    """Line-oriented, whitespace-separated, trivially parsed by both native test suites.

    scenario <name> <seed> <ticks>
    input <tick> <type> <dx> <dy> <dir>
    checkpoint <tick> <hash16> <obs.tick> <score> <lives> <entityCount> <ended> <nextId>
    end
    """
    lines = ["# GENERATED conformance scenarios - do not edit", "monstera-scenarios 1"]
    for sc in scenarios:
        lines.append(f"scenario {sc['name']} {sc['seed']} {sc['ticks']}")
        for step in sc["inputs"]:
            for ev in step["events"]:
                lines.append(f"input {step['tick']} {ev['type']} {ev['dx']} {ev['dy']} {ev['dir']}")
        for cp in sc["checkpoints"]:
            o = cp["observe"]
            lines.append(f"checkpoint {cp['tick']} {cp['hash']} {o['tick']} {o['score']} {o['lives']} "
                         f"{o['entityCount']} {o['ended']} {o['nextId']}")
        lines.append("end")
    return "\n".join(lines) + "\n"
