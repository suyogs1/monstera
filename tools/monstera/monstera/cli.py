"""`monstera` command line.

Exit codes: 0 success, 1 invalid spec / drift / violation, 2 usage or internal error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import GENERATOR_NAME, GENERATOR_VERSION, archcheck, generate, kirocheck, targets
from .jsonio import canonical_text
from .schema import SchemaError, SchemaStore
from .validate import Result, validate_path

REPO_ROOT = targets.REPO_ROOT
DEFAULT_SCHEMAS = REPO_ROOT / "spec" / "schema"


def _label(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.name


def _report(path: Path, result: Result, as_json: bool) -> None:
    if as_json:
        print(json.dumps({
            "file": _label(path), "valid": result.ok,
            "sha256": result.sha256 if result.ok else None,
            "issues": [{"path": i.path, "code": i.code, "message": i.message} for i in result.issues],
        }, sort_keys=True))
        return
    if result.ok:
        note = ""
        if path.read_bytes() != result.canonical:
            note = " (not in canonical form; run `monstera format`)"
        print(f"{_label(path)}: valid, sha256 {result.sha256}{note}")
    else:
        print(f"{_label(path)}: INVALID ({len(result.issues)} issue{'s' if len(result.issues) != 1 else ''})")
        for issue in result.issues:
            print(f"  {issue}")


def cmd_validate(args: argparse.Namespace, store: SchemaStore) -> int:
    paths = [Path(p) for p in args.specs]
    if args.all:
        paths += targets.spec_files()
    if not paths:
        print("validate: give spec paths or --all", file=sys.stderr)
        return 2
    failed = 0
    for path in paths:
        result = validate_path(path, store)
        _report(path, result, args.json)
        failed += not result.ok
    return 1 if failed else 0


def cmd_format(args: argparse.Namespace, store: SchemaStore) -> int:
    path = Path(args.spec)
    result = validate_path(path, store)
    if result.spec is None:
        _report(path, result, False)
        return 1
    text = canonical_text(result.spec)
    if path.read_text(encoding="utf-8") == text:
        print(f"{_label(path)}: already canonical")
        return 0
    if args.check:
        print(f"{_label(path)}: not canonical")
        return 1
    path.write_bytes(text.encode("utf-8"))
    print(f"{_label(path)}: rewritten in canonical form")
    return 0


def cmd_generate(args: argparse.Namespace, store: SchemaStore) -> int:
    path = Path(args.spec)
    result = validate_path(path, store)
    if not result.ok:
        _report(path, result, False)
        print("generate: refusing to generate from an invalid specification", file=sys.stderr)
        return 1
    try:
        default_dir, default_layout = targets.default_out(path, result.spec["project"]["id"])
    except ValueError as exc:
        print(f"generate: {exc}", file=sys.stderr)
        return 2
    out = Path(args.out) if args.out else default_dir
    layout = args.layout or default_layout
    files = generate.plan(result.spec, _label(path), store, layout=layout)
    if args.check:
        drift = generate.check(files, out)
        if drift.clean:
            print(f"{_label(out)}: up to date ({len(files)} files, spec sha256 {result.sha256})")
            return 0
        print(f"{_label(out)}: DRIFT from a fresh generation")
        for label, items in (("changed", drift.changed), ("missing", drift.missing), ("unexpected", drift.unexpected)):
            for item in items:
                print(f"  {label}: {item}")
        return 1
    try:
        generate.write(files, out, force=args.force)
    except generate.OutputError as exc:
        print(f"generate: {exc}", file=sys.stderr)
        return 2
    print(f"{_label(out)}: generated {len(files)} files from spec sha256 {result.sha256}")
    return 0


def cmd_verify(args: argparse.Namespace, store: SchemaStore) -> int:
    out = Path(args.dir)
    try:
        drift = generate.verify(out)
    except generate.OutputError as exc:
        print(f"verify: {exc}", file=sys.stderr)
        return 1
    if drift.clean:
        print(f"{_label(out)}: matches its manifest")
        return 0
    print(f"{_label(out)}: DIFFERS from its manifest")
    for label, items in (("changed", drift.changed), ("missing", drift.missing), ("unexpected", drift.unexpected)):
        for item in items:
            print(f"  {label}: {item}")
    return 1


def cmd_check_architecture(args: argparse.Namespace, store: SchemaStore) -> int:
    violations = archcheck.check(Path(args.root) if args.root else REPO_ROOT)
    for v in violations:
        print(v)
    print(f"architecture check: {'FAILED' if violations else 'ok'} ({len(violations)} violation(s))")
    return 1 if violations else 0


_PATH_KEYS = {"path", "paths", "targetFile", "sourcePath", "destinationPath", "file_path", "filePath",
              "oldPath", "newPath"}


def _paths_in(value: object) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, sub in value.items():
            if key in _PATH_KEYS and isinstance(sub, str):
                found.append(sub)
            elif key in _PATH_KEYS and isinstance(sub, list):
                found += [s for s in sub if isinstance(s, str)] + _paths_in([s for s in sub if not isinstance(s, str)])
            else:
                found += _paths_in(sub)
    elif isinstance(value, list):
        for sub in value:
            found += _paths_in(sub)
    return found


def _key(path: Path) -> str:
    return os.path.normcase(str(path))  # case-insensitive filesystems (Windows) compare folded


def _normalize_spelling(raw: str) -> str | None:
    """Map Windows extended-length and admin-share spellings to a plain path. None = a UNC or
    device path we can't map, which the guard treats as owned (fail closed)."""
    s = raw.replace("/", "\\") if os.name == "nt" else raw
    if os.name == "nt":
        if s.startswith("\\\\?\\UNC\\"):
            s = "\\\\" + s[8:]
        elif s.startswith(("\\\\?\\", "\\\\.\\")):
            s = s[4:]
        if s.startswith("\\\\"):
            parts = s[2:].split("\\", 2)
            if len(parts) >= 2 and parts[0].lower() in ("localhost", "127.0.0.1", ".") and \
                    len(parts[1]) == 2 and parts[1][1] == "$":
                return parts[1][0] + ":\\" + (parts[2] if len(parts) > 2 else "")
            return None
    return s


