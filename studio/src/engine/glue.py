"""Studio glue: calls the unmodified engine inside Pyodide and returns JSON strings.

It holds no validation, generation, serialization or simulation logic. The engine lives at
/repo/tools/monstera exactly as in the repository and reads /repo/spec/schema through the same paths.
Canonical text and SHA-256 come from monstera.jsonio / monstera.validate, the CLI's own code.
"""
import json
import os
import sys
from pathlib import Path

# The worker mounts the repository at /repo. MONSTERA_STUDIO_REPO exists only so host-side tests can import this file.
REPO = Path(os.environ.get("MONSTERA_STUDIO_REPO", "/repo"))
sys.path.insert(0, str(REPO / "tools" / "monstera"))

from monstera import targets  # noqa: E402
from monstera.jsonio import LoadError, canonical_text, loads_strict, sha256_hex  # noqa: E402
from monstera.oracle import sim  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_value  # noqa: E402

STORE = SchemaStore.load(REPO / "spec" / "schema")


def info() -> str:
    return json.dumps({"python": sys.version, "repoRoot": str(targets.REPO_ROOT),
                       "schemaDigests": STORE.digests()}, sort_keys=True)


def schemas() -> str:
    """The schema files exactly as the engine reads them (the UI derives constraints and labels from these)."""
    out = {}
    for f in sorted((REPO / "spec" / "schema").glob("*.schema.json")):
        out[f.name] = f.read_text(encoding="utf-8")
    return json.dumps(out)


def _issues(result) -> list:
    return [{"path": i.path, "code": i.code, "message": i.message} for i in result.issues]


def validate_draft(text: str) -> str:
    """CLI-equivalent validation of a draft held as JSON text (strict load, schema, semantic rules).

    `canonicalText` and `sha256` are present whenever the text parses, even if the spec is invalid, so the
    Spec view can show what the engine would write. The hash identifies a spec only when `ok` is true.
    """
    try:
        value = loads_strict(text)
    except LoadError as exc:
        where = f" (line {exc.line}, column {exc.column})" if exc.line else ""
        return json.dumps({"ok": False, "parsed": False,
                           "issues": [{"path": "$", "code": exc.code, "message": exc.message + where}],
                           "sha256": None, "canonicalText": None})
    result = validate_value(value, STORE)
    canon = canonical_text(value)
    return json.dumps({"ok": result.ok, "parsed": True, "issues": _issues(result),
                       "sha256": sha256_hex(canon.encode("utf-8")), "canonicalText": canon})


def template(path: str) -> str:
    """A bundled template: its file text, the engine's canonical text, and whether they are byte-identical."""
    raw = (REPO / path).read_bytes()
    text = raw.decode("utf-8")
    draft = json.loads(validate_draft(text))
    draft["path"] = path
    draft["fileText"] = text
    draft["canonicalEqualsFile"] = draft["canonicalText"] is not None and draft["canonicalText"].encode("utf-8") == raw
    return json.dumps(draft)


def golden_report() -> str:
    """Every committed golden scenario, run by the engine's own code. `fresh` is what the oracle produces now
    (pure in-memory path, the one a draft would use), `checkIssues` is the CLI's `scenario.check`. Nothing here
    decides a verdict: the caller compares `fresh` with `committed`."""
    import time

    from monstera import scenario
    from monstera.jsonio import load_path

    rows = []
    for path in sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}")):
        data = load_path(path)
        committed = data["checkpoints"]
        game = load_path(REPO / data["spec"]["path"])["game"]
        t0 = time.perf_counter()
        fresh = scenario.checkpoints_for_game(game, data, [c["tick"] for c in committed])
        ms = (time.perf_counter() - t0) * 1000
        rows.append({"file": path.relative_to(REPO).as_posix(), "specPath": data["spec"]["path"],
                     "frameDriven": data["frames"]["count"] > 0, "ticks": data["ticks"],
                     "committed": committed, "fresh": fresh, "ms": ms,
                     "checkIssues": [str(i) for i in scenario.check(path, STORE)]})
    return json.dumps(rows)


