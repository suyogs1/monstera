#!/usr/bin/env bash
# Shared helpers for Device Lab adapters. Sourced, not executed.
# Contract: device-lab/contract/README.md

# Git Bash on Windows rewrites POSIX-looking args (e.g. /sdcard/x) into Windows paths when
# calling native tools like adb.exe. Disable that; it is a no-op on Linux/macOS.
export MSYS_NO_PATHCONV=1

DL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# On Git Bash, use C:/... form so native tools receive valid paths with conversion disabled.
command -v cygpath >/dev/null 2>&1 && DL_ROOT="$(cygpath -m "$DL_ROOT")"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

dl_init() { # $1 = target
  DL_TARGET="$1"
  DL_OUT="$DL_ROOT/device-lab/reports/runs/$RUN_ID/$DL_TARGET"
  mkdir -p "$DL_OUT"
}

# dl_result <op> <status> [artifact] [detail]
# Prints one contract line to stdout and appends it to the run's results.jsonl.
dl_result() {
  local op="$1" status="$2" artifact="${3:-}" detail="${4:-}"
  local ts line
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  detail="${detail//\\/\\\\}"; detail="${detail//\"/\\\"}"
  line="{\"op\":\"$op\",\"target\":\"$DL_TARGET\",\"status\":\"$status\",\"run_id\":\"$RUN_ID\",\"timestamp\":\"$ts\""
  [ -n "$artifact" ] && line="$line,\"artifact\":\"${artifact#"$DL_ROOT"/}\""
  [ -n "$detail" ] && line="$line,\"detail\":\"$detail\""
  line="$line}"
  echo "$line" >> "$DL_OUT/results.jsonl"
  echo "$line"
}

# dl_report: writes report.json as an array of all results in this run/target.
dl_report() {
  local f="$DL_OUT/report.json"
  { echo "["; sed '$!s/$/,/' "$DL_OUT/results.jsonl" 2>/dev/null; echo "]"; } > "$f"
  dl_result report ok "$f"
}

dl_unsupported() { dl_result "$1" unsupported "" "${2:-not supported on $DL_TARGET}"; exit 3; }

# dl_require <op> VAR... : fail the op (exit 2, contract line "failed") if any variable is unset.
# Adapters have no default app since G1.5, so they never silently act on the wrong project.
dl_require() {
  local op="$1" var missing=""; shift
  for var in "$@"; do [ -n "${!var:-}" ] || missing="$missing $var"; done
  if [ -n "$missing" ]; then
    echo "$op: set$missing (no default app since G1.5; see device-lab/contract/README.md)" >&2
    dl_result "$op" failed "" "missing env:$missing"
    exit 2
  fi
}
