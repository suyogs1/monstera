"""Structural checks of the project's Kiro configuration (`monstera gates`, gate "kiro-config").

This catches typos, broken references and rule drift early. It does not replace Kiro's own
loaders: agent loading, live hooks, `validate_workflow` and MCP connection are verified in Kiro
and recorded in docs/KIRO-USAGE.md.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# Kiro's bundled workflow step agents (kiro.dev/docs/workflows/authoring).
BUNDLED_STEP_AGENTS = {"wf-planner", "wf-coder", "wf-design", "wf-design-reviewer", "wf-code-reviewer",
                       "wf-review-aggregator", "wf-pr-submitter", "wf-pr-responder", "wf-auto-researcher",
                       "semantic_reviewer"}
HOOK_TRIGGERS = {"PreToolUse", "PostToolUse", "SessionStart", "Stop", "UserPromptSubmit", "PreTaskExec",
                 "PostTaskExec", "PreCompact", "PostCompact", "PostFileCreate", "PostFileSave", "PostFileDelete"}
NODE_FIELDS = {"step": ["id", "agent", "prompt"], "sequence": ["id", "steps"],
               "repeat": ["id", "steps", "maxIterations", "onMaxIterations"],
               "parallel": ["id", "branches", "joinPolicy"], "watch": ["id", "handler", "config"]}
REQUIRED_PROMPTS = {"architecture-review", "native-implementation", "debugging", "conformance-review",
                    "security-dependency-review"}


def _load(path: Path, problems: list[str]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"{path.as_posix()}: not valid JSON ({exc})")
        return None


def _lint_workflow(rel: str, recipe: dict[str, Any], agents: set[str], problems: list[str]) -> None:
    inputs = recipe.get("inputs", {})
    ids: list[str] = []
    steps = 0

    def walk(nodes: list[Any], depth: int, in_parallel: bool) -> None:
        nonlocal steps
        if depth > 8:
            problems.append(f"{rel}: nesting deeper than 8")
        for index, node in enumerate(nodes):
            kind = node.get("type")
            if kind not in NODE_FIELDS:
                problems.append(f"{rel}: unknown node type {kind!r}")
                continue
            ids.append(node.get("id", "?"))
            for key in NODE_FIELDS[kind]:
                if key not in node:
                    problems.append(f"{rel}: {node.get('id', '?')} missing '{key}'")
            if kind == "step":
                steps += 1
                if node.get("agent") not in agents:
                    problems.append(f"{rel}: {node['id']} uses unknown agent {node.get('agent')!r}")
                prompt = node.get("prompt", "")
                if "{{previous.output}}" in prompt and (index == 0 or in_parallel):
                    problems.append(f"{rel}: {node['id']} uses previous.output where it is not allowed")
                for name in re.findall(r"\{\{([A-Za-z_][\w-]*)\}\}", prompt):
                    if name not in inputs:
                        problems.append(f"{rel}: {node['id']} uses undeclared input {{{{{name}}}}}")
            if kind == "watch" and "{{" in str(node.get("config", {}).get("command", "")):
                problems.append(f"{rel}: {node['id']} has a template in its command")
            if kind == "repeat":
                if not isinstance(node.get("maxIterations"), int) or node["maxIterations"] < 1:
                    problems.append(f"{rel}: {node['id']} needs a finite maxIterations")
                walk(node.get("steps", []), depth + 1, False)
            elif kind == "sequence":
                walk(node.get("steps", []), depth + 1, False)
            elif kind == "parallel":
                walk(node.get("branches", []), depth + 1, True)

    if not recipe.get("name") or not isinstance(recipe.get("steps"), list):
        problems.append(f"{rel}: needs 'name' and 'steps'")
        return
    if recipe["name"] != Path(rel).name.removesuffix(".workflow.json"):
        problems.append(f"{rel}: name {recipe['name']!r} differs from the file name")
    walk(recipe["steps"], 1, False)
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        problems.append(f"{rel}: duplicate node ids {dupes}")
    if steps > 50:
        problems.append(f"{rel}: more than 50 steps")


def check(root: Path) -> list[str]:
    problems: list[str] = []
    kiro = root / ".kiro"

    gitignore = root / ".gitignore"
    if gitignore.exists():
        for line in gitignore.read_text(encoding="utf-8").splitlines():
            entry = line.strip()
            if entry and not entry.startswith(("#", "!")) and entry.lstrip("/").startswith(".kiro"):
                problems.append(f".gitignore ignores '{entry}': .kiro must stay committed (Kiroween rule)")

    agents: set[str] = set()
    for path in sorted((kiro / "agents").glob("*.json")):
        data = _load(path, problems)
        if not isinstance(data, dict):
            continue
        rel = path.relative_to(root).as_posix()
        if data.get("name") != path.stem:
            problems.append(f"{rel}: name {data.get('name')!r} differs from the file name")
        for key in ("description", "prompt"):
            if not isinstance(data.get(key), str) or not data[key]:
                problems.append(f"{rel}: missing '{key}'")
        if not isinstance(data.get("tools"), list) or not data["tools"]:
            problems.append(f"{rel}: 'tools' must be a non-empty list")
        for res in data.get("resources", []):
            if isinstance(res, str) and res.startswith("file://") and "*" not in res:
                if not (root / res.removeprefix("file://")).exists():
                    problems.append(f"{rel}: resource {res} does not exist")
        agents.add(path.stem)

    for path in sorted((kiro / "hooks").glob("*.json")):
        data = _load(path, problems)
        rel = path.relative_to(root).as_posix()
        if not isinstance(data, dict) or not isinstance(data.get("hooks"), list):
            problems.append(f"{rel}: needs a 'hooks' list")
            continue
        for hook in data["hooks"]:
            if hook.get("trigger") not in HOOK_TRIGGERS:
                problems.append(f"{rel}: unknown trigger {hook.get('trigger')!r}")
            action = hook.get("action", {})
            if action.get("type") not in ("command", "agent") or not (action.get("command") or action.get("prompt")):
                problems.append(f"{rel}: action needs type command|agent and a command or prompt")
            if hook.get("matcher"):
                try:
                    re.compile(hook["matcher"])
                except re.error as exc:
                    problems.append(f"{rel}: matcher does not compile: {exc}")

    mcp = kiro / "settings" / "mcp.json"
    if mcp.exists():
        data = _load(mcp, problems)
        servers = data.get("mcpServers") if isinstance(data, dict) else None
        if not isinstance(servers, dict) or not servers:
            problems.append(".kiro/settings/mcp.json: needs a non-empty 'mcpServers' object")
        else:
            for name, server in servers.items():
                if not isinstance(server, dict) or not server.get("command"):
                    problems.append(f".kiro/settings/mcp.json: server {name!r} needs a 'command'")

    for path in sorted((kiro / "workflows").glob("*.workflow.json")):
        data = _load(path, problems)
        if isinstance(data, dict):
            _lint_workflow(path.relative_to(root).as_posix(), data, BUNDLED_STEP_AGENTS | agents, problems)

    prompts = {p.stem for p in (kiro / "prompts").glob("*.md")}
    missing = sorted(REQUIRED_PROMPTS - prompts)
    if (kiro / "prompts").exists() and missing:
        problems.append(f".kiro/prompts: missing {missing}")
    return problems
