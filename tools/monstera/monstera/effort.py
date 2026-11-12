"""Lightweight execution-effort log (`monstera effort`), policy: .kiro/steering/09-value-for-credit.md.

Records only what can be observed: kind (command, wait, retry, review, note), seconds and a note.
It never records or estimates AI credits: Kiro does not expose them. Advisory; it gates nothing.
"""
from __future__ import annotations
import json
import subprocess
from collections import Counter
from pathlib import Path

KINDS = ("command", "wait", "retry", "review", "note")
LOG = Path(".kiro") / "workflow-output" / "effort.jsonl"
GOVERNANCE = Path(".kiro") / "governance.json"
PROFILE_KEYS = {"maxReviewRounds": int, "ciWaitMinutes": int, "adversarialReview": str, "gatesCadence": str}


def validate_governance(data: object) -> list[str]:
    """Structural problems of governance.json (used by the kiro-config gate)."""
    if not isinstance(data, dict):
        return ["governance.json: must be an object"]
    problems = []
    profiles = data.get("profiles")
    if data.get("version") != 1:
        problems.append("governance.json: version must be 1")
    if not isinstance(profiles, dict) or not profiles:
        return problems + ["governance.json: needs a non-empty 'profiles' object"]
    if data.get("active") not in profiles:
        problems.append(f"governance.json: active profile {data.get('active')!r} is not defined")
    for name, profile in profiles.items():
        if not isinstance(profile, dict) or set(profile) != set(PROFILE_KEYS):
            problems.append(f"governance.json: profile {name!r} needs exactly {sorted(PROFILE_KEYS)}")
            continue
        for key, typ in PROFILE_KEYS.items():
            value = profile[key]
            if not isinstance(value, typ) or isinstance(value, bool) or (typ is int and value < 1):
                problems.append(f"governance.json: {name}.{key} is invalid")
    return problems


def append(root: Path, kind: str, seconds: int, note: str) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    if seconds < 0:
        raise ValueError("seconds must be >= 0")
    entry = {"kind": kind, "seconds": seconds, "note": note}
    path = root / LOG
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    return entry


def _git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False).stdout
    except OSError:
        return ""


def report(root: Path, base: str | None) -> str:
    """Factual markdown summary: logged effort plus git-derived change size."""
    lines = ["# Effort (observed; AI credit consumption is not available to this project)"]
    entries = []
    path = root / LOG
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            try:
                entries.append(json.loads(raw))
            except ValueError:
                continue
    counts = Counter(e.get("kind") for e in entries)
    secs = Counter()
    for e in entries:
        secs[e.get("kind")] += int(e.get("seconds", 0))
    if entries:
        for kind in KINDS:
            if counts[kind]:
                lines.append(f"- {kind}: {counts[kind]} entries, {secs[kind]} s")
    else:
        lines.append("- no effort entries logged")
    profile = ""
    try:
        gov = json.loads((root / GOVERNANCE).read_text(encoding="utf-8"))
        profile = f"{gov['active']} {gov['profiles'][gov['active']]}"
    except (OSError, ValueError, KeyError):
        profile = "unavailable"
    lines.append(f"- governance profile: {profile}")
    if base:
        stat = _git(root, "diff", "--shortstat", f"{base}...HEAD").strip() or "no changes"
        commits = len(_git(root, "rev-list", f"{base}..HEAD").split())
        lines.append(f"- since {base}: {commits} commits; {stat}")
    return "\n".join(lines) + "\n"
