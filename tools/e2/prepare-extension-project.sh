#!/usr/bin/env bash
# E2: make a fresh app-layout project from a spec, then add the extensions/ tree exactly as Studio exports it
# (the materialize step of studio/src/integrations/scaffold/native.test.ts), then secret-scan the whole tree.
# The output directory must not exist. Nothing is deleted. Needs Python 3.10+, Node 22 and the studio lockfile install.
# Usage: tools/e2/prepare-extension-project.sh <spec> <out>      e.g. spec/samples/lantern-run/monstera.spec.json e2-native/lantern-run
set -euo pipefail
cd "$(dirname "$0")/../.."
spec="${1:?usage: prepare-extension-project.sh <spec> <out>}"
out="${2:?usage: prepare-extension-project.sh <spec> <out>}"
test -f "$spec" || { echo "no spec at $spec" >&2; exit 2; }
test ! -e "$out" || { echo "$out already exists; this script never reuses or deletes a directory" >&2; exit 2; }
mkdir -p "$out"
cp "$spec" "$out/monstera.spec.json"
bash tools/monstera/bin/monstera generate "$out/monstera.spec.json" --out "$out" --layout app
bash tools/monstera/bin/monstera verify "$out"
abs="$(cd "$out" && pwd)"
ios_target="$(node -p "require('./$spec').project.platforms.ios.deploymentTarget")"
if test ! -d studio/node_modules; then (cd studio && npm ci --no-audit --no-fund); fi
(cd studio && E2_OUT="$abs" E2_IOS_TARGET="$ios_target" npx vitest --run src/integrations/scaffold/native.test.ts)
test -f "$out/extensions/android/src/main/kotlin/monstera/extensions/MonsteraExtensions.kt"
test -f "$out/extensions/ios/MonsteraExtensions/Package.swift"
# Secret scan over the generated output AND the extensions (no build output exists yet).
node studio/scripts/scan-secrets.mjs "$out"
# The engine must still call the tree clean: extensions/ is not engine-owned and is invisible to verify.
bash tools/monstera/bin/monstera verify "$out"
echo "prepared $out"