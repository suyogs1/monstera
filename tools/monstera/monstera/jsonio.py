"""Strict JSON loading and canonical serialization.

Canonical form: UTF-8, keys sorted, 2-space indent, ", " / ": " separators, LF, one trailing
newline, no NaN/Infinity. The SHA-256 of these bytes identifies a specification.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class LoadError(Exception):
    code: str
    message: str
    line: int = 0
    column: int = 0

    def __str__(self) -> str:
        where = f" (line {self.line}, column {self.column})" if self.line else ""
        return f"[{self.code}] {self.message}{where}"


class _DuplicateKey(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _reject_constant(name: str) -> Any:
    raise ValueError(f"non-finite number {name} is not allowed")


def _line_col(text: str, offset: int) -> tuple[int, int]:
    line = text.count("\n", 0, offset) + 1
    col = offset - (text.rfind("\n", 0, offset) + 1) + 1
    return line, col


def loads_strict(text: str) -> Any:
    """Parse JSON, rejecting duplicate keys and NaN/Infinity, with line/column on errors."""
    if text.startswith("\ufeff"):
        raise LoadError("json.bom", "file starts with a UTF-8 byte order mark; save without BOM", 1, 1)
    try:
        return json.loads(text, object_pairs_hook=_no_duplicates, parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise LoadError("json.parse", exc.msg, exc.lineno, exc.colno) from None
    except _DuplicateKey as exc:
        # Report the second occurrence of the key: that's the one to remove.
        hits = [m.start() for m in re.finditer(r'"' + re.escape(exc.key) + r'"\s*:', text)]
        line, col = _line_col(text, hits[1]) if len(hits) > 1 else (0, 0)
        raise LoadError("json.duplicate-key", f"duplicate key '{exc.key}'", line, col) from None
    except ValueError as exc:
        raise LoadError("json.non-finite", str(exc)) from None


def load_path(path: Path) -> Any:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise LoadError("io.read", f"cannot read {path}: {exc.strerror}") from None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LoadError("json.encoding", f"file is not valid UTF-8 (byte {exc.start})") from None
    return loads_strict(text)


def canonical_text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def canonical_bytes(value: Any) -> bytes:
    return canonical_text(value).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
