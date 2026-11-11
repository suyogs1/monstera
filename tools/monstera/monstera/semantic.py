"""Semantic rules that JSON Schema can't express. Only run after schema validation passes,
so every value here has the type and shape the schema guarantees."""

from __future__ import annotations

from typing import Any

from .naming import product_name
from .schema import Issue

# Java/Kotlin keywords that are illegal as package segments (applicationId -> Kotlin package).
_PACKAGE_KEYWORDS = frozenset("""
abstract as assert boolean break byte case catch char class const continue default do double
else enum extends false final finally float for fun goto if implements import in instanceof int
interface is long native new null object package private protected public return short static
strictfp super switch synchronized this throw throws transient true try typealias typeof val var
void volatile when while
""".split())
# Module names an iOS product must not shadow.
_RESERVED_MODULES = frozenset({
    "Foundation", "SwiftUI", "SpriteKit", "UIKit", "CryptoKit", "Swift", "Combine", "os",
    "GameplayKit", "CoreGraphics", "Dispatch",
})
MAX_ASPECT = 3.0
MIN_CONTRAST = 3.0  # WCAG 2.x non-text contrast threshold


def _luminance(hex_color: str) -> float:
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast_ratio(a: str, b: str) -> float:
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


MAX_WORLD_UNITS = 32767
RAW_MAX = (1 << 31) - 1
MAX_SPAWN_SPAN = 1 << 31  # nextBelow takes a uint32 bound: span + 1 must stay below 2^32


def _runtime_issues(game: dict[str, Any]) -> list[Issue]:
    """Rules the runtime contract (architecture/RUNTIME-CONTRACT.md) depends on."""
    out: list[Issue] = []
    rt, world = game["runtime"], game["world"]

    def bad(path: str, code: str, msg: str) -> None:
        out.append(Issue(path, f"semantic.{code}", msg))

    dims = {}
    for axis in ("width", "height"):
        value = world[axis]
        if value != int(value) or value > MAX_WORLD_UNITS:
            bad(f"$.game.world.{axis}", "world-units",
                f"the runtime needs whole units no larger than {MAX_WORLD_UNITS}, got {value}")
        else:
            dims[axis] = int(value) << 16
    kinds: dict[str, dict[str, Any]] = {}
    for i, kind in enumerate(rt["kinds"]):
        path = f"$.game.runtime.kinds[{i}]"
        if kind["id"] in kinds:
            bad(f"{path}.id", "duplicate-kind", f"kind id '{kind['id']}' is used twice")
        kinds[kind["id"]] = kind
        if "width" in dims and kind["width"] > dims["width"]:
            bad(f"{path}.width", "kind-size", "kind is wider than the world")
        if "height" in dims and kind["height"] > dims["height"]:
            bad(f"{path}.height", "kind-size", "kind is taller than the world")

    def ref(path: str, name: str) -> None:
        if name not in kinds:
            bad(path, "unknown-kind", f"'{name}' is not a kind id; defined: {', '.join(sorted(kinds)) or 'none'}")

    tap = game["input"]["tapKind"]
    if tap:
        ref("$.game.input.tapKind", tap)
    if len(rt["initialEntities"]) > rt["maxEntities"]:
        bad("$.game.runtime.initialEntities", "entity-cap",
            f"{len(rt['initialEntities'])} initial entities exceed maxEntities {rt['maxEntities']}")
    for i, e in enumerate(rt["initialEntities"]):
        ref(f"$.game.runtime.initialEntities[{i}].kind", e["kind"])
    for i, s in enumerate(rt["spawners"]):
        path = f"$.game.runtime.spawners[{i}]"
        ref(f"{path}.kind", s["kind"])
        for lo, hi in (("xMin", "xMax"), ("yMin", "yMax")):
            if s[lo] > s[hi]:
                bad(f"{path}.{lo}", "spawn-range", f"{lo} {s[lo]} is greater than {hi} {s[hi]}")
            elif s[hi] - s[lo] + 1 > MAX_SPAWN_SPAN:
                bad(f"{path}.{hi}", "spawn-range", f"{lo}..{hi} spans more than 2^31 raw units")
    for i, c in enumerate(rt["collisions"]):
        ref(f"$.game.runtime.collisions[{i}].a", c["a"])
        ref(f"$.game.runtime.collisions[{i}].b", c["b"])
    return out


def validate(spec: dict[str, Any], type_names: frozenset[str] = frozenset()) -> list[Issue]:
    issues: list[Issue] = []
    project, game = spec["project"], spec["game"]

    for segment in project["identifier"].split("."):
        if segment in _PACKAGE_KEYWORDS:
            issues.append(Issue("$.project.identifier", "semantic.identifier-keyword",
                                f"segment '{segment}' is a Java/Kotlin keyword and can't be a package name"))

    product = product_name(project["id"])
    if product in _RESERVED_MODULES:
        issues.append(Issue("$.project.id", "semantic.product-name",
                            f"derived iOS product name '{product}' shadows a system module; choose another id"))
    elif product in type_names or f"{product}App" in type_names:
        issues.append(Issue("$.project.id", "semantic.product-name",
                            f"derived iOS product name '{product}' collides with a generated model type; "
                            "choose another id"))

    width, height = game["world"]["width"], game["world"]["height"]
    if game["orientation"] == "portrait" and width > height:
        issues.append(Issue("$.game.world", "semantic.orientation-aspect",
                            f"world is {width}x{height} (landscape) but orientation is 'portrait'; "
                            "swap width and height or set orientation to 'landscape'"))
    if game["orientation"] == "landscape" and height > width:
        issues.append(Issue("$.game.world", "semantic.orientation-aspect",
                            f"world is {width}x{height} (portrait) but orientation is 'landscape'; "
                            "swap width and height or set orientation to 'portrait'"))
    aspect = max(width, height) / min(width, height)
    if aspect > MAX_ASPECT:
        issues.append(Issue("$.game.world", "semantic.world-aspect",
                            f"aspect ratio {aspect:.2f}:1 exceeds {MAX_ASPECT:.0f}:1"))

    issues += _runtime_issues(game)
    palette = game["palette"]
    for role in ("primary", "accent"):
        ratio = contrast_ratio(palette[role], palette["background"])
        if ratio < MIN_CONTRAST:
            issues.append(Issue(f"$.game.palette.{role}", "semantic.palette-contrast",
                                f"contrast {ratio:.2f}:1 against background {palette['background']} is below "
                                f"{MIN_CONTRAST:.1f}:1; choose a lighter or darker color"))
    return sorted(issues)