def plan_template(path: str) -> str:
    """`generate.plan` for a bundled template spec, exactly as `monstera generate` calls it (same layout,
    same label, scenarios recorded for this spec). Files are returned as hashes, sizes and modes."""
    import time

    from monstera import generate, scenario
    from monstera.jsonio import sha256_hex
    from monstera.validate import validate_path

    spec_path = REPO / path
    result = validate_path(spec_path, STORE)
    if not result.ok:
        return json.dumps({"ok": False, "issues": _issues(result)})
    project_id = result.spec["project"]["id"]
    _, layout = targets.default_out(spec_path, project_id)
    t0 = time.perf_counter()
    scenarios = scenario.load_for_project(project_id, result.sha256, STORE)
    files = generate.plan(result.spec, spec_path.relative_to(REPO).as_posix(), STORE, layout=layout, scenarios=scenarios)
    ms = (time.perf_counter() - t0) * 1000
    rows = sorted(({"path": f.path, "sha256": sha256_hex(f.data), "size": len(f.data), "mode": f.mode} for f in files),
                  key=lambda r: r["path"])
    return json.dumps({"ok": True, "project": project_id, "layout": layout, "specSha256": result.sha256,
                       "scenarioCount": len(scenarios), "files": rows, "ms": ms})


# ---------------------------------------------------------------- determinism badge (oracle vs recorded goldens)

def badge_scenarios(spec_path: str) -> str:
    """The committed golden scenarios recorded against the spec at `spec_path` (their own `spec.path`), sorted."""
    from monstera import scenario
    from monstera.jsonio import load_path

    rows = []
    for path in sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}")):
        data = load_path(path)
        if data["spec"]["path"] != spec_path:
            continue
        rows.append({"file": path.relative_to(REPO).as_posix(), "name": data["name"], "ticks": data["ticks"],
                     "frameDriven": data["frames"]["count"] > 0, "checkpoints": len(data["checkpoints"]),
                     "recordedSpecPath": data["spec"]["path"], "recordedSpecSha256": data["spec"]["sha256"]})
    return json.dumps(rows)


def badge_check(draft_text: str, scenario_file: str) -> str:
    """Runs one recorded golden scenario against the draft and compares every checkpoint with Python equality.

    The verdict of a scenario is `match` only when the oracle's checkpoints equal the committed ones (`==`, the
    comparison `scenario.check` uses). An unparsable or invalid draft is `invalid`; any failure is `error`. Neither
    carries a comparison. `draftSha256` is the engine's hash of exactly the text that was run.
    """
    import time

    from monstera import scenario
    from monstera.jsonio import load_path

    try:
        try:
            value = loads_strict(draft_text)
        except LoadError as exc:
            return json.dumps({"status": "invalid", "file": scenario_file, "draftSha256": None, "message": exc.message})
        result = validate_value(value, STORE)
        if not result.ok:
            return json.dumps({"status": "invalid", "file": scenario_file, "draftSha256": None,
                               "message": f"{len(result.issues)} validation issue(s)"})
        path = (REPO / scenario_file).resolve()
        path.relative_to(scenario.SCENARIOS)  # only committed golden files
        data = load_path(path)
        committed = data["checkpoints"]
        if not committed:
            raise ValueError(f"{scenario_file} has no recorded checkpoints")
        t0 = time.perf_counter()
        fresh = scenario.checkpoints_for_game(result.spec["game"], data, [c["tick"] for c in committed])
        ms = (time.perf_counter() - t0) * 1000
        diverged = [i for i, (want, got) in enumerate(zip(committed, fresh)) if want != got]
        if len(fresh) != len(committed):
            diverged.append(min(len(fresh), len(committed)))
        out = {"status": "match" if not diverged else "diverged", "file": scenario_file, "draftSha256": result.sha256,
               "checkpoints": len(committed), "divergentCheckpoints": len(diverged), "ms": ms}
        if diverged:
            i = diverged[0]
            out.update(firstDivergentIndex=i, firstDivergentTick=committed[i]["tick"] if i < len(committed) else None,
                       expected=committed[i] if i < len(committed) else None, actual=fresh[i] if i < len(fresh) else None)
        return json.dumps(out)
    except Exception as exc:  # reported as an error, never as a result
        return json.dumps({"status": "error", "file": scenario_file, "draftSha256": None,
                           "message": f"{type(exc).__name__}: {exc}"})


