#!/usr/bin/env bash
# G6-B: regenerate one official game from its committed spec into a fresh, empty directory inside the
# checkout (Device Lab adapters resolve DL_APP_DIR against the repository root), verify the manifest and
# prove every generator-owned file equals the committed app tree.
# Usage: tools/clean-room/clean-room.sh <apps/<id>>      e.g. apps/pumpkin-blaster
# Output: g6-clean-room/<id>/ (fresh tree, git-ignored) and g6-clean-room-reports/<id>.compare.json
# The fresh directory must not exist: this script never deletes anything and never uses --force.
set -euo pipefail
cd "$(dirname "$0")/../.."
app="${1:?usage: clean-room.sh apps/<id>}"
app="${app%/}"
id="$(basename "$app")"
spec="$app/monstera.spec.json"
fresh="g6-clean-room/$id"
reports="g6-clean-room-reports"
test -f "$spec" || { echo "no spec at $spec" >&2; exit 2; }
test ! -e "$fresh" || { echo "$fresh already exists; remove it yourself, clean-room never reuses a directory" >&2; exit 2; }
PY=""
for c in python3 python "py -3"; do
  # shellcheck disable=SC2086 # "py -3" must split
  if $c -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then PY="$c"; break; fi
done
test -n "$PY" || { echo "Python 3.10+ not found" >&2; exit 2; }
mkdir -p "$fresh" "$reports"
test -z "$(ls -A "$fresh")" || { echo "$fresh is not empty" >&2; exit 2; }
bash tools/monstera/bin/monstera generate "$spec" --out "$fresh" --layout app
bash tools/monstera/bin/monstera verify "$fresh"
# shellcheck disable=SC2086
$PY tools/clean-room/clean_room.py compare "$app" "$fresh" "$reports/$id.compare.json"
