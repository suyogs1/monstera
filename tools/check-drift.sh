#!/usr/bin/env bash
# Drift check for an exported MONSTERA Studio pack (requirement R10.3, design section 7).
# Reads MONSTERA-STUDIO-MANIFEST.json only. Engine files stay with `monstera verify` and `generate --check`.
#
# Usage: tools/check-drift.sh [PROJECT_DIR]     (default: the parent of this script's directory)
#
# One line per file: STATE CLASS PATH, sorted by path. States:
#   unchanged  the file matches the manifest hash
#   edited     the file differs from the manifest hash (or is a link, which cannot be verified)
#   missing    the manifest lists the file and it is not on disk
#   unknown    the file is on disk, is not in the manifest, and is not an engine-owned file or the spec
# Exit codes:
#   0  no drift: nothing edited or missing in studio-scaffold (edits to studio-data and write-once are not drift)
#   1  drift: a studio-scaffold file is edited or missing
#   2  the check could not run: bad usage, no sha256 tool, or a missing or invalid manifest
# Needs only bash, awk, find, sort and sha256sum or shasum.
set -euo pipefail
export LC_ALL=C

MANIFEST="MONSTERA-STUDIO-MANIFEST.json"

die() { printf 'check-drift: %s\n' "$*" >&2; exit 2; }

if [ "$#" -gt 1 ]; then die "usage: check-drift.sh [PROJECT_DIR]"; fi
if [ "$#" -eq 1 ]; then
  root="$1"
else
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
[ -d "$root" ] || die "not a directory: $root"
cd "$root"

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum -- "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 -- "$1" | awk '{print $1}'; }
else
  die "needs sha256sum or shasum"
fi

[ -f "$MANIFEST" ] || die "$MANIFEST is missing in $root"

# The manifest is the canonical text the Studio exporter writes: one key per line. Read it as lines, not as general JSON.
manifest_text="$(tr -d '\r' < "$MANIFEST")"
printf '%s\n' "$manifest_text" | grep -q '^  "schema": "monstera.studio.pack-manifest",$' || die "$MANIFEST: schema is not monstera.studio.pack-manifest"
printf '%s\n' "$manifest_text" | grep -q '^  "version": 1,$' || die "$MANIFEST: unsupported version"

# Emit "class<TAB>sha256<TAB>path" for each entry; fail on anything that does not look like an entry.
entries="$(printf '%s\n' "$manifest_text" | awk '
  /^      "path": "/ { p = $0; sub(/^      "path": "/, "", p); sub(/",?$/, "", p); path = p; next }
  /^      "class": "/ { c = $0; sub(/^      "class": "/, "", c); sub(/",?$/, "", c); cls = c; next }
  /^      "sha256": "/ { s = $0; sub(/^      "sha256": "/, "", s); sub(/",?$/, "", s);
    if (path == "" || cls == "") { print "BAD\tentry without path or class"; exit }
    printf "%s\t%s\t%s\n", cls, s, path; path = ""; cls = ""; next }
')" || die "$MANIFEST: cannot read entries"

declare -a rows=()
declare -a listed=()
drift=0

while IFS=$'\t' read -r cls sha path; do
  [ -n "${cls:-}" ] || continue
  [ "$cls" != "BAD" ] || die "$MANIFEST: $sha"
  case "$cls" in studio-data|studio-scaffold|write-once) ;; *) die "$MANIFEST: unknown class '$cls' for '$path'" ;; esac
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "$MANIFEST: bad sha256 for '$path'"
  case "$path" in
    ''|/*|*'\'*|../*|*/../*|*/..|./*|*/./*|*/.|*//*|*/) die "$MANIFEST: unsafe path '$path'" ;;
    "$MANIFEST") die "$MANIFEST: the manifest cannot list itself" ;;
  esac
  listed+=("$path")
  if [ -L "$path" ]; then
    state="edited"
  elif [ ! -f "$path" ]; then
    state="missing"
  elif [ "$(hash_of "$path")" = "$sha" ]; then
    state="unchanged"
  else
    state="edited"
  fi
  if [ "$cls" = "studio-scaffold" ] && { [ "$state" = "edited" ] || [ "$state" = "missing" ]; }; then drift=$((drift + 1)); fi
  rows+=("$path"$'\t'"$state"$'\t'"$cls")
done <<< "$entries"

is_listed() {
  local p
  for p in "${listed[@]+"${listed[@]}"}"; do [ "$p" = "$1" ] && return 0; done
  return 1
}

# Files outside the manifest. Engine-owned files and the spec are covered by the engine's own manifest; .git is not pack content.
while IFS= read -r f; do
  p="${f#./}"
  case "$p" in
    "$MANIFEST"|monstera.spec.json|MONSTERA-MANIFEST.json|.kiro/steering/monstera-generated.md|android/*|ios/*|.git/*) continue ;;
  esac
  is_listed "$p" && continue
  rows+=("$p"$'\t'"unknown"$'\t'"-")
done < <(find . \( -type f -o -type l \) -print)

counts_u=0; counts_e=0; counts_m=0; counts_k=0
if [ "${#rows[@]}" -gt 0 ]; then
  while IFS=$'\t' read -r path state cls; do
    printf '%-9s %-15s %s\n' "$state" "$cls" "$path"
    case "$state" in unchanged) counts_u=$((counts_u + 1)) ;; edited) counts_e=$((counts_e + 1)) ;; missing) counts_m=$((counts_m + 1)) ;; unknown) counts_k=$((counts_k + 1)) ;; esac
  done < <(printf '%s\n' "${rows[@]}" | sort -t $'\t' -k1,1)
fi

printf 'unchanged=%d edited=%d missing=%d unknown=%d scaffold-drift=%d\n' "$counts_u" "$counts_e" "$counts_m" "$counts_k" "$drift"
if [ "$drift" -gt 0 ]; then
  printf 'DRIFT: %d studio-scaffold file(s) edited or missing\n' "$drift" >&2
  exit 1
fi
exit 0