def _fallback_owned(candidate: str) -> bool:
    """Deliberately simple check used only when the full guard crashes. It uses only string
    operations and os.path.exists, so a bug in the full guard can't break it. Blocks: anything
    under generated/, any apps/<id>/android|ios|.kiro path, any manifest, any UNC/device path,
    and any path with a MONSTERA-MANIFEST.json in one of its ancestor directories."""
    try:
        text = candidate.replace("\\", "/")
        low = text.lower()
        if low.startswith("//") or "monstera-manifest.json" in low:
            return True
        rel = low
        repo = str(REPO_ROOT).replace("\\", "/").lower().rstrip("/") + "/"
        if rel.startswith(repo):
            rel = rel[len(repo):]
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if parts[:1] == ["generated"] or (len(parts) >= 3 and parts[0] == "apps"
                                           and parts[2] in ("android", "ios", ".kiro")):
            return True
        base = text if os.path.isabs(text) else str(REPO_ROOT).replace("\\", "/") + "/" + text
        directory = os.path.dirname(os.path.normpath(base))
        for _ in range(64):
            if os.path.exists(os.path.join(directory, generate.MANIFEST)):
                return True
            parent = os.path.dirname(directory)
            if parent == directory:
                break
            directory = parent
        return False
    except Exception:  # noqa: BLE001 - last resort
        return True


