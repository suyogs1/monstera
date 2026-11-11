"""Deterministic validator for the JSON Schema 2020-12 keyword subset used by MONSTERA.

Supported keywords are listed in SUPPORTED_KEYWORDS. A schema that uses any other keyword is
rejected at load time, so validation can never silently ignore a rule.

Differences from full JSON Schema, chosen for a strict canonical format:
- "integer" requires a JSON integer token (1.0 is rejected); booleans are never numbers.
- "pattern" uses Python `re` syntax. A trailing `$` anchors at the true end of the string.
- "$ref" resolves to a schema file in the same directory, optionally with "#/$defs/<name>".
"""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .jsonio import load_path, sha256_hex

SUPPORTED_KEYWORDS = frozenset({
    "$schema", "$defs", "$ref", "title", "description",
    "type", "properties", "required", "additionalProperties",
    "enum", "const", "pattern", "minLength", "maxLength",
    "minimum", "maximum", "exclusiveMinimum",
    "items", "minItems", "uniqueItems",
})
ROOT_SCHEMA = "monstera.spec.schema.json"

_TYPE_NAME = re.compile(r"[A-Z][A-Za-z0-9]*")
_FIELD_NAME = re.compile(r"[a-z][A-Za-z0-9]*")
# Names a schema title may not take: platform built-ins and the generator's own helper types.
RESERVED_TYPE_NAMES = frozenset({
    "Any", "AnyObject", "App", "Array", "Bool", "Boolean", "Bundle", "Char", "Character", "Codable",
    "Color", "ContentView", "Data", "Date", "Dictionary", "Double", "Equatable", "Error", "Float",
    "GeneratedSpec", "Int", "List", "Logger", "Long", "MainActivity", "Map", "Never", "Nothing",
    "Object", "Optional", "Package", "Protocol", "Result", "Scene", "Self", "Sendable", "Set",
    "SpecIntegrity", "SpecScene", "SpecScreen", "String", "Target", "Type", "Unit", "View", "Void",
})
# Kotlin hard keywords plus Swift keywords: illegal (or needing escapes) as property names.
FIELD_KEYWORDS = frozenset("""
as break class continue do else false for fun if in interface is null object package return super
this throw true try typealias typeof val var when while associatedtype deinit enum extension
fileprivate func import init inout internal let open operator private precedencegroup protocol
public rethrows static struct subscript case catch default defer fallthrough guard nil repeat
switch where throws self
""".split())


@dataclass(frozen=True, order=True)
class Issue:
    path: str
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.path} [{self.code}]: {self.message}"


class SchemaError(Exception):
    """The schema files themselves are invalid (a generator bug, not a user error)."""


