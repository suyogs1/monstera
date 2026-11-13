"""Host reference for the Studio M2 determinism badge: what host CPython's engine says for each draft.

Usage: python m2-badge-reference.py <cases.json> <out.json>. Each case is {name, projectId, text}. For every recorded
golden of the project (scenario.scenario_files), the draft's oracle checkpoints are compared with the committed ones
using Python equality. The browser run (m2-badge.mjs) requires Studio to report exactly the same outcome.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "monstera"))

from monstera import scenario  # noqa: E402
from monstera.cli import DEFAULT_SCHEMAS  # noqa: E402
from monstera.jsonio import load_path, loads_strict  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_value  # noqa: E402

STORE = SchemaStore.load(DEFAULT_SCHEMAS)


def run(case: dict) -> dict:
    result = validate_value(loads_strict(case["text"]), STORE)
    if not result.ok:
        return {"name": case["name"], "valid": False, "sha256": None, "scenarios": []}
    rows = []
    for path in scenario.scenario_files(case["projectId"]):
        data = load_path(path)
        committed = data["checkpoints"]
        fresh = scenario.checkpoints_for_game(result.spec["game"], data, [c["tick"] for c in committed])
        diverged = [i for i, (want, got) in enumerate(zip(committed, fresh)) if want != got]
        rows.append({"file": path.relative_to(REPO).as_posix(), "status": "diverged" if diverged else "match",
                     "divergentCheckpoints": len(diverged),
                     "firstDivergentTick": committed[diverged[0]]["tick"] if diverged else None})
    return {"name": case["name"], "valid": True, "sha256": result.sha256, "scenarios": rows}


def main() -> None:
    cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    Path(sys.argv[2]).write_text(json.dumps([run(c) for c in cases]), encoding="utf-8")


main()
