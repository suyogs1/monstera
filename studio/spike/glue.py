"""Spike-only glue: calls the unmodified engine inside Pyodide and returns JSON strings.

It holds no validation, generation or simulation logic. The engine lives at /repo/tools/monstera
exactly as in the repository, and reads /repo/spec and /repo/apps through the same paths.
"""
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, "/repo/tools/monstera")

from monstera import generate, scenario, targets  # noqa: E402
from monstera.jsonio import load_path, loads_strict, sha256_hex  # noqa: E402
from monstera.oracle import sim  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_path, validate_value  # noqa: E402

REPO = Path("/repo")
STORE = SchemaStore.load(REPO / "spec" / "schema")


def info() -> str:
    return json.dumps({"python": sys.version, "repoRoot": str(targets.REPO_ROOT),
                       "schemaDigests": STORE.digests()}, sort_keys=True)


def _issues(result) -> list:
    return [{"path": i.path, "code": i.code, "message": i.message} for i in result.issues]


def validate_cases(cases_json: str) -> str:
    """Each case is validated through validate_path (the CLI path) and, when it parses,
    through loads_strict + validate_value (the path an editor holding a draft would use)."""
    out = []
    tmp = Path("/tmp/cases")
    tmp.mkdir(parents=True, exist_ok=True)
    for case in json.loads(cases_json):
        f = tmp / case["file"]
        f.write_bytes(case["text"].encode("utf-8"))
        r = validate_path(f, STORE)
        row = {"name": case["name"], "valid": r.ok, "sha256": r.sha256 if r.ok else None, "issues": _issues(r)}
        if r.spec is not None:
            r2 = validate_value(loads_strict(case["text"]), STORE)
            row["valueParity"] = (r2.ok == r.ok and _issues(r2) == _issues(r))
        out.append(row)
    return json.dumps(out)


def plan_project(project_id: str) -> str:
    spec_path = REPO / "apps" / project_id / "monstera.spec.json"
    result = validate_path(spec_path, STORE)
    assert result.ok, result.issues
    _, layout = targets.default_out(spec_path, project_id)
    label = spec_path.relative_to(REPO).as_posix()
    t0 = time.perf_counter()
    scenarios = scenario.load_for_project(project_id, result.sha256, STORE)
    t1 = time.perf_counter()
    files = generate.plan(result.spec, label, STORE, layout=layout, scenarios=scenarios)
    t2 = time.perf_counter()
    rows = [{"path": f.path, "sha256": sha256_hex(f.data), "size": len(f.data), "mode": f.mode} for f in files]
    rows.sort(key=lambda r: r["path"])
    binary = [r["path"] for r in rows if r["path"].endswith(".jar")]
    return json.dumps({"project": project_id, "layout": layout, "specSha256": result.sha256, "files": rows,
                       "binary": binary, "scenarioCount": len(scenarios),
                       "msLoadScenarios": (t1 - t0) * 1000, "msPlan": (t2 - t1) * 1000}, sort_keys=True)


def golden(project_id: str) -> str:
    rows = []
    for path in scenario.scenario_files(project_id):
        data = load_path(path)
        committed = data["checkpoints"]
        t0 = time.perf_counter()
        fresh = scenario.oracle_checkpoints(data, STORE, [c["tick"] for c in committed])
        ms = (time.perf_counter() - t0) * 1000
        first = next((c["tick"] for c, g in zip(committed, fresh) if c != g), None)
        check = scenario.check(path, STORE)
        rows.append({"name": path.name, "ticks": data["ticks"], "frames": data["frames"]["count"],
                     "checkpoints": len(committed), "match": len(fresh) == len(committed) and first is None,
                     "firstMismatchTick": first, "checkIssues": [str(i) for i in check], "ms": ms,
                     "lastHash": committed[-1]["hash"]})
    return json.dumps(rows)


def _set(doc, pointer, value):
    for key in pointer[:-1]:
        doc = doc[key]
    doc[pointer[-1]] = value


def edited(project_id: str, scenario_name: str, pointer_json: str, value_json: str) -> str:
    """Spike-only: run a scenario against an EDITED in-memory spec and report where it first
    diverges from the committed checkpoints. Uses sim.Config/run_scenario directly (the file based
    scenario API insists on the recorded spec hash). Frame-based scenarios are not covered here."""
    spec = load_path(REPO / "apps" / project_id / "monstera.spec.json")
    data = load_path(scenario.SCENARIOS / project_id / scenario_name)
    assert data["frames"]["count"] == 0
    _set(spec, json.loads(pointer_json), json.loads(value_json))
    r = validate_value(spec, STORE)
    t0 = time.perf_counter()
    rows = sim.run_scenario(sim.Config(r.spec["game"]), data)
    ms = (time.perf_counter() - t0) * 1000
    fresh = [{"tick": x["tick"], "hash": format(x["hash"], "016x"), "observe": x["observe"]} for x in rows]
    diverged = [c["tick"] for c, g in zip(data["checkpoints"], fresh) if c != g]
    return json.dumps({"valid": r.ok, "editedSha256": r.sha256 if r.ok else None,
                       "firstDivergentTick": diverged[0] if diverged else None,
                       "divergentCheckpoints": len(diverged), "checkpoints": len(fresh), "ms": ms,
                       "hashes": [g["hash"] for g in fresh]})


def live(project_id: str, scenario_name: str) -> str:
    """Per-tick stepping of a scenario's recorded input, timing each step as the preview loop would."""
    spec = load_path(REPO / "apps" / project_id / "monstera.spec.json")
    data = load_path(scenario.SCENARIOS / project_id / scenario_name)
    w = sim.new_world(sim.Config(spec["game"]), data["seed"])
    by_tick = {}
    for item in data["inputs"]:
        by_tick.setdefault(item["tick"], []).extend(item["events"])
    times = []
    peak = 0
    for i in range(data["ticks"]):
        t0 = time.perf_counter()
        sim.step(w, by_tick.get(i, []))
        sim.observe(w)
        times.append((time.perf_counter() - t0) * 1000)
        peak = max(peak, len(w.entities))
    times.sort()
    return json.dumps({"project": project_id, "scenario": scenario_name, "ticks": data["ticks"],
                       "meanMs": statistics.fmean(times), "p95Ms": times[int(len(times) * 0.95) - 1],
                       "maxMs": times[-1], "peakEntities": peak, "ended": w.ended, "finalTick": w.tick,
                       "hash": format(sim.state_hash(w), "016x")})
