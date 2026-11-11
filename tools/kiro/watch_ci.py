#!/usr/bin/env python3
"""Kiro workflow `command` watch handler: wait for GitHub Actions runs on the current HEAD.

Protocol (kiro.dev/docs/workflows/authoring, "command" handler): one JSON object on stdin
({cursor, config, workspacePath, ...}); exactly one JSON object on stdout:
  {"outcome": "idle" | "new-activity" | "terminal-state", "cursor": ..., "payload": "<json string>"}
Diagnostics go to stderr only. Exit 0 with a result; exit 2 for invalid input/config.

Terminal when at least one run exists for HEAD and every run for HEAD has completed. The payload
lists each run (workflow, conclusion, url) and an overall verdict (success only if all succeeded).
Standard library only; needs the `gh` CLI, authenticated.
"""

from __future__ import annotations

import json
import subprocess
import sys


def _git_head(cwd: str) -> str:
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=cwd, capture_output=True, text=True,
                          check=True).stdout.strip()


def _runs(cwd: str, sha: str) -> list[dict]:
    proc = subprocess.run(
        ["gh", "run", "list", "--commit", sha, "--limit", "50",
         "--json", "databaseId,workflowName,event,status,conclusion,url"],
        cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "gh run list failed")
    return json.loads(proc.stdout or "[]")


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print("watch-ci: stdin is not JSON", file=sys.stderr)
        return 2
    cwd = request.get("workspacePath") or "."
    cursor = request.get("cursor")
    try:
        sha = _git_head(cwd)
        runs = _runs(cwd, sha)
    except (OSError, subprocess.CalledProcessError, RuntimeError, ValueError) as exc:
        print(f"watch-ci: {exc}", file=sys.stderr)
        print(json.dumps({"outcome": "idle", "cursor": cursor}))  # transient: poll again
        return 0
    pending = [r for r in runs if r.get("status") != "completed"]
    if not runs or pending:
        print(json.dumps({"outcome": "idle", "cursor": {"sha": sha, "pending": len(pending), "runs": len(runs)}}))
        return 0
    verdict = "success" if all(r.get("conclusion") == "success" for r in runs) else "failure"
    payload = {"sha": sha, "verdict": verdict,
               "runs": [{"workflow": r["workflowName"], "event": r["event"], "conclusion": r["conclusion"],
                         "id": r["databaseId"], "url": r["url"]} for r in runs]}
    print(json.dumps({"outcome": "terminal-state", "cursor": {"sha": sha, "done": True},
                      "payload": json.dumps(payload), "targetId": sha}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
