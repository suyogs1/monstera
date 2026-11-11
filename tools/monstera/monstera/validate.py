"""Validation entry point: strict load -> schema -> semantic rules."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import semantic
from .jsonio import LoadError, canonical_bytes, load_path, sha256_hex
from .schema import Issue, SchemaStore


@dataclass(frozen=True)
class Result:
    spec: Any
    issues: tuple[Issue, ...]

    @property
    def ok(self) -> bool:
        return not self.issues

    @property
    def canonical(self) -> bytes:
        return canonical_bytes(self.spec)

    @property
    def sha256(self) -> str:
        return sha256_hex(self.canonical)


def validate_value(value: Any, store: SchemaStore) -> Result:
    issues = store.validate(value)
    if not issues:
        issues = semantic.validate(value, frozenset(store.titles()))
    return Result(value, tuple(issues))


def validate_path(path: Path, store: SchemaStore) -> Result:
    try:
        value = load_path(path)
    except LoadError as exc:
        where = f"line {exc.line}, column {exc.column}" if exc.line else "file"
        return Result(None, (Issue(f"{path.name}:{where}" if exc.line else "$", exc.code, exc.message),))
    return validate_value(value, store)
