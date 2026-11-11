"""`monstera` command line.

Exit codes: 0 success, 1 invalid spec / drift / violation, 2 usage or internal error.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import GENERATOR_NAME, GENERATOR_VERSION, archcheck, generate
from .jsonio import canonical_text
from .schema import SchemaError, SchemaStore
from .validate import Result, validate_path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SCHEMAS = REPO_ROOT / "spec" / "schema"
SPEC_GLOB_ROOT = REPO_ROOT / "spec" / "samples"


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
        paths += sorted(SPEC_GLOB_ROOT.rglob("monstera.spec.json"))
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
    out = Path(args.out) if args.out else REPO_ROOT / "generated" / result.spec["project"]["id"]
    files = generate.plan(result.spec, _label(path), store)
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
        generate.write(files, out)
    except generate.OutputError as exc:
        print(f"generate: {exc}", file=sys.stderr)
        return 2
    print(f"{_label(out)}: generated {len(files)} files from spec sha256 {result.sha256}")
    return 0


def cmd_check_architecture(args: argparse.Namespace, store: SchemaStore) -> int:
    violations = archcheck.check(Path(args.root) if args.root else REPO_ROOT)
    for v in violations:
        print(v)
    print(f"architecture check: {'FAILED' if violations else 'ok'} ({len(violations)} violation(s))")
    return 1 if violations else 0


_PATH_KEYS = {"path", "targetFile", "sourcePath", "destinationPath", "file_path", "filePath"}


def _paths_in(value: object) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, sub in value.items():
            if key in _PATH_KEYS and isinstance(sub, str):
                found.append(sub)
            else:
                found += _paths_in(sub)
    elif isinstance(value, list):
        for sub in value:
            found += _paths_in(sub)
    return found


def cmd_guard_generated(args: argparse.Namespace, store: SchemaStore) -> int:
    """PreToolUse hook: exit 2 (block) if a file tool targets generated/. Reads hook JSON on stdin."""
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        return 0  # not a structured tool call; nothing to guard
    generated = (REPO_ROOT / "generated").resolve()
    for candidate in _paths_in(payload):
        target = Path(candidate)
        target = (target if target.is_absolute() else REPO_ROOT / target).resolve()
        if target == generated or generated in target.parents:
            print(f"Blocked: {candidate} is generator-owned output. Edit the spec "
                  "(spec/samples/...) or the templates (tools/monstera/monstera/templates/) and run "
                  "`monstera generate` instead.", file=sys.stderr)
            return 2
    return 0


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
    p.add_argument("--out", help="output directory (default: generated/<project.id>)")
    p.add_argument("--check", action="store_true", help="compare with a fresh generation; write nothing")
    p.set_defaults(func=cmd_generate)

    p = sub.add_parser("check-architecture", help="reject forbidden cross-platform frameworks")
    p.add_argument("--root", help="directory to scan (default: repository root)")
    p.set_defaults(func=cmd_check_architecture)

    p = sub.add_parser("guard-generated", help="hook: block file-tool edits under generated/ (reads stdin)")
    p.set_defaults(func=cmd_guard_generated)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        store = SchemaStore.load(Path(args.schemas))
        return args.func(args, store)
    except SchemaError as exc:
        print(f"monstera: schema error: {exc}", file=sys.stderr)
        return 2
