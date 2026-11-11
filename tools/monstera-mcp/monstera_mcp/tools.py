"""Tool implementations. Each one is a thin adapter over existing tools/monstera functions:
no validation, generation, hashing or manifest logic lives here (architecture/MONSTERA-MCP.md).

Pure Python and SDK-free, so the security and parity tests run without the MCP SDK.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "tools" / "monstera"))

from monstera import conformance, generate, scenario, targets  # noqa: E402
from monstera.jsonio import canonical_bytes  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_path, validate_value  # noqa: E402

MAX_INLINE_SPEC_BYTES = 64 * 1024


def _safe_generated_child(rel: str) -> bool:
    head, _, name = rel.partition("/")
    return (head == "generated" and bool(name) and "/" not in name and name[0].isalnum()
            and all(c.isalnum() or c in "._-" for c in name))
MAX_REPORT_LINES = 1000
MAX_RUN_LISTING = 20
DEVICE_TARGETS = ("android-emulator", "android-device", "ios-simulator", "ios-device")
RESULT_KEYS = {"op", "target", "status", "run_id", "timestamp"}
RESULT_OPTIONAL = {"artifact", "detail"}
RESULT_STATUS = {"ok", "failed", "unsupported"}


class ToolError(ValueError):
    """A refused or invalid request. Its message is returned to the client as the tool error."""


_store: SchemaStore | None = None


def store() -> SchemaStore:
    global _store
    if _store is None:
        _store = SchemaStore.load(REPO_ROOT / "spec" / "schema")
    return _store


def _confined(raw: str, allowed: tuple[str, ...], what: str) -> Path:
    """Resolve a repository-relative path; refuse anything outside `allowed` prefixes or via a symlink."""
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise ToolError(f"{what}: a non-empty path is required")
    candidate = Path(raw)
    if candidate.is_absolute():
        raise ToolError(f"{what}: use a repository-relative path, not {raw!r}")
    root = REPO_ROOT.resolve()
    unresolved = root / candidate
    for hop in [unresolved, *unresolved.parents]:
        if hop == root:
            break
        if hop.is_symlink():
            raise ToolError(f"{what}: {raw!r} goes through a symlink; refused")
    resolved = unresolved.resolve()
    if root not in resolved.parents:
        raise ToolError(f"{what}: {raw!r} is outside the repository")
    rel = resolved.relative_to(root).as_posix()
    if not any(rel == a.rstrip("/") or rel.startswith(a) for a in allowed):
        raise ToolError(f"{what}: {raw!r} is not under {', '.join(allowed)}")
    return resolved


def _label(path: Path) -> str:
    return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()


def _issues(result: Any) -> list[dict[str, str]]:
    return [{"path": i.path, "code": i.code, "message": i.message} for i in result.issues]


def _spec_path(raw: str) -> Path:
    path = _confined(raw, ("spec/", "apps/"), "spec_path")
    rel = _label(path)
    if not (rel.startswith("spec/") or (rel.startswith("apps/") and rel.count("/") == 2)):
        raise ToolError("spec_path: specs live under spec/ or at apps/<id>/monstera.spec.json")
    if path.name != "monstera.spec.json" and not rel.startswith("spec/fixtures/"):
        raise ToolError("spec_path: must be a monstera.spec.json file")
    return path


def validate_spec(path: str | None = None, spec: dict[str, Any] | None = None) -> dict[str, Any]:
    if (path is None) == (spec is None):
        raise ToolError("give exactly one of 'path' or 'spec'")
    if path is not None:
        file = _spec_path(path)
        result = validate_path(file, store())
        canonical = result.ok and file.read_bytes() == result.canonical
        return {"valid": result.ok, "sha256": result.sha256 if result.ok else None,
                "canonical": canonical, "issues": _issues(result)}
    try:
        if len(json.dumps(spec)) > MAX_INLINE_SPEC_BYTES:
            raise ToolError(f"inline spec exceeds {MAX_INLINE_SPEC_BYTES} bytes")
        result = validate_value(spec, store())
    except RecursionError:
        raise ToolError("inline spec is nested too deeply") from None
    return {"valid": result.ok, "sha256": result.sha256 if result.ok else None,
            "canonical": None, "issues": _issues(result)}


def generate_project(spec_path: str, out: str | None = None, write: bool = False) -> dict[str, Any]:
    file = _spec_path(spec_path)
    result = validate_path(file, store())
    if not result.ok:
        return {"spec_sha256": None, "files": 0, "mode": "write" if write else "check",
                "issues": _issues(result), "drift": None, "written": False,
                "refused": "invalid specification"}
    try:
        default_dir, layout = targets.default_out(file, result.spec["project"]["id"])
    except ValueError as exc:
        raise ToolError(str(exc)) from None
    # Outputs are exactly one project directory (review issue 4): an app spec writes only to its
    # own apps/<id>/; any other spec writes only to a direct child of generated/. Never a container
    # (apps/, generated/), never nested inside another project or a hand-maintained directory.
    if out is None:
        root = default_dir
    elif layout == "app":
        root = _confined(out, ("apps/",), "out")
        if _label(root) != _label(default_dir):
            raise ToolError(f"out: an app spec generates only into its own folder {_label(default_dir)}")
    else:
        root = _confined(out, ("generated/",), "out")
        rel = _label(root)
        if not _safe_generated_child(rel):
            raise ToolError("out: must be a direct child of generated/ (generated/<name>)")
    _confined(_label(root), ("generated/", "apps/"), "out")
    try:
        embedded = scenario.load_for_project(result.spec["project"]["id"], result.sha256, store())
    except ValueError as exc:
        return {"spec_sha256": result.sha256, "files": 0, "mode": "write" if write else "check", "issues": [],
                "drift": None, "written": False, "refused": f"scenarios: {exc}"}
    files = generate.plan(result.spec, _label(file), store(), layout=layout, scenarios=embedded)
    drift = generate.check(files, root)
    response: dict[str, Any] = {
        "spec_sha256": result.sha256, "files": len(files), "mode": "write" if write else "check",
        "out": _label(root), "layout": layout, "issues": [],
        "drift": {"changed": list(drift.changed), "missing": list(drift.missing),
                  "unexpected": list(drift.unexpected)},
        "written": False, "refused": None,
    }
    if write and not drift.clean:
        try:
            generate.write(files, root, force=False)  # the server never forces
            response["written"] = True
        except generate.OutputError as exc:
            response["refused"] = str(exc)
    return response


def inspect_manifest(dir: str) -> dict[str, Any]:  # noqa: A002 - matches the tool contract
    root = _confined(dir, ("generated/", "apps/"), "dir")
    try:
        manifest = generate.read_manifest(root)
        if manifest is None:
            raise ToolError(f"{_label(root)} has no {generate.MANIFEST}")
        drift = generate.verify(root)
    except generate.OutputError as exc:
        raise ToolError(str(exc)) from None
    kinds: dict[str, int] = {}
    for entry in manifest["files"]:
        kinds[entry.get("kind", "?")] = kinds.get(entry.get("kind", "?"), 0) + 1
    return {
        "generator": manifest.get("generator"), "spec": manifest.get("spec"),
        "layout": manifest.get("layout", "fixture"), "ownedRoots": manifest.get("ownedRoots", ["."]),
        "schemas": manifest.get("schemas"), "toolchain": manifest.get("toolchain"),
        "file_count": len(manifest["files"]), "files_by_kind": dict(sorted(kinds.items())),
        "verify": {"clean": drift.clean, "changed": list(drift.changed), "missing": list(drift.missing),
                   "unexpected": list(drift.unexpected)},
    }


def run_conformance(dir: str, platforms: list[str] | None = None,  # noqa: A002 - matches the tool contract
                    swift_image: str | None = None) -> dict[str, Any]:
    """Run the golden scenarios on the requested platforms and compare (monstera conformance).
    Defaults to the in-process oracle only; kotlin runs Gradle unit tests, swift runs `swift test`
    in the given swift:<version> container image (or a local toolchain when none is given)."""
    root = _confined(dir, ("generated/", "apps/"), "dir")
    try:
        report = conformance.run(root, store(), platforms if platforms is not None else ["oracle"], swift_image)
    except (conformance.ConformanceError, generate.OutputError, ValueError) as exc:
        raise ToolError(str(exc)) from None
    problems = store().validate(report, "conformance.schema.json")
    if problems:
        raise ToolError("internal error: report violates conformance.schema.json: " + "; ".join(map(str, problems)))
    return {"report": report, "summary": conformance.summarize(report)}


def _valid_result(line: Any) -> bool:
    return (isinstance(line, dict) and RESULT_KEYS <= set(line) <= RESULT_KEYS | RESULT_OPTIONAL
            and line.get("status") in RESULT_STATUS and line.get("target") in DEVICE_TARGETS
            and all(isinstance(v, str) for v in line.values()))


def get_device_report(run_id: str | None = None, evidence: str | None = None,
                      target: str | None = None) -> dict[str, Any]:
    runs = REPO_ROOT / "device-lab" / "reports" / "runs"
    if run_id is None and evidence is None:
        available = sorted((p for p in runs.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime,
                           reverse=True) if runs.exists() else []
        return {"available_runs": [p.name for p in available[:MAX_RUN_LISTING]]}
    if run_id is not None and evidence is not None:
        raise ToolError("give at most one of 'run_id' or 'evidence'")
    if target is not None and target not in DEVICE_TARGETS:
        raise ToolError(f"target must be one of {DEVICE_TARGETS}")
    if run_id is not None:
        if "/" in run_id or "\\" in run_id or run_id in ("", ".", ".."):
            raise ToolError("run_id must be a single directory name")
        base = _confined(f"device-lab/reports/runs/{run_id}", ("device-lab/reports/runs/",), "run_id")
        candidates = [base / t / "report.json" for t in ([target] if target else DEVICE_TARGETS)]
    else:
        base = _confined(evidence, ("docs/evidence/",), "evidence")
        candidates = [base / "report.json"]
    found = [c for c in candidates if c.is_file() and not c.is_symlink()]
    if not found:
        raise ToolError(f"no report.json under {_label(base)}" + (f" for {target}" if target else ""))
    source = found[0]
    try:
        lines = json.loads(source.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise ToolError(f"{_label(source)} is not valid JSON: {exc}") from None
    if not isinstance(lines, list):
        raise ToolError(f"{_label(source)} must be a JSON array of result lines")
    lines = lines[:MAX_REPORT_LINES]
    valid = [ln for ln in lines if _valid_result(ln)]
    if target is not None:
        valid = [ln for ln in valid if ln["target"] == target]
    summary = {s: sum(1 for ln in valid if ln["status"] == s) for s in ("ok", "failed", "unsupported")}
    return {"source": _label(source), "results": valid, "summary": summary,
            "invalid_lines": len(lines) - sum(1 for ln in lines if _valid_result(ln))}


__all__ = ["ToolError", "validate_spec", "generate_project", "inspect_manifest", "get_device_report", "run_conformance",
           "canonical_bytes"]
