"""Architecture rule check: no cross-platform app/render frameworks in any build definition.

Scans build and package manifests only (not docs), so the rules can be written down elsewhere
without tripping the check.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {".git", "build", ".gradle", ".kotlin", ".build", ".swiftpm", "xtool", ".bsp", "node_modules",
             ".build-xtool", "__pycache__"}
MANIFEST_NAMES = {"build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
                  "Package.swift", "package.json", "pubspec.yaml", "Podfile", "Cartfile", "app.json",
                  "project.godot", "libs.versions.toml"}
FORBIDDEN_FILES = {
    "pubspec.yaml": "Flutter project file",
    "project.godot": "Godot project file",
    "app.json": "Expo/React Native app config",
}
RULES: list[tuple[str, re.Pattern[str]]] = [
    ("React Native", re.compile(r"react-native|com\.facebook\.react", re.I)),
    ("Expo", re.compile(r"[\"']expo[\"'\-/]|expo-modules", re.I)),
    ("Flutter", re.compile(r"io\.flutter|flutter_?sdk|\bflutter\b", re.I)),
    ("Kotlin Multiplatform", re.compile(r"kotlin\(\"multiplatform\"\)|org\.jetbrains\.kotlin\.multiplatform", re.I)),
    ("Compose Multiplatform", re.compile(r"org\.jetbrains\.compose", re.I)),
    ("Unity", re.compile(r"com\.unity3d|unityLibrary", re.I)),
    ("libGDX", re.compile(r"com\.badlogicgames\.gdx", re.I)),
    ("Cocos", re.compile(r"cocos2d|org\.cocos", re.I)),
]


@dataclass(frozen=True, order=True)
class Violation:
    path: str
    rule: str

    def __str__(self) -> str:
        return f"{self.path}: forbidden {self.rule}"


def check(root: Path) -> list[Violation]:
    found: list[Violation] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name not in MANIFEST_NAMES:
                continue
            path = Path(dirpath, name)
            rel = path.relative_to(root).as_posix()
            if name in FORBIDDEN_FILES:
                found.append(Violation(rel, FORBIDDEN_FILES[name]))
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            found += [Violation(rel, rule) for rule, pattern in RULES if pattern.search(text)]
    return sorted(found)
