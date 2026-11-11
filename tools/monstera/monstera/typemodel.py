"""Platform-neutral type model derived from the schema files.

Rules:
- An object schema with a "title" becomes a record type named by the title.
- A string schema with "enum" and a "title" becomes an enum type.
- Other strings (patterns, untitled enums) map to String; integer -> Int; number -> Double;
  boolean -> Bool; array -> list of its item type.
- Field and type order follows schema declaration order, so output is deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union

from .schema import ROOT_SCHEMA, SchemaError, SchemaStore


@dataclass(frozen=True)
class Scalar:
    name: str  # "string" | "int" | "double" | "bool"


@dataclass(frozen=True)
class ListOf:
    item: "TypeRef"


@dataclass(frozen=True)
class Named:
    name: str


TypeRef = Union[Scalar, ListOf, Named]


@dataclass(frozen=True)
class Field:
    name: str
    type: TypeRef
    description: str


@dataclass
class Record:
    name: str
    description: str
    fields: list[Field] = field(default_factory=list)


@dataclass
class Enum:
    name: str
    description: str
    values: list[str]


@dataclass
class TypeModel:
    root: str
    types: dict[str, Union[Record, Enum]]  # insertion order = declaration order


_SCALARS = {"string": "string", "integer": "int", "number": "double", "boolean": "bool"}


def build(store: SchemaStore) -> TypeModel:
    types: dict[str, Union[Record, Enum]] = {}
    origins: dict[str, int] = {}

    def register(name: str, node: dict[str, Any], kind: Union[Record, Enum]) -> bool:
        if name in types:
            if origins[name] != id(node):
                raise SchemaError(f"type name '{name}' is used by two different schemas")
            return False
        types[name] = kind
        origins[name] = id(node)
        return True

    def ref(node: dict[str, Any], base: str) -> TypeRef:
        if "$ref" in node:
            base, node = store.resolve(node["$ref"], base)
        kind = node.get("type")
        if kind == "object":
            title = node.get("title")
            if not title:
                raise SchemaError("object schemas must have a 'title' to name their type")
            record = Record(title, node.get("description", ""))
            if register(title, node, record):
                required = set(node.get("required", []))
                for fname, sub in node.get("properties", {}).items():
                    if fname not in required:
                        raise SchemaError(f"{title}.{fname}: optional properties are not supported in G1")
                    record.fields.append(Field(fname, ref(sub, base), sub.get("description", "")))
            return Named(title)
        if kind == "array":
            return ListOf(ref(node["items"], base))
        if kind == "string" and "enum" in node and "title" in node:
            register(node["title"], node, Enum(node["title"], node.get("description", ""), list(node["enum"])))
            return Named(node["title"])
        if kind in _SCALARS:
            return Scalar(_SCALARS[kind])
        raise SchemaError(f"cannot map schema type {kind!r} to a model type")

    root = ref(store.documents[ROOT_SCHEMA], ROOT_SCHEMA)
    assert isinstance(root, Named)
    return TypeModel(root.name, types)
