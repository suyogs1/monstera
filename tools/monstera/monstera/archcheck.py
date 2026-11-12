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
#
# There is no YAML parser in the standard library, so these rules are a fail-closed lint over the
# raw text: they over-approximate (any spelling that COULD mean the dangerous thing is flagged) and
# forbid obfuscation outright (escape sequences, multi-line quoted scalars). They complement, and
# don't replace, GitHub's own protections (fork PRs never receive repository secrets).
_USES = re.compile(r"""["']?\buses\b["']?[ \t]*:[ \t]*["']?([^\s"'#,}\]]+)""", re.I)
_PINNED = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
_PR_TRIGGER = re.compile(r"\bpull_request(?!_target)\b|\bworkflow_run\b", re.I)
_EXPR = re.compile(r"\$\{\{(.*?)\}\}", re.S)
_SECRETS_WORD = re.compile(r"\bsecrets\b", re.I)
_GITHUB_TOKEN = re.compile(r"\bsecrets\s*\.\s*github_token\b", re.I)
_SECRETS_KEY = re.compile(r"""^\s*["']?secrets["']?\s*:""", re.I | re.M)
_ESCAPE = re.compile(r'"(?:[^"\\\n]|\\.)*\\[xuUN0-9]', re.M)
_UNCLOSED_QUOTE = re.compile(r"""^[ \t]*-?[ \t]*["']?[\w-]+["']?[ \t]*:[ \t]*(["'])""", re.M)
_PERMISSIONS = re.compile(r"""^["']?permissions["']?[ \t]*:(.*)$""", re.M)
_APPLE_SDK = re.compile(
    r"xtoolsdk|darwin[.-]artifactbundle|swift-sdks|\.xip\b|Xcode[\w.-]*\.app\b|iPhone(OS|Simulator)\.platform"
    r"|\bxtool\s+(sdk|setup)\b|\bsdk\s+(build|install)\b"
    r"|linux-build\.sh[ \t]+(?![0-9]*[<>|&;])\S"  # passing it an SDK/Xcode argument
    r"|\b(tar|zip|scp|rsync|cp|ditto)\b[^\n]*show-sdk-path", re.I)  # packaging/copying the SDK
# Write scopes allowed per workflow file (none today). Adding one is a reviewed change here.
ALLOWED_WRITE_SCOPES: dict[str, set[str]] = {}


def _unclosed_quoted_scalar(text: str) -> bool:
    for line in text.splitlines():
        m = _UNCLOSED_QUOTE.match(line)
        if not m:
            continue
        quote, rest = m.group(1), line[m.end():]
        if quote == '"':
            closed = re.search(r'(?<!\\)(?:\\\\)*"', rest)
        else:
            closed = re.search(r"'(?!')", rest.replace("''", ""))
        if not closed:
            return True
    return False


def _permission_problems(rel: str, text: str) -> list[str]:
    match = _PERMISSIONS.search(text)
    if not match:
        return ["workflow without an explicit top-level permissions: block"]
    inline = match.group(1).split("#")[0].strip()
    allowed = ALLOWED_WRITE_SCOPES.get(rel.rsplit("/", 1)[-1], set())
    pairs: list[tuple[str, str]] = []
    if inline:
        if inline in ("read-all", "{}"):
            return []
        if inline.startswith("{") and inline.endswith("}"):
            body = inline[1:-1].strip()
            pairs = [tuple(p.strip().strip("'\"") for p in item.split(":", 1)) for item in body.split(",") if ":" in item]
        else:
            return [f"top-level permissions: {inline} (only read-all, {{}} or read/none scopes)"]
    else:
        for line in text[match.end():].splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line[:1].isspace():
                break
            if ":" in line:
                key, value = line.split(":", 1)
                pairs.append((key.strip().strip("'\""), value.split("#")[0].strip().strip("'\"")))
        if not pairs:
            return ["empty top-level permissions: block"]
    return [f"write permission '{key}: {value}' (not allow-listed in archcheck.ALLOWED_WRITE_SCOPES)"
            for key, value in pairs if value not in ("read", "none") and key not in allowed]


def _check_ci_file(rel: str, text: str, is_workflow: bool) -> list[Violation]:
    found = []
    flat = re.sub(r"\\\r?\n\s*", " ", text)  # join shell line continuations
    if _ESCAPE.search(text):
        found.append(Violation(rel, "escape sequence in a double-quoted YAML scalar (can hide keys)"))
    if _unclosed_quoted_scalar(text):
        found.append(Violation(rel, "multi-line quoted YAML scalar (can hide keys; use a block scalar)"))
    if re.search(r"pull_request_target", text, re.I):
        found.append(Violation(rel, "pull_request_target trigger (runs fork code with secrets)"))
    for ref in _USES.findall(text):
        if not ref.startswith("./") and not _PINNED.match(ref):
            found.append(Violation(rel, f"action not pinned to a commit SHA ({ref})"))
    if _APPLE_SDK.search(flat):
        found.append(Violation(rel, "Apple SDK generation or transfer in CI"))
    if is_workflow:
        found += [Violation(rel, p) for p in _permission_problems(rel, text)]
        uses_secrets = bool(_SECRETS_KEY.search(text)) or any(
            _SECRETS_WORD.search(_GITHUB_TOKEN.sub("", expr)) for expr in _EXPR.findall(text))
        if _PR_TRIGGER.search(text) and uses_secrets:
            found.append(Violation(rel, "secrets used in a pull_request/workflow_run-triggered workflow"))
    return found


