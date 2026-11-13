"""Studio glue: calls the unmodified engine inside Pyodide and returns JSON strings.

It holds no validation, generation, serialization or simulation logic. The engine lives at
/repo/tools/monstera exactly as in the repository and reads /repo/spec/schema through the same paths.
Canonical text and SHA-256 come from monstera.jsonio / monstera.validate, the CLI's own code.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "/repo/tools/monstera")

from monstera import targets  # noqa: E402
from monstera.jsonio import LoadError, canonical_text, loads_strict, sha256_hex  # noqa: E402
from monstera.schema import SchemaStore  # noqa: E402
from monstera.validate import validate_value  # noqa: E402

REPO = Path("/repo")
STORE = SchemaStore.load(REPO / "spec" / "schema")


def info() -> str:
    return json.dumps({"python": sys.version, "repoRoot": str(targets.REPO_ROOT),
                       "schemaDigests": STORE.digests()}, sort_keys=True)


def schemas() -> str:
    """The schema files exactly as the engine reads them (the UI derives constraints and labels from these)."""
    out = {}
    for f in sorted((REPO / "spec" / "schema").glob("*.schema.json")):
        out[f.name] = f.read_text(encoding="utf-8")
    return json.dumps(out)


def _issues(result) -> list:
    return [{"path": i.path, "code": i.code, "message": i.message} for i in result.issues]


def validate_draft(text: str) -> str:
    """CLI-equivalent validation of a draft held as JSON text (strict load, schema, semantic rules).

    `canonicalText` and `sha256` are present whenever the text parses, even if the spec is invalid, so the
    Spec view can show what the engine would write. The hash identifies a spec only when `ok` is true.
    """
    try:
        value = loads_strict(text)
    except LoadError as exc:
        where = f" (line {exc.line}, column {exc.column})" if exc.line else ""
        return json.dumps({"ok": False, "parsed": False,
                           "issues": [{"path": "$", "code": exc.code, "message": exc.message + where}],
                           "sha256": None, "canonicalText": None})
    result = validate_value(value, STORE)
    canon = canonical_text(value)
    return json.dumps({"ok": result.ok, "parsed": True, "issues": _issues(result),
                       "sha256": sha256_hex(canon.encode("utf-8")), "canonicalText": canon})


def template(path: str) -> str:
    """A bundled template: its file text, the engine's canonical text, and whether they are byte-identical."""
    raw = (REPO / path).read_bytes()
    text = raw.decode("utf-8")
    draft = json.loads(validate_draft(text))
    draft["path"] = path
    draft["fileText"] = text
    draft["canonicalEqualsFile"] = draft["canonicalText"] is not None and draft["canonicalText"].encode("utf-8") == raw
    return json.dumps(draft)
