"""Host reference for Studio M2 batch 1: results produced by host CPython and the real `monstera` CLI.

Usage: python m2-reference.py <out.json>. The browser run (m2-batch1.mjs) compares Pyodide against this file.
Holds no logic of its own: it calls the engine and the CLI and records what they return.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GAMES = ["pumpkin-blaster", "trick-or-treat-rush"]
sys.path.insert(0, str(REPO / "tools" / "monstera"))
ENV = dict(os.environ, PYTHONPATH=str(REPO / "tools" / "monstera"), PYTHONUTF8="1")


def cli(*args: str) -> subprocess.CompletedProcess:
    code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))"
    return subprocess.run([sys.executable, "-c", code, *args], cwd=REPO, env=ENV, capture_output=True, text=True,
                          encoding="utf-8")


def golden() -> list:
    from monstera import scenario
    from monstera.cli import DEFAULT_SCHEMAS
    from monstera.jsonio import load_path
    from monstera.schema import SchemaStore
    store = SchemaStore.load(DEFAULT_SCHEMAS)
    rows = []
    for path in sorted(scenario.SCENARIOS.rglob(f"*{scenario.SUFFIX}")):
        data = load_path(path)
        game = load_path(REPO / data["spec"]["path"])["game"]
        t0 = time.perf_counter()
        fresh = scenario.checkpoints_for_game(game, data, [c["tick"] for c in data["checkpoints"]])
        rows.append({"file": path.relative_to(REPO).as_posix(), "frameDriven": data["frames"]["count"] > 0,
                     "ticks": data["ticks"], "fresh": fresh, "committed": data["checkpoints"],
                     "ms": (time.perf_counter() - t0) * 1000,
                     "checkIssues": [str(i) for i in scenario.check(path, store)]})
    return rows


def generate(game: str) -> dict:
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
    jar = "android/gradle/wrapper/gradle-wrapper.jar"
    committed_jar = subprocess.run(["git", "show", f"HEAD:apps/{game}/{jar}"], cwd=REPO, capture_output=True,
                                   check=True).stdout
    return {"files": files, "manifestModes": {f["path"]: f["mode"] for f in manifest["files"]},
            "committedManifestSha256": hashlib.sha256(committed).hexdigest(),
            "committedJarSha256": hashlib.sha256(committed_jar).hexdigest(), "jarPath": jar}


def main() -> None:
    out = {"hostPython": sys.version, "golden": golden(), "generate": {g: generate(g) for g in GAMES}}
    Path(sys.argv[1]).write_text(json.dumps(out), encoding="utf-8")
    g = out["golden"]
    print(f"reference: {len(g)} scenarios ({sum(r['frameDriven'] for r in g)} frame-driven), "
          f"{sum(len(v['files']) for v in out['generate'].values())} generated files")


main()
