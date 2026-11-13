"""Verifies Studio source-export ZIPs against the real CLI (or, for edited drafts the CLI refuses, the same
`generate.plan` call with no scenarios). Independent of Studio: Python's zipfile reads the archive.

Usage: python m2-export-verify.py <cases.json> <out.json>. Each case: {name, zip, projectId, specSha256, kind, ...}
  kind "cli":    {spec}: compare with `monstera generate <spec> --out <tmp>` and, for apps/, the committed manifest
  kind "edited": {text, label, layout}: also run the CLI on the edited spec (expected to refuse because of stale
                 goldens) and compare with generate.plan(spec, label, layout, scenarios=[])
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "monstera"))
ENV = dict(os.environ, PYTHONPATH=str(REPO / "tools" / "monstera"), PYTHONUTF8="1")

from monstera import emit_runtime, generate  # noqa: E402
from monstera.cli import DEFAULT_SCHEMAS  # noqa: E402
from monstera.jsonio import canonical_bytes, loads_strict, sha256_hex  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_value  # noqa: E402

STORE = SchemaStore.load(DEFAULT_SCHEMAS)
JAR = "android/gradle/wrapper/gradle-wrapper.jar"
SCEN = "android/app/src/test/resources/" + generate.SCENARIOS_RESOURCE


def cli(*args: str) -> subprocess.CompletedProcess:
    code = "import sys; from monstera import cli; sys.exit(cli.main(sys.argv[1:]))"
    return subprocess.run([sys.executable, "-c", code, *args], cwd=REPO, env=ENV, capture_output=True, text=True, encoding="utf-8")


def git_blob(path: str) -> bytes:
    return subprocess.run(["git", "show", f"HEAD:{path}"], cwd=REPO, capture_output=True, check=True).stdout


def read_zip(path: str, project_id: str) -> tuple[dict, dict, list]:
    problems = []
    files, modes = {}, {}
    with zipfile.ZipFile(path) as zf:
        bad = zf.testzip()
        if bad is not None:
            problems.append(f"CRC mismatch in {bad}")
        names = zf.namelist()
        if len(names) != len(set(names)):
            problems.append("duplicate entries")
        for info in zf.infolist():
            n = info.filename
            if n.startswith("/") or "\\" in n or any(s in ("", ".", "..") for s in n.split("/")):
                problems.append(f"unsafe path {n!r}")
            if not n.startswith(project_id + "/"):
                problems.append(f"{n} is outside {project_id}/")
            kind = info.external_attr >> 16
            if kind & 0o170000 != 0o100000:
                problems.append(f"{n} is not a regular file")
            rel = n[len(project_id) + 1:]
            files[rel] = zf.read(info)
            modes[rel] = kind & 0o7777
    return files, modes, problems


def compare(name: str, files: dict, modes: dict, ref: dict, spec_sha: str) -> dict:
    missing = sorted(set(ref) - set(files))
    extra = sorted(set(files) - set(ref))
    differ = sorted(p for p in set(ref) & set(files) if ref[p] != files[p])
    manifest = json.loads(files.get(generate.MANIFEST, b"{}"))
    mode_diff = [f["path"] for f in manifest.get("files", []) if oct(modes.get(f["path"], -1))[2:] != f["mode"]]
    if modes.get(generate.MANIFEST) != 0o644:
        mode_diff.append(generate.MANIFEST)
    spec_asset = files.get("android/app/src/main/assets/" + generate.SPEC_FILE)
    return {"name": name, "files": len(files), "missing": missing, "extra": extra, "contentDiffers": differ,
            "modeDiffers": mode_diff, "executables": sorted(p for p, m in modes.items() if m == 0o755),
            "manifestSha256": sha256_hex(files.get(generate.MANIFEST, b"")), "manifestSpec": manifest.get("spec"),
            "manifestSpecShaOk": manifest.get("spec", {}).get("sha256") == spec_sha,
            "specAssetShaOk": spec_asset is not None and sha256_hex(spec_asset) == spec_sha,
            "jarSha256": sha256_hex(files.get(JAR, b"")),
            "jarEqualsCommittedTemplate": files.get(JAR) == git_blob("tools/monstera/monstera/templates/android/static/gradle/wrapper/gradle-wrapper.jar"),
            "scenariosResourceBytes": len(files.get(SCEN, b""))}


def run(case: dict) -> dict:
    files, modes, problems = read_zip(case["zip"], case["projectId"])
    with tempfile.TemporaryDirectory() as tmp:
        if case["kind"] == "cli":
            proc = cli("generate", case["spec"], "--out", str(Path(tmp) / "out"))
            if proc.returncode != 0:
                return {"name": case["name"], "problems": problems + [f"CLI failed: {proc.stderr.strip()}"]}
            root = Path(tmp) / "out"
            ref = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            row = compare(case["name"], files, modes, ref, case["specSha256"])
            row["reference"] = f"monstera generate {case['spec']}"
            if case["spec"].startswith("apps/"):
                row["equalsCommittedManifest"] = files.get(generate.MANIFEST) == git_blob(str(Path(case["spec"]).parent.as_posix()) + "/" + generate.MANIFEST)
            row["scenariosEmbedded"] = case["expectScenarios"]
            row["scenariosResourceEqualsCli"] = files.get(SCEN) == ref.get(SCEN)
        else:
            spec_file = Path(tmp) / "edited.monstera.spec.json"
            spec_file.write_text(case["text"], encoding="utf-8")
            proc = cli("generate", str(spec_file), "--out", str(Path(tmp) / "cli-out"), "--layout", case["layout"])
            result = validate_value(loads_strict(case["text"]), STORE)
            planned = generate.plan(result.spec, case["label"], STORE, layout=case["layout"], scenarios=[])
            row = compare(case["name"], files, modes, {f.path: f.data for f in planned}, case["specSha256"])
            row["reference"] = f"generate.plan(<edited spec>, {case['label']!r}, layout={case['layout']!r}, scenarios=[])"
            row["cliRefuses"] = proc.returncode != 0
            row["cliMessage"] = (proc.stderr or proc.stdout).strip().splitlines()[0][:200] if proc.returncode else ""
            row["scenariosResourceIsEmpty"] = files.get(SCEN) == emit_runtime.scenarios_text([]).encode()
            row["specAssetIsCanonicalDraft"] = files.get("android/app/src/main/assets/" + generate.SPEC_FILE) == canonical_bytes(result.spec)
    row["zipProblems"] = problems
    row["zipSha256"] = hashlib.sha256(Path(case["zip"]).read_bytes()).hexdigest()
    return row


cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
Path(sys.argv[2]).write_text(json.dumps([run(c) for c in cases], indent=1), encoding="utf-8")