def generator_owned(target: Path) -> bool:
    """True if `target` (resolved) is, or contains, generator-owned output:
    - anything under generated/, or generated/ inside target;
    - a path that ANY MONSTERA-MANIFEST.json above it claims (a decoy deeper manifest can't
      release files an outer one owns);
    - a directory containing a manifest, or containing a path an outer manifest owns
      (moving or deleting it would move or delete owned files);
    - anything under a directory whose manifest exists but is invalid (fail closed)."""
    generated = targets.GENERATED.resolve()
    tkey = _key(target)
    if _key(generated) == tkey or tkey.startswith(_key(generated) + os.sep) or \
            _key(target) in (_key(p) for p in generated.parents):
        return True
    root = REPO_ROOT.resolve()
    for directory in [target, *target.parents]:
        if _key(directory) != _key(root) and not tkey.startswith(_key(root) + os.sep):
            break
        try:
            manifest = generate.read_manifest(directory)
        except generate.OutputError:
            return True  # a manifest exists but is invalid: fail closed
        if manifest is not None:
            rel = os.path.relpath(tkey, _key(directory)).replace(os.sep, "/")
            owned = [os.path.normcase(o).replace(os.sep, "/") for o in generate._owned_from(manifest)]
            if rel in (".", os.path.normcase(generate.MANIFEST)) or generate._in_owned(rel, owned):
                return True
            if any(o == "." or o.startswith(rel + "/") for o in owned):
                return True  # target is a directory above owned paths
        if _key(directory) == _key(root):
            break
    if target.is_dir():
        for found in target.rglob(generate.MANIFEST):
            if ".git" not in found.parts:
                return True
    return False


def cmd_guard_generated(args: argparse.Namespace, store: SchemaStore) -> int:
    """PreToolUse hook: exit 2 (block) if a file tool targets generator-owned output.
    Reads the hook JSON on stdin."""
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0  # not a structured tool call; nothing to guard
    for candidate in _paths_in(payload):
        try:
            spelled = _normalize_spelling(candidate)
            if spelled is None:
                blocked = True  # unmappable UNC/device path: fail closed
            else:
                target = Path(spelled)
                target = (target if target.is_absolute() else REPO_ROOT / target).resolve()
                blocked = generator_owned(target)
        except Exception as exc:  # noqa: BLE001 - a crash would exit 1, which Kiro treats as "allow"
            # Fail closed for anything that looks generator-owned, but NOT for everything: blocking
            # every path also blocks the edit that repairs the guard (G1.5 self-lock incident).
            blocked = _fallback_owned(candidate)
            print(f"guard error ({type(exc).__name__}: {exc}); fallback check: "
                  f"{'blocking' if blocked else 'allowing'} {candidate}", file=sys.stderr)
        if blocked:
            print(f"Blocked: {candidate} is generator-owned output. Edit the spec "
                  "(monstera.spec.json) or the templates (tools/monstera/monstera/templates/) and run "
                  "`monstera generate` instead.", file=sys.stderr)
            return 2
    return 0


