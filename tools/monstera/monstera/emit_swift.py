"""Swift emission: Codable structs / String-backed enums from the type model, and the spec
constant. Property names equal JSON keys, so JSONDecoder reads the canonical file directly."""

from __future__ import annotations

from typing import Any

from .naming import swift_enum_case
from .typemodel import Enum, ListOf, Named, Record, Scalar, TypeModel, TypeRef

_SCALAR = {"string": "String", "int": "Int", "double": "Double", "bool": "Bool"}
_CONFORMANCES = "Codable, Equatable, Sendable"


def _type(t: TypeRef) -> str:
    if isinstance(t, Scalar):
        return _SCALAR[t.name]
    if isinstance(t, ListOf):
        return f"[{_type(t.item)}]"
    return t.name


def _string(value: str) -> str:
    escaped = (value.replace("\\", "\\\\").replace('"', '\\"')
               .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))
    return f'"{escaped}"'


def _doc(text: str, indent: str) -> list[str]:
    return [f"{indent}/// {text}"] if text else []


def models(model: TypeModel, header: str) -> str:
    lines = [header, "import Foundation", ""]
    for t in model.types.values():
        if isinstance(t, Record):
            lines += _doc(t.description, "")
            lines.append(f"struct {t.name}: {_CONFORMANCES} {{")
            for f in t.fields:
                lines += _doc(f.description, "    ")
                lines.append(f"    let {f.name}: {_type(f.type)}")
            lines += ["}", ""]
        else:
            assert isinstance(t, Enum)
            lines += _doc(t.description, "")
            lines.append(f"enum {t.name}: String, {_CONFORMANCES}, CaseIterable {{")
            lines += [f"    case {swift_enum_case(v)} = {_string(v)}" for v in t.values]
            lines += ["}", ""]
    return "\n".join(lines).rstrip("\n") + "\n"


def _value(model: TypeModel, t: TypeRef, value: Any, indent: int) -> str:
    pad = "    " * indent
    if isinstance(t, Scalar):
        if t.name == "string":
            return _string(value)
        if t.name == "double":
            return repr(float(value))
        if t.name == "bool":
            return "true" if value else "false"
        return str(int(value))
    if isinstance(t, ListOf):
        return "[" + ", ".join(_value(model, t.item, v, indent) for v in value) + "]"
    assert isinstance(t, Named)
    target = model.types[t.name]
    if isinstance(target, Enum):
        return f"{t.name}.{swift_enum_case(value)}"
    inner = "    " * (indent + 1)
    # Memberwise initializer: arguments must follow declaration order (schema order).
    args = [f"{inner}{f.name}: {_value(model, f.type, value[f.name], indent + 1)}" for f in target.fields]
    return f"{t.name}(\n" + ",\n".join(args) + f"\n{pad})"


def constant(model: TypeModel, spec: Any, sha256: str, resource: str, header: str) -> str:
    body = _value(model, Named(model.root), spec, 1)
    return "\n".join([
        header,
        "import Foundation",
        "",
        "/// The canonical specification this app was generated from.",
        "enum GeneratedSpec {",
        "    /// SHA-256 of the canonical monstera.spec.json bundled as a package resource.",
        f"    static let sha256 = {_string(sha256)}",
        f"    static let resourceName = {_string(resource)}",
        "",
        f"    static let spec = {body}",
        "}",
        "",
    ])
