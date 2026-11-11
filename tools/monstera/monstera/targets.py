"""Where canonical specs live and where their generated output goes. One definition, used by the
CLI (`validate --all`, `gates`), CI and the MCP server."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SAMPLES = REPO_ROOT / "spec" / "samples"
APPS = REPO_ROOT / "apps"
GENERATED = REPO_ROOT / "generated"


@dataclass(frozen=True)
class Target:
    spec: Path
    out: Path
    layout: str  # "fixture" (generated/<id>) or "app" (apps/<id>)


def spec_files() -> list[Path]:
    """Every canonical spec in the repository, sorted."""
    return sorted(SAMPLES.rglob("monstera.spec.json")) + sorted(APPS.glob("*/monstera.spec.json"))


def default_out(spec_path: Path, project_id: str) -> tuple[Path, str]:
    """apps/<id>/monstera.spec.json generates into apps/<id>/ (app layout); every other spec
    into generated/<id>/ (fixture layout). The app folder name must equal the project id."""
    resolved = spec_path.resolve()
    if resolved.parent.parent == APPS.resolve():
        if resolved.parent.name != project_id:
            raise ValueError(f"{resolved.parent.name}/monstera.spec.json declares project.id "
                             f"'{project_id}'; the folder name must match")
        return resolved.parent, "app"
    return GENERATED / project_id, "fixture"


def all_targets() -> list[Target]:
    found = []
    for spec in spec_files():
        try:
            project_id = json.loads(spec.read_text(encoding="utf-8"))["project"]["id"]
        except (OSError, ValueError, KeyError, TypeError):
            continue  # invalid specs are reported by validation, not here
        out, layout = default_out(spec, project_id)
        found.append(Target(spec, out, layout))
    return found
