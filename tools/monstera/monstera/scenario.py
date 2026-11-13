"""Golden scenarios: load, validate, record (oracle only) and look up by project.
Contract: architecture/RUNTIME-CONTRACT.md section 7. Expected checkpoints are produced only by
`record`, an explicit command; nothing in validation or generation rewrites them.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import targets
from .jsonio import LoadError, canonical_text, load_path, sha256_hex
from .oracle import loop, sim
from .schema import Issue, SchemaStore
from .validate import validate_path

SCENARIO_SCHEMA = "scenario.schema.json"
SUFFIX = ".scenario.json"
SCENARIOS = targets.REPO_ROOT / "spec" / "scenarios"
OBSERVABLES = ("tick", "score", "lives", "entityCount", "ended", "nextId")
# Upper bound on the oracle work a scenario may demand: ticks x rules x maxEntities^2 pair tests.
# The largest committed scenario (20000 ticks, 64 entities, 3 rules) is about 2.5e8.
MAX_ORACLE_WORK = 5_000_000_000
# Issue codes that describe expected checkpoints or staleness, which `record` is about to rewrite.
RECORDING_CODES = frozenset({"scenario.spec-stale", "scenario.checkpoint-order", "scenario.checkpoint-range",
                             "scenario.final-checkpoint"})


class StaleScenarios(ValueError):
    """The project's scenarios are valid but were recorded against a different spec SHA-256. A ValueError like every
    other `load_for_project` refusal (callers that only catch ValueError behave exactly as before); raised only for
    this condition, so a caller can tell "the goldens do not apply to this spec" from "a golden is broken"."""


@dataclass(frozen=True)
class Loaded:
    path: Path
    data: dict[str, Any]


def scenario_files(project_id: str) -> list[Path]:
    return sorted((SCENARIOS / project_id).glob(f"*{SUFFIX}"))


def checkpoint_ticks(ticks: int) -> list[int]:
    """Deterministic checkpoint schedule: every tick for short runs, about 100 for long ones."""
    step = max(1, ticks // 100)
    return sorted({0, ticks, *range(step, ticks, step)})


def _spec_for(data: dict[str, Any], store: SchemaStore) -> tuple[Any, list[Issue]]:
    ref = data["spec"]
    spec_path = (targets.REPO_ROOT / ref["path"]).resolve()
    try:
        spec_path.relative_to(targets.REPO_ROOT)
    except ValueError:
        return None, [Issue("$.spec.path", "scenario.spec-path", "must stay inside the repository")]
    if not spec_path.is_file():
        return None, [Issue("$.spec.path", "scenario.spec-missing", f"{ref['path']} does not exist")]
    result = validate_path(spec_path, store)
    if not result.ok:
        return None, [Issue("$.spec.path", "scenario.spec-invalid", f"{ref['path']} is not a valid specification")]
    if result.sha256 != ref["sha256"]:
        return result, [Issue("$.spec.sha256", "scenario.spec-stale",
                              f"scenario was recorded against spec {ref['sha256'][:12]}, the spec is now "
                              f"{result.sha256[:12]}; run `monstera scenarios record`")]
    return result, []


def validate(path: Path, store: SchemaStore) -> tuple[dict[str, Any] | None, list[Issue]]:
    """Schema + semantic checks. Does not compare checkpoints with the oracle (see `check`)."""
    try:
        data = load_path(path)
    except LoadError as exc:
        return None, [Issue(path.name, exc.code, exc.message)]
    issues = store.validate(data, SCENARIO_SCHEMA)
    if issues:
        return None, issues
    out: list[Issue] = []
    frames = data["frames"]
    if frames["count"] > 0:
        if frames["minNanos"] > frames["maxNanos"]:
            out.append(Issue("$.frames.minNanos", "scenario.frames", "minNanos is greater than maxNanos"))
        if data["ticks"] != frames["count"]:
            out.append(Issue("$.ticks", "scenario.frames", "a frame-driven scenario must set ticks equal to frames.count"))
    elif any(frames[k] for k in ("seed", "minNanos", "maxNanos")):
        out.append(Issue("$.frames", "scenario.frames", "frames.count is 0 (tick-driven) so the other frames fields must be 0"))
    if path.name != data["name"] + SUFFIX:
        out.append(Issue("$.name", "scenario.name", f"name '{data['name']}' must match the file name {path.name}"))
    last = -1
    for i, step in enumerate(data["inputs"]):
        if step["tick"] <= last:
            out.append(Issue(f"$.inputs[{i}].tick", "scenario.order", "input ticks must be strictly ascending"))
        if step["tick"] >= data["ticks"]:
            out.append(Issue(f"$.inputs[{i}].tick", "scenario.range", f"tick {step['tick']} is not below ticks {data['ticks']}"))
        last = step["tick"]
    last = -1
    for i, cp in enumerate(data["checkpoints"]):
        if cp["tick"] <= last:
            out.append(Issue(f"$.checkpoints[{i}].tick", "scenario.checkpoint-order", "checkpoint ticks must be strictly ascending"))
        if cp["tick"] > data["ticks"]:
            out.append(Issue(f"$.checkpoints[{i}].tick", "scenario.checkpoint-range", f"tick {cp['tick']} exceeds ticks {data['ticks']}"))
        last = cp["tick"]
    if data["checkpoints"] and data["checkpoints"][-1]["tick"] != data["ticks"]:
        out.append(Issue("$.checkpoints", "scenario.final-checkpoint",
                         f"the last checkpoint must be at tick {data['ticks']}; a scenario cut short is not a test"))
    result, spec_issues = _spec_for(data, store)
    out += spec_issues
    if result is not None:
        game = result.spec["game"]
        steps = frames["count"] * game["simulation"]["maxTicksPerFrame"] if frames["count"] > 0 else data["ticks"]
        work = steps * max(1, len(game["runtime"]["collisions"])) * game["runtime"]["maxEntities"] ** 2
        if work > MAX_ORACLE_WORK:
            out.append(Issue("$.ticks", "scenario.cost",
                             f"worst-case oracle work {work:.2e} exceeds {MAX_ORACLE_WORK:.0e} "
                             "(ticks x rules x maxEntities^2); shorten the scenario or reduce the entity cap"))
    return data, sorted(set(out))


def checkpoints_for_game(game: dict[str, Any], data: dict[str, Any], ticks: list[int]) -> list[dict[str, Any]]:
    """Oracle checkpoints of scenario `data` (seed, inputs, frames) against an already validated `game`
    object. Pure: no file access, no recorded-hash check, so an edited in-memory draft can be run.
    The caller owns validation of `game` and `data`; `oracle_checkpoints` adds the recorded-spec check."""
    probe = dict(data, checkpoints=[{"tick": t} for t in ticks])
    cfg = sim.Config(game)
    if data["frames"]["count"] > 0:
        rows = loop.run_frame_scenario(cfg, probe, game["simulation"]["tickRate"], game["simulation"]["maxTicksPerFrame"])
    else:
        rows = sim.run_scenario(cfg, probe)
    return [{"tick": r["tick"], "hash": format(r["hash"], "016x"), "observe": r["observe"]} for r in rows]


def oracle_checkpoints(data: dict[str, Any], store: SchemaStore, ticks: list[int]) -> list[dict[str, Any]]:
    result, issues = _spec_for(data, store)
    if result is None or issues:
        raise ValueError("; ".join(map(str, issues)) or "spec unavailable")
    return checkpoints_for_game(result.spec["game"], data, ticks)


def record(path: Path, store: SchemaStore) -> list[Issue]:
    """Rewrite `path` with the spec hash current and oracle-produced checkpoints."""
    try:
        data = load_path(path)
    except LoadError as exc:
        return [Issue(path.name, exc.code, exc.message)]
    _, found = validate(path, store)
    blocking = [i for i in found if i.code not in RECORDING_CODES]
    if blocking:  # never record checkpoints for a scenario that validation rejects
        return blocking
    spec_path = (targets.REPO_ROOT / data["spec"]["path"]).resolve()
    result = validate_path(spec_path, store)
    data["spec"]["sha256"] = result.sha256
    data["checkpoints"] = oracle_checkpoints(data, store, checkpoint_ticks(data["ticks"]))
    # Replace atomically: an interrupted write must not destroy the committed golden file.
    temp = path.with_name(f".{path.name}.monstera-tmp")
    try:
        temp.write_bytes(canonical_text(data).encode("utf-8"))
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()
    return []


def check(path: Path, store: SchemaStore) -> list[Issue]:
    """validate + the committed checkpoints equal what the oracle produces now."""
    data, issues = validate(path, store)
    if issues or data is None:
        return issues
    if not data["checkpoints"]:
        return [Issue("$.checkpoints", "scenario.unrecorded", "no checkpoints; run `monstera scenarios record`")]
    fresh = oracle_checkpoints(data, store, [c["tick"] for c in data["checkpoints"]])
    if fresh != data["checkpoints"]:
        for want, got in zip(fresh, data["checkpoints"]):
            if want != got:
                return [Issue(f"$.checkpoints[tick={got['tick']}]", "scenario.oracle-mismatch",
                              "committed checkpoint differs from the oracle; run `monstera scenarios record` "
                              "if the change is intended")]
    return []


_CHECKED: dict[tuple[str, str], list[Issue]] = {}


def _checked(path: Path, spec_sha: str, store: SchemaStore) -> list[Issue]:
    """check() cached by (scenario bytes, spec sha): the oracle is deterministic, so the result is too."""
    key = (sha256_hex(path.read_bytes()), spec_sha)
    if key not in _CHECKED:
        _CHECKED[key] = check(path, store)
    return _CHECKED[key]


def load_for_project(project_id: str, spec_sha: str, store: SchemaStore) -> list[dict[str, Any]]:
    """Validated scenarios recorded against exactly this spec, sorted by name. Raises ValueError on
    any invalid or stale scenario so generation never embeds a scenario that does not apply."""
    loaded = []
    for path in scenario_files(project_id):
        data, issues = validate(path, store)
        if issues or data is None:
            raise ValueError(f"{path.name}: " + "; ".join(map(str, issues)))
        if not data["checkpoints"]:
            raise ValueError(f"{path.name}: no checkpoints; run `monstera scenarios record`")
        if data["spec"]["sha256"] != spec_sha:
            raise StaleScenarios(f"{path.name}: recorded against a different spec; run `monstera scenarios record`")
        # Goldens come only from `monstera scenarios record`: a hand-edited checkpoint must never be embedded.
        found = _checked(path, spec_sha, store)
        if found:
            raise ValueError(f"{path.name}: " + "; ".join(map(str, found)))
        loaded.append(data)
    return loaded
