"""Runs the real `monstera validate` CLI on every level variant inside a Studio level-variants ZIP.
Independent of Studio: Python's zipfile reads the archive and the unmodified CLI judges each file.
Usage: python validate-exported-levels.py <zip> <expected-ids.json> <out.json> [<extract-dir>]
  expected-ids.json is a JSON array of level ids. The archive must hold exactly
  studio-pack/derived/levels/<id>/monstera.spec.json for those ids and nothing else.
Exit code 0 only when the paths match exactly and the CLI accepts every file.
"""
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENV = dict(os.environ, PYTHONPATH=str(REPO / "tools" / "monstera"), PYTHONUTF8="1")


def cli(*args: str) -> subprocess.CompletedProcess:
    code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))"
    return subprocess.run([sys.executable, "-c", code, *args], cwd=REPO, env=ENV, capture_output=True, text=True, encoding="utf-8")


def main(argv: list) -> int:
    zip_path, ids_path, out_path, *rest = argv
    extract_to = Path(rest[0]) if rest else None  # optional: also write the files out, so another caller can run the CLI wrapper on them
    expected = sorted(json.loads(Path(ids_path).read_text(encoding="utf-8")))
    want = [f"studio-pack/derived/levels/{i}/monstera.spec.json" for i in expected]
    problems: list = []
    results: list = []
    with zipfile.ZipFile(zip_path) as zf:
        bad = zf.testzip()
        if bad is not None:
            problems.append(f"CRC mismatch in {bad}")
        names = sorted(zf.namelist())
        if names != sorted(want):
            problems.append(f"entries differ: expected {sorted(want)}, found {names}")
        with tempfile.TemporaryDirectory() as tmp:
            for name in names:
                if name not in want:
                    continue
                target = Path(tmp) / name.replace("/", "_")
                target.write_bytes(zf.read(name))
                if extract_to is not None:
                    out_file = extract_to / name
                    out_file.parent.mkdir(parents=True, exist_ok=True)
                    out_file.write_bytes(target.read_bytes())
                r = cli("validate", str(target))
                results.append({"path": name, "exitCode": r.returncode, "output": (r.stdout + r.stderr).strip()})
                if r.returncode != 0:
                    problems.append(f"monstera validate rejected {name}: {(r.stdout + r.stderr).strip()[:300]}")
    Path(out_path).write_text(json.dumps({"ok": not problems, "problems": problems, "files": results}, indent=2) + "\n", encoding="utf-8")
    for r in results:
        print(f"{'PASS' if r['exitCode'] == 0 else 'FAIL'}  monstera validate {r['path']}")
    for p in problems:
        print(f"PROBLEM  {p}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