# ---------------------------------------------------------------- live preview (oracle GameLoop, one session)
# The preview steps the engine's own GameLoop (RUNTIME-CONTRACT section 1) with the frame times and input events the
# page sends: the same loop the native shells use. Glue keeps the session and a trace of every frame it was given,
# so a session can be replayed exactly on host CPython. Nothing here simulates, maps input or renders.
PREVIEW_TRACE_LIMIT = 36000  # frames (10 minutes at 60 Hz); beyond that the trace is marked truncated
_preview = None


def _snapshot(lp, ticks: int, ms: float) -> dict:
    w = lp.world
    flat = []
    for e in w.entities:
        flat += [e.id, e.kind, e.x, e.y, e.vx, e.vy, 1 if e.controlled else 0]
    return {"tick": w.tick, "score": w.score, "lives": w.lives, "ended": w.ended, "alpha": lp.clock.alpha,
            "ticks": ticks, "entities": flat, "ms": ms}


def preview_start(draft_text: str, seed: int) -> str:
    """Starts a session for a valid draft. Returns the session id, the draft's SHA-256 and the initial snapshot."""
    global _preview
    from monstera.oracle import loop

    try:
        value = loads_strict(draft_text)
    except LoadError as exc:
        return json.dumps({"ok": False, "message": exc.message})
    result = validate_value(value, STORE)
    if not result.ok:
        return json.dumps({"ok": False, "message": f"{len(result.issues)} validation issue(s)"})
    game = result.spec["game"]
    lp = loop.GameLoop(sim.new_world(sim.Config(game), int(seed)), game["simulation"]["tickRate"],
                       game["simulation"]["maxTicksPerFrame"])
    session = (_preview["session"] + 1) if _preview else 1
    _preview = {"session": session, "loop": lp, "game": game, "seed": int(seed), "sha256": result.sha256, "frames": [],
                "truncated": False}
    return json.dumps({"ok": True, "session": session, "sha256": result.sha256, "seed": int(seed),
                       "snapshot": _snapshot(lp, 0, 0.0)})


def preview_frame(session: int, elapsed_nanos: int, events_json: str) -> str:
    """One display frame: submit the events (applied at the next tick, in order), then GameLoop.frame(elapsed)."""
    import time

    global _preview
    from monstera.oracle import loop

    p = _preview
    if p is None or p["session"] != int(session):
        return json.dumps({"ok": False, "message": "no such preview session"})
    t0 = time.perf_counter()
    try:
        events = json.loads(events_json)
        for event in events:
            p["loop"].submit(event)
        ticks = p["loop"].frame(int(elapsed_nanos))
    except Exception as exc:
        # The frame may have changed the world before it failed. Rebuild the world from the recorded trace (this rare
        # path only), so the live session always equals what its trace replays to; a truncated trace ends the session.
        if p["truncated"]:
            _preview = None
            return json.dumps({"ok": False, "message": f"preview session ended: {type(exc).__name__}: {exc}"})
        game = p["game"]
        rebuilt = loop.GameLoop(sim.new_world(sim.Config(game), p["seed"]), game["simulation"]["tickRate"],
                                game["simulation"]["maxTicksPerFrame"])
        for nanos, recorded in p["frames"]:
            for event in recorded:
                rebuilt.submit(event)
            rebuilt.frame(nanos)
        p["loop"] = rebuilt
        return json.dumps({"ok": False, "message": f"frame refused: {type(exc).__name__}: {exc}"})
    ms = (time.perf_counter() - t0) * 1000
    if len(p["frames"]) < PREVIEW_TRACE_LIMIT:
        p["frames"].append([int(elapsed_nanos), events])
    else:
        p["truncated"] = True
    return json.dumps({"ok": True, "session": p["session"], "snapshot": _snapshot(p["loop"], ticks, ms)})


