"""Kotlin emission: data classes / enum classes from the type model, and the spec constant."""

from __future__ import annotations

from typing import Any

from .naming import kotlin_enum_case
from .typemodel import Enum, ListOf, Named, Record, Scalar, TypeModel, TypeRef

_SCALAR = {"string": "String", "int": "Int", "double": "Double", "bool": "Boolean"}


def _type(t: TypeRef) -> str:
    if isinstance(t, Scalar):
        return _SCALAR[t.name]
    if isinstance(t, ListOf):
        return f"List<{_type(t.item)}>"
    return t.name


def _string(value: str) -> str:
    escaped = (value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
               .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t"))
    return f'"{escaped}"'


def _kdoc(text: str, indent: str) -> list[str]:
    return [f"{indent}/** {text.replace('*/', '* /')} */"] if text else []


def models(model: TypeModel, package: str, header: str) -> str:
    lines = [header, f"package {package}", ""]
    for t in model.types.values():
        if isinstance(t, Record):
            lines += _kdoc(t.description, "")
            lines.append(f"data class {t.name}(")
            for f in t.fields:
                lines += _kdoc(f.description, "    ")
                lines.append(f"    val {f.name}: {_type(f.type)},")
            lines += [")", ""]
        else:
            assert isinstance(t, Enum)
            lines += _kdoc(t.description, "")
            lines.append(f"enum class {t.name}(val value: String) {{")
            cases = [f"    {kotlin_enum_case(v)}({_string(v)})" for v in t.values]
            lines.append(",\n".join(cases) + ";")
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
        return "listOf(" + ", ".join(_value(model, t.item, v, indent) for v in value) + ")"
    assert isinstance(t, Named)
    target = model.types[t.name]
    if isinstance(target, Enum):
        return f"{t.name}.{kotlin_enum_case(value)}"
    inner = "    " * (indent + 1)
    args = [f"{inner}{f.name} = {_value(model, f.type, value[f.name], indent + 1)}," for f in target.fields]
    return f"{t.name}(\n" + "\n".join(args) + f"\n{pad})"


def constant(model: TypeModel, spec: Any, sha256: str, package: str, asset: str, header: str) -> str:
    body = _value(model, Named(model.root), spec, 1)
    return "\n".join([
        header,
        f"package {package}",
        "",
        "/** The canonical specification this app was generated from. */",
        "object GeneratedSpec {",
        "    /** SHA-256 of the canonical monstera.spec.json bundled as an asset. */",
        f"    const val SHA256: String = {_string(sha256)}",
        f"    const val SPEC_ASSET: String = {_string(asset)}",
        "",
        f"    val spec: {model.root} = {body}",
        "}",
        "",
    ])
