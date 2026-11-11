"""Deterministic name derivation shared by validation and code generation."""

from __future__ import annotations

import re

SWIFT_KEYWORDS = frozenset("""
associatedtype class deinit enum extension fileprivate func import init inout internal let open
operator private precedencegroup protocol public rethrows static struct subscript typealias var
break case catch continue default defer do else fallthrough for guard if in repeat return throw
switch where while as false is nil self Self super throws true try Any
""".split())


def _words(value: str) -> list[str]:
    words = [w for w in re.split(r"[^A-Za-z0-9]+", value) if w]
    if not words or not words[0][0].isalpha():
        raise ValueError(f"cannot derive an identifier from {value!r}")
    return words


def product_name(project_id: str) -> str:
    """monstera-sample -> MonsteraSample (iOS product, Swift module and app type prefix)."""
    return "".join(w[:1].upper() + w[1:] for w in _words(project_id))


def kotlin_enum_case(value: str) -> str:
    """arcade-shooter -> ARCADE_SHOOTER"""
    return "_".join(w.upper() for w in _words(value))


def swift_enum_case(value: str) -> str:
    """arcade-shooter -> arcadeShooter (backticked if it is a Swift keyword)"""
    words = _words(value)
    name = words[0].lower() + "".join(w[:1].upper() + w[1:].lower() for w in words[1:])
    return f"`{name}`" if name in SWIFT_KEYWORDS else name
