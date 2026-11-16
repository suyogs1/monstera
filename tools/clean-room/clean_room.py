#!/usr/bin/env python3
"""G6-B clean-room support (standard library only). Not part of the generator and never shipped.

  compare  <committed-app-dir> <fresh-dir> <report.json>
      Every generator-owned path of the fresh tree equals the committed tree: file set, bytes, SHA-256 and mode.
  junit    <gradle-test-results-dir> <report.json>
      Sums JUnit XML counts. Fails when no test ran.
  branching <report.json>
      Production generator and template code mention no project of this repository (derived from the specs).

Exit 0 = pass, 1 = proof failed, 2 = bad usage. Reports contain no timestamps, so equal inputs give equal reports.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

REPO = Path(__file__).resolve().parents[2]
OWNED_ROOTS = ("android", "ios", ".kiro/steering/monstera-generated.md", "MONSTERA-MANIFEST.json")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_report(path: str, report: dict) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def committed_files(app: Path) -> dict[str, str]:
    """Tracked generator-owned files of a committed app -> git mode ('100644' or '100755')."""
    raw = subprocess.run(["git", "ls-files", "-s", "-z", "--", *OWNED_ROOTS], cwd=app, check=True,
                         capture_output=True).stdout.decode("utf-8")
    files: dict[str, str] = {}
    for entry in filter(None, raw.split("\0")):
        meta, name = entry.split("\t", 1)
        files[name] = meta.split()[0]
    return files


def fresh_files(root: Path) -> tuple[dict[str, str], list[str]]:
    """Every file in the fresh tree -> mode, and the problems found (links, directories that are not files)."""
    files: dict[str, str] = {}
    problems: list[str] = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if p.is_symlink():
            problems.append(f"link in fresh tree: {rel}")
        elif p.is_file():
            files[rel] = "100755" if p.stat().st_mode & 0o111 else "100644"
    return files, problems


def cmd_compare(app_dir: str, fresh_dir: str, report_path: str) -> int:
    app, fresh = Path(app_dir).resolve(), Path(fresh_dir).resolve()
    committed = committed_files(app)
    actual, problems = fresh_files(fresh)
    missing = sorted(set(committed) - set(actual))
    extra = sorted(set(actual) - set(committed))
    content, modes = [], []
    for name in sorted(set(committed) & set(actual)):
        if (app / name).read_bytes() != (fresh / name).read_bytes():
            content.append(name)
        if committed[name] != actual[name]:
            modes.append(f"{name}: committed {committed[name]}, fresh {actual[name]}")
    # Manifest cross-check: both manifests list the same files with the same hashes and modes.
    manifest = json.loads((fresh / "MONSTERA-MANIFEST.json").read_text(encoding="utf-8"))
    committed_manifest = json.loads((app / "MONSTERA-MANIFEST.json").read_text(encoding="utf-8"))
    listed = {f["path"]: f for f in manifest["files"]}
    manifest_bad = [n for n, f in sorted(listed.items())
                    if not (fresh / n).is_file() or sha256(fresh / n) != f["sha256"]]
    manifest_equal = manifest == committed_manifest
    spec_path = REPO / manifest["spec"]["path"]
    spec_sha = sha256(spec_path)
    ok = not (missing or extra or content or modes or problems or manifest_bad) and manifest_equal \
        and spec_sha == manifest["spec"]["sha256"] and set(listed) | {"MONSTERA-MANIFEST.json"} == set(actual)
    report = {
        "check": "clean-room generator-owned tree equals committed tree",
        "projectId": manifest["spec"]["projectId"],
        "specPath": manifest["spec"]["path"],
        "specSha256": spec_sha,
        "specShaMatchesManifest": spec_sha == manifest["spec"]["sha256"],
        "manifestSha256Fresh": sha256(fresh / "MONSTERA-MANIFEST.json"),
        "manifestSha256Committed": sha256(app / "MONSTERA-MANIFEST.json"),
        "manifestsEqual": manifest_equal,
        "manifestListedFiles": len(listed),
        "ownedFilesCompared": len(committed),
        "freshFileCount": len(actual),
        "missingInFresh": missing, "extraInFresh": extra, "contentDiffers": content, "modeDiffers": modes,
        "manifestHashMismatches": manifest_bad, "problems": problems,
        "verdict": "PASS" if ok else "FAIL",
    }
    write_report(report_path, report)
    print(f"{report['projectId']}: {report['verdict']} ({len(committed)} owned files, manifest sha256 {report['manifestSha256Fresh']})")
    return 0 if ok else 1


def cmd_junit(results_dir: str, report_path: str) -> int:
    suites = []
    for xml in sorted(Path(results_dir).rglob("TEST-*.xml")):
        root = ElementTree.parse(xml).getroot()
        suites.append({"suite": root.get("name"), "tests": int(root.get("tests", 0)), "failures": int(root.get("failures", 0)),
                       "errors": int(root.get("errors", 0)), "skipped": int(root.get("skipped", 0))})
    total = {k: sum(s[k] for s in suites) for k in ("tests", "failures", "errors", "skipped")}
    ok = total["tests"] > 0 and total["failures"] == 0 and total["errors"] == 0
    write_report(report_path, {"check": "Gradle testDebugUnitTest results", "suites": suites, "total": total,
                               "verdict": "PASS" if ok else "FAIL"})
    print(f"junit: {total} {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def project_strings() -> set[str]:
    """Identity strings of every project in the repository (id, display name, identifier), read from the specs."""
    found: set[str] = set()
    for spec in sorted(REPO.glob("apps/*/monstera.spec.json")) + sorted(REPO.glob("spec/samples/*/monstera.spec.json")):
        project = json.loads(spec.read_text(encoding="utf-8")).get("project", {})
        found |= {project[k] for k in ("id", "displayName", "identifier") if isinstance(project.get(k), str)}
    return found

def cmd_branching(report_path: str) -> int:
    """Production code = tools/monstera/monstera/ (generator, oracle, schema loader) and its templates.
    Tests and author_scenarios.py are not production generator code and may name games."""
    root = REPO / "tools" / "monstera" / "monstera"
    names = {s for s in project_strings()}
    # Name stems that identify a game, matched case-insensitively with optional separators.
    stems = [r"pumpkin", r"blaster", r"trick[-_ ]?or[-_ ]?treat", r"treat[-_ ]?rush", r"lantern", r"boundary[-_ ]?lab",
             r"monstera[-_ ]?sample"]
    stem_re = re.compile("|".join(stems), re.IGNORECASE)
    hits: list[str] = []
    scanned = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
        scanned += 1
        rel = path.relative_to(REPO).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        if path.suffix == ".py":
            # Code only: string literals and identifiers. Docstrings and comments may use a game as an example.
            tree = ast.parse(text)
            docs = {id(n.body[0].value) for n in ast.walk(tree)
                    if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body
                    and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
            for node in ast.walk(tree):
                value = None
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                    value = node.value
                elif isinstance(node, ast.Name):
                    value = node.id
                elif isinstance(node, ast.Attribute):
                    value = node.attr
                if value is not None and (stem_re.search(value) or value in names):
                    hits.append(f"{rel}:{node.lineno}: {value[:80]}")
        else:
            for n, line in enumerate(text.splitlines(), 1):
                if stem_re.search(line) or any(s in line for s in names):
                    hits.append(f"{rel}:{n}: {line.strip()[:120]}")
    # Python: no comparison, membership test or match case against a string literal that is a project identity.
    branch_sites = 0
    ast_hits: list[str] = []
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Compare):
                branch_sites += 1
                for sub in ast.walk(node):
                    if isinstance(sub, ast.Constant) and isinstance(sub.value, str) and (
                            sub.value in names or stem_re.search(sub.value)):
                        ast_hits.append(f"{path.relative_to(REPO).as_posix()}:{node.lineno}")
    ok = not hits and not ast_hits
    write_report(report_path, {
        "check": "no project-specific branching in production generator and template code",
        "scope": "tools/monstera/monstera/ (all files, including oracle and templates)",
        "filesScanned": scanned, "comparisonsInspected": branch_sites,
        "projectIdentityStringsChecked": len(names), "textHits": hits, "comparisonHits": ast_hits,
        "verdict": "PASS" if ok else "FAIL"})
    print(f"branching: {scanned} files, {branch_sites} comparisons, {len(hits)} text hits -> {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    table = {"compare": (cmd_compare, 3), "junit": (cmd_junit, 2), "branching": (cmd_branching, 1)}
    if len(argv) < 2 or argv[1] not in table or len(argv) - 2 != table[argv[1]][1]:
        print(__doc__, file=sys.stderr)
        return 2
    return table[argv[1]][0](*argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