def preview_trace() -> str:
    """The current session's seed, SHA-256, every frame it was given and its state hash now (for replay checks)."""
    p = _preview
    if p is None:
        return json.dumps(None)
    w = p["loop"].world
    return json.dumps({"session": p["session"], "seed": p["seed"], "sha256": p["sha256"], "frames": p["frames"],
                       "truncated": p["truncated"], "tick": w.tick, "hash": format(sim.state_hash(w), "016x")})


# ---------------------------------------------------------------- native source export (generate.plan, as the CLI)

def export_plan(draft_text: str, origin_path: str) -> str:
    """The files `monstera generate` would write for this draft, from `generate.plan` (the CLI's own call).

    The spec label and layout are those the CLI uses for the spec at its repository location: the origin template's
    path when the draft keeps that template's project id, else `apps/<project.id>/monstera.spec.json`. Scenarios
    come from `scenario.load_for_project` exactly as in the CLI; when that refuses because the recorded goldens are
    stale for an edited draft (the CLI would refuse to generate), the plan is made with no scenarios and the number
    of omitted goldens is reported. File data is base64.
    """
    import base64

    from monstera import generate, scenario

    try:
        value = loads_strict(draft_text)
    except LoadError as exc:
        return json.dumps({"ok": False, "message": exc.message})
    result = validate_value(value, STORE)
    if not result.ok:
        return json.dumps({"ok": False, "message": f"{len(result.issues)} validation issue(s)"})
    from monstera.validate import validate_path

    spec = result.spec
    project_id = spec["project"]["id"]
    repo_specs = {p.relative_to(REPO).as_posix(): p for p in targets.spec_files()}
    if origin_path and origin_path not in repo_specs:
        return json.dumps({"ok": False, "message": f"unknown origin template {origin_path!r}"})
    # A draft that IS a repository spec (same canonical SHA-256) exports exactly as `monstera generate <that spec>`,
    # whatever origin was declared. Otherwise: the origin template's path when the draft keeps its project id, else
    # the app folder the CLI would use for a new game.
    exact = next((rel for rel, p in repo_specs.items() if validate_path(p, STORE).sha256 == result.sha256), None)
    if exact is not None:
        label = exact
    elif origin_path and loads_strict(repo_specs[origin_path].read_text(encoding="utf-8"))["project"]["id"] == project_id:
        label = origin_path
    else:
        label = f"apps/{project_id}/monstera.spec.json"
    _, layout = targets.default_out(REPO / label, project_id)
    recorded = scenario.scenario_files(project_id)
    omitted = None
    try:
        scenarios = scenario.load_for_project(project_id, result.sha256, STORE)
    except scenario.StaleScenarios as exc:
        # The only case Studio departs from the CLI (approved): the goldens apply to another spec, so none are embedded
        # and the page says so. The CLI refuses this spec until `monstera scenarios record`.
        scenarios = []
        omitted = {"count": len(recorded), "reason": str(exc)}
    except ValueError as exc:
        # An invalid, unrecorded or corrupted golden: refuse, exactly like `monstera generate` (no files, no ZIP).
        return json.dumps({"ok": False, "message": str(exc)})
    files = generate.plan(spec, label, STORE, layout=layout, scenarios=scenarios)
    manifest = next(f for f in files if f.path == generate.MANIFEST)
    rows = [{"path": f.path, "mode": f.mode, "size": len(f.data), "sha256": sha256_hex(f.data), "kind": f.kind,
             "data": base64.b64encode(f.data).decode("ascii")} for f in files]
    return json.dumps({"ok": True, "projectId": project_id, "specSha256": result.sha256, "label": label, "layout": layout,
                       "manifestSha256": sha256_hex(manifest.data), "scenariosIncluded": len(scenarios),
                       "scenariosOmitted": omitted, "files": rows})