# The deterministic runtime core (architecture/RUNTIME-CONTRACT.md): platform-free, float-free, clock-free.
_CORE_PATH = re.compile(
    r"^(?:apps|generated|reference)/[^/]+/(?:android/app/src/main/kotlin/(?:[^/]+/)*runtime/(?:[^/]+/)*[^/]+\.kt"
    r"|ios/Runtime/Sources/[^/]+/(?:[^/]+/)*[^/]+\.swift)$")
_COMMENTS = re.compile(r"//[^\n]*|/\*.*?\*/", re.S)
_CORE_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("platform import (android/androidx/Compose/SwiftUI/UIKit/SpriteKit/Foundation/CoreGraphics)",
     re.compile(r"^\s*import\s+(?:android\.|androidx\.|SwiftUI|UIKit|SpriteKit|Foundation|CoreGraphics|Dispatch)", re.M)),
    ("floating point type", re.compile(r"\b(?:Double|Float|CGFloat|Float32|Float64|Float80)\b")),
    ("floating point literal", re.compile(r"(?<![\w.])\d+\.\d+(?:[eE][+-]?\d+)?[fF]?\b")),
    ("floating point conversion or literal", re.compile(r"\.to(?:Double|Float)\s*\(|\b\d+(?:\.\d+)?[fF]\b|\b\d+(?:\.\d+)?[eE][+-]?\d+\b|\.squareRoot\s*\(|\bDouble\s*\(|\bFloat\s*\(")),
    ("hash-order or system random collection helper", re.compile(r"\.shuffled?\s*\(|\.randomElement\s*\(|\bshuffle\s*\(")),
    ("floating point math", re.compile(r"\b(?:kotlin\.math|java\.lang\.Math|StrictMath|sqrt|sin|cos|atan2|pow)\s*\(")),
    ("wall-clock time", re.compile(r"System\.(?:currentTimeMillis|nanoTime)|SystemClock|\bDate\s*\(|ProcessInfo|DispatchTime|\bClock\b|\bInstant\b")),
    ("system randomness", re.compile(r"kotlin\.random|java\.util\.Random|SecureRandom|\bRandom\s*\.|arc4random|SystemRandomNumberGenerator|\.random\s*\(")),
    ("locale", re.compile(r"\bLocale\b")),
    ("logical shift on signed values (use arithmetic shifts only)", re.compile(r"\bushr\b")),
]


def check_runtime_core(rel: str, text: str) -> list[Violation]:
    """Purity rules for one runtime core source (comments ignored)."""
    code = _COMMENTS.sub("", text)
    return [Violation(rel, f"runtime core: {rule}") for rule, pattern in _CORE_RULES if pattern.search(code)]


def check(root: Path) -> list[Violation]:
    found: list[Violation] = []
    for dirpath, dirnames, filenames in os.walk(root):
        base_rel = Path(dirpath).relative_to(root).as_posix()
        in_native = (base_rel + "/").startswith(NATIVE_TREES)
        # Inside native app trees, a directory named build/ or xtool/ can hold compiled sources
        # (e.g. ios/Sources/build/), so only VCS and interpreter caches are skipped there.
        skip = {".git", "__pycache__", "node_modules"} if in_native else SKIP_DIRS
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        if in_native and "node_modules" in os.listdir(dirpath):
            found.append(Violation(f"{base_rel}/node_modules", "web/JS dependency inside a native app tree"))
        for name in sorted(filenames):
            path = Path(dirpath, name)
            rel = path.relative_to(root).as_posix()
            lower = name.lower()
            in_github = base_rel == ".github" or base_rel.startswith(".github/")
            is_workflow = base_rel == ".github/workflows" and lower.endswith((".yml", ".yaml"))
            is_action = lower in ("action.yml", "action.yaml") and (in_github or base_rel == ".")
            if is_workflow or is_action:
                found += _check_ci_file(rel, path.read_text(encoding="utf-8", errors="replace"), is_workflow)
                continue
            if in_native and name in WEB_FILES:
                found.append(Violation(rel, "web/JS dependency inside a native app tree"))
                continue
            if _CORE_PATH.match(rel):
                found += check_runtime_core(rel, path.read_text(encoding="utf-8", errors="replace"))
                continue
            if name not in MANIFEST_NAMES:
                continue
            if name in FORBIDDEN_FILES:
                found.append(Violation(rel, FORBIDDEN_FILES[name]))
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            found += [Violation(rel, rule) for rule, pattern in RULES if pattern.search(text)]
    return sorted(set(found))
