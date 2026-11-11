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


def validate(spec: dict[str, Any]) -> list[Issue]:
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

    palette = game["palette"]
    for role in ("primary", "accent"):
        ratio = contrast_ratio(palette[role], palette["background"])
        if ratio < MIN_CONTRAST:
            issues.append(Issue(f"$.game.palette.{role}", "semantic.palette-contrast",
                                f"contrast {ratio:.2f}:1 against background {palette['background']} is below "
                                f"{MIN_CONTRAST:.1f}:1; choose a lighter or darker color"))
    return sorted(issues)