def describe(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean " + ("true" if value else "false")
    if isinstance(value, int):
        return f"integer {value}"
    if isinstance(value, float):
        return f"number {json.dumps(value)}"
    if isinstance(value, str):
        # ASCII-escaped so messages are identical on every OS and console encoding.
        return f"string {json.dumps(value)}"
    if isinstance(value, list):
        return "array"
    return "object"


def _anchored(pattern: str) -> re.Pattern[str]:
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


def _suggest(word: str, options: list[str]) -> str:
    match = difflib.get_close_matches(word, options, n=1, cutoff=0.6)
    return f" (did you mean '{match[0]}'?)" if match else ""


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


@dataclass
class SchemaStore:
    directory: Path
    documents: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, directory: Path) -> "SchemaStore":
        store = cls(directory)
        for path in sorted(directory.glob("*.schema.json")):
            try:
                doc = load_path(path)
            except Exception as exc:  # LoadError: report as a schema problem
                raise SchemaError(f"{path.name}: {exc}") from None
            store._check_keywords(doc, path.name, "#")
            store.documents[path.name] = doc
        if ROOT_SCHEMA not in store.documents:
            raise SchemaError(f"{ROOT_SCHEMA} not found in {directory}")
        store._check_refs()
        return store

    def digests(self) -> dict[str, str]:
        return {name: sha256_hex((self.directory / name).read_bytes()) for name in sorted(self.documents)}

    def _check_keywords(self, node: Any, doc: str, where: str) -> None:
        """Structural meta-validation. Every rule here exists because violating it would make
        validation lie or the generated Kotlin/Swift wrong. See architecture/SPECIFICATION-ENGINE.md."""
        def fail(msg: str) -> None:
            raise SchemaError(f"{doc}{where}: {msg}")

        if not isinstance(node, dict):
            fail("schema node must be an object")
        unknown = sorted(set(node) - SUPPORTED_KEYWORDS)
        if unknown:
            fail(f"unsupported keyword(s) {unknown}")
        if "$ref" in node:
            if not isinstance(node["$ref"], str) or set(node) - {"$ref", "description"}:
                fail("$ref must be a string and may only be combined with 'description'")
            return
        kind = node.get("type")
        if kind not in _TYPE_CHECKS:
            fail(f"'type' must be one of {sorted(_TYPE_CHECKS)}, got {kind!r}")
        for key in ("title", "description", "pattern", "$schema"):
            if key in node and not isinstance(node[key], str):
                fail(f"'{key}' must be a string")
        if "title" in node and not _TYPE_NAME.fullmatch(node["title"]):
            fail(f"title {node['title']!r} must be PascalCase ASCII")
        if node.get("title") in RESERVED_TYPE_NAMES:
            fail(f"title {node['title']!r} collides with a Kotlin/Swift built-in or generated helper type")
        if "pattern" in node:
            try:
                _anchored(node["pattern"])
            except re.error as exc:
                fail(f"pattern does not compile: {exc}")
        for key in ("minLength", "maxLength", "minItems"):
            if key in node and not (_TYPE_CHECKS["integer"](node[key]) and node[key] >= 0):
                fail(f"'{key}' must be a non-negative integer")
        for key in ("minimum", "maximum", "exclusiveMinimum"):
            if key in node and not _TYPE_CHECKS["number"](node[key]):
                fail(f"'{key}' must be a number")
        if "uniqueItems" in node and not isinstance(node["uniqueItems"], bool):
            fail("'uniqueItems' must be a boolean")
        if "enum" in node:
            values = node["enum"]
            if not isinstance(values, list) or not values:
                fail("'enum' must be a non-empty array")
            if len({json.dumps(v) for v in values}) != len(values):
                fail("'enum' values must be unique")
            if not all(_TYPE_CHECKS[kind](v) for v in values):
                fail(f"every 'enum' value must be of type {kind}")
        if kind == "object":
            props = node.get("properties")
            if not isinstance(props, dict) or not props:
                fail("object schemas need a non-empty 'properties' object")
            if node.get("additionalProperties") is not False:
                # Extra data would be hashed into the canonical spec but dropped by the models.
                fail("object schemas must set \"additionalProperties\": false")
            required = node.get("required")
            if not isinstance(required, list) or not all(isinstance(r, str) for r in required):
                fail("'required' must be an array of strings")
            if len(set(required)) != len(required) or set(required) != set(props):
                fail("'required' must list every property exactly once (no optional properties in G1)")
            for name, sub in props.items():
                if not _FIELD_NAME.fullmatch(name) or name in FIELD_KEYWORDS:
                    fail(f"property name {name!r} must be lowerCamelCase and not a Kotlin/Swift keyword")
                self._check_keywords(sub, doc, f"{where}/properties/{name}")
        elif "properties" in node or "required" in node or "additionalProperties" in node:
            fail("'properties', 'required' and 'additionalProperties' apply to objects only")
        if kind == "array":
            if not isinstance(node.get("items"), dict):
                fail("array schemas need an 'items' schema")
            self._check_keywords(node["items"], doc, f"{where}/items")
        elif "items" in node:
            fail("'items' applies to arrays only")
        for name, sub in node.get("$defs", {}).items():
            self._check_keywords(sub, doc, f"{where}/$defs/{name}")

    def _check_refs(self) -> None:
        def walk(node: Any, doc: str) -> None:
            if not isinstance(node, dict):
                return
            if "$ref" in node:
                self.resolve(node["$ref"], doc)
            for sub in node.get("properties", {}).values():
                walk(sub, doc)
            for sub in node.get("$defs", {}).values():
                walk(sub, doc)
            if "items" in node:
                walk(node["items"], doc)
        for doc, root in self.documents.items():
            walk(root, doc)

    def titles(self) -> set[str]:
        found: set[str] = set()
        def walk(node: Any) -> None:
            if isinstance(node, dict):
                if isinstance(node.get("title"), str):
                    found.add(node["title"])
                for sub in [*node.get("properties", {}).values(), *node.get("$defs", {}).values()]:
                    walk(sub)
                if "items" in node:
                    walk(node["items"])
        for root in self.documents.values():
            walk(root)
        return found

    def resolve(self, ref: str, base: str) -> tuple[str, dict[str, Any]]:
        file_part, _, pointer = ref.partition("#")
        doc_name = file_part or base
        if doc_name not in self.documents:
            raise SchemaError(f"unresolvable $ref '{ref}' from {base}")
        node: Any = self.documents[doc_name]
        for token in [t for t in pointer.split("/") if t]:
            if not isinstance(node, dict) or token not in node:
                raise SchemaError(f"unresolvable $ref '{ref}' from {base}")
            node = node[token]
        return doc_name, node

    # ---------------------------------------------------------------- validation

    def validate(self, instance: Any) -> list[Issue]:
        issues: list[Issue] = []
        self._validate(self.documents[ROOT_SCHEMA], instance, "$", ROOT_SCHEMA, issues)
        return sorted(set(issues))

    def _validate(self, node: dict[str, Any], value: Any, path: str, base: str, out: list[Issue]) -> None:
        if "$ref" in node:
            base, node = self.resolve(node["$ref"], base)

        expected = node.get("type")
        if expected is not None and not _TYPE_CHECKS[expected](value):
            hint = ""
            if expected == "integer" and isinstance(value, str) and value.lstrip("-").isdigit():
                hint = f"; remove the quotes: {value}"
            elif expected == "integer" and isinstance(value, float) and value.is_integer():
                hint = f"; write {int(value)} without a decimal point"
            out.append(Issue(path, "type", f"expected {expected}, got {describe(value)}{hint}"))
            return

        if "const" in node and value != node["const"]:
            out.append(Issue(path, "const", f"must be {json.dumps(node['const'])}, got {describe(value)}"))
        if "enum" in node and value not in node["enum"]:
            allowed = ", ".join(json.dumps(v) for v in node["enum"])
            hint = _suggest(value, [v for v in node["enum"] if isinstance(v, str)]) if isinstance(value, str) else ""
            out.append(Issue(path, "enum", f"{describe(value)} is not allowed; expected one of: {allowed}{hint}"))

        if isinstance(value, str):
            self._validate_string(node, value, path, out)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            self._validate_number(node, value, path, out)
        elif isinstance(value, list):
            self._validate_array(node, value, path, base, out)
        elif isinstance(value, dict):
            self._validate_object(node, value, path, base, out)

    @staticmethod
    def _validate_string(node: dict[str, Any], value: str, path: str, out: list[Issue]) -> None:
        if "minLength" in node and len(value) < node["minLength"]:
            out.append(Issue(path, "minLength", f"length {len(value)} is below the minimum {node['minLength']}"))
        if "maxLength" in node and len(value) > node["maxLength"]:
            out.append(Issue(path, "maxLength", f"length {len(value)} exceeds the maximum {node['maxLength']}"))
        if "pattern" in node and not _anchored(node["pattern"]).search(value):
            hint = f" ({node['description']})" if "description" in node else ""
            out.append(Issue(path, "pattern", f"{describe(value)} does not match {node['pattern']}{hint}"))

    @staticmethod
    def _validate_number(node: dict[str, Any], value: float, path: str, out: list[Issue]) -> None:
        if "minimum" in node and value < node["minimum"]:
            out.append(Issue(path, "minimum", f"{json.dumps(value)} is below the minimum {node['minimum']}"))
        if "maximum" in node and value > node["maximum"]:
            out.append(Issue(path, "maximum", f"{json.dumps(value)} exceeds the maximum {node['maximum']}"))
        if "exclusiveMinimum" in node and value <= node["exclusiveMinimum"]:
            out.append(Issue(path, "exclusiveMinimum", f"{json.dumps(value)} must be greater than {node['exclusiveMinimum']}"))

    def _validate_array(self, node: dict[str, Any], value: list[Any], path: str, base: str, out: list[Issue]) -> None:
        if "minItems" in node and len(value) < node["minItems"]:
            out.append(Issue(path, "minItems", f"needs at least {node['minItems']} item(s), got {len(value)}"))
        if node.get("uniqueItems"):
            seen: list[str] = []
            for index, item in enumerate(value):
                key = json.dumps(item, sort_keys=True)
                if key in seen:
                    out.append(Issue(f"{path}[{index}]", "uniqueItems", f"duplicate item {describe(item)}"))
                seen.append(key)
        if "items" in node:
            for index, item in enumerate(value):
                self._validate(node["items"], item, f"{path}[{index}]", base, out)

    def _validate_object(self, node: dict[str, Any], value: dict[str, Any], path: str, base: str, out: list[Issue]) -> None:
        props: dict[str, Any] = node.get("properties", {})
        for name in node.get("required", []):
            if name not in value:
                out.append(Issue(path, "required", f"missing required property '{name}'"))
        if node.get("additionalProperties") is False:
            for name in sorted(value):
                if name not in props:
                    out.append(Issue(path, "additionalProperties",
                                     f"unknown property {json.dumps(name)}{_suggest(name, list(props))}"))
        for name, sub in props.items():
            if name in value:
                self._validate(sub, value[name], f"{path}.{name}", base, out)
