"""Golden scenarios: load, validate, record (oracle only) and look up by project.
Contract: architecture/RUNTIME-CONTRACT.md section 7. Expected checkpoints are produced only by
`record`, an explicit command; nothing in validation or generation rewrites them.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import targets
from .jsonio import LoadError, canonical_text, load_path
from .oracle import sim
from .schema import Issue, SchemaStore
from .validate import validate_path

SCENARIO_SCHEMA = "scenario.schema.json"
SUFFIX = ".scenario.json"
SCENARIOS = targets.REPO_ROOT / "spec" / "scenarios"
OBSERVABLES = ("tick", "score", "lives", "entityCount", "ended", "nextId")


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
            out.append(Issue(f"$.checkpoints[{i}].tick", "scenario.order", "checkpoint ticks must be strictly ascending"))
        if cp["tick"] > data["ticks"]:
            out.append(Issue(f"$.checkpoints[{i}].tick", "scenario.range", f"tick {cp['tick']} exceeds ticks {data['ticks']}"))
        last = cp["tick"]
    _, spec_issues = _spec_for(data, store)
    out += spec_issues
    return data, sorted(set(out))


def oracle_checkpoints(data: dict[str, Any], store: SchemaStore, ticks: list[int]) -> list[dict[str, Any]]:
    result, issues = _spec_for(data, store)
    if result is None or issues:
        raise ValueError("; ".join(map(str, issues)) or "spec unavailable")
    probe = dict(data, checkpoints=[{"tick": t} for t in ticks])
    cfg = sim.Config(result.spec["game"])
    return [{"tick": r["tick"], "hash": format(r["hash"], "016x"), "observe": r["observe"]}
            for r in sim.run_scenario(cfg, probe)]


def record(path: Path, store: SchemaStore) -> list[Issue]:
    """Rewrite `path` with the spec hash current and oracle-produced checkpoints."""
    try:
        data = load_path(path)
    except LoadError as exc:
        return [Issue(path.name, exc.code, exc.message)]
    issues = store.validate(data, SCENARIO_SCHEMA)
    if issues:
        return issues
    spec_path = (targets.REPO_ROOT / data["spec"]["path"]).resolve()
    result = validate_path(spec_path, store)
    if not result.ok:
        return [Issue("$.spec.path", "scenario.spec-invalid", f"{data['spec']['path']} is not a valid specification")]
    data["spec"]["sha256"] = result.sha256
    data["checkpoints"] = oracle_checkpoints(data, store, checkpoint_ticks(data["ticks"]))
    path.write_bytes(canonical_text(data).encode("utf-8"))
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
            raise ValueError(f"{path.name}: recorded against a different spec; run `monstera scenarios record`")
        loaded.append(data)
    return loaded
