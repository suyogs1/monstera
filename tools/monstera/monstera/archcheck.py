"""Architecture rule check.

1. No cross-platform app/render frameworks in any build definition.
2. No web/JS tooling inside native app trees (apps/, generated/, reference/).
3. CI workflows are safe for public build workers: no pull_request_target, explicit permissions,
   actions pinned by SHA, no secrets in pull_request workflows, no Apple SDK transfer.

Scans build/package manifests and workflow files only (not docs), so the rules can be written
down elsewhere without tripping the check.
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


# Native app trees: no web/JS tooling at all (Studio's web stack lives in studio/ only; G1.5).
NATIVE_TREES = ("apps/", "generated/", "reference/")
WEB_FILES = {"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "vite.config.ts",
             "vite.config.js", "next.config.js", "tsconfig.json"}

# CI safety for public build workers (decision 3, G1.5).
_USES = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)", re.M)
_PINNED = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
_TRIGGER_PR = re.compile(r"^\s{2}pull_request\s*:", re.M)
_SECRET = re.compile(r"\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)")
_APPLE_SDK = re.compile(r"xtoolsdk|xtool\s+sdk\s+build|darwin-xtoolsdk", re.I)


def _check_workflow(rel: str, text: str) -> list[Violation]:
    found = []
    if "pull_request_target" in text:
        found.append(Violation(rel, "pull_request_target trigger (runs fork code with secrets)"))
    if not re.search(r"^permissions:", text, re.M):
        found.append(Violation(rel, "workflow without an explicit top-level permissions: block"))
    for ref in _USES.findall(text):
        if not ref.startswith("./") and not _PINNED.match(ref):
            found.append(Violation(rel, f"action not pinned to a commit SHA ({ref})"))
    if _TRIGGER_PR.search(text) and _SECRET.search(text):
        found.append(Violation(rel, "secrets used in a pull_request-triggered workflow"))
    if _APPLE_SDK.search(text):
        found.append(Violation(rel, "Apple SDK generation or transfer in CI"))
    return found


def check(root: Path) -> list[Violation]:
    found: list[Violation] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        base_rel = Path(dirpath).relative_to(root).as_posix()
        in_native = (base_rel + "/").startswith(NATIVE_TREES)
        if in_native and "node_modules" in os.listdir(dirpath):
            found.append(Violation(f"{base_rel}/node_modules", "web/JS dependency inside a native app tree"))
        for name in sorted(filenames):
            path = Path(dirpath, name)
            rel = path.relative_to(root).as_posix()
            if base_rel == ".github/workflows" and name.endswith((".yml", ".yaml")):
                found += _check_workflow(rel, path.read_text(encoding="utf-8", errors="replace"))
                continue
            if in_native and name in WEB_FILES:
                found.append(Violation(rel, "web/JS dependency inside a native app tree"))
                continue
            if name not in MANIFEST_NAMES:
                continue
            if name in FORBIDDEN_FILES:
                found.append(Violation(rel, FORBIDDEN_FILES[name]))
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            found += [Violation(rel, rule) for rule, pattern in RULES if pattern.search(text)]
    return sorted(set(found))
