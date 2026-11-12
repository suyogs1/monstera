"""Reference results for the M0 spike, produced by the real CLI and host CPython.

Writes dist/reference.json: the validation corpus with `monstera validate --json` results, the
file list of `monstera generate` for both games, and edited-spec runs on host CPython.
Run after build-bundle.mjs (which recreates dist/).
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
GAMES = ["pumpkin-blaster", "trick-or-treat-rush"]
LIVE = {"pumpkin-blaster": "sweep-and-fire.scenario.json", "trick-or-treat-rush": "candy-chase.scenario.json"}
EDITS = [
    # (project, scenario, pointer, value): the first edit of each game changes behaviour, the second is a no-op.
    ("pumpkin-blaster", "sweep-and-fire.scenario.json", ["game", "runtime", "spawners", 0, "intervalTicks"], 50),
    ("pumpkin-blaster", "sweep-and-fire.scenario.json", ["game", "runtime", "spawners", 0, "intervalTicks"], 60),
    ("trick-or-treat-rush", "candy-chase.scenario.json", ["game", "runtime", "spawners", 0, "intervalTicks"], "half"),
    ("trick-or-treat-rush", "candy-chase.scenario.json", ["game", "runtime", "spawners", 0, "intervalTicks"], "same"),
]

sys.path.insert(0, str(REPO / "tools" / "monstera"))
ENV = dict(os.environ, PYTHONPATH=str(REPO / "tools" / "monstera"), PYTHONUTF8="1")


def cli(*args: str) -> subprocess.CompletedProcess:
    code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))"
    return subprocess.run([sys.executable, "-c", code, *args], cwd=REPO, env=ENV, capture_output=True, text=True,
                          encoding="utf-8")


def pointer_get(doc, tokens):
    for t in tokens:
        doc = doc[t]
    return doc


def apply(doc, pointer: str, value=None, remove=False):
    tokens = [t.replace("~1", "/").replace("~0", "~") for t in pointer.split("/")[1:]]
    parent = doc
    for t in tokens[:-1]:
        parent = parent[int(t)] if isinstance(parent, list) else parent[t]
    last = tokens[-1]
    key = int(last) if isinstance(parent, list) else last
    if remove:
        del parent[key]
    else:
        parent[key] = value


def build_cases() -> list:
    fixtures = json.loads((REPO / "spec/fixtures/invalid-cases.json").read_text(encoding="utf-8"))
    base_text = (REPO / fixtures["base"]).read_text(encoding="utf-8")
    cases = []
    for i, c in enumerate(fixtures["cases"]):
        doc = json.loads(base_text)
        for ptr, val in c.get("set", {}).items():
            apply(doc, ptr, val)
        for ptr in c.get("remove", []):
            apply(doc, ptr, remove=True)
        cases.append({"name": c["name"], "file": f"invalid-{i:02d}.json", "text": json.dumps(doc, indent=2)})
    for p in sorted((REPO / "spec/fixtures/raw").glob("*.json")):
        cases.append({"name": f"raw/{p.name}", "file": f"raw-{p.name}", "text": p.read_text(encoding="utf-8")})
    valid = [REPO / "apps" / g / "monstera.spec.json" for g in GAMES] + sorted((REPO / "spec/samples").glob("*/monstera.spec.json"))
    for p in valid:
        cases.append({"name": f"valid/{p.parent.name}", "file": f"valid-{p.parent.name}.json",
                      "text": p.read_text(encoding="utf-8")})
    return cases


def cli_validate(cases: list) -> list:
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for c in cases:
            (Path(tmp) / c["file"]).write_bytes(c["text"].encode("utf-8"))
            paths.append(str(Path(tmp) / c["file"]))
        out = {}
        for c, path in zip(cases, paths):  # one call per file keeps the exit code per file
            proc = cli("validate", "--json", path)
            row = json.loads(proc.stdout.strip().splitlines()[-1])
            out[c["name"]] = {"name": c["name"], "valid": row["valid"], "sha256": row["sha256"], "issues": row["issues"]}
        return [out[c["name"]] for c in cases]


def cli_generate(game: str) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        proc = cli("generate", f"apps/{game}/monstera.spec.json", "--out", str(Path(tmp) / game))
        assert proc.returncode == 0, proc.stdout + proc.stderr
        root = Path(tmp) / game
        files = {}
        for p in sorted(root.rglob("*")):
            if p.is_file():
                data = p.read_bytes()
                files[p.relative_to(root).as_posix()] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        manifest = json.loads((root / "MONSTERA-MANIFEST.json").read_text(encoding="utf-8"))
    committed = subprocess.run(["git", "show", f"HEAD:apps/{game}/MONSTERA-MANIFEST.json"], cwd=REPO,
                               capture_output=True, check=True).stdout
    return {"files": files, "manifestModes": {f["path"]: f["mode"] for f in manifest["files"]},
            "committedManifestSha256": hashlib.sha256(committed).hexdigest()}


def host_runs() -> tuple:
    from monstera.jsonio import load_path
    from monstera.oracle import sim
    from monstera.schema import SchemaStore
    from monstera.validate import validate_value
    store = SchemaStore.load(REPO / "spec/schema")

    def run(game, scen, spec):
        data = load_path(REPO / "spec/scenarios" / game / scen)
        r = validate_value(spec, store)
        rows = sim.run_scenario(sim.Config(r.spec["game"]), data)
        fresh = [{"tick": x["tick"], "hash": format(x["hash"], "016x"), "observe": x["observe"]} for x in rows]
        diverged = [c["tick"] for c, g in zip(data["checkpoints"], fresh) if c != g]
        return r, fresh, diverged

    edits = []
    for game, scen, pointer, value in EDITS:
        spec = load_path(REPO / "apps" / game / "monstera.spec.json")
        original = pointer_get(spec, pointer)
        value = original if value == "same" else (original // 2 if value == "half" else value)
        apply(spec, "/" + "/".join(str(t) for t in pointer), value)
        r, fresh, diverged = run(game, scen, spec)
        edits.append({"project": game, "scenario": scen, "pointer": pointer, "value": value, "original": original,
                      "valid": r.ok, "editedSha256": r.sha256 if r.ok else None,
                      "firstDivergentTick": diverged[0] if diverged else None,
                      "divergentCheckpoints": len(diverged), "hashes": [g["hash"] for g in fresh]})
    live = {}
    for game, scen in LIVE.items():
        spec = load_path(REPO / "apps" / game / "monstera.spec.json")
        data = load_path(REPO / "spec/scenarios" / game / scen)
        w = sim.new_world(sim.Config(spec["game"]), data["seed"])
        by_tick = {}
        for item in data["inputs"]:
            by_tick.setdefault(item["tick"], []).extend(item["events"])
        for i in range(data["ticks"]):
            sim.step(w, by_tick.get(i, []))
        live[game] = {"hash": format(sim.state_hash(w), "016x"), "finalTick": w.tick, "ended": w.ended}
    return edits, live


def main() -> None:
    dist = HERE / "dist"
    assert dist.is_dir(), "run build-bundle.mjs first"
    cases = build_cases()
    edits, live = host_runs()
    ref = {"hostPython": sys.version, "cases": cases, "validate": cli_validate(cases),
           "generate": {g: cli_generate(g) for g in GAMES}, "edits": edits, "live": live, "liveScenario": LIVE}
    (dist / "reference.json").write_text(json.dumps(ref), encoding="utf-8")
    invalid = sum(1 for r in ref["validate"] if not r["valid"])
    print(f"reference: {len(cases)} validation cases ({invalid} invalid), "
          f"{sum(len(g['files']) for g in ref['generate'].values())} generated files, {len(edits)} edits")


main()