def cmd_gates(args: argparse.Namespace, store: SchemaStore) -> int:
    """The single definition of "green", shared by the Kiro hook, the workflows and CI."""
    import subprocess

    results: list[tuple[str, bool, str]] = []

    def gate(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)

    if not args.skip_tests:
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tools/monstera/tests", "-t", "tools/monstera"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        summary = [ln for ln in proc.stderr.splitlines() if ln.startswith(("Ran ", "OK", "FAILED"))]
        gate("unit-tests", proc.returncode == 0, " | ".join(summary) or f"exit {proc.returncode}")
        if proc.returncode != 0:
            print(proc.stderr[-4000:], file=sys.stderr)

    for target in targets.all_targets():
        label = _label(target.spec)
        result = validate_path(target.spec, store)
        gate(f"validate {label}", result.ok,
             f"sha256 {result.sha256}" if result.ok else "; ".join(map(str, result.issues))[:500])
        if not result.ok:
            continue
        gate(f"canonical {label}", target.spec.read_bytes() == result.canonical,
             "canonical" if target.spec.read_bytes() == result.canonical else "run `monstera format`")
        files = generate.plan(result.spec, label, store, layout=target.layout)
        drift = generate.check(files, target.out)
        gate(f"generate --check {_label(target.out)}", drift.clean,
             f"{len(files)} files" if drift.clean else f"changed={list(drift.changed)} missing={list(drift.missing)} "
                                                       f"unexpected={list(drift.unexpected)}")
        if (target.out / generate.MANIFEST).exists():
            try:
                v = generate.verify(target.out)
                gate(f"verify {_label(target.out)}", v.clean, "matches manifest" if v.clean else str(v))
            except generate.OutputError as exc:
                gate(f"verify {_label(target.out)}", False, str(exc))

    violations = archcheck.check(REPO_ROOT)
    gate("architecture", not violations, "ok" if not violations else "; ".join(map(str, violations)))
    problems = kirocheck.check(REPO_ROOT)
    gate("kiro-config", not problems, "ok" if not problems else "; ".join(problems))

    failed = [name for name, ok, _ in results if not ok]
    print(f"gates: {'FAILED' if failed else 'all passed'} ({len(results) - len(failed)}/{len(results)})")
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="monstera", description="MONSTERA specification engine")
    parser.add_argument("--version", action="version", version=f"{GENERATOR_NAME} {GENERATOR_VERSION}")
    parser.add_argument("--schemas", default=str(DEFAULT_SCHEMAS), help="schema directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("validate", help="validate specification files")
    p.add_argument("specs", nargs="*")
    p.add_argument("--all", action="store_true", help="validate every spec under spec/samples/")
    p.add_argument("--json", action="store_true", help="one JSON result per line")
    p.set_defaults(func=cmd_validate)

    p = sub.add_parser("format", help="rewrite a spec in canonical form")
    p.add_argument("spec")
    p.add_argument("--check", action="store_true", help="only report whether it is canonical")
    p.set_defaults(func=cmd_format)

    p = sub.add_parser("generate", help="generate native projects from a spec")
    p.add_argument("spec")
    p.add_argument("--out", help="output directory (default: apps/<id>/ for apps/<id>/monstera.spec.json, "
                                 "otherwise generated/<project.id>)")
    p.add_argument("--layout", choices=sorted(generate.LAYOUTS),
                   help="fixture = generator owns the whole directory; app = only android/, ios/ and the "
                        "Kiro guidance file (default: app for apps/<id>/, fixture otherwise)")
    p.add_argument("--check", action="store_true", help="compare with a fresh generation; write nothing")
    p.add_argument("--force", action="store_true",
                   help="discard hand edits and unmanaged files in the output directory (never follows symlinks)")
    p.set_defaults(func=cmd_generate)

    p = sub.add_parser("verify", help="check a generated directory against its own manifest")
    p.add_argument("dir")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("check-architecture", help="reject forbidden cross-platform frameworks")
    p.add_argument("--root", help="directory to scan (default: repository root)")
    p.set_defaults(func=cmd_check_architecture)

    p = sub.add_parser("guard-generated", help="hook: block file-tool edits to generator-owned paths (reads stdin)")
    p.set_defaults(func=cmd_guard_generated)

    p = sub.add_parser("gates", help="run every quality gate (tests, specs, generation, architecture, Kiro config)")
    p.add_argument("--skip-tests", action="store_true", help="skip the unit tests (used by the tests themselves)")
    p.set_defaults(func=cmd_gates)
    return parser


def main(argv: list[str] | None = None) -> int:
    # Never crash on a console/pipe encoding (e.g. cp1252 on Windows); output is ASCII-safe anyway.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    args = build_parser().parse_args(argv)
    try:
        store = SchemaStore.load(Path(args.schemas))
        return args.func(args, store)
    except SchemaError as exc:
        print(f"monstera: schema error: {exc}", file=sys.stderr)
        return 2
